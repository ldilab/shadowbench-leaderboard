import { chromium } from "playwright";
import { startServer } from "./serve.mjs";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function browserExecutable() {
  const current = chromium.executablePath();
  if (existsSync(current)) return current;
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  for (const directory of readdirSync(cache).filter((name) => name.startsWith("chromium_headless_shell-")).sort().reverse()) {
    const executable = join(cache, directory, "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
    if (existsSync(executable)) return executable;
  }
  return undefined;
}

const target = process.env.SITE_URL?.replace(/\/$/, "");
const server = target ? null : await startServer({ port: 0 });
const baseUrl = target || `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: browserExecutable() });
const errors = [];
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`${viewport.width}px console: ${message.text()}`);
    });
    page.on("pageerror", (error) => errors.push(`${viewport.width}px page: ${error.message}`));
    await page.route("**/data/community.json", (route) => route.fulfill({ json: {
      generatedAt: "2026-09-11T00:00:00Z", datasetVersion: "v1.2",
      entries: [{
        id: "leaderboard-category-check", name: "Category check", org: "ShadowBench",
        completedAt: "2026-09-11T00:00:00Z",
        metrics: { n: 6, compile: 50, saPassSoft: 25, saPass: 16.6667 },
        categories: [
          { category: "algebra", n: 3, compile: 66.6667, saPassSoft: 33.3333, saPass: 33.3333 },
          { category: "topology", n: 3, compile: 33.3333, saPassSoft: 16.6667, saPass: 0 },
        ],
      }],
    }}));
    let submittedPayload;
    await page.route("https://apilift.lim247.com/**", async (route) => {
      const url = route.request().url();
      if (url.endsWith("/api/submissions") && route.request().method() === "POST") {
        submittedPayload = route.request().postDataJSON();
        await route.fulfill({ json: { submission_id: "leaderboard-browser-check", status: "queued" } });
      } else if (url.endsWith("/api/submissions/leaderboard-browser-check")) {
        await route.fulfill({ json: { submission_id: "leaderboard-browser-check", status: "queued" } });
      } else if (url.endsWith("/api/submission_queue.json")) {
        await route.fulfill({ json: { items: [], queued: 0, running: 0, maxWorkers: 4 } });
      } else {
        await route.abort();
      }
    });
    await page.goto(`${baseUrl}/index.html`, { waitUntil: "domcontentloaded" });
    await page.locator("#paper-board tbody tr").first().waitFor();
    await page.locator("[data-category-toggle]").click();
    await page.locator(".category-row").waitFor();
    await page.screenshot({ path: `/tmp/shadowbench-${viewport.width}.png`, fullPage: true });
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll("body *")].filter((element) => {
        const style = getComputedStyle(element);
        return style.position !== "fixed" && element.scrollWidth > element.clientWidth + 1 &&
          !element.closest(".tbl-wrap") && style.overflowX !== "auto";
      }).map((element) => element.tagName + "." + element.className).slice(0, 10)
    );
    if (overflow.length) errors.push(`${viewport.width}px overflow: ${overflow.join(", ")}`);
    await page.goto(`${baseUrl}/submit.html`, { waitUntil: "domcontentloaded" });
    await page.locator("#f-code").fill('[{"task_id":"algebra/L1/alg_gen_L1_003","lean_code":"import Mathlib\\nexample : True := by trivial"}]');
    await page.locator("#f-code").blur();
    await page.getByText("1 solution loaded. 178 tasks will be evaluated.").waitFor();
    await page.screenshot({ path: `/tmp/shadowbench-submit-${viewport.width}.png`, fullPage: true });
    await page.locator("#f-name").fill("Browser check");
    await page.locator("#f-org").fill("ShadowBench");
    await page.locator("#f-pass").fill("browser-test-password");
    await page.locator("#submit-btn").click();
    await page.getByText("Submitted as leaderboard-browser-check.").waitFor();
    if (!submittedPayload?.tags?.includes("generated-code")) throw new Error("Missing generated-code tag.");
    if (!submittedPayload?.submissionSpec?.model_cmd) throw new Error("Missing code replay adapter.");
    if (submittedPayload.submissionSpec.env.VLLM_BASE_URL || submittedPayload.submissionSpec.env.VLLM_API_KEY) {
      throw new Error("Submission unexpectedly contains a model endpoint or API key.");
    }
    await page.close();
  }
} finally {
  await browser.close();
  server?.close();
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Browser checks passed at 1440x900 and 390x844: ${baseUrl}`);
}
