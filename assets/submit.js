import { API_BASE, ID_PREFIX, RATE_LIMIT_MS, PROBLEM_COUNT, WORKER_BASE } from "./config.js";
import { parseSolutions, buildCodeSpec, MAX_SOURCE_BYTES } from "./code-submission.js";
import { computeMetrics, computeCategoryMetrics } from "./metrics.js";
import {
  initTheme, fmtPct, escapeHtml, slugify,
  loadTrackedJobs, saveTrackedJob, removeTrackedJob, lastSubmitAt, markSubmitted,
  derivePasswordHash, delkTag, renderCategoryMetrics,
} from "./ui.js";
import { deleteSubmission } from "./delete-submission.js";

initTheme();

const POLL_MS = 15000;
const TERMINAL_OK = new Set(["completed", "done", "succeeded", "success"]);
const TERMINAL_FAIL = new Set(["failed", "error", "errored", "cancelled", "canceled"]);
const submitBtn = document.getElementById("submit-btn");
const rateNote = document.getElementById("rate-note");
const form = document.getElementById("submit-form");
const formMsg = document.getElementById("form-msg");
const codeInput = document.getElementById("f-code");
const fileInput = document.getElementById("f-file");
const codeStatus = document.getElementById("code-status");
let submitting = false;
let readingFile = false;
let fileReadVersion = 0;
let validationTimer;

function refreshRateGate() {
  const remaining = lastSubmitAt() + RATE_LIMIT_MS - Date.now();
  submitBtn.disabled = submitting || readingFile || remaining > 0;
  if (remaining > 0) {
    const seconds = Math.ceil(remaining / 1000);
    rateNote.textContent = `Next submission in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.`;
  } else {
    rateNote.textContent = "One submission per 10 minutes in this browser.";
  }
}
refreshRateGate();
setInterval(refreshRateGate, 1000);

function validateCode() {
  codeInput.setCustomValidity("");
  if (!codeInput.value.trim()) {
    codeStatus.textContent = "No solutions loaded.";
    codeStatus.style.color = "";
    return null;
  }
  try {
    const rows = parseSolutions(codeInput.value);
    codeStatus.textContent = `${rows.length} solution${rows.length === 1 ? "" : "s"} loaded. ${PROBLEM_COUNT} tasks will be evaluated.`;
    codeStatus.style.color = "var(--good)";
    return rows;
  } catch (error) {
    codeStatus.textContent = error.message;
    codeStatus.style.color = "var(--bad)";
    codeInput.setCustomValidity(error.message);
    return null;
  }
}

codeInput.addEventListener("input", () => {
  fileReadVersion++;
  readingFile = false;
  refreshRateGate();
  codeInput.setCustomValidity("");
  clearTimeout(validationTimer);
  validationTimer = setTimeout(validateCode, 250);
});
codeInput.addEventListener("blur", validateCode);

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  const version = ++fileReadVersion;
  readingFile = Boolean(file);
  refreshRateGate();
  if (!file) return;
  try {
    if (!/\.(json|jsonl)$/i.test(file.name)) throw new Error("Choose a .json or .jsonl file.");
    if (file.size > MAX_SOURCE_BYTES) throw new Error("Solutions must be 4 MiB or smaller.");
    const text = await file.text();
    if (version !== fileReadVersion) return;
    codeInput.value = text;
    validateCode();
  } catch (error) {
    if (version !== fileReadVersion) return;
    fileInput.value = "";
    fail(error.message);
  } finally {
    if (version === fileReadVersion) {
      readingFile = false;
      refreshRateGate();
    }
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submitting || readingFile || lastSubmitAt() + RATE_LIMIT_MS > Date.now()) return;
  const rows = validateCode();
  if (!rows) return fail(codeInput.validationMessage || "Add your generated solutions.");
  const fd = new FormData(form);
  const name = String(fd.get("name") || "").trim();
  const org = String(fd.get("org") || "").trim();
  const email = String(fd.get("email") || "").trim();
  const password = String(fd.get("password") || "");
  if (!name || !org) return fail("Submission name and organization are required.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Enter a valid email address.");
  if (password.length < 4) return fail("Set a delete password of at least 4 characters.");

  // Lock before hashing/compressing so repeated clicks cannot create duplicate jobs.
  submitting = true;
  refreshRateGate();
  submitBtn.textContent = "Submitting...";
  formMsg.textContent = "";
  let acceptedJob = null;
  try {
    const submissionSpec = await buildCodeSpec(rows);
    const id = `${ID_PREFIX}${slugify(name)}-${crypto.randomUUID().slice(0, 8)}`;
    const delk = await derivePasswordHash(password);
    const body = {
      id, name, org, track: "Open",
      tags: ["leaderboard", "generated-code", delkTag(delk.salt, delk.hash)],
      submissionSpec, email,
    };
    // Goes through our Worker, not straight to the evaluator: it enforces a
    // real per-IP/per-email rate limit (unlike the localStorage gate above,
    // which a private window resets), and starts watching the id + email for
    // completion in the same request, so there's no separate tracking call
    // that could be lost to a network blip.
    const res = await fetch(`${WORKER_BASE}/api/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const text = await res.text();
    if (res.status === 429) {
      let detail = "Too many submissions recently -- please wait before trying again.";
      try { detail = JSON.parse(text).error || detail; } catch {}
      throw new Error(detail);
    }
    if (!res.ok) {
      let detail = text;
      try { detail = JSON.parse(text).error || JSON.stringify(JSON.parse(text).detail); } catch {}
      throw new Error(`HTTP ${res.status}: ${detail.slice(0, 500)}`);
    }
    const out = JSON.parse(text);
    if (!out.submission_id) throw new Error("The server did not return a submission ID.");
    markSubmitted();
    acceptedJob = {
      id: out.submission_id, name, org, status: out.status || "queued",
      createdAt: Date.now(), solutionCount: rows.length, submissionType: "generated-code", delk,
    };
    saveTrackedJob(acceptedJob);
    form.reset();
    validateCode();
    formMsg.style.color = "var(--good)";
    formMsg.textContent = `Submitted as ${acceptedJob.id}.`;
    renderJobs();
  } catch (error) {
    fail(error.name === "TimeoutError"
      ? "The server response timed out. The run may have been accepted; check the leaderboard before retrying."
      : error.message);
  } finally {
    submitting = false;
    submitBtn.textContent = "Submit code";
    refreshRateGate();
  }
  if (acceptedJob) void pollJob(acceptedJob.id);
});

function fail(message) {
  formMsg.style.color = "var(--bad)";
  formMsg.textContent = message;
  return false;
}

/* ------------------------------- Polling --------------------------------- */

let queueInfo = null;

async function refreshQueue() {
  try {
    const res = await fetch(`${API_BASE}/api/submission_queue.json`, { cache: "no-cache" });
    if (res.ok) queueInfo = await res.json();
  } catch (_e) {}
}

async function pollJob(id) {
  try {
    const res = await fetch(`${API_BASE}/api/submissions/${encodeURIComponent(id)}`, { cache: "no-cache" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const s = await res.json();
    const status = String(s.status || "").toLowerCase();
    const patch = { status: s.status || "unknown", lastError: null };
    if (s.error) patch.error = s.error;

    if (TERMINAL_OK.has(status)) {
      const an = await fetchAnalysis(id);
      if (an) {
        patch.metrics = computeMetrics(an);
        patch.categories = computeCategoryMetrics(an);
        patch.completedAt = Date.now();
        patch.status = "completed";
      }
    }
    if (!loadTrackedJobs().some((job) => job.id === id)) return true;
    saveTrackedJob({ id, ...patch });
    renderJobs();

    const done = TERMINAL_OK.has(status) || TERMINAL_FAIL.has(status);
    return done;
  } catch (e) {
    if (!loadTrackedJobs().some((job) => job.id === id)) return true;
    saveTrackedJob({ id, lastError: e.message });
    renderJobs();
    return false;
  }
}

async function fetchAnalysis(id) {
  try {
    const res = await fetch(`${API_BASE}/api/submissions/${encodeURIComponent(id)}/analysis`, { cache: "no-cache" });
    if (!res.ok) return null;
    return await res.json();
  } catch (_e) { return null; }
}

let polling = false;
async function pollAllActive() {
  if (polling) return;
  polling = true;
  try {
  await refreshQueue();
  const active = loadTrackedJobs().filter((j) => {
    const st = String(j.status || "").toLowerCase();
    return !TERMINAL_OK.has(st) && !TERMINAL_FAIL.has(st) ||
      (TERMINAL_OK.has(st) && (!j.metrics || !Array.isArray(j.categories)));
  });
  for (const j of active) await pollJob(j.id);
  renderJobs();
  } finally {
    polling = false;
  }
}

/* ------------------------------- Rendering ------------------------------- */

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function statusBadge(status) {
  const st = String(status || "").toLowerCase();
  if (TERMINAL_OK.has(st)) return `<span class="badge good">completed</span>`;
  if (TERMINAL_FAIL.has(st)) return `<span class="badge bad">${escapeHtml(status)}</span>`;
  if (st === "running") return `<span class="badge run"><span class="spinner"></span> running</span>`;
  return `<span class="badge warn"><span class="spinner"></span> ${escapeHtml(status || "queued")}</span>`;
}

function renderJobs() {
  const host = document.getElementById("jobs");
  const jobs = loadTrackedJobs();
  if (jobs.length === 0) {
    host.innerHTML = `<div class="empty">No submissions from this browser yet.</div>`;
    return;
  }
  host.innerHTML = jobs
    .map((j) => {
      const st = String(j.status || "").toLowerCase();
      const isDone = TERMINAL_OK.has(st);
      const isFail = TERMINAL_FAIL.has(st);
      const active = !isDone && !isFail;
      const elapsed = j.createdAt ? fmtElapsed((j.completedAt || Date.now()) - j.createdAt) : "n/a";

      let queueLine = "";
      if (active && queueInfo) {
        const pos = (queueInfo.items || []).findIndex((it) => (it.id || it.submission_id) === j.id);
        queueLine = pos >= 0
          ? `Queue position ${pos + 1} of ${queueInfo.items.length}`
          : `Queue ${queueInfo.queued ?? 0} queued, ${queueInfo.running ?? 0} running, ${queueInfo.maxWorkers ?? "?"} workers`;
      }

      let metricsHtml = "";
      if (isDone && j.metrics) {
        const m = j.metrics;
        metricsHtml = `<div class="metrics">
          <div class="m"><span class="k">Compile rate</span><span class="v">${fmtPct(m.compile)}</span></div>
          <div class="m"><span class="k">SA-pass (Soft)</span><span class="v">${fmtPct(m.saPassSoft)}</span></div>
          <div class="m"><span class="k">SA-pass</span><span class="v">${fmtPct(m.saPass)}</span></div>
          <div class="m"><span class="k">Tasks</span><span class="v">${m.n ?? "n/a"}</span></div>
        </div>
        <div class="job-categories">
          <h3>By category</h3>
          ${renderCategoryMetrics(j.categories)}
        </div>
        <div class="meta"><a href="./index.html">leaderboard</a></div>`;
      }

      const progress = active
        ? `<div class="progress indet"><span></span></div>`
        : "";
      const errLine = ((isFail && j.error) || j.lastError)
        ? `<div class="meta" style="color:var(--bad)">${escapeHtml(j.error || j.lastError)}</div>`
        : "";

      return `<div class="job">
        <div class="top">
          <span class="name">${escapeHtml(j.name || j.id)}</span>
          ${statusBadge(j.status)}
          <button type="button" class="mini-del" data-del-id="${escapeHtml(j.id)}">Delete</button>
        </div>
        <div class="id">${escapeHtml(j.id)}</div>
        <div class="meta">
          <span>${j.submissionType === "generated-code" ? `${j.solutionCount} solutions` : escapeHtml(j.model || "")}</span>
          <span>elapsed ${elapsed}</span>
          ${queueLine ? `<span>${escapeHtml(queueLine)}</span>` : ""}
        </div>
        ${progress}
        ${errLine}
        ${metricsHtml}
      </div>`;
    })
    .join("");

  host.querySelectorAll(".mini-del").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.delId;
      const pass = window.prompt(`Enter the delete password for ${id}:`);
      if (pass == null) return;
      const local = loadTrackedJobs().find((j) => j.id === id);
      btn.disabled = true;
      const { ok, message } = await deleteSubmission(id, pass, local && local.delk);
      btn.textContent = ok ? "Deleted" : "Failed";
      if (ok) removeTrackedJob(id);
      else { btn.disabled = false; window.alert(message); }
      renderJobs();
    });
  });
}

renderJobs();
pollAllActive();
setInterval(pollAllActive, POLL_MS);
