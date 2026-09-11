import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  CODE_ADAPTER_SOURCE, parseSolutions, buildCodeSpec,
} from "../assets/code-submission.js";
import { computeCategoryMetrics } from "../assets/metrics.js";

const one = {
  task_id: "algebra/L1/alg_gen_L1_003",
  lean_code: "import Mathlib\nexample : True := by trivial",
};

test("parses JSON and JSONL solutions", () => {
  assert.deepEqual(parseSolutions(JSON.stringify([one])), [one]);
  assert.deepEqual(parseSolutions(JSON.stringify(one) + "\n"), [one]);
});

test("rejects duplicate and malformed task IDs", () => {
  assert.throws(() => parseSolutions(JSON.stringify([one, one])), /Duplicate task_id/);
  assert.throws(() => parseSolutions(JSON.stringify([{ ...one, task_id: "../secret" }])), /full task_id/);
});

test("builds a model-free spec and replays code by exact task ID", async () => {
  const spec = await buildCodeSpec([one], { count: 3, areas: ["algebra"], levels: ["L1"] });
  assert.equal(spec.eval.num_problems, 3);
  assert.equal(spec.env.VLLM_BASE_URL, undefined);
  assert.equal(spec.env.VLLM_API_KEY, undefined);
  const run = spawnSync("python3", ["-c", CODE_ADAPTER_SOURCE, `task_id: ${one.task_id}`], {
    encoding: "utf8", env: { ...process.env, ...spec.env },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).lean_code, one.lean_code);
});

test("computes compile-gated metrics for each category", () => {
  const categories = computeCategoryMetrics({ tasks: [
    { task_id: "topology/L1/a", standalone_compile_ok: true, hidden_checker_score: 1, backward_hidden_checker_score: 1 },
    { task_id: "algebra/L1/b", standalone_compile_ok: true, hidden_checker_score: 0.5, backward_hidden_checker_score: 0 },
    { task_id: "algebra/L1/c", standalone_compile_ok: false, hidden_checker_score: 1, backward_hidden_checker_score: 1 },
  ] });
  assert.deepEqual(categories, [
    { category: "algebra", n: 2, compile: 50, saPass: 0, saPassSoft: 12.5 },
    { category: "topology", n: 1, compile: 100, saPass: 100, saPassSoft: 100 },
  ]);
});
