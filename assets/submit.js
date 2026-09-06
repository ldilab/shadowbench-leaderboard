import {
  API_BASE, ID_PREFIX, RATE_LIMIT_MS, RUN_ANALYSIS_URL,
  EVAL_DEFAULTS, ADAPTER, PROBLEM_COUNT, SUBMISSION_AREAS, SUBMISSION_LEVELS,
} from "./config.js";
import { computeMetrics } from "./metrics.js";
import {
  initTheme, fmtPct, escapeHtml, slugify,
  loadTrackedJobs, saveTrackedJob, removeTrackedJob, lastSubmitAt, markSubmitted,
  derivePasswordHash, delkTag, parseDelkTag, verifyPassword,
} from "./ui.js";

initTheme();

const POLL_MS = 15000;
const TERMINAL_OK = new Set(["completed", "done", "succeeded", "success"]);
const TERMINAL_FAIL = new Set(["failed", "error", "errored", "cancelled", "canceled"]);

// Local test mode: an API key + small problem count, revealed only when the page
// is served from localhost. The deployed site never shows these or reads a key.
const IS_LOCAL = typeof location !== "undefined" &&
  (["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(location.hostname) ||
    location.protocol === "file:");
if (IS_LOCAL) {
  const dev = document.getElementById("dev-panel");
  if (dev) dev.hidden = false;
}

/* ---------------------------- Rate-limit gate ---------------------------- */

const submitBtn = document.getElementById("submit-btn");
const rateNote = document.getElementById("rate-note");
let rateTimer = null;

function refreshRateGate() {
  const remaining = lastSubmitAt() + RATE_LIMIT_MS - Date.now();
  if (remaining > 0) {
    submitBtn.disabled = true;
    const mm = Math.floor(remaining / 60000);
    const ss = String(Math.ceil((remaining % 60000) / 1000)).padStart(2, "0");
    rateNote.textContent = `Rate limit: you can submit again in ${mm}:${ss}.`;
    if (!rateTimer) rateTimer = setInterval(refreshRateGate, 1000);
  } else {
    submitBtn.disabled = false;
    rateNote.textContent = "One submission per 10 minutes.";
    if (rateTimer) { clearInterval(rateTimer); rateTimer = null; }
  }
}
refreshRateGate();

/* ------------------------------- Submit ---------------------------------- */

const form = document.getElementById("submit-form");
const formMsg = document.getElementById("form-msg");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formMsg.textContent = "";
  formMsg.className = "rate-note";

  if (lastSubmitAt() + RATE_LIMIT_MS - Date.now() > 0) { refreshRateGate(); return; }

  const fd = new FormData(form);
  const name = String(fd.get("name") || "").trim();
  const org = String(fd.get("org") || "").trim();
  const endpoint = String(fd.get("endpoint") || "").trim();
  const model = String(fd.get("model") || "").trim();
  const maxTokens = String(fd.get("maxTokens") || "8192").trim();
  const temperature = String(fd.get("temperature") || "0.6").trim();
  const password = String(fd.get("password") || "");
  // Local test mode only: an API key and a small problem count. Read nowhere else.
  const apiKey = IS_LOCAL ? String(fd.get("apiKey") || "").trim() : "";
  const devCount = IS_LOCAL ? Number(fd.get("devCount") || 0) : 0;
  const count = devCount > 0 ? devCount : PROBLEM_COUNT;
  // Scope is fixed: every submission runs the full ShadowBench set (all areas, L1 to L3).
  const areas = SUBMISSION_AREAS;
  const levels = SUBMISSION_LEVELS;

  if (!name || !org || !endpoint || !model) {
    return fail("Name, organization, model endpoint and model id are required.");
  }
  if (!/^https?:\/\//i.test(endpoint)) {
    return fail("Model endpoint must be an http(s) URL (e.g. https://openrouter.ai/api/v1).");
  }
  if (password.length < 4) {
    return fail("Set a delete password of at least 4 characters.");
  }

  const evalCfg = {
    num_problems: count,
    areas, levels,
    seed: EVAL_DEFAULTS.seed,
    sampling: EVAL_DEFAULTS.sampling,
    prompt_components: EVAL_DEFAULTS.prompt_components,
    two_phase_evaluation: EVAL_DEFAULTS.two_phase_evaluation,
    lean_version: EVAL_DEFAULTS.lean_version,
    hidden_checker_only: EVAL_DEFAULTS.hidden_checker_only,
  };
  const env = {
    ...ADAPTER.env_static,
    VLLM_BASE_URL: endpoint,
    VLLM_MODEL: model,
    VLLM_MAX_TOKENS: maxTokens,
    VLLM_TEMPERATURE: temperature,
    ABM_MAX_TASKS: String(count),
  };
  if (apiKey) { env.VLLM_API_KEY = apiKey; env.OPENAI_API_KEY = apiKey; env.OPENROUTER_API_KEY = apiKey; }

  const submissionSpec = {
    model_cmd: ADAPTER.model_cmd,
    env,
    eval: evalCfg,
    runtime: ADAPTER.runtime,
    bench: {
      limit: count,
      seed: evalCfg.seed,
      sampling: evalCfg.sampling,
      areas, levels,
      prompt_components: EVAL_DEFAULTS.prompt_components,
      two_phase_evaluation: EVAL_DEFAULTS.two_phase_evaluation,
      hidden_checker_only: EVAL_DEFAULTS.hidden_checker_only,
    },
  };

  const id = `${ID_PREFIX}${slugify(name)}-${Math.random().toString(16).slice(2, 8)}`;
  const delk = await derivePasswordHash(password);
  const body = {
    id, name, org, track: "Open",
    tags: ["leaderboard", delkTag(delk.salt, delk.hash)],
    submissionSpec,
  };

  submitBtn.disabled = true;
  submitBtn.innerHTML = `<span class="spinner"></span> Submitting…`;
  try {
    const res = await fetch(`${API_BASE}/api/submissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try { detail = JSON.stringify(JSON.parse(text).detail); } catch (_e) {}
      throw new Error(`HTTP ${res.status}: ${detail}`);
    }
    const out = JSON.parse(text);
    markSubmitted();
    const job = {
      id: out.submission_id || id,
      name, org,
      status: out.status || "queued",
      createdAt: Date.now(),
      endpoint, model,
      delk, // local fallback for verifying the delete password
    };
    saveTrackedJob(job);
    form.reset();
    formMsg.className = "rate-note";
    formMsg.style.color = "var(--good)";
    formMsg.textContent = `Submitted as ${job.id}. Tracking below.`;
    renderJobs();
    pollJob(job.id);
  } catch (err) {
    fail(err.message);
  } finally {
    submitBtn.innerHTML = "Submit to leaderboard";
    refreshRateGate();
  }
});

function fail(msg) {
  formMsg.className = "rate-note";
  formMsg.style.color = "var(--bad)";
  formMsg.textContent = msg;
  submitBtn.disabled = false;
  submitBtn.innerHTML = "Submit to leaderboard";
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
    const patch = { status: s.status || "unknown" };
    if (s.error) patch.error = s.error;

    if (TERMINAL_OK.has(status)) {
      const an = await fetchAnalysis(id);
      if (an) {
        patch.metrics = computeMetrics(an);
        patch.completedAt = Date.now();
        patch.status = "completed";
      }
    }
    saveTrackedJob({ id, ...patch });
    renderJobs();

    const done = TERMINAL_OK.has(status) || TERMINAL_FAIL.has(status);
    return done;
  } catch (e) {
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

async function pollAllActive() {
  await refreshQueue();
  const active = loadTrackedJobs().filter((j) => {
    const st = String(j.status || "").toLowerCase();
    return !TERMINAL_OK.has(st) && !TERMINAL_FAIL.has(st) || (TERMINAL_OK.has(st) && !j.metrics);
  });
  for (const j of active) await pollJob(j.id);
  renderJobs();
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
        <div class="meta"><a href="${RUN_ANALYSIS_URL(j.id)}" target="_blank" rel="noopener">analysis</a> <a href="./index.html">leaderboard</a></div>`;
      }

      const progress = active
        ? `<div class="progress indet"><span></span></div>`
        : "";
      const errLine = (isFail && (j.error || j.lastError))
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
          <span>${escapeHtml(j.model || "")}</span>
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
    btn.addEventListener("click", () => {
      const id = btn.dataset.delId;
      const pass = window.prompt(`Enter the delete password for ${id}:`);
      if (pass == null) return;
      deleteSubmission(id, pass, (msg, ok) => {
        btn.textContent = ok ? "Deleted" : "Failed";
        if (!ok) window.alert(msg);
        renderJobs();
      });
    });
  });
}

/* ------------------------------- Deletion -------------------------------- */

// Verify the password against the delete-key stored in the submission tag
// (works from any browser), with a local fallback for a just-made submission.
async function deleteSubmission(id, password, done) {
  const report = typeof done === "function" ? done : () => {};
  try {
    let delk = null;
    const local = loadTrackedJobs().find((j) => j.id === id);
    try {
      const res = await fetch(`${API_BASE}/api/submissions/${encodeURIComponent(id)}`, { cache: "no-cache" });
      if (res.ok) {
        const s = await res.json();
        delk = parseDelkTag((s.run && s.run.tags) || []);
      }
    } catch (_e) { /* fall back to local delk */ }
    if (!delk && local && local.delk) delk = local.delk;

    if (!delk) {
      return report("No delete password is on record for this submission, so it cannot be verified here.", false);
    }
    const ok = await verifyPassword(password, delk.salt, delk.hash);
    if (!ok) return report("Wrong password.", false);

    const del = await fetch(`${API_BASE}/api/admin/submissions/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!del.ok) {
      const t = await del.text();
      return report(`Delete failed: HTTP ${del.status} ${t}`, false);
    }
    removeTrackedJob(id);
    return report("Deleted.", true);
  } catch (e) {
    return report(`Delete error: ${e.message}`, false);
  }
}

const deleteForm = document.getElementById("delete-form");
if (deleteForm) {
  const delMsg = document.getElementById("delete-msg");
  deleteForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(deleteForm);
    const id = String(fd.get("delId") || "").trim();
    const pass = String(fd.get("delPass") || "");
    if (!id || !pass) return;
    const btn = document.getElementById("delete-btn");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Deleting…`;
    await deleteSubmission(id, pass, (msg, ok) => {
      delMsg.style.color = ok ? "var(--good)" : "var(--bad)";
      delMsg.textContent = msg;
      if (ok) { deleteForm.reset(); renderJobs(); }
    });
    btn.disabled = false;
    btn.textContent = "Delete submission";
  });
}

renderJobs();
pollAllActive();
setInterval(pollAllActive, POLL_MS);
