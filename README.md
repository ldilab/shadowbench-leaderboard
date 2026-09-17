# ShadowBench Leaderboard

A static leaderboard and generated-code submission client for
[ShadowBench](https://github.com/ldilab/shadowbench), a Lean 4 autoformalization benchmark scored
with SA-PASS ([paper](https://arxiv.org/abs/2608.29270)).

## What the site does

- Shows the results reported in the paper separately from live community runs.
- Accepts generated Lean solutions as JSON or JSONL. It does not ask for a model endpoint or API key.
- Sends the uploaded solutions through the existing evaluator API and tracks the run in the browser.
- Recomputes compile-gated Compile rate, SA-pass (Soft), and SA-pass overall and by mathematical category.

The code upload format is:

```json
[
  {
    "task_id": "algebra/L2/alg_gen_L2_002",
    "lean_code": "import Mathlib\n\n..."
  }
]
```

A complete example is at `data/submission-example.json`. Each task ID may occur once and must be
one of the 178 ids in `assets/test_task_ids.js` -- the exact "test" split of
[DicoTiar/ShadowBench](https://huggingface.co/datasets/DicoTiar/ShadowBench) on Hugging Face
("the problem set of the ShadowBench paper. Use this split for the public leaderboard."). That list
is passed to the evaluator as `taskIds`, which pins it to exactly those 178 problems regardless of
what else is in its live, growing benchmark directory -- missing solutions just fail that task.
See "Fixed task selection" below for why this exists and how to regenerate the list.

## How code submission works

The hosted evaluator expects a model command and cannot be changed by this repository. The browser
therefore compresses the submitted `task_id -> lean_code` map into the submission environment and
uses a fixed Python reader as the evaluator command. For each task, that reader identifies the task
from the evaluator prompt and returns the corresponding code. It never calls a model service.

The reader source and validation live in `assets/code-submission.js`. User-provided Lean is stored
as JSON data and is never interpolated into the Python command. Source input is limited to 4 MiB and
the compressed evaluator payload to 512 KiB.

A submission's result is private until the submitter chooses to publish it (see "How results become
public" below) -- but treat generated code and run metadata sent to the hosted evaluator itself as
visible to whoever operates that service. A delete password is hashed in the browser and stored in a
submission tag. This is only a convenience check in the static site; real authorization depends on
the hosted API.

## Fixed task selection

The hosted evaluator's own benchmark directory is a live, growing superset (well over the paper's
178 problems, and its own `L1`-`L4` level labels don't line up with the paper's -- the paper's
178-problem set actually spans the evaluator's `L2`/`L3`/`L4`, not `L1`/`L2`/`L3`). Asking it to pick
178 by area/level/count (`sampling: "first"`) therefore was not reliably the paper's problem set,
just something the same shape.

`assets/test_task_ids.js` fixes this: it's the exact 178 ids from the `test` split of
[DicoTiar/ShadowBench](https://huggingface.co/datasets/DicoTiar/ShadowBench) ("the problem set of
the ShadowBench paper. Use this split for the public leaderboard."), passed to the evaluator as
`taskIds` on every submission. Confirmed against the live API: setting `taskIds` makes it report
back `sampling: "task_ids"` and select exactly (and only) those ids, regardless of `areas`/`levels`.
`assets/code-submission.js` also validates each submitted `task_id` against this same list, so a
mismatched or malformed id is rejected in the browser rather than silently scoring zero.

Regenerate the list only if the dataset's `test` split changes:

```bash
curl -sL https://huggingface.co/datasets/DicoTiar/ShadowBench/resolve/main/test.jsonl \
  | python3 -c "
import json, sys
ids = [json.loads(l)['idx'] for l in sys.stdin]
assert len(ids) == len(set(ids))
print('export const TEST_TASK_IDS = [')
print(',\n'.join(f'  \"{i}\"' for i in ids))
print('];')
" > assets/test_task_ids.js
```

Then prepend the header comment (what the list is, where it's from, when it was fetched) by hand --
the script above only emits the array.

## Local development

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:8199>. Useful checks:

```bash
npm test
npm run build
npm run test:browser
node scripts/test_submit.mjs data/submission-example.json
```

The last command validates a payload without submitting it. Add `--live` to create a real
three-task evaluator job:

```bash
COUNT=3 node scripts/test_submit.mjs data/submission-example.json --live
```

## Hosting: GitHub Pages + a small Cloudflare Worker

The site itself is static and served by **GitHub Pages** from this repo
(`.github/workflows/pages.yml`, source: GitHub Actions) at
<https://ldilab.github.io/shadowbench-leaderboard/>. GitHub Pages can't run any server code, so a
small **Cloudflare Worker** (`worker/index.mjs`) handles the two things that need one:

1. `POST /api/submit {id, name, org, track, tags, submissionSpec, email}` -- called by `submit.js`
   instead of the evaluator's own `/api/submissions`. Enforces a real rate limit (by IP first, then
   by email -- unlike the localStorage-based courtesy gate the UI also has, which a private window
   resets), forwards to the evaluator, and starts watching the id + email for completion.
2. A Cron Trigger, every minute, polls watched ids against the hosted evaluator. When one finishes,
   the Worker computes the score (same `assets/metrics.js` logic the site itself uses), stashes it in
   KV, and fires a `repository_dispatch` that makes `.github/workflows/send-score.yml` email the
   submitter a link.
3. `GET/POST /publish?token=...` -- the confirmation page from that email. Only a `POST` (i.e. only
   an actual click on the confirm button, never a bare `GET` -- email security scanners prefetch
   links) commits the entry into `data/community.json` on `main` via the GitHub Contents API, which
   triggers the Pages redeploy above.
4. `POST /api/delete {id, hash}` -- from `submit.html`'s delete form, in any browser. `hash` is the
   PBKDF2 hash the browser derives from the typed password using the salt in the submission's public
   delk tag (this is the same courtesy gate the UI has always had -- the delk tag is public and the
   backend's delete route has no auth of its own, so this was never real access control). On a match,
   the Worker deletes from the evaluator, drops the id from the watch list if still pending, removes
   it from `data/community.json` if it was published (triggering a redeploy), and fires
   `.github/workflows/delete-notice.yml` to email the original submitter that it's gone.

So: a result is private (only in that email) until the submitter confirms publishing it. The Worker
never serves the site; it's the deploy target `wrangler.jsonc` points at, reachable directly at its
own `*.workers.dev` URL only for `/api/submit`, `/publish`, and `/api/delete`.

```bash
npx wrangler login
npx wrangler kv namespace create COMMUNITY_KV        # once; paste the id into wrangler.jsonc
npx wrangler secret put GITHUB_TOKEN                 # fine-grained PAT: Contents R/W on this repo
gh secret set SMTP_USER --repo ldilab/shadowbench-leaderboard   # a Gmail address
gh secret set SMTP_PASS --repo ldilab/shadowbench-leaderboard   # that Gmail account's app password
npm run deploy
```

**Known gap**: removing an already-published entry is manual (edit `data/community.json` and push) --
there's no automatic reconciliation against the evaluator backend for the git-published list.

**Branch protection**: `main` requires a pull request to merge (0 required approvals -- this just
blocks accidental direct pushes, it's not a review gate), with force-push and branch deletion
blocked. The Worker's bot account is on the bypass list so its direct commits to `data/community.json`
still work; everyone else needs a PR.

## Project layout

```
index.html                     leaderboard
submit.html                    generated-code form and run tracking
assets/code-submission.js      input validation and fixed code replay adapter
assets/submit.js               submission, polling, and deletion UI
assets/leaderboard.js          paper and community tables
assets/metrics.js              shared SA-PASS calculation (also used by worker/index.mjs)
data/paper_results.json        paper Table 3 values
data/community.json            published community results (Worker commits to this on publish)
worker/index.mjs               Cloudflare Worker: /api/submit, /publish, /api/delete, and the
                                scheduled watcher
.github/workflows/pages.yml        builds and deploys the static site to GitHub Pages
.github/workflows/send-score.yml   emails a submitter when their run completes
scripts/test_submit.mjs        dry-run and live service check
scripts/build.mjs              static build (used by pages.yml)
```
