// Guards data/paper_results.json against transcription errors: for every row and
// metric, the Average must equal the difficulty-weighted mean of L1/L2/L3
// (n = 113 / 52 / 13, total 178), and every row must carry the fields the
// board filters on. Run with: node scripts/check_paper.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(HERE, "..", "data", "paper_results.json"), "utf8"));
const N = { L1: 113, L2: 52, L3: 13, total: 178 };
const TOL = 0.15; // rounding slack for one-decimal reported values

let fails = 0;
for (const r of data.rows) {
  for (const m of ["compile", "saPassSoft", "saPass"]) {
    const weighted = (r.L1[m] * N.L1 + r.L2[m] * N.L2 + r.L3[m] * N.L3) / N.total;
    if (Math.abs(weighted - r.average[m]) > TOL) {
      fails++;
      console.error(
        `MISMATCH  ${r.method}  [${m}]  average=${r.average[m]}  weighted=${weighted.toFixed(2)}`
      );
    }
  }
}
// Every row needs the two classification axes the board filters on, plus a
// display model name (agentic rows also name their scaffold).
const APPROACHES = new Set(["agentic", "direct", "lean"]);
const WEIGHTS = new Set(["closed", "open"]);
for (const r of data.rows) {
  const bad = [];
  if (!APPROACHES.has(r.approach)) bad.push(`approach=${r.approach}`);
  if (!WEIGHTS.has(r.weights)) bad.push(`weights=${r.weights}`);
  if (!r.model) bad.push("model missing");
  if (r.approach === "agentic" && !r.scaffold) bad.push("agentic row without scaffold");
  if (bad.length) {
    fails++;
    console.error(`FIELDS  ${r.method}  ${bad.join(", ")}`);
  }
}
if (fails) {
  console.error(`\n${fails} mismatch(es).`);
  process.exit(1);
}
console.log(`OK — ${data.rows.length} rows consistent (Average = weighted mean of L1/L2/L3; approach/weights/model set).`);
