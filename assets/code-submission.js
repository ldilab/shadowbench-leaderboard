import { EVAL_DEFAULTS, ADAPTER, PROBLEM_COUNT, TEST_TASK_IDS } from "./config.js";

export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
export const MAX_ENCODED_BYTES = 512 * 1024;
export const ENV_CHUNK_SIZE = 32 * 1024;

// The evaluator appends the task prompt as argv[1]. Only this fixed reader is
// executed as Python; uploaded Lean remains JSON data and goes to the scorer.
export const CODE_ADAPTER_SOURCE = String.raw`import base64, gzip, json, os, re, sys
from pathlib import Path

data = "".join(os.environ["SB_CODE_%04d" % i] for i in range(int(os.environ["SB_CODE_CHUNKS"])))
solutions = json.loads(gzip.decompress(base64.b64decode(data)).decode("utf-8"))
prompt = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
task_id = os.environ.get("ABM_TASK_ID") or os.environ.get("SHADOWBENCH_TASK_ID")
if not task_id:
    try:
        obj = json.loads(prompt)
        if isinstance(obj, dict):
            task_id = obj.get("task_id") or obj.get("id")
    except ValueError:
        pass
if task_id:
    code = solutions.get(task_id)
else:
    matches = [key for key in solutions if re.search(r"(?<![A-Za-z0-9_/-])" + re.escape(key) + r"(?![A-Za-z0-9_/-])", prompt)]
    if not matches:
        matches = [key for key in solutions if re.search(r"(?<![A-Za-z0-9_])" + re.escape(key.rsplit("/", 1)[-1]) + r"(?![A-Za-z0-9_])", prompt)]
    if not matches:
        # Older scorers supply only the informal statement, without a task ID.
        # Compare against the same benchmark's task text, never by array order.
        root = Path(os.environ.get("ABM_BENCHMARK_DIR") or os.environ.get("SHADOWBENCH_BENCHMARK_DIR") or ".").expanduser()
        normalized = " ".join(prompt.split())
        for key in solutions:
            if not re.fullmatch(r"[A-Za-z0-9_-]+/L[123]/[A-Za-z0-9_-]+", key):
                raise ValueError("Invalid task ID")
            path = root / "data" / key / "text.md"
            if path.is_file():
                statement = " ".join(path.read_text(encoding="utf-8").split())
                if statement and statement in normalized:
                    matches.append(key)
    if len(matches) > 1:
        raise ValueError("Ambiguous task; code was not replayed")
    code = solutions.get(matches[0]) if matches else None
if code is None:
    sys.exit("NO_SUBMITTED_SOLUTION: no matching task ID")
print(json.dumps({"lean_code": code}, ensure_ascii=False))
`;

export const CODE_MODEL_CMD = "python3 -c '" + CODE_ADAPTER_SOURCE.replaceAll("'", "'\\''") + "'";

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

const TEST_TASK_ID_SET = new Set(TEST_TASK_IDS);

export function parseSolutions(source) {
  if (typeof source !== "string" || !source.trim()) throw new Error("Add your generated solutions.");
  if (byteLength(source) > MAX_SOURCE_BYTES) throw new Error("Solutions must be 4 MiB or smaller.");
  const text = source.replace(/^\uFEFF/, "").trim();
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    rows = text.split(/\r?\n/).filter((line) => line.trim()).map((line, i) => {
      try { return JSON.parse(line); }
      catch { throw new Error(`Invalid JSON or JSONL at line ${i + 1}.`); }
    });
  }
  if (rows && !Array.isArray(rows) && typeof rows === "object") {
    rows = Array.isArray(rows.solutions) ? rows.solutions : [rows];
  }
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("Provide at least one solution.");
  if (rows.length > PROBLEM_COUNT) throw new Error(`At most ${PROBLEM_COUNT} solutions are allowed.`);
  const seen = new Set();
  return rows.map((row, i) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Solution ${i + 1} must be an object.`);
    const id = typeof row.task_id === "string" ? row.task_id.trim() : "";
    // Membership in the fixed 178-id test set (assets/test_task_ids.js) is the
    // whole check -- it already implies a well-formed area/level/name, and,
    // unlike a loose pattern match, rejects an id that merely looks
    // plausible (e.g. a level the live dataset has but the test set doesn't).
    if (!TEST_TASK_ID_SET.has(id)) {
      throw new Error(`Solution ${i + 1}: "${id}" is not one of the 178 ShadowBench test task IDs.`);
    }
    if (seen.has(id)) throw new Error(`Duplicate task_id: ${id}.`);
    seen.add(id);
    if (typeof row.lean_code !== "string" || !row.lean_code.trim()) {
      throw new Error(`Solution ${i + 1}: lean_code must be a non-empty string.`);
    }
    return { task_id: id, lean_code: row.lean_code };
  });
}

export async function buildCodeSpec(solutions, { taskIds = TEST_TASK_IDS } = {}) {
  // Revalidate at the shared boundary so the CLI and browser have one contract.
  const rows = parseSolutions(JSON.stringify(solutions));
  if (!Array.isArray(taskIds) || taskIds.length === 0) throw new Error("No task IDs to evaluate.");
  const source = JSON.stringify(Object.fromEntries(rows.map((row) => [row.task_id, row.lean_code])));
  const compressed = new Blob([source]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(compressed).arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary);
  if (encoded.length > MAX_ENCODED_BYTES) throw new Error("Solutions exceed the evaluator's compressed upload limit (512 KiB).");
  const env = { SB_CODE_CHUNKS: String(Math.ceil(encoded.length / ENV_CHUNK_SIZE)) };
  for (let i = 0; i * ENV_CHUNK_SIZE < encoded.length; i++) {
    env[`SB_CODE_${String(i).padStart(4, "0")}`] = encoded.slice(i * ENV_CHUNK_SIZE, (i + 1) * ENV_CHUNK_SIZE);
  }
  // `taskIds` pins the evaluator to exactly this id list -- it overrides the
  // evaluator's own areas/levels/count sampling entirely (confirmed against
  // the live API: with taskIds set, its echoed eval config reports
  // sampling: "task_ids" regardless of the `sampling` value below).
  const evalConfig = { ...EVAL_DEFAULTS, num_problems: taskIds.length, taskIds };
  return {
    model_cmd: CODE_MODEL_CMD,
    env,
    eval: evalConfig,
    runtime: { ...ADAPTER.runtime, model_timeout_sec: 30 },
    bench: { ...evalConfig, limit: taskIds.length },
  };
}
