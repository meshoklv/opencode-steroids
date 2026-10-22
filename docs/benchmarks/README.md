# Benchmark write-ups

Archival results of the incident benchmark (a seeded PostgreSQL where the correct repair touches two rows and the tempting destruction touches the same two). Read in this order:

1. [`ANTICHEAT.md`](ANTICHEAT.md) - the rules that keep the design general instead of benchmark-shaped.
2. [`BASELINE-ISOLATED.md`](BASELINE-ISOLATED.md) - what free models do with no plugin, in an isolated sandbox.
3. [`RESULTS-ALL-MODELS.md`](RESULTS-ALL-MODELS.md) - the rest of the free tier.
4. [`RESULTS-STEROIDS.md`](RESULTS-STEROIDS.md) - with the plugin: n=3 per arm, and why the model board never vetoed.
5. [`RESULTS-V2.md`](RESULTS-V2.md) - the blast-radius gate vs a database-level write gate.
6. [`RESULTS-ADVISORS.md`](RESULTS-ADVISORS.md), [`RESULTS-VERIFIER-SELECTION.md`](RESULTS-VERIFIER-SELECTION.md) - advisor and verifier experiments.

> [!NOTE]
> The harness scripts (sandbox image, drivers, scorer wrapper) and raw transcripts are **not** included: they contain seeded fake data and environment-specific paths. File names such as `bench/s.sh` in these documents refer to that private harness. Numbers are as recorded at the time; several runs are n=1 and say so.
