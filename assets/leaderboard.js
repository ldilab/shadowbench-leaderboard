import { API_BASE, ID_PREFIX, METRIC_LABELS, TEST_TASK_IDS } from "./config.js";
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

/* --------------------------- One unified board ---------------------------
 * One ranked table + top-10 chart, mixing the paper's reported methods with
 * live community submissions (badged "community", never color-only -- see
 * table/chart rendering below). The filter box between chart and table holds
 * four controls, kept in the URL query (?level=L2&show=open&zeros=1):
 *   - Level (Average/L1/L2/L3) and Area: which problems the three metric
 *     columns are computed over. An area's score is itself an all-levels
 *     aggregate (there is no per-level-per-area number), so picking an area
 *     resets Level to Average and picking a level resets Area to all.
 *     Community rows only have an overall and per-area score, so they drop
 *     out of the L1/L2/L3 views.
 *   - Show: agentic / non-agentic (data/paper_results.json `approach`),
 *     open / closed (`weights`), rows run after the paper (`postPaper`), or
 *     community submissions (which declare neither axis).
 *   - Include 0.0: rows at 0.0 SA-PASS in the current view are hidden by
 *     default (unless nothing in view scores above 0.0).
 * Columns are always Compile rate, SA-PASS (Soft), SA-PASS, in that order.
 * --------------------------------------------------------------------- */

// Derived from the fixed 178-task set (not a static list) so it can never
// list a category the live benchmark doesn't actually have, or miss one.
const CATEGORIES = [...new Set(TEST_TASK_IDS.map((id) => id.split("/")[0]))].sort();

const SHOWS = ["all", "agentic", "nonagentic", "open", "closed", "new", "community"];
const LEVELS = ["average", "L1", "L2", "L3"];
const DEFAULTS = { level: "average", category: "all", show: "all", zeros: false };
const boardState = { ...DEFAULTS };

function readUrlState() {
  const q = new URLSearchParams(location.search);
  if (LEVELS.includes(q.get("level"))) boardState.level = q.get("level");
  if (CATEGORIES.includes(q.get("area"))) { boardState.category = q.get("area"); boardState.level = "average"; }
  if (SHOWS.includes(q.get("show"))) boardState.show = q.get("show");
  boardState.zeros = q.get("zeros") === "1";
}

function writeUrlState() {
  const q = new URLSearchParams();
  if (boardState.level !== DEFAULTS.level) q.set("level", boardState.level);
  if (boardState.category !== DEFAULTS.category) q.set("area", boardState.category);
  if (boardState.show !== DEFAULTS.show) q.set("show", boardState.show);
  if (boardState.zeros) q.set("zeros", "1");
  const qs = q.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

function showsPaperRow(r) {
  switch (boardState.show) {
    case "agentic": return r.approach === "agentic";
    case "nonagentic": return r.approach === "direct" || r.approach === "lean";
    case "open": case "closed": return r.weights === boardState.show;
    case "new": return !!r.postPaper;
    case "community": return false;
    default: return true;
  }
}
let paperData = null;
const communityState = { entries: [], pending: [], tracked: [], generatedAt: null, datasetVersion: null };

async function loadPaper() {
  try {
    const res = await fetch("./data/paper_results.json", { cache: "no-cache" });
    paperData = await res.json();
  } catch (e) {
    document.getElementById("paper-board").innerHTML = `<div class="empty">Could not load paper results: ${escapeHtml(e.message)}</div>`;
    return;
  }
  const src = paperData.source;
  document.getElementById("paper-sub").innerHTML =
    `<a href="${src.arxivUrl}" target="_blank" rel="noopener">arXiv:${src.arxiv}${src.version}</a>, ${escapeHtml(src.table)}. ` +
    `${src.benchmark.problems} problems (L1 ${src.benchmark.levels.L1}, L2 ${src.benchmark.levels.L2}, L3 ${src.benchmark.levels.L3}).` +
    (paperData.rows.some((r) => r.postPaper)
      ? ` Highlighted rows tagged <span class="new-pill"><span aria-hidden="true">✦</span> NEW</span> were run after the paper (hover the tag for details).`
      : "");
  renderBoard();
}

async function loadCommunity() {
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
  communityState.entries = [...byId.values()].filter((e) => e.metrics);
  communityState.tracked = tracked;
  // Runs still being evaluated: from the shared queue (any visitor) + this
  // browser's own in-flight jobs. Shown at the top with a waiting badge,
  // unranked, regardless of the current filters.
  communityState.pending = await loadPending(new Set(byId.keys()), tracked);
  communityState.generatedAt = community.generatedAt;
  communityState.datasetVersion = community.datasetVersion;
  renderBoard();
}

// Build the unified row set for the current filters. `m` is the metrics
// object to actually display/sort by -- null means "no data for this view"
// (rendered as n/a, sorted last), not "zero".
function computeRows() {
  const { level, category, show } = boardState;

  const paperRows = (paperData?.rows || [])
    .filter(showsPaperRow)
    .map((r) => {
      const categories = r.categories || [];
      const m = category !== "all"
        ? categories.find((c) => c.category === category) || null
        : r[level];
      // postPaper rows: same metrics and 178-task set, but run after the
      // paper's Table 3 (dated, badged, and explained in a tooltip).
      const post = r.postPaper || null;
      const completedAt = post ? `${post.date}T12:00:00Z` : null; // noon UTC: same calendar date in any timezone
      return { method: r.method, group: r.group, org: null, id: null, completedAt, local: false, source: "paper", post, categories, m };
    });

  const includeCommunity = category !== "all" || level === "average";
  const communityRows = includeCommunity
    ? communityState.entries
        .filter(() => show === "all" || show === "community")
        .map((e) => {
          const categories = e.categories || [];
          const m = category !== "all" ? (categories.find((c) => c.category === category) || null) : e.metrics;
          return {
            method: e.name || e.id, group: "Community", org: e.org, id: e.id,
            completedAt: e.completedAt, local: e.local, source: "community", categories, m,
          };
        })
    : [];

  return paperRows.concat(communityRows);
}

function sortRows(rows) {
  return rows.slice().sort((a, b) => {
    if (!a.m && !b.m) return 0;
    if (!a.m) return 1;
    if (!b.m) return -1;
    return (b.m.saPass - a.m.saPass) || (b.m.saPassSoft - a.m.saPassSoft) || (b.m.compile - a.m.compile);
  });
}

const isZero = (r) => !r.m || Math.round(r.m.saPass * 10) / 10 <= 0;

function renderBoard() {
  if (!paperData) return;
  const all = sortRows(computeRows());
  const rows = boardState.zeros || !all.some((r) => !isZero(r)) ? all : all.filter((r) => !isZero(r));
  renderControls(rows.length, all.length);
  renderChart(rows);
  renderTable(rows, all.length - rows.length);
}

const CHART_TOP_N = 10;

// One series (magnitude, not identity) -> one flat hue, bar length is the
// primary encoding, value direct-labeled at the tip. Bars scale to the best
// score in view (not to 100%), so the ranking is legible even though SA-PASS
// values themselves are small percentages. Community rows get a small dot
// marker (never the bar's own color -- see renderTable's "community" badge
// for why) since they compete in the same ranking as paper-reported ones.
function renderChart(sortedRows) {
  const host = document.getElementById("paper-chart");
  const top = sortedRows.filter((r) => r.m).slice(0, CHART_TOP_N);
  if (top.length === 0) {
    host.innerHTML = "";
    return;
  }
  const maxVal = Math.max(top[0].m.saPass, 0.0001);
  const rowsHtml = top
    .map((r, i) => {
      const pct = fmtPct(r.m.saPass);
      const widthPct = Math.max((r.m.saPass / maxVal) * 100, 1.5);
      const isCommunity = r.source === "community";
      const communityMark = isCommunity ? `<span class="chart-community-dot" aria-hidden="true"></span>` : "";
      const postMark = r.post ? `<span class="new-pill"><span aria-hidden="true">✦</span> NEW</span>` : "";
      return `<div class="chart-row" title="${escapeHtml(r.method)}: ${pct} SA-PASS${isCommunity ? " (community submission)" : ""}${r.post ? " (run after the paper)" : ""}">
        <div class="chart-rank">${i + 1}</div>
        <div class="chart-label">${communityMark}${escapeHtml(r.method)}${postMark}</div>
        <div class="chart-bar-track"><div class="chart-bar${r.post ? " post" : ""}" style="width:${widthPct}%"></div></div>
        <div class="chart-value">${pct}</div>
      </div>`;
    })
    .join("");
  host.innerHTML = `
    <div class="chart-wrap" role="img" aria-label="Top ${top.length} by SA-PASS, ${top.map((r) => `${r.method} ${fmtPct(r.m.saPass)}`).join(", ")}">
      <div class="chart-title">Top ${top.length} by ${METRIC_LABELS.saPass}</div>
      ${rowsHtml}
    </div>`;
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

function rowHtml(row, rank, idx) {
  const { method, group, id, m, categories, source, completedAt, local, post } = row;
  const isCommunity = source === "community";
  const localTag = local ? ` <span class="badge run" title="From this browser, not in the shared sync">you</span>` : "";
  const communityTag = isCommunity
    ? ` <span class="badge run" title="Self-reported community submission, not from the paper">community</span>`
    : "";
  const postTag = post
    ? `<span class="new-pill" title="${escapeHtml(post.note || "")}"><span aria-hidden="true">✦</span> NEW</span>`
    : "";
  const idSpan = id ? `<span class="id">${escapeHtml(id)}</span>` : "";
  const date = completedAt ? new Date(completedAt).toLocaleDateString() : "n/a";
  const hasCategories = Array.isArray(categories) && categories.length > 0;
  const detailId = `categories-${idx}`;
  const controlsIds = hasCategories ? categories.map((_, k) => `${detailId}-${k}`).join(" ") : "";
  const expander = hasCategories
    ? `<button type="button" class="expand-btn" data-category-toggle="${detailId}" aria-expanded="false" aria-controls="${controlsIds}" title="Show category performance"><span aria-hidden="true">&#9656;</span></button>`
    : "";
  const delBtn = isCommunity
    ? `<button type="button" class="del-btn" data-del-id="${escapeHtml(id)}" title="Delete this submission">&times;</button>`
    : "";
  return `<tr${post ? ' class="post-row"' : ""}>
    <td class="rank">${rank}</td>
    <td><div class="submission-name">${expander}<span><span class="method">${escapeHtml(method)}</span>${postTag}${localTag}${communityTag}${idSpan}</span>${delBtn}</div></td>
    <td class="group">${escapeHtml(group)}</td>
    ${metricCell(m?.compile, false)}
    ${metricCell(m?.saPassSoft, false)}
    ${metricCell(m?.saPass, true)}
    <td class="num metric-mut">${m ? (m.n ?? "n/a") : "n/a"}</td>
    <td class="num metric-mut">${date}</td>
  </tr>${categoryRowsHtml(categories, detailId)}`;
}

function pendingRowHtml(p) {
  const badge = p.status === "running"
    ? `<span class="badge run"><span class="spinner"></span> running</span>`
    : `<span class="badge warn"><span class="spinner"></span> ${escapeHtml(p.status || "queued")}</span>`;
  const youTag = p.local ? ` <span class="badge run" title="From your browser">you</span>` : "";
  const delBtn = `<button type="button" class="del-btn" data-del-id="${escapeHtml(p.id)}" title="Delete this submission">&times;</button>`;
  return `<tr>
    <td class="rank">•</td>
    <td><div class="submission-name"><span><span class="method">${escapeHtml(p.name || p.id)}</span>${youTag} ${badge}<span class="id">${escapeHtml(p.id)}</span></span>${delBtn}</div></td>
    <td class="group">Community</td>
    <td class="num metric-mut">n/a</td>
    <td class="num metric-mut">n/a</td>
    <td class="num metric-mut">n/a</td>
    <td class="num metric-mut">n/a</td>
    <td class="num metric-mut">n/a</td>
  </tr>`;
}

function renderTable(rows, hiddenZeros) {
  const host = document.getElementById("paper-board");
  const { pending, tracked } = communityState;

  if (rows.length === 0 && pending.length === 0) {
    const { show, category, level } = boardState;
    host.innerHTML = `<div class="empty">${
      show === "community" && category === "all" && level !== "average"
        ? "Community submissions only have an overall score -- switch to Average (or pick an Area) to see them."
        : show === "community" ? "No community submissions yet." : "No results for these filters."
    }</div>`;
    return;
  }

  const pendingHtml = pending.map(pendingRowHtml).join("");
  const rowsHtml = rows.map((r, i) => rowHtml(r, i + 1, i)).join("");

  host.innerHTML = `
    <div class="tbl-wrap" role="region" aria-label="Leaderboard, ranked by SA-PASS" tabindex="0"><table class="board">
      <thead><tr>
        <th>#</th><th>Submission</th><th>Group</th>
        <th class="num">${METRIC_LABELS.compile}</th>
        <th class="num">${METRIC_LABELS.saPassSoft}</th>
        <th class="num">${METRIC_LABELS.saPass}</th>
        <th class="num">Tasks</th><th class="num">Date</th>
      </tr></thead>
      <tbody>${pendingHtml}${rowsHtml}</tbody>
    </table></div>${hiddenZeros > 0 ? `<p class="table-note">${hiddenZeros} more ${hiddenZeros === 1 ? "system scores" : "systems score"} 0.0 SA-PASS here (tick “Include 0.0” to show).</p>` : ""}`;

  host.querySelectorAll("[data-category-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const groupRows = host.querySelectorAll(`[data-group="${button.dataset.categoryToggle}"]`);
      const expanded = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!expanded));
      button.title = expanded ? "Show category performance" : "Hide category performance";
      groupRows.forEach((row) => { row.hidden = expanded; });
    });
  });

  // Any submission can be deleted from any browser given its password -- see
  // assets/delete-submission.js -- so this button is on every community row,
  // not just ones tracked locally. Paper rows never get one.
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

const areaSel = document.getElementById("f-area");
const showSel = document.getElementById("f-show");
const zerosBox = document.getElementById("f-zeros");
const resetBtn = document.getElementById("reset-filters");

areaSel.insertAdjacentHTML(
  "beforeend",
  CATEGORIES.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("")
);

function renderControls(nShown, nAll) {
  document.querySelectorAll("#level-seg button").forEach((b) => {
    const on = b.dataset.level === boardState.level;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  areaSel.value = boardState.category;
  showSel.value = boardState.show;
  zerosBox.checked = boardState.zeros;
  document.getElementById("result-count").textContent = nShown === nAll ? `${nShown} systems` : `${nShown} of ${nAll} systems`;
  resetBtn.hidden = Object.keys(DEFAULTS).every((k) => boardState[k] === DEFAULTS[k]);
}

function update(changes) {
  Object.assign(boardState, changes);
  writeUrlState();
  renderBoard();
}

document.querySelectorAll("#level-seg button").forEach((b) => {
  b.addEventListener("click", () => update(b.dataset.level === "average" ? { level: "average" } : { level: b.dataset.level, category: "all" }));
});
areaSel.addEventListener("change", () => update(areaSel.value === "all" ? { category: "all" } : { category: areaSel.value, level: "average" }));
showSel.addEventListener("change", () => update({ show: showSel.value }));
zerosBox.addEventListener("change", () => update({ zeros: zerosBox.checked }));
resetBtn.addEventListener("click", () => update({ ...DEFAULTS }));

readUrlState();
loadPaper();
loadCommunity();

export { computeMetrics }; // re-exported for console debugging convenience
