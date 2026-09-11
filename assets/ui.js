// Small shared UI helpers: theme, formatting, and local job tracking.

const THEME_KEY = "sb_theme";
const JOBS_KEY = "sb_jobs";
const RATE_KEY = "sb_last_submit";

export function initTheme() {
  const btn = document.querySelector(".theme-btn");
  const apply = (t) => {
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
  };
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (_e) {}
  apply(saved); // default (no value) = bright light theme
  if (btn) {
    btn.addEventListener("click", () => {
      const isDark = document.documentElement.getAttribute("data-theme") === "dark";
      const next = isDark ? "light" : "dark";
      apply(next);
      try { localStorage.setItem(THEME_KEY, next); } catch (_e) {}
    });
  }
}

export function fmtPct(v) {
  return typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(1)}%` : "—";
}

export function renderCategoryMetrics(categories) {
  if (!Array.isArray(categories) || categories.length === 0) {
    return '<div class="empty">No category results available.</div>';
  }
  const rows = categories.map((item) => '<tr>' +
    '<td>' + escapeHtml(item.category) + '</td>' +
    '<td class="num">' + fmtPct(item.compile) + '</td>' +
    '<td class="num">' + fmtPct(item.saPassSoft) + '</td>' +
    '<td class="num metric-strong">' + fmtPct(item.saPass) + '</td>' +
    '<td class="num metric-mut">' + (item.n ?? "n/a") + '</td>' +
  '</tr>').join("");
  return '<div class="category-table-wrap"><table class="category-table">' +
    '<thead><tr><th>Category</th><th class="num">Compile</th>' +
    '<th class="num">SA-pass (Soft)</th><th class="num">SA-pass</th>' +
    '<th class="num">Tasks</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function slugify(s) {
  return String(s || "").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "model";
}

/* ---- Local job tracking (per browser) ---- */

export function loadTrackedJobs() {
  try {
    const raw = localStorage.getItem(JOBS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (_e) { return []; }
}

export function saveTrackedJob(job) {
  const jobs = loadTrackedJobs();
  const i = jobs.findIndex((j) => j.id === job.id);
  if (i >= 0) jobs[i] = { ...jobs[i], ...job };
  else jobs.unshift(job);
  try { localStorage.setItem(JOBS_KEY, JSON.stringify(jobs.slice(0, 40))); } catch (_e) {}
}

export function removeTrackedJob(id) {
  const jobs = loadTrackedJobs().filter((j) => j.id !== id);
  try { localStorage.setItem(JOBS_KEY, JSON.stringify(jobs)); } catch (_e) {}
}

/* ---- Delete password (PBKDF2 via Web Crypto) ----
   The derived hash is stored in a public submission tag, so this is a courtesy
   gate against casual deletion through the UI, not real access control. The
   backend DELETE route is open, so a determined caller can bypass it. Use a
   password you do not reuse elsewhere. */

const DELK_ITER = 100000;

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex) {
  const a = new Uint8Array(hex.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
  return a;
}

// Returns {salt, hash} as hex strings. Pass an existing saltHex to reproduce a hash.
export async function derivePasswordHash(password, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: DELK_ITER, hash: "SHA-256" }, key, 256
  );
  return { salt: toHex(salt), hash: toHex(bits) };
}

export function delkTag(salt, hash) {
  return `delk:${salt}:${hash}`;
}

export function parseDelkTag(tags) {
  for (const t of tags || []) {
    const m = /^delk:([0-9a-f]+):([0-9a-f]+)$/.exec(String(t));
    if (m) return { salt: m[1], hash: m[2] };
  }
  return null;
}

export async function verifyPassword(password, salt, hash) {
  const d = await derivePasswordHash(password, salt);
  return d.hash === hash;
}

/* ---- Client-side rate-limit gate (courtesy only) ---- */

export function lastSubmitAt() {
  try { return Number(localStorage.getItem(RATE_KEY)) || 0; } catch (_e) { return 0; }
}
export function markSubmitted() {
  try { localStorage.setItem(RATE_KEY, String(Date.now())); } catch (_e) {}
}
