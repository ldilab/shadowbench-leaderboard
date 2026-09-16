// Shared deletion flow, used from both submit.html's job list and the
// community leaderboard table -- any submission can be deleted from any
// browser given its password, so the same logic applies wherever a
// submission id is shown.

import { API_BASE, WORKER_BASE } from "./config.js";
import { parseDelkTag, verifyPassword } from "./ui.js";

// `localDelk` is an optional {salt, hash} fallback for a job this browser
// itself just submitted, in case the backend's copy of the tag can't be
// fetched (e.g. it was already deleted).
export async function deleteSubmission(id, password, localDelk) {
  let delk = null;
  try {
    const res = await fetch(`${API_BASE}/api/submissions/${encodeURIComponent(id)}`, { cache: "no-cache" });
    if (res.ok) {
      const s = await res.json();
      delk = parseDelkTag((s.run && s.run.tags) || []);
    }
  } catch (_e) { /* fall back to local delk */ }
  if (!delk && localDelk) delk = localDelk;
  if (!delk) {
    return { ok: false, message: "No delete password is on record for this submission, so it cannot be verified here." };
  }

  const ok = await verifyPassword(password, delk.salt, delk.hash);
  if (!ok) return { ok: false, message: "Wrong password." };

  // The Worker re-checks this hash against the backend's own delk tag, then
  // deletes from the evaluator, removes the entry from the public leaderboard
  // if it was published, and emails the original submitter.
  try {
    const res = await fetch(`${WORKER_BASE}/api/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, hash: delk.hash }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, message: out.error || `Delete failed: HTTP ${res.status}` };
    return { ok: true, message: "Deleted." };
  } catch (e) {
    return { ok: false, message: `Delete error: ${e.message}` };
  }
}
