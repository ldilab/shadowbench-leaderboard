// Dry run by default. --live creates one small generated-code evaluation.
import { readFile, writeFile } from "node:fs/promises";
import { API_BASE, RUN_ANALYSIS_URL, PROBLEM_COUNT, TEST_TASK_IDS } from "../assets/config.js";
import { parseSolutions, buildCodeSpec } from "../assets/code-submission.js";
import { computeMetrics } from "../assets/metrics.js";

const live = process.argv.includes("--live");
const path = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const count = Number(process.env.COUNT || 3);
const id = process.env.RESUME_ID || `code-smoke-${crypto.randomUUID().slice(0, 8)}`;
const api = process.env.API_BASE || API_BASE;
const timeoutMinutes = Number(process.env.MAX_MINUTES || 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(path) {
  const res = await fetch(`${api}${path}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

async function main() {
  if (!Number.isInteger(count) || count < 1 || count > PROBLEM_COUNT) throw new Error("Invalid COUNT.");
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) throw new Error("Invalid MAX_MINUTES.");
  let subId = id;
  if (!process.env.RESUME_ID) {
    if (!path) throw new Error("Usage: node scripts/test_submit.mjs solutions.json [--live]");
    const solutions = parseSolutions(await readFile(path, "utf8"));
    const taskIds = process.env.TASK_IDS?.split(",") || TEST_TASK_IDS.slice(0, count);
    const submissionSpec = await buildCodeSpec(solutions, { taskIds });
    const body = {
      id, name: "Generated-code service check", org: "ShadowBench",
      track: "Open", tags: ["generated-code", "smoke-test"], submissionSpec,
    };
    console.log(`${solutions.length} solutions; ${taskIds.length} requested tasks (${taskIds.slice(0, 3).join(", ")}${taskIds.length > 3 ? ", ..." : ""}).`);
    console.log("No model endpoint, API key, or generation request.");
    if (!live) {
      console.log("Payload validated. Add --live to send it to the evaluator.");
      return;
    }
    const res = await fetch(`${api}/api/submissions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`Submit failed: HTTP ${res.status} ${await res.text()}`);
    const out = await res.json();
    if (!out.submission_id) throw new Error("No submission ID returned.");
    subId = out.submission_id;
    console.log(`Accepted: ${subId}`);
  } else if (!live) {
    throw new Error("Use --live with RESUME_ID to poll a real run.");
  }
  console.log(`Analysis: ${RUN_ANALYSIS_URL(subId)}`);
  const deadline = Date.now() + timeoutMinutes * 60000;
  let lastStatus;
  while (Date.now() < deadline) {
    const status = await getJson(`/api/submissions/${encodeURIComponent(subId)}`);
    if (status.status !== lastStatus) {
      console.log(`Status: ${status.status}`);
      lastStatus = status.status;
    }
    if (["failed", "error", "errored", "cancelled", "canceled"].includes(status.status)) {
      throw new Error(`Evaluation failed: ${status.error || "unknown error"}`);
    }
    if (["completed", "done", "succeeded", "success"].includes(status.status)) {
      const analysis = await getJson(`/api/submissions/${encodeURIComponent(subId)}/analysis`);
      const metrics = computeMetrics(analysis);
      console.log(JSON.stringify(metrics, null, 2));
      if (process.env.RESULT_PATH) {
        await writeFile(process.env.RESULT_PATH, JSON.stringify({ id: subId, status, analysis, metrics }, null, 2) + "\n");
        console.log(`Saved run evidence to ${process.env.RESULT_PATH}`);
      }
      if (!metrics.n) throw new Error("Completed without scored tasks.");
      return;
    }
    await sleep(15000);
  }
  throw new Error(`Still pending. Resume with RESUME_ID=${subId} and --live; no second job is needed.`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
