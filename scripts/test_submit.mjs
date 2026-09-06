// End-to-end test of a community submission using an OpenAI-compatible endpoint
// (e.g. OpenRouter). It submits a small, cheap run, polls until it finishes, and
// prints the three metrics. This is the only place a key is used, and it is read
// from the environment, never written to the repo.
//
// Usage:
//   OPENROUTER_API_KEY=sk-or-... node scripts/test_submit.mjs
//
// Optional environment overrides:
//   MODEL      OpenRouter model id      (default: openai/gpt-4o-mini)
//   COUNT      number of problems       (default: 3, keep small and cheap)
//   ENDPOINT   OpenAI-compatible base   (default: https://openrouter.ai/api/v1)
//   NAME, ORG  leaderboard labels       (default: derived)
//   PASSWORD   delete password          (optional; lets you delete this entry later)
//
// The run is submitted with a "leaderboard-" id prefix, so after the next sync it
// appears on the community board. Delete it from submit.html with PASSWORD, or with
//   curl -X DELETE https://apilift.lim247.com/api/admin/submissions/<id>

import { API_BASE, ID_PREFIX, ADAPTER, EVAL_DEFAULTS, SUBMISSION_AREAS, SUBMISSION_LEVELS } from "../assets/config.js";
import { computeMetrics } from "../assets/metrics.js";
import { derivePasswordHash, delkTag } from "../assets/ui.js";

const KEY = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || process.env.VLLM_API_KEY;
const MODEL = process.env.MODEL || "openai/gpt-4o-mini";
const COUNT = Number(process.env.COUNT || 3);
const ENDPOINT = process.env.ENDPOINT || "https://openrouter.ai/api/v1";
const NAME = process.env.NAME || `test ${MODEL}`;
const ORG = process.env.ORG || "test";
const PASSWORD = process.env.PASSWORD || "";

const POLL_MS = 15000;
const MAX_MINUTES = 90;
const TERMINAL_OK = new Set(["completed", "done", "succeeded", "success"]);
const TERMINAL_FAIL = new Set(["failed", "error", "errored", "cancelled", "canceled"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!KEY) {
  console.error("Missing OPENROUTER_API_KEY (or OPENAI_API_KEY / VLLM_API_KEY) in the environment.");
  process.exit(1);
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function main() {
  const areas = SUBMISSION_AREAS;
  const levels = SUBMISSION_LEVELS;
  const env = {
    ...ADAPTER.env_static,
    VLLM_BASE_URL: ENDPOINT,
    VLLM_MODEL: MODEL,
    VLLM_MAX_TOKENS: "8192",
    VLLM_TEMPERATURE: "0.6",
    ABM_MAX_TASKS: String(COUNT),
    VLLM_API_KEY: KEY,
    OPENAI_API_KEY: KEY,
    OPENROUTER_API_KEY: KEY,
  };
  const submissionSpec = {
    model_cmd: ADAPTER.model_cmd,
    env,
    eval: {
      num_problems: COUNT,
      areas, levels,
      seed: EVAL_DEFAULTS.seed,
      sampling: EVAL_DEFAULTS.sampling,
      prompt_components: EVAL_DEFAULTS.prompt_components,
      two_phase_evaluation: EVAL_DEFAULTS.two_phase_evaluation,
      lean_version: EVAL_DEFAULTS.lean_version,
      hidden_checker_only: EVAL_DEFAULTS.hidden_checker_only,
    },
    runtime: ADAPTER.runtime,
    bench: { limit: COUNT, seed: EVAL_DEFAULTS.seed, sampling: EVAL_DEFAULTS.sampling, areas, levels },
  };

  const id = `${ID_PREFIX}test-${Math.random().toString(16).slice(2, 8)}`;
  const tags = ["leaderboard", "test"];
  if (PASSWORD) {
    const delk = await derivePasswordHash(PASSWORD);
    tags.push(delkTag(delk.salt, delk.hash));
  }
  const body = { id, name: NAME, org: ORG, track: "Open", tags, submissionSpec };

  console.log(`Submitting ${id}`);
  console.log(`  model=${MODEL}  count=${COUNT}  endpoint=${ENDPOINT}`);
  console.log(`  (real job: consumes backend compute and OpenRouter credits)`);

  const res = await fetch(`${API_BASE}/api/submissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`Submit failed: HTTP ${res.status} ${text}`);
    process.exit(1);
  }
  const out = JSON.parse(text);
  const subId = out.submission_id || id;
  console.log(`Accepted. submission_id=${subId} status=${out.status || "queued"}`);

  const deadline = Date.now() + MAX_MINUTES * 60000;
  let last = "";
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let s;
    try { s = await getJson(`${API_BASE}/api/submissions/${encodeURIComponent(subId)}`); }
    catch (e) { console.log(`  poll error: ${e.message}`); continue; }
    const status = String(s.status || "").toLowerCase();
    if (status !== last) { console.log(`  status=${status}`); last = status; }
    if (TERMINAL_OK.has(status)) break;
    if (TERMINAL_FAIL.has(status)) {
      console.error(`Run ${status}: ${s.error || "(no error message)"}`);
      process.exit(1);
    }
  }

  const analysis = await getJson(`${API_BASE}/api/submissions/${encodeURIComponent(subId)}/analysis`);
  const m = computeMetrics(analysis);
  console.log("\nResult");
  console.log(`  Compile rate:   ${m.compile == null ? "n/a" : m.compile.toFixed(1) + "%"}`);
  console.log(`  SA-pass (Soft): ${m.saPassSoft == null ? "n/a" : m.saPassSoft.toFixed(1) + "%"}`);
  console.log(`  SA-pass:        ${m.saPass == null ? "n/a" : m.saPass.toFixed(1) + "%"}`);
  console.log(`  Tasks:          ${m.n}`);
  console.log(`\nAnalysis: https://lift.lim247.com/run-analysis.html?id=${encodeURIComponent(subId)}`);
  if (PASSWORD) console.log(`Delete: submit.html "Delete a submission" with id ${subId} and your PASSWORD.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
