import { API_BASE, ID_PREFIX, RUN_ANALYSIS_URL, METRIC_LABELS } from "./config.js";
import { computeMetrics } from "./metrics.js";
import { initTheme, fmtPct, escapeHtml, loadTrackedJobs } from "./ui.js";

initTheme();

const TERMINAL_OK = new Set(["completed", "done", "succeeded", "success"]);
const TERMINAL_FAIL = new Set(["failed", "error", "errored", "cancelled", "canceled"]);
const isPending = (status) => {
  const s = String(status || "").toLowerCase();
  return !TERMINAL_OK.has(s) && !TERMINAL_FAIL.has(s);
};

const GROUP_BADGE = {
  Agentic: "agentic",
  "Closed-source LLM": "closed",
  "Open-source LLM": "open",
  "Lean-specialized": "lean",
};
const METRIC_ORDER = ["compile", "saPassSoft", "saPass"];

/* ------------------------------ Paper table ------------------------------ */

const paperState = { data: null, level: "average", group: "all", sort: "saPass", dir: -1 };

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

function renderPaper() {
  const { data, level, group, sort, dir } = paperState;
  let rows = data.rows.filter((r) => group === "all" || r.group === group);
  rows = rows
    .map((r) => ({ ...r, cur: r[level] }))
    .sort((a, b) => {
      const d = (a.cur[sort] - b.cur[sort]) * dir;
      if (d !== 0) return d;
      // stable tiebreak: saPass, then soft, then compile
      for (const m of ["saPass", "saPassSoft", "compile"]) {
        if (a.cur[m] !== b.cur[m]) return (b.cur[m] - a.cur[m]);
      }
      return 0;
    });

  const th = (key, label) =>
    `<th class="num sortable ${sort === key ? (dir < 0 ? "sort-desc" : "sort-asc") : ""}" data-sort="${key}">${label}</th>`;

  const medalsOn = dir < 0; // top-of-column highlight only when ranking high→low
  const rowsHtml = rows
    .map((r, i) => {
      const md = medalsOn ? medal(i) : "";
      const badge = GROUP_BADGE[r.group] || "";
      const bestTag = r.best ? ` <span class="badge good" title="Highest SA-PASS">best</span>` : "";
      return `<tr class="${medalsOn && i === 0 ? "top-row" : ""}">
        <td class="rank">${md ? `<span class="medal">${md}</span>` : i + 1}</td>
        <td><span class="method">${escapeHtml(r.method)}</span>${bestTag}</td>
        <td><span class="badge ${badge}">${escapeHtml(r.group)}</span></td>
        ${metricCell(r.cur.compile, sort === "compile")}
        ${metricCell(r.cur.saPassSoft, sort === "saPassSoft")}
        ${metricCell(r.cur.saPass, sort === "saPass")}
      </tr>`;
    })
    .join("");

  document.getElementById("paper-board").innerHTML = `
    <div class="tbl-wrap"><table class="board">
      <thead><tr>
        <th>#</th><th>Method</th><th>Group</th>
        ${th("compile", METRIC_LABELS.compile)}
        ${th("saPassSoft", METRIC_LABELS.saPassSoft)}
        ${th("saPass", METRIC_LABELS.saPass)}
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table></div>`;

  document.querySelectorAll("#paper-board th[data-sort]").forEach((el) => {
    el.addEventListener("click", () => {
      const key = el.dataset.sort;
      if (paperState.sort === key) paperState.dir *= -1;
      else { paperState.sort = key; paperState.dir = -1; }
      renderPaper();
    });
  });
}

function metricCell(v, strong) {
  const pct = fmtPct(v);
  const width = Math.max(0, Math.min(100, Number(v) || 0));
  return `<td class="num bar"><span class="track"><span style="width:${width}%"></span></span><span class="val ${strong ? "metric-strong" : ""}">${pct}</span></td>`;
}

function medal(i) {
  return ["🥇", "🥈", "🥉"][i] || "";
}

/* --------------------------- Community table ----------------------------- */

async function loadCommunity() {
  const host = document.getElementById("community-board");
  let community = { entries: [], generatedAt: null };
  try {
    const res = await fetch("./data/community.json", { cache: "no-cache" });
    if (res.ok) community = await res.json();
  } catch (e) {
    /* file may not exist yet before the first sync run */
  }

  // Merge in locally-tracked completed jobs (so a submitter sees their own
  // result immediately, before the periodic sync commits community.json).
  const byId = new Map((community.entries || []).map((e) => [e.id, e]));
  const tracked = loadTrackedJobs();
  for (const j of tracked) {
    if (TERMINAL_OK.has(String(j.status).toLowerCase()) && j.metrics && !byId.has(j.id)) {
      byId.set(j.id, {
        id: j.id, name: j.name, org: j.org,
        completedAt: j.completedAt || null, metrics: j.metrics, local: true,
      });
    }
  }
  const entries = [...byId.values()].filter((e) => e.metrics);

  // Runs still being evaluated: from the shared queue (any visitor) + this
  // browser's own in-flight jobs. Shown at the top with a waiting badge.
  const pending = await loadPending(new Set(byId.keys()), tracked);

  if (community.generatedAt) {
    document.getElementById("community-sub").textContent =
      `Models submitted through this site, dataset v1.2. Last synced ${new Date(community.generatedAt).toLocaleString()}.`;
  }

  if (entries.length === 0 && pending.length === 0) {
    host.innerHTML = `<div class="empty">No community submissions. <a href="./submit.html">Submit a model</a>.</div>`;
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
      const md = medal(i);
      return `<tr class="${i === 0 ? "top-row" : ""}">
        <td class="rank">${md ? `<span class="medal">${md}</span>` : i + 1}</td>
        <td><span class="method">${escapeHtml(e.name || e.id)}</span>${localTag}<div class="id">${escapeHtml(e.id)}</div></td>
        <td>${escapeHtml(e.org || "n/a")}</td>
        ${metricCell(m.compile, false)}
        ${metricCell(m.saPassSoft, false)}
        ${metricCell(m.saPass, true)}
        <td class="num metric-mut">${m.n ?? "n/a"}</td>
        <td class="num metric-mut">${date}</td>
        <td><a href="${RUN_ANALYSIS_URL(e.id)}" target="_blank" rel="noopener">analysis</a></td>
      </tr>`;
    })
    .join("");

  const pendingHtml = pending
    .map((p) => {
      const badge = p.status === "running"
        ? `<span class="badge run"><span class="spinner"></span> running</span>`
        : `<span class="badge warn"><span class="spinner"></span> ${escapeHtml(p.status || "queued")}</span>`;
      const youTag = p.local ? ` <span class="badge run" title="From your browser">you</span>` : "";
      return `<tr>
        <td class="rank">•</td>
        <td><span class="method">${escapeHtml(p.name || p.id)}</span>${youTag}<div class="id">${escapeHtml(p.id)}</div></td>
        <td>${escapeHtml(p.org || "n/a")} ${badge}</td>
        <td class="num metric-mut">n/a</td>
        <td class="num metric-mut">n/a</td>
        <td class="num metric-mut">n/a</td>
        <td class="num metric-mut">n/a</td>
        <td class="num metric-mut">n/a</td>
        <td><a href="${RUN_ANALYSIS_URL(p.id)}" target="_blank" rel="noopener">analysis</a></td>
      </tr>`;
    })
    .join("");

  host.innerHTML = `
    <div class="tbl-wrap"><table class="board">
      <thead><tr>
        <th>#</th><th>Model</th><th>Org</th>
        <th class="num">${METRIC_LABELS.compile}</th>
        <th class="num">${METRIC_LABELS.saPassSoft}</th>
        <th class="num">${METRIC_LABELS.saPass}</th>
        <th class="num">Tasks</th><th class="num">Date</th><th>Run</th>
      </tr></thead>
      <tbody>${pendingHtml}${rowsHtml}</tbody>
    </table></div>`;
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
    document.querySelectorAll("#level-seg button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
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
