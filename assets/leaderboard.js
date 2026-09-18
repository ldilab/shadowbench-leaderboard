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
 * table/chart rendering below). Level, Category, and Group are independent
 * filters over the same row set:
 *   - Level (Average/L1/L2/L3): paper rows have all four; community rows
 *     only ever have one overall score (every run covers the same fixed
 *     178-task set, no per-level split), so they drop out unless a Category
 *     is also selected or Level is "Average".
 *   - Category: a category's score is itself an all-levels aggregate (same
 *     as the paper's/community's per-category numbers always were), so
 *     picking one overrides the Level pick for scoring purposes rather than
 *     compounding with it -- there's no per-level-per-category number to
 *     show. Paper rows don't have category data yet (pending real numbers);
 *     the per-row expand arrow and this filter already work for any row
 *     that has a non-empty `categories` array, paper included, once
 *     data/paper_results.json rows carry one.
 *   - Group: same dropdown as always, "Community" included as one more
 *     value rather than a special case.
 * --------------------------------------------------------------------- */

// Derived from the fixed 178-task set (not a static list) so it can never
// list a category the live benchmark doesn't actually have, or miss one.
const CATEGORIES = [...new Set(TEST_TASK_IDS.map((id) => id.split("/")[0]))].sort();

const boardState = { level: "average", category: "all", group: "all" };
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
    `${src.benchmark.problems} problems (L1 ${src.benchmark.levels.L1}, L2 ${src.benchmark.levels.L2}, L3 ${src.benchmark.levels.L3}).`;
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
  const { level, category, group } = boardState;

  const paperRows = (paperData?.rows || [])
    .filter((r) => group === "all" || r.group === group)
    .map((r) => {
      const categories = r.categories || [];
      const m = category !== "all"
        ? categories.find((c) => c.category === category) || null
        : r[level];
      return { method: r.method, group: r.group, org: null, id: null, completedAt: null, local: false, source: "paper", categories, m };
    });

  const includeCommunity = category !== "all" || level === "average";
  const communityRows = includeCommunity
    ? communityState.entries
        .filter((e) => group === "all" || group === "Community")
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

function renderBoard() {
  if (!paperData) return;
  const rows = sortRows(computeRows());
  renderChart(rows);
  renderTable(rows);
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
      return `<div class="chart-row" title="${escapeHtml(r.method)}: ${pct} SA-PASS${isCommunity ? " (community submission)" : ""}">
        <div class="chart-rank">${i + 1}</div>
        <div class="chart-label">${communityMark}${escapeHtml(r.method)}</div>
        <div class="chart-bar-track"><div class="chart-bar" style="width:${widthPct}%"></div></div>
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
  const { method, group, org, id, m, categories, source, completedAt, local } = row;
  const isCommunity = source === "community";
  const localTag = local ? ` <span class="badge run" title="From this browser, not in the shared sync">you</span>` : "";
  const communityTag = isCommunity
    ? ` <span class="badge run" title="Self-reported community submission, not from the paper">community</span>`
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
  return `<tr>
    <td class="rank">${rank}</td>
    <td><div class="submission-name">${expander}<span><span class="method">${escapeHtml(method)}</span>${localTag}${communityTag}${idSpan}</span>${delBtn}</div></td>
    <td>${escapeHtml(org || "n/a")}</td>
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
    <td><div class="submission-name"><span><span class="method">${escapeHtml(p.name || p.id)}</span>${youTag}<span class="id">${escapeHtml(p.id)}</span></span>${delBtn}</div></td>
    <td>${escapeHtml(p.org || "n/a")} ${badge}</td>
    <td class="group">Community</td>
    <td class="num metric-mut">n/a</td>
    <td class="num metric-mut">n/a</td>
    <td class="num metric-mut">n/a</td>
    <td class="num metric-mut">n/a</td>
    <td class="num metric-mut">n/a</td>
  </tr>`;
}

function renderTable(rows) {
  const host = document.getElementById("paper-board");
  const { pending, tracked } = communityState;

  if (rows.length === 0 && pending.length === 0) {
    const { group, category, level } = boardState;
    host.innerHTML = `<div class="empty">${
      group === "Community" && category === "all" && level !== "average"
        ? "Community submissions only have an overall score -- switch to Average (or pick a Category) to see them."
        : "No results for this filter."
    }</div>`;
    return;
  }

  const pendingHtml = pending.map(pendingRowHtml).join("");
  const rowsHtml = rows.map((r, i) => rowHtml(r, i + 1, i)).join("");

  host.innerHTML = `
    <div class="tbl-wrap" role="region" aria-label="Leaderboard, ranked by SA-PASS" tabindex="0"><table class="board">
      <thead><tr>
        <th>#</th><th>Submission</th><th>Org</th><th>Group</th>
        <th class="num">${METRIC_LABELS.compile}</th>
        <th class="num">${METRIC_LABELS.saPassSoft}</th>
        <th class="num">${METRIC_LABELS.saPass}</th>
        <th class="num">Tasks</th><th class="num">Date</th>
      </tr></thead>
      <tbody>${pendingHtml}${rowsHtml}</tbody>
    </table></div>`;

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

document.querySelectorAll("#level-seg button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll("#level-seg button").forEach((x) => {
      x.classList.remove("active");
      x.setAttribute("aria-pressed", "false");
    });
    b.classList.add("active");
    b.setAttribute("aria-pressed", "true");
    boardState.level = b.dataset.level;
    renderBoard();
  });
});

const categorySeg = document.getElementById("category-seg");
if (categorySeg) {
  // Up to 9 options (Overall + 8 areas) -- too many for a dropdown to beat a
  // glance-and-click row, and unlike a Level x Category grid, this doesn't
  // imply cells that don't exist (a category's score is already an
  // all-levels aggregate, independent of the Level buttons -- see
  // computeRows()).
  categorySeg.insertAdjacentHTML(
    "beforeend",
    CATEGORIES.map((c) => `<button type="button" data-category="${escapeHtml(c)}" aria-pressed="false">${escapeHtml(c)}</button>`).join("")
  );
  categorySeg.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      categorySeg.querySelectorAll("button").forEach((x) => {
        x.classList.remove("active");
        x.setAttribute("aria-pressed", "false");
      });
      b.classList.add("active");
      b.setAttribute("aria-pressed", "true");
      boardState.category = b.dataset.category;
      renderBoard();
    });
  });
}

document.getElementById("group-filter").addEventListener("change", (e) => {
  boardState.group = e.target.value;
  renderBoard();
});

loadPaper();
loadCommunity();

export { computeMetrics }; // re-exported for console debugging convenience
