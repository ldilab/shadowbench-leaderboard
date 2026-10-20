import { initTheme, escapeHtml } from "./ui.js";

initTheme();

/* ------------------------- Compile vs. SA-PASS map -------------------------
 * data/compile_confusion.json holds, per leaderboard row, how its 178 outputs
 * split between compile (standalone compile passed) and aligned (every
 * forward and backward checker passed, compile ignored):
 *   tp = both (this is SA-PASS)          fp = compiles, misaligned
 *   fn = aligned, does not compile       alignedTimeout = aligned, compile hit
 *   tn = neither                         the evaluator's time limit
 * It is built by scripts/build_compile_confusion_178.py in the paper repo
 * (the post-paper agentic rows from
 * leaderboard_categories/post_paper_agentic_per_task_178.csv); the counts
 * reproduce every row's published Compile rate and SA-PASS.
 * Display names, approach and weights come from data/paper_results.json.
 * ----------------------------------------------------------------------- */

const key = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const MAX = 100; // both axes share one scale, so the diagonal is y = x
const APPROACH_LABEL = { agentic: "Agentic", direct: "Direct", lean: "Lean-specialized" };
const WEIGHTS_LABEL = { closed: "Closed", open: "Open weights" };
const pct = (n, d) => (d ? (n / d) * 100 : 0);
const f1 = (v) => v.toFixed(1);

let rows = [];
let conf = null;
let selected = null;

async function load() {
  const [paper, c] = await Promise.all([
    fetch("./data/paper_results.json", { cache: "no-cache" }).then((r) => r.json()),
    fetch("./data/compile_confusion.json", { cache: "no-cache" }).then((r) => r.json()),
  ]);
  conf = c;
  const meta = new Map(paper.rows.map((r) => [key(r.method), r]));
  const expert = new Map(conf.expert.configs.map((e) => [key(e.method), e]));
  rows = conf.rows.map((r) => {
    const m = meta.get(key(r.method)) || {};
    return {
      ...r, key: key(r.method), method: m.method || r.method, model: m.model || r.method,
      sub: [m.scaffold, APPROACH_LABEL[m.approach], WEIGHTS_LABEL[m.weights]].filter(Boolean).join(" · "),
      approach: m.approach || "direct", post: !!m.postPaper,
      aligned: r.tp + r.fn + r.alignedTimeout, expert: expert.get(key(r.method)) || null,
    };
  });
  const fromUrl = new URLSearchParams(location.search).get("sys");
  selected = rows.find((r) => r.key === fromUrl) || rows.slice().sort((a, b) => b.tp - a.tp || b.compile - a.compile)[0];
  render();
}

function select(k) {
  selected = rows.find((r) => r.key === k) || selected;
  const q = new URLSearchParams(location.search);
  q.set("sys", selected.key);
  history.replaceState(null, "", `?${q}`);
  render();
}

function render() {
  renderKpis();
  renderPlot();
  renderDetail();
  renderStrips();
}

function renderKpis() {
  const t = conf.totals, e = conf.expert, n = conf.problems;
  // Post-paper direct-prompting runs only; the post-paper agentic runs are a different setting.
  const postRows = rows.filter((r) => r.post && r.approach === "direct");
  const post = postRows.reduce((a, r) => ({ tp: a.tp + r.tp, fn: a.fn + r.fn, to: a.to + r.alignedTimeout }), { tp: 0, fn: 0, to: 0 });
  document.getElementById("scope").textContent = `${t.systems} systems × ${n} problems = ${t.outputs.toLocaleString("en-US")} outputs`;
  const cards = [
    { k: "Compiled but misaligned", v: `${Math.round(pct(t.fp, t.compile))}%`, d: `${t.fp} of the ${t.compile} outputs that compile fail at least one checker: false positives of compile rate.` },
    { k: "Expert check (6 agentic systems)", v: `${f1(e.precision * 100)}%`, d: `of the ${e.reviewed} compile-passed outputs two mathematicians reviewed were aligned (the paper's expert study).` },
    { k: "Aligned but not compiling", v: String(t.fn), d: `outputs pass every checker yet fail the standalone compile, mostly a sorry or a broken proof: false negatives${t.alignedTimeout ? `, plus ${t.alignedTimeout} compile time-outs` : ""}.` },
    { k: "Run after the paper", v: `FN ${post.fn} · TP ${post.tp}`, d: `Across the ${postRows.length} direct-prompting runs added after the paper, compile rejected ${post.fn} statements that pass every checker${post.to ? ` (plus ${post.to} compile time-outs)` : ""} and accepted only ${post.tp} that do.` },
  ];
  document.getElementById("kpis").innerHTML = cards.map((c) => `
    <div class="card kpi"><div class="kpi-k">${escapeHtml(c.k)}</div><div class="kpi-v">${escapeHtml(c.v)}</div><div class="kpi-d">${escapeHtml(c.d)}</div></div>`).join("");
}

function renderPlot() {
  const host = document.getElementById("plot");
  const n = conf.problems;
  const ticks = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const shownRows = rows.filter((r) => r.compile > 0 || r.aligned > 0);
  const atOrigin = rows.length - shownRows.length;
  // Label the selected system and the most striking false-positive case.
  const worst = rows.filter((r) => r.tp === 0).sort((a, b) => b.fp - a.fp)[0];
  const labelled = new Set([selected.key, worst?.key]);
  const pos = (r) => ({ x: Math.min(100, (pct(r.compile, n) / MAX) * 100), y: Math.min(100, (pct(r.aligned, n) / MAX) * 100) });

  const points = shownRows.map((r) => {
    const { x, y } = pos(r);
    const label = `${r.method}: compile ${f1(pct(r.compile, n))}%, aligned ${f1(pct(r.aligned, n))}%, ${r.fp} false positives, ${r.fn} false negatives`;
    const cls = ["pt", r.approach, r.post ? "post" : "", r.key === selected.key ? "sel" : ""].filter(Boolean).join(" ");
    return `<button type="button" class="${cls}" style="left:${x}%;bottom:${y}%" data-key="${r.key}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" aria-pressed="${r.key === selected.key}"><i></i></button>`;
  }).join("");
  const labels = shownRows.filter((r) => labelled.has(r.key)).map((r) => {
    const { x, y } = pos(r);
    const side = x > 55 ? `right:calc(${100 - x}% + 14px)` : `left:calc(${x}% + 14px)`;
    return `<span class="pt-label${r.key === selected.key ? " sel" : ""}" style="${side};bottom:calc(${y}% + 6px)">${escapeHtml(r.model)}${r.sub.startsWith("Claude Code") || r.sub.startsWith("Codex") ? ` · ${escapeHtml(r.sub.split(" · ")[0])}` : ""}</span>`;
  }).join("");

  host.innerHTML = `
    <div class="plot-area">
      <svg class="plot-bg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <polygon points="0,100 100,100 100,0" class="region-fp"></polygon>
        <polygon points="0,100 0,0 100,0" class="region-fn"></polygon>
        ${ticks.map((t) => `<line x1="${(t / MAX) * 100}" y1="0" x2="${(t / MAX) * 100}" y2="100" class="grid"></line><line x1="0" y1="${100 - (t / MAX) * 100}" x2="100" y2="${100 - (t / MAX) * 100}" class="grid"></line>`).join("")}
        <line x1="0" y1="100" x2="100" y2="0" class="diag"></line>
      </svg>
      <span class="region-label fn-label">Aligned, but does not compile<br><b>false negatives</b></span>
      <span class="region-label fp-label">Compiles, but misaligned<br><b>false positives</b></span>
      <span class="diag-label">compile = aligned</span>
      ${atOrigin ? `<span class="origin-note">${atOrigin} systems at 0, 0</span>` : ""}
      ${points}${labels}
      ${ticks.map((t) => `<span class="tick x${t === MAX ? " end" : ""}" style="left:${(t / MAX) * 100}%">${t}</span><span class="tick y" style="bottom:${(t / MAX) * 100}%">${t}</span>`).join("")}
      <span class="axis-title x">Compile rate (%)</span>
      <span class="axis-title y">Passes every checker (%)</span>
    </div>`;
  host.querySelectorAll(".pt").forEach((b) => b.addEventListener("click", () => select(b.dataset.key)));
}

function renderDetail() {
  const r = selected, n = conf.problems;
  const causes = r.fn
    ? (r.fnUnknown ? `The cause of each standalone failure is not recorded for agentic runs.` :
      `Why the standalone compile failed: ${[r.fnSorry && `${r.fnSorry} left a sorry`, r.fnError && `${r.fnError} had another Lean error`].filter(Boolean).join(", ")}.`)
    : "";
  const exp = r.expert ? `<p class="detail-note">Experts reviewed its ${r.expert.reviewed} compile-passed outputs and judged ${r.expert.aligned} aligned${r.expert.aligned > r.tp ? `; the checkers miss ${r.expert.aligned - r.tp} of them, whose auxiliary declarations are named differently from the reference` : ""}.</p>` : "";
  document.getElementById("detail").innerHTML = `
    <div class="detail-head">
      <div class="name-line"><span class="detail-name">${escapeHtml(r.model)}</span>${r.post ? `<span class="new-pill"><span aria-hidden="true">✦</span> NEW</span>` : ""}</div>
      <div class="name-sub">${escapeHtml(r.sub)}</div>
    </div>
    <div class="confusion" role="table" aria-label="Outputs of ${escapeHtml(r.method)} by compile and checker result">
      <div role="row" class="c-row"><span role="columnheader"></span><span role="columnheader" class="ch">Passes every checker</span><span role="columnheader" class="ch">Fails a checker</span></div>
      <div role="row" class="c-row"><span role="rowheader" class="rh">Compiles</span><span role="cell" class="cell tp"><b>${r.tp}</b>SA-PASS</span><span role="cell" class="cell fp"><b>${r.fp}</b>false positive</span></div>
      <div role="row" class="c-row"><span role="rowheader" class="rh">Does not compile</span><span role="cell" class="cell fn"><b>${r.fn}</b>false negative${r.alignedTimeout ? ` (+${r.alignedTimeout} timed out)` : ""}</span><span role="cell" class="cell tn"><b>${r.tn}</b>neither</span></div>
    </div>
    <p class="detail-note">Compile rate <b>${f1(pct(r.compile, n))}%</b> vs. SA-PASS <b>${f1(pct(r.tp, n))}%</b>.${r.compile ? ` Of its ${r.compile} compiled outputs, ${r.fp} (${Math.round(pct(r.fp, r.compile))}%) fail a checker.` : ""} ${causes}</p>
    ${exp}`;
}

function renderStrips() {
  const n = conf.problems;
  const list = rows.filter((r) => r.compile > 0 || r.aligned > 0).sort((a, b) => b.compile - a.compile || b.aligned - a.aligned);
  const seg = (cls, count) => (count ? `<span class="seg-${cls}" style="width:${pct(count, n)}%"></span>` : "");
  document.getElementById("strips").innerHTML = list.map((r) => `
    <button type="button" class="strip-row${r.key === selected.key ? " sel" : ""}" data-key="${r.key}" aria-pressed="${r.key === selected.key}"
      aria-label="${escapeHtml(`${r.method}: ${r.tp} SA-PASS, ${r.fp} false positives, ${r.fn} false negatives, ${r.alignedTimeout} timed out, ${r.tn} neither`)}">
      <span class="strip-name"><span class="method">${escapeHtml(r.model)}</span>${r.post ? `<span class="new-pill"><span aria-hidden="true">✦</span> NEW</span>` : ""}<span class="name-sub">${escapeHtml(r.sub.split(" · ")[0])}</span></span>
      <span class="strip-bar" aria-hidden="true">${seg("tp", r.tp)}${seg("fp", r.fp)}${seg("fn", r.fn)}${seg("to", r.alignedTimeout)}${seg("tn", r.tn)}</span>
      <span class="strip-stats"><span class="fp-t">FP ${r.fp}</span><span class="fn-t">FN ${r.fn}</span></span>
    </button>`).join("");
  document.querySelectorAll(".strip-row").forEach((b) => b.addEventListener("click", () => select(b.dataset.key)));
}

load().catch((e) => {
  document.getElementById("kpis").innerHTML = `<div class="empty">Could not load the data: ${escapeHtml(e.message)}</div>`;
});
