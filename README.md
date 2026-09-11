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
    "task_id": "algebra/L1/alg_gen_L1_003",
    "lean_code": "import Mathlib\n\n..."
  }
]
```

A complete example is at `data/submission-example.json`. Each task ID may occur once. The live run
selects 178 tasks across the configured L1-L3 areas. Missing solutions fail that task. The live
dataset and selection are not presented as identical to the paper snapshot.

## How code submission works

The hosted evaluator expects a model command and cannot be changed by this repository. The browser
therefore compresses the submitted `task_id -> lean_code` map into the submission environment and
uses a fixed Python reader as the evaluator command. For each task, that reader identifies the task
from the evaluator prompt and returns the corresponding code. It never calls a model service.

The reader source and validation live in `assets/code-submission.js`. User-provided Lean is stored
as JSON data and is never interpolated into the Python command. Source input is limited to 4 MiB and
the compressed evaluator payload to 512 KiB.

Submissions are public benchmark entries. Names, organizations, generated code, run metadata, and
results should be treated as public. A delete password is hashed in the browser and stored in a
submission tag. This is only a convenience check in the static site; real authorization depends on
the hosted API.

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

## Cloudflare deployment

`wrangler.jsonc` deploys the static `dist/` output as a Worker named `shadowbench`.

```bash
npx wrangler login
npm run deploy
```

A Workers development URL always has the form
`<worker>.<account-subdomain>.workers.dev`. The middle label belongs to the Cloudflare account,
not this repository. In **Workers & Pages > Account details > workers.dev subdomain**, change it to
a neutral available name. This changes the account label for every Worker in that Cloudflare
account.

For a stable production address without an account label, attach a domain you control in
**Worker > Settings > Domains & Routes > Add > Custom Domain**, such as
`shadowbench.example.org`. Cloudflare creates the DNS record and certificate. A separate
Cloudflare Pages project is another option and uses `<project>.pages.dev`.

## Project layout

```
index.html                     leaderboard
submit.html                    generated-code form and run tracking
assets/code-submission.js      input validation and fixed code replay adapter
assets/submit.js               submission, polling, and deletion UI
assets/leaderboard.js          paper and community tables
assets/metrics.js              shared SA-PASS calculation
data/paper_results.json        paper Table 3 values
data/community.json            periodically generated community results
scripts/sync_leaderboard.mjs   community data sync
scripts/test_submit.mjs        dry-run and live service check
scripts/build.mjs              Cloudflare static build
```

The scheduled GitHub Action refreshes `data/community.json` every 30 minutes.
