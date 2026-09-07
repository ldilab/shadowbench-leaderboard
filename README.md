# ShadowBench Leaderboard

A static leaderboard for **ShadowBench** — a Lean 4 full-autoformalization benchmark that scores
*semantic alignment* with **SA-PASS**, not just compilation
([arXiv:2608.29270](https://arxiv.org/abs/2608.29270)).

It shows two things side by side:

1. **Reported results** — the paper's Table 3 numbers (n=178 snapshot), for public models.
2. **Live submissions** — models submitted through this site and evaluated on the lift backend
   (dataset v1.2), scored with the same SA-PASS definition.

## Metrics

All three are recomputed **per task** from a run's analysis payload and averaged over the run
(`denominator = total tasks`). Definitions follow the paper (Table 3 caption, Def. 5/6):

| Metric | Meaning | Per-task rule |
| --- | --- | --- |
| **Compile rate** | Generated Lean compiles standalone | `standalone_compile_ok` |
| **SA-pass (Soft)** | When it compiles, average of forward & backward checker pass rates | `compile ? (fwd + bwd) / 2 : 0` |
| **SA-pass** | Compiles **and** every forward & backward checker passes | `compile && fwd == 100% && bwd == 100%` |
