// Publishes community submissions to data/community.json.
//
// Runs in CI (see .github/workflows/sync-leaderboard.yml). A static site cannot
// fetch the ~128 MB backend leaderboard dump in the browser, so we do it here:
// pull the dump, keep only runs whose id starts with the "leaderboard-" prefix,
// recompute the compile-gated SA-PASS metrics from each run's analysis, and write
// a small JSON the site can load instantly.

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { API_BASE, ID_PREFIX } from "../assets/config.js";
import { computeMetrics, computeCategoryMetrics } from "../assets/metrics.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "data", "community.json");
const CONCURRENCY = 4;

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function pool(items, worker, size) {
  const out = [];
  let i = 0;
  const runners = Array.from({ length: size }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}

function isCompleted(run) {
  const s = String(run.status || run.state || "").toLowerCase();
  if (s) return ["completed", "done", "succeeded", "success"].includes(s);
  // leaderboard.json entries are generally finished runs; if there is no status
  // field, treat presence of a completion timestamp (or metrics) as completed.
  return Boolean(run.completedAt || run.completed_at || run.overall != null);
}

async function main() {
  console.log(`Fetching leaderboard dump from ${API_BASE} …`);
  const board = await getJson(`${API_BASE}/api/leaderboard.json`);
  const isOurs = (r) =>
    (typeof r.id === "string" && r.id.startsWith(ID_PREFIX)) ||
    (Array.isArray(r.tags) && r.tags.includes("leaderboard"));
  const runs = (board.runs || []).filter((r) => isOurs(r) && isCompleted(r));
  console.log(`Found ${runs.length} completed "${ID_PREFIX}" runs.`);

  // If two runs share a base model name, keep the best by SA-PASS later; for now
  // fetch analysis for each and compute metrics.
  const entries = (
    await pool(
      runs,
      async (r) => {
        try {
          const an = await getJson(`${API_BASE}/api/submissions/${encodeURIComponent(r.id)}/analysis`);
          const metrics = computeMetrics(an);
          const categories = computeCategoryMetrics(an);
          if (metrics.n === 0) return null;
          return {
            id: r.id,
            name: r.name || an.summary?.name || r.id,
            org: r.org || "n/a",
            track: r.track || "Open",
            completedAt: r.completedAt || r.completed_at || null,
            metrics,
            categories,
          };
        } catch (e) {
          console.warn(`  skip ${r.id}: ${e.message}`);
          return null;
        }
      },
      CONCURRENCY
    )
  ).filter(Boolean);

  entries.sort(
    (a, b) =>
      b.metrics.saPass - a.metrics.saPass ||
      b.metrics.saPassSoft - a.metrics.saPassSoft ||
      b.metrics.compile - a.metrics.compile
  );

  const payload = {
    generatedAt: new Date().toISOString(),
    datasetVersion: board.datasetVersion || null,
    prefix: ID_PREFIX,
    count: entries.length,
    entries,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(`Wrote ${entries.length} entries -> ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
