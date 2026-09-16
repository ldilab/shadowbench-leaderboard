// Cloudflare Worker for the ShadowBench leaderboard.
//
// The site itself is a static GitHub Pages project (github.com/ldilab/
// shadowbench-leaderboard, served at ldilab.github.io/shadowbench-leaderboard/)
// -- this Worker does NOT serve it. It only does the two things a static site
// can't: watch a submission until it finishes, and let the submitter (and only
// the submitter) decide whether to publish it.
//
// Flow:
//   1. POST /api/track {id, email} -- called by submit.js right after a
//      submission is accepted. Records the id + email to watch.
//   2. scheduled() (Cron Trigger, every minute) polls watched ids against the
//      backend. When one completes, it computes the score (reusing the exact
//      metrics.js logic the site itself uses), stashes it in KV under a random
//      token, and fires a `repository_dispatch` to the GitHub repo, which
//      triggers a workflow that emails the submitter a confirm-publish link.
//      The cron is the only thing that still works if the submitter closes
//      their browser before evaluation finishes -- it doesn't depend on them
//      being present.
//   3. GET /publish?token=... shows a confirmation page (never publishes on a
//      bare GET -- email security scanners prefetch links, and a GET that
//      published on load would silently expose scores before the submitter
//      chose to).
//   4. POST /publish commits the entry directly into data/community.json on
//      main via the GitHub Contents API. That push triggers the Pages deploy
//      workflow, so the public leaderboard updates within about a minute.
//
// Known gap: deleting an already-published entry is manual (edit
// data/community.json directly) -- there's no automatic reconciliation
// against the backend the way the KV-only design had, because the published
// list now lives in git, not KV.

import { API_BASE, ID_PREFIX } from "../assets/config.js";
import { computeMetrics, computeCategoryMetrics } from "../assets/metrics.js";

const WATCH_KEY = "community:watch";
const PENDING_PREFIX = "community:pending:";
const PENDING_TTL_SEC = 30 * 24 * 60 * 60; // 30 days -- long enough to not lose a slow responder

const REPO = "ldilab/shadowbench-leaderboard";
const REPO_API = `https://api.github.com/repos/${REPO}`;
const DATA_PATH = "data/community.json";
const PAGES_URL = "https://ldilab.github.io/shadowbench-leaderboard/";
const WORKER_ORIGIN = "https://shadowbench.johnjongyoonkim.workers.dev";
const ALLOWED_ORIGIN = "https://ldilab.github.io";

const MAX_WATCH = 200; // cap on concurrently tracked (not-yet-terminal) ids
const MAX_PER_TICK = 20; // bound subrequests spent advancing watched ids per tick
const MAX_FETCH_ATTEMPTS = 5; // consecutive fetch failures before giving up on an id
const MAX_WATCH_AGE_MS = 6 * 60 * 60 * 1000; // give up if never terminal after 6h

const TERMINAL_OK = new Set(["completed", "done", "succeeded", "success"]);
const TERMINAL_FAIL = new Set(["failed", "error", "errored", "cancelled", "canceled"]);

function isValidTrackId(id) {
  return (
    typeof id === "string" &&
    id.length <= 128 &&
    id.startsWith(ID_PREFIX) &&
    /^[a-z0-9-]+$/i.test(id.slice(ID_PREFIX.length))
  );
}

function isValidEmail(email) {
  return typeof email === "string" && email.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": ALLOWED_ORIGIN,
      ...(init.headers || {}),
    },
  });
}

function htmlResponse(html, init = {}) {
  return new Response(html, {
    status: init.status || 200,
    headers: { "content-type": "text/html; charset=utf-8", ...(init.headers || {}) },
  });
}

async function readJson(kv, key, fallback) {
  const value = await kv.get(key, "json");
  return value ?? fallback;
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers: { accept: "application/json", ...(headers || {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToUtf8(b64) {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtPct(v) {
  return typeof v === "number" ? `${v.toFixed(2)}%` : "n/a";
}

async function trackSubmission(env, id, email) {
  const watch = await readJson(env.COMMUNITY_KV, WATCH_KEY, { ids: {} });
  if (watch.ids[id]) return; // already tracked
  if (Object.keys(watch.ids).length >= MAX_WATCH) return; // full, drop silently
  watch.ids[id] = { email, firstSeen: Date.now(), attempts: 0 };
  await env.COMMUNITY_KV.put(WATCH_KEY, JSON.stringify(watch));
}

function confirmPageHtml({ token, name, org, metrics, error }) {
  if (error) {
    return `<!doctype html><meta charset="utf-8"><title>ShadowBench</title>
<body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1>Link not valid</h1><p>${escapeHtml(error)}</p></body>`;
  }
  return `<!doctype html><meta charset="utf-8"><title>Publish your result? · ShadowBench</title>
<body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1>Publish your result?</h1>
<p><strong>${escapeHtml(name)}</strong> (${escapeHtml(org)})</p>
<ul>
  <li>Compile rate: ${fmtPct(metrics.compile)}</li>
  <li>SA-pass (Soft): ${fmtPct(metrics.saPassSoft)}</li>
  <li>SA-pass: ${fmtPct(metrics.saPass)}</li>
  <li>Tasks: ${metrics.n}</li>
</ul>
<p>This adds your submission to the public community leaderboard at
<a href="${PAGES_URL}">${PAGES_URL}</a>. It stays private until you confirm.</p>
<form method="POST" action="/publish">
  <input type="hidden" name="token" value="${escapeHtml(token)}" />
  <button type="submit" style="font-size:1rem;padding:0.6rem 1.2rem">Publish to public leaderboard</button>
</form>
</body>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/track") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "access-control-allow-origin": ALLOWED_ORIGIN,
            "access-control-allow-methods": "POST",
            "access-control-allow-headers": "Content-Type",
          },
        });
      }
      if (request.method !== "POST") return jsonResponse({ error: "POST only" }, { status: 405 });
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: "Invalid JSON body." }, { status: 400 });
      }
      if (!isValidTrackId(body && body.id)) return jsonResponse({ error: "Invalid submission id." }, { status: 400 });
      if (!isValidEmail(body && body.email)) return jsonResponse({ error: "Invalid email." }, { status: 400 });
      await trackSubmission(env, body.id, body.email);
      return jsonResponse({ ok: true }, { status: 202 });
    }

    if (url.pathname === "/publish" && request.method === "GET") {
      const token = url.searchParams.get("token") || "";
      const pending = token ? await readJson(env.COMMUNITY_KV, PENDING_PREFIX + token, null) : null;
      if (!pending) {
        return htmlResponse(confirmPageHtml({ error: "This link is invalid, expired, or was already used." }), { status: 404 });
      }
      return htmlResponse(confirmPageHtml({ token, name: pending.name, org: pending.org, metrics: pending.metrics }));
    }

    if (url.pathname === "/publish" && request.method === "POST") {
      const form = await request.formData();
      const token = String(form.get("token") || "");
      const pending = token ? await readJson(env.COMMUNITY_KV, PENDING_PREFIX + token, null) : null;
      if (!pending) {
        return htmlResponse(confirmPageHtml({ error: "This link is invalid, expired, or was already used." }), { status: 404 });
      }
      try {
        await publishEntry(env, pending);
        await env.COMMUNITY_KV.delete(PENDING_PREFIX + token);
        return htmlResponse(`<!doctype html><meta charset="utf-8"><title>Published · ShadowBench</title>
<body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1>Published</h1><p>Your result is on its way to <a href="${PAGES_URL}">${PAGES_URL}</a> (usually live within a minute or two).</p></body>`);
      } catch (err) {
        console.error("publish failed:", err && err.stack ? err.stack : err);
        return htmlResponse(`<!doctype html><meta charset="utf-8"><title>Publish failed · ShadowBench</title>
<body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1>Something went wrong</h1><p>Publishing failed. The link is still valid -- please try again in a minute.</p></body>`, { status: 500 });
      }
    }

    return Response.redirect(PAGES_URL, 302);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      syncTick(env).catch((err) => console.error("syncTick failed:", err && err.stack ? err.stack : err))
    );
  },
};

async function publishEntry(env, pending) {
  const auth = { authorization: `Bearer ${env.GITHUB_TOKEN}`, "user-agent": "shadowbench-leaderboard-worker" };

  async function attempt() {
    const cur = await getJson(`${REPO_API}/contents/${DATA_PATH}?ref=main`, auth);
    const doc = JSON.parse(base64ToUtf8(cur.content));
    const entries = (doc.entries || []).filter((e) => e.id !== pending.id);
    entries.push({
      id: pending.id,
      name: pending.name,
      org: pending.org,
      track: pending.track || "Open",
      completedAt: pending.completedAt,
      metrics: pending.metrics,
      categories: pending.categories,
    });
    entries.sort(
      (a, b) =>
        b.metrics.saPass - a.metrics.saPass ||
        b.metrics.saPassSoft - a.metrics.saPassSoft ||
        b.metrics.compile - a.metrics.compile
    );
    const next = {
      generatedAt: new Date().toISOString(),
      datasetVersion: doc.datasetVersion || "v1.2",
      prefix: ID_PREFIX,
      count: entries.length,
      entries,
    };
    const res = await fetch(`${REPO_API}/contents/${DATA_PATH}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        message: `chore: publish ${pending.name} (${pending.id})`,
        content: utf8ToBase64(JSON.stringify(next, null, 2) + "\n"),
        sha: cur.sha,
        branch: "main",
      }),
    });
    return res;
  }

  let res = await attempt();
  if (res.status === 409) res = await attempt(); // one retry on a concurrent-publish race
  if (!res.ok) throw new Error(`GitHub Contents API PUT failed: HTTP ${res.status} ${await res.text()}`);
}

async function notifySubmitter(env, pending, token) {
  const confirmUrl = `${WORKER_ORIGIN}/publish?token=${encodeURIComponent(token)}`;
  const res = await fetch(`${REPO_API}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "user-agent": "shadowbench-leaderboard-worker",
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      event_type: "score-ready",
      client_payload: {
        email: pending.email,
        name: pending.name,
        org: pending.org,
        compile: pending.metrics.compile,
        saPassSoft: pending.metrics.saPassSoft,
        saPass: pending.metrics.saPass,
        n: pending.metrics.n,
        confirmUrl,
      },
    }),
  });
  if (!res.ok) throw new Error(`repository_dispatch failed: HTTP ${res.status} ${await res.text()}`);
}

async function syncTick(env) {
  const kv = env.COMMUNITY_KV;
  const watch = await readJson(kv, WATCH_KEY, { ids: {} });
  let changedWatch = false;

  const pendingIds = Object.keys(watch.ids).slice(0, MAX_PER_TICK);
  for (const id of pendingIds) {
    const entry = watch.ids[id];
    try {
      const run = await getJson(`${API_BASE}/api/submissions/${encodeURIComponent(id)}`);
      const status = String(run.status || "").toLowerCase();
      if (TERMINAL_OK.has(status)) {
        const an = await getJson(`${API_BASE}/api/submissions/${encodeURIComponent(id)}/analysis`);
        const metrics = computeMetrics(an);
        if (metrics.n > 0) {
          const r = run.run || {};
          const pending = {
            id,
            name: r.name || an.summary?.name || id,
            org: r.org || "n/a",
            track: r.track || "Open",
            completedAt: r.completedAt || r.completed_at || new Date().toISOString(),
            metrics,
            categories: computeCategoryMetrics(an),
            email: entry.email,
          };
          const token = crypto.randomUUID();
          await kv.put(PENDING_PREFIX + token, JSON.stringify(pending), { expirationTtl: PENDING_TTL_SEC });
          try {
            await notifySubmitter(env, pending, token);
          } catch (err) {
            console.error(`notify failed for ${id}:`, err.message);
            // Leave the pending record -- the submitter can't retry a lost
            // email, but a future manual /publish?token= isn't recoverable
            // without it, so at least don't lose the computed score.
          }
        }
        delete watch.ids[id];
        changedWatch = true;
      } else if (TERMINAL_FAIL.has(status)) {
        delete watch.ids[id];
        changedWatch = true;
      } else if (Date.now() - entry.firstSeen > MAX_WATCH_AGE_MS) {
        delete watch.ids[id]; // stuck; give up rather than watch forever
        changedWatch = true;
      } else if (entry.attempts) {
        entry.attempts = 0; // recovered from a prior transient failure
        changedWatch = true;
      }
    } catch (err) {
      entry.attempts = (entry.attempts || 0) + 1;
      changedWatch = true;
      if (entry.attempts >= MAX_FETCH_ATTEMPTS) delete watch.ids[id];
    }
  }

  if (changedWatch) await kv.put(WATCH_KEY, JSON.stringify(watch));
}
