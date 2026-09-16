// Shared configuration for the ShadowBench leaderboard site.
// ES module — imported by the browser pages and by worker/index.mjs.

export const API_BASE = "https://apilift.lim247.com";

// The site is served as a static GitHub Pages project (no server of its own),
// so anything dynamic -- accepting a submission's tracking email, and the
// "publish to the public leaderboard" confirmation link -- goes to this
// small Cloudflare Worker instead. It never serves the site itself.
export const WORKER_BASE = "https://shadowbench.johnjongyoonkim.workers.dev";

// Every job this leaderboard submits is prefixed so it can be distinguished
// from other traffic on the shared lift backend. The sync job only surfaces
// runs whose id starts with this prefix.
export const ID_PREFIX = "leaderboard-";

// Client-side anti-abuse gate. NOTE: this is a courtesy limit only; it lives in
// the visitor's browser (localStorage) and enforces nothing on the server. Real
// per-IP limiting must happen in the backend or a proxy. See README.
export const RATE_LIMIT_MS = 10 * 60 * 1000; // 10 minutes

export const RUN_ANALYSIS_URL = (id) =>
  `https://lift.lim247.com/run-analysis.html?id=${encodeURIComponent(id)}`;

// Every community submission runs the fixed 178-problem ShadowBench set.
export const PROBLEM_COUNT = 178;

// Benchmark surface, from GET /api/benchmark_manifest.json (datasetVersion v1.2).
export const AREAS = [
  "algebra",
  "analysis",
  "topology",
  "geometry",
  "number-theory",
  "combinatorics",
  "probability",
  "algebraic-geometry",
  "college-math-competition",
  "misc",
];

// Difficulty levels used by ShadowBench (L1 to L3 are the paper snapshot, L4 exists in v1.2).
export const LEVELS = ["L1", "L2", "L3", "L4"];

// Fixed scope for every community submission. The whole ShadowBench set runs each
// time, with no per-submission area or level choice. Areas cover all of AREAS and
// levels cover L1 to L3, which together is the 178-problem set (see PROBLEM_COUNT).
export const SUBMISSION_AREAS = AREAS;
export const SUBMISSION_LEVELS = ["L1", "L2", "L3"];

// Sampling/prompt defaults mirror the reference submissions on the backend so a
// community run is configured the same way the paper's LLM runs were.
export const EVAL_DEFAULTS = {
  seed: 1337,
  sampling: "first",
  two_phase_evaluation: false,
  hidden_checker_only: false,
  // Matches what real ShadowBench-area submissions on this backend used (241/241),
  // so community runs are comparable with the existing ones.
  lean_version: "v4.27.0-rc1",
  prompt_components: {
    informal_statement: true,
    informal_proof: true,
    formalization_rules: true,
    imports: true,
    aux_theorems: true,
    formal_statement: true,
    dpp: false,
  },
};

// Runtime fixed by the hosted evaluator. Generated-code submissions provide a
// fixed reader command in code-submission.js and never call a model endpoint.
export const ADAPTER = {
  runtime: {
    docker_image: "lift/lean-eval:lean4.26.0-data",
    eval_project_dir: "/data2/autoformal/lean-eval-proj",
    docker_network: "none",
    model_timeout_sec: 600,
    compile_timeout_sec: 180,
  },
};

// Metric labels shown across the UI.
export const METRIC_LABELS = {
  saPass: "SA-pass",
  saPassSoft: "SA-pass (Soft)",
  compile: "Compile rate",
};
