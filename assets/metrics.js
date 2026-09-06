// SA-PASS metric computation — the single source of truth for the leaderboard.
//
// Definitions follow ShadowBench (arXiv:2608.29270, Table 3 + Def. 5/6):
//   compile_i  = the generated statement compiles standalone in Lean.
//   SA-PASS_i  = compile_i AND every forward checker passes AND every backward
//                checker passes.  (binary, per Def. 5)
//   SA-PASS_soft_i = compile_i ? mean(forward_pass_fraction, backward_pass_fraction) : 0
//                (partial credit, per Def. 6)
//
// We recompute these from the per-task analysis payload rather than trusting the
// API summary's `overall`/`hiddenCheckerScore`: those fields are NOT compile-gated
// (a run can report overall=75% with compileRate=0%), so they overstate semantic
// alignment. The leaderboard must reflect the paper's compile-gated definition.

export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Per-task scores. `fwd`/`bwd` are pass fractions in [0,1]. A missing backward
// checker is treated as 0 (not passed): SA-PASS requires it, so absence fails.
export function taskScores(t) {
  // Prefer the explicit boolean; fall back to the numeric standalone score the
  // analysis view uses when the boolean is absent.
  let compile;
  if (typeof t.standalone_compile_ok === "boolean") {
    compile = t.standalone_compile_ok;
  } else {
    const sc = num(t.standalone_compile_score ?? t.phase1_score);
    compile = sc != null ? sc >= 1 : false;
  }
  const fwd = num(t.hidden_checker_score);
  const bwd = num(t.backward_hidden_checker_score);
  const fwdV = fwd == null ? 0 : fwd;
  const bwdV = bwd == null ? 0 : bwd;

  const saPass = compile && fwdV >= 1 && bwdV >= 1 ? 1 : 0;
  const saPassSoft = compile ? (fwdV + bwdV) / 2 : 0;
  return { compile: compile ? 1 : 0, saPass, saPassSoft };
}

// Aggregate over an analysis payload => percentages in [0,100].
// Denominator is the number of tasks in the run (matches summary.total_tasks).
export function computeMetrics(analysis) {
  const tasks = (analysis && analysis.tasks) || [];
  const n = tasks.length;
  if (n === 0) {
    return { n: 0, compile: null, saPass: null, saPassSoft: null };
  }
  let c = 0,
    sa = 0,
    soft = 0;
  for (const t of tasks) {
    const s = taskScores(t);
    c += s.compile;
    sa += s.saPass;
    soft += s.saPassSoft;
  }
  return {
    n,
    compile: (c / n) * 100,
    saPass: (sa / n) * 100,
    saPassSoft: (soft / n) * 100,
  };
}
