import { API_BASE, ID_PREFIX, METRIC_LABELS } from "./config.js";
import { computeMetrics } from "./metrics.js";
import { initTheme, fmtPct, escapeHtml, loadTrackedJobs, removeTrackedJob } from "./ui.js";
import { deleteSubmission } from "./delete-submission.js";

initTheme();

const TERMINAL_OK = new Set(["completed", "done", "succeeded", "success"]);
const TERMINAL_FAIL = new Set(["failed", "error", "errored", "cancelled", "canceled"]);
const isPending = (status) => {
  const s = String(status || "").toLowerCase();
  return !TERMINAL_OK.has(s) && !TERMINAL_FAIL.has(s);
};

/* ------------------------------ Paper table ------------------------------ */

const paperState = { data: null, level: "average", group: "all" };

async function loadPaper() {
  const host = document.getElementById("paper-board");
  try {
    const res = await fetch("./data/paper_results.json", { cache: "no-cache" });
    paperState.data = await res.json();
  } catch (e) {
    host.innerHTML = `<div class="empty">Could not load paper results: ${escapeHtml(e.message)}</div>`;
    return;
  }
  const src = paperState.data.source;
  document.getElementById("paper-sub").innerHTML =
    `<a href="${src.arxivUrl}" target="_blank" rel="noopener">arXiv:${src.arxiv}${src.version}</a>, ${escapeHtml(src.table)}. ` +
    `${src.benchmark.problems} problems (L1 ${src.benchmark.levels.L1}, L2 ${src.benchmark.levels.L2}, L3 ${src.benchmark.levels.L3}).`;
  renderPaper();
}

// Always ranked by SA-PASS (ties broken by SA-PASS Soft, then compile) --
// no interactive column sort. A toggleable sort arrow next to SA-PASS read as
// ambiguous (does it mean this column, or "lower is better"?); a fixed,
// clearly-labeled primary ranking avoids that entirely.
function renderPaper() {
  const { data, level, group } = paperState;
  if (!data) return;
  let rows = data.rows.filter((r) => group === "all" || r.group === group);
  rows = rows
    .map((r) => ({ ...r, cur: r[level] }))
    .sort((a, b) => {
      for (const m of ["saPass", "saPassSoft", "compile"]) {
        if (a.cur[m] !== b.cur[m]) return b.cur[m] - a.cur[m];
      }
      return 0;
    });

  const rowsHtml = rows
    .map((r, i) => {
      return `<tr>
        <td class="rank">${i + 1}</td>
        <td><span class="method">${escapeHtml(r.method)}</span></td>
        <td class="group">${escapeHtml(r.group)}</td>
        ${metricCell(r.cur.compile, false)}
        ${metricCell(r.cur.saPassSoft, false)}
        ${metricCell(r.cur.saPass, true)}
      </tr>`;
    })
    .join("");

  document.getElementById("paper-board").innerHTML = `
    <div class="tbl-wrap" role="region" aria-label="Reported results, ranked by SA-PASS" tabindex="0"><table class="board">
      <thead><tr>
        <th>#</th><th>Method</th><th>Group</th>
        <th class="num">${METRIC_LABELS.compile}</th>
        <th class="num">${METRIC_LABELS.saPassSoft}</th>
        <th class="num">${METRIC_LABELS.saPass}</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table></div>`;
}

function metricCell(v, strong) {
  const pct = fmtPct(v);
  return `<td class="num ${strong ? "metric-strong" : ""}">${pct}</td>`;
}

// Category breakdown rows share the board table's own <colgroup>, so they line
// up with the parent row's columns exactly (a separate nested table can't).
function categoryRowsHtml(categories, groupId) {
  if (!Array.isArray(categories) || categories.length === 0) return "";
  return categories
    .map(
      (item, idx) => `<tr class="category-row" id="${groupId}-${idx}" data-group="${groupId}" hidden>
        <td class="rank"></td>
        <td class="category-name">${escapeHtml(item.category)}</td>
        <td></td>
        ${metricCell(item.compile, false)}
        ${metricCell(item.saPassSoft, false)}
        ${metricCell(item.saPass, true)}
        <td class="num metric-mut">${item.n ?? "n/a"}</td>
        <td></td>
      </tr>`
    )
    .join("");
}

/* --------------------------- Community table ----------------------------- */

async function loadCommunity() {
  const host = document.getElementById("community-board");
  let community = { entries: [], generatedAt: null };
  try {
    const res = await fetch("./data/community.json", { cache: "no-cache" });
    if (res.ok) community = await res.json();
  } catch (e) {
    /* file may not exist yet before the first publish */
  }

  // Merge in locally-tracked completed jobs (so a submitter sees their own
  // result immediately in this browser, even before they confirm publishing
  // it -- their own view is never gated on the email confirmation step).
  const byId = new Map((community.entries || []).map((e) => [e.id, e]));
  const tracked = loadTrackedJobs();
  for (const j of tracked) {
    if (TERMINAL_OK.has(String(j.status).toLowerCase()) && j.metrics && !byId.has(j.id)) {
      byId.set(j.id, {
        id: j.id, name: j.name, org: j.org,
        completedAt: j.completedAt || null, metrics: j.metrics,
        categories: j.categories || [], local: true,
      });
    }
  }
  const entries = [...byId.values()].filter((e) => e.metrics);

  // Runs still being evaluated: from the shared queue (any visitor) + this
  // browser's own in-flight jobs. Shown at the top with a waiting badge.
  const pending = await loadPending(new Set(byId.keys()), tracked);

  if (community.generatedAt) {
    document.getElementById("community-sub").textContent =
      `Live dataset ${community.datasetVersion || "v1.2"}; task selection may differ from the paper. Updated ${new Date(community.generatedAt).toLocaleString()}.`;
  }

  if (entries.length === 0 && pending.length === 0) {
    host.innerHTML = `<div class="empty">No community submissions yet.</div>`;
    return;
  }

  entries.sort((a, b) => {
    const am = a.metrics, bm = b.metrics;
    return (bm.saPass - am.saPass) || (bm.saPassSoft - am.saPassSoft) || (bm.compile - am.compile);
  });

  const rowsHtml = entries
    .map((e, i) => {
      const m = e.metrics;
      const localTag = e.local ? ` <span class="badge run" title="From this browser, not in the shared sync">you</span>` : "";
      const date = e.completedAt ? new Date(e.completedAt).toLocaleDateString() : "n/a";
      const detailId = `categories-${i}`;
      const hasCategories = Array.isArray(e.categories) && e.categories.length > 0;
      const controlsIds = hasCategories ? e.categories.map((_, idx) => `${detailId}-${idx}`).join(" ") : "";
      const expander = hasCategories
        ? `<button type="button" class="expand-btn" data-category-toggle="${detailId}" aria-expanded="false" aria-controls="${controlsIds}" title="Show category performance"><span aria-hidden="true">&#9656;</span></button>`
        : "";
      const delBtn = `<button type="button" class="del-btn" data-del-id="${escapeHtml(e.id)}" title="Delete this submission">&times;</button>`;
      return `<tr>
        <td class="rank">${i + 1}</td>
        <td><div class="submission-name">${expander}<span><span class="method">${escapeHtml(e.name || e.id)}</span>${localTag}<span class="id">${escapeHtml(e.id)}</span></span>${delBtn}</div></td>
        <td>${escapeHtml(e.org || "n/a")}</td>
        ${metricCell(m.compile, false)}
        ${metricCell(m.saPassSoft, false)}
        ${metricCell(m.saPass, true)}
        <td class="num metric-mut">${m.n ?? "n/a"}</td>
        <td class="num metric-mut">${date}</td>
      </tr>${categoryRowsHtml(e.categories, detailId)}`;
    })
    .join("");

  const pendingHtml = pending
    .map((p) => {
      const badge = p.status === "running"
        ? `<span class="badge run"><span class="spinner"></span> running</span>`
        : `<span class="badge warn"><span class="spinner"></span> ${escapeHtml(p.status || "queued")}</span>`;
      const youTag = p.local ? ` <span class="badge run" title="From your browser">you</span>` : "";
      const delBtn = `<button type="button" class="del-btn" data-del-id="${escapeHtml(p.id)}" title="Delete this submission">&times;</button>`;
      return `<tr>
        <td class="rank">•</td>
        <td><div class="submission-name"><span><span class="method">${escapeHtml(p.name || p.id)}</span>${youTag}<span class="id">${escapeHtml(p.id)}</span></span>${delBtn}</div></td>
        <td>${escapeHtml(p.org || "n/a")} ${badge}</td>
        <td class="num metric-mut">n/a</td>
        <td class="num metric-mut">n/a</td>
        <td class="num metric-mut">n/a</td>
        <td class="num metric-mut">n/a</td>
        <td class="num metric-mut">n/a</td>
      </tr>`;
    })
    .join("");

  host.innerHTML = `
    <div class="tbl-wrap" role="region" aria-label="Community submissions" tabindex="0"><table class="board">
      <thead><tr>
        <th>#</th><th>Submission</th><th>Org</th>
        <th class="num">${METRIC_LABELS.compile}</th>
        <th class="num">${METRIC_LABELS.saPassSoft}</th>
        <th class="num">${METRIC_LABELS.saPass}</th>
        <th class="num">Tasks</th><th class="num">Date</th>
      </tr></thead>
      <tbody>${pendingHtml}${rowsHtml}</tbody>
    </table></div>`;

  host.querySelectorAll("[data-category-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const rows = host.querySelectorAll(`[data-group="${button.dataset.categoryToggle}"]`);
      const expanded = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!expanded));
      button.title = expanded ? "Show category performance" : "Hide category performance";
      rows.forEach((row) => { row.hidden = expanded; });
    });
  });

  // Any submission can be deleted from any browser given its password -- see
  // assets/delete-submission.js -- so this button is on every row, not just
  // ones tracked locally.
  host.querySelectorAll("[data-del-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.delId;
      const pass = window.prompt(`Enter the delete password for ${id}:`);
      if (pass == null) return;
      const local = tracked.find((j) => j.id === id);
      button.disabled = true;
      const { ok, message } = await deleteSubmission(id, pass, local && local.delk);
      if (ok) {
        removeTrackedJob(id);
        loadCommunity();
      } else {
        button.disabled = false;
        window.alert(message);
      }
    });
  });
}

// Collect runs still being evaluated: shared backend queue entries with our
// prefix, plus this browser's own non-terminal jobs. `doneIds` are already shown.
async function loadPending(doneIds, tracked) {
  const map = new Map();
  try {
    const res = await fetch(`${API_BASE}/api/submission_queue.json`, { cache: "no-cache" });
    if (res.ok) {
      const q = await res.json();
      for (const it of q.items || []) {
        const id = it.id || it.submission_id;
        if (!id || !String(id).startsWith(ID_PREFIX) || doneIds.has(id)) continue;
        map.set(id, { id, name: it.name || id, org: it.org || "n/a", status: (it.status || "queued").toLowerCase() });
      }
    }
  } catch (_e) { /* queue unavailable, fall back to local jobs only */ }

  for (const j of tracked) {
    if (!isPending(j.status) || doneIds.has(j.id)) continue;
    map.set(j.id, { id: j.id, name: j.name || j.id, org: j.org || "n/a", status: String(j.status || "queued").toLowerCase(), local: true });
  }
  return [...map.values()];
}

/* ------------------------------ Controls --------------------------------- */

document.querySelectorAll("#level-seg button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll("#level-seg button").forEach((x) => {
      x.classList.remove("active");
      x.setAttribute("aria-pressed", "false");
    });
    b.classList.add("active");
    b.setAttribute("aria-pressed", "true");
    paperState.level = b.dataset.level;
    renderPaper();
  });
});
document.getElementById("group-filter").addEventListener("change", (e) => {
  paperState.group = e.target.value;
  renderPaper();
});

loadPaper();
loadCommunity();

export { computeMetrics }; // re-exported for console debugging convenience
