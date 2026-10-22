# Do advisors help? And does mixing models beat resampling the best one?

*Measurement of the `advisor` / `advisor_panel` tools (`plugin/lib/advisors.ts`) on an
objectively graded coding task. Everything measured before this file was about SAFETY —
whether the system stops a destructive action. This is about CAPABILITY, and the safety
verdict deliberately does not carry over.*

**Status: draft — numbers are filled in by the run that produced this file.**

---

## 1. The two competing predictions being tested

`docs/EVIDENCE.md` records two findings that point in opposite directions for our roster,
and this benchmark exists because we did not know which one applies here.

| | prediction | what it implies for us |
|---|---|---|
| **Self-MoA** (arXiv:2502.00674) | resampling the single best model beats mixing weaker ones by ~6.6% (AlpacaEval) / ~3.8% (MMLU, CRUX, MATH) | `solo-xN` should beat `panel`; consulting weaker free models should *hurt* |
| **Panel of small judges** (arXiv:2404.18796) | 3 small heterogeneous judges beat one big judge, because independent biases cancel | `panel` should beat `solo` and `advisor` |

Neither was assumed. The design below is the coin-flip.

## 2. The task, and why the oracle is trustworthy

`EVIDENCE.md`'s one-line verdict is that structure converts external verifier signal into
accuracy and cannot manufacture it. So the task needs a real external verifier — and one we
did not write.

**The task: finish a regular-expression engine.** The sandbox contains `solution.py`, a
working ~200-line first cut (recursive-descent parser + backtracking matcher) that handles
literals, `.`, classes, greedy `* + ?`, alternation, groups and anchors, and that is
**incomplete and in places wrong**: no lazy quantifiers, no `{m,n}`, no `(?:…)`, no capture
rollback on backtracking, `$` does not match before a trailing newline, and empty-matching
repeats are merely capped rather than handled. The model is told the file is incomplete and
wrong, but **not which parts** — locating the gaps from the specification is the job. That
is deliberate: `EVIDENCE.md` finding 4 is that models can *fix* an error but cannot *find*
one, which makes this precisely the shape of task where a second opinion might pay.

**The grade** is a corpus of `(pattern, text)` pairs whose expected answers were produced
by **Python's own `re` module** (`bench/advisors/gen_cases.py`): 126 hidden cases, one
point each, plus 29 visible ones the agent can run.

That gives four properties a hand-authored answer key would not have:

1. **The answer key is not ours.** It is CPython's `sre`. We could not have written it to
   match a model's habits, and we could not tune it if we wanted to.
2. **Deterministic and total.** 126 pass/fail cases. No LLM judge, no rubric.
3. **The hidden corpus never enters the sandbox.** Grading copies `solution.py` *out* and
   runs it in a second, throwaway, `--network none` container.
4. **The obvious cheat is blocked mechanically.** `import re` (and `regex`, `sre_*`,
   `fnmatch`, `__import__`, `eval`, `exec`) is caught by an AST walk over `solution.py`;
   such a solution scores **0/126**. Verified: an otherwise-perfect `re`-backed solution
   scores 0/126.

**Floor and ceiling are both measured, not assumed.**

| | score | what it establishes |
|---|---|---|
| the starter the model is given | **88/126 = 69.8%** (visible 20/29) | the task is not "write it from nothing"; a run that achieves nothing still scores ~70% |
| an independent implementer given only `TASK.md` + the visible tests | **126/126** | the corpus is achievable and the spec is sufficient |

The independent implementer was a different, stronger model, explicitly forbidden from
reading the corpus or the generator. It also returned a list of every point where it had to
guess; every ambiguity it named that the corpus can actually reach was closed in `TASK.md`
**before any model under test ran** (the normative "match `re`" rule, the ASCII-only
guarantee, `-0x10`, and the corner cases the corpus deliberately does not test).

### Two earlier task designs were discarded, and that is part of the result

- **A stack-machine exercise** (`bench/advisors/work/`, 65 hidden tests). Piloted at
  98.5%, 100%, 98.5%. Saturated — the same thing the benchmark author reports for
  `01-code-fix` ("almost every modern model solves it perfectly"). Kept unused as the
  record of the calibration.
- **The same regex engine written from scratch** (`bench/advisors/work-b/`). Too hard in a
  different way: on 3 completed runs the model spent its **entire ~32 000-token per-turn
  reasoning budget in a single turn and emitted nothing** (`finish: "length"`), twice out
  of three. Scores were 0%, 0%, 24.7%, and **no run ever reached the point of consulting an
  advisor**. Telling it to work incrementally did not fix this, and `reasoning_effort:
  "low"` is accepted by the endpoint but has no effect. Those three runs are kept as
  `runs/_scratch-condition/`. They are reported below as a finding in their own right, not
  hidden: *a mechanism that only fires late in a session never fires at all if the model
  cannot get that far.*

## 3. Arms

Everything is held constant except **which advisor tool the agent can see**. Same task
files, same `AGENTS.md`, same model, same permissions, same container image, same starter
`solution.py`.

| arm | what the agent has |
|---|---|
| `solo` | no advisor tool exists (plugin not installed) |
| `solo-xN` | *not run separately* — derived from the `solo` pool, see below |
| `advisor` | only `advisor` (one specialist persona, on one other free model) |
| `panel` | only `advisor_panel` (fan-out to several different free models, merged) |

Tool exposure is not taken on trust. `opencode debug agent build` was dumped for each
config: the advisor arm resolves to `advisor:true, advisor_panel:false,
advisor_debate:false`, the panel arm to the mirror image, and solo has no advisor entries
at all. (A model asked to *list* its tools gave a different, wrong answer in one probe —
which is exactly why the resolved config, not the model, is the evidence.)

The review board is **off** in every arm (`mode: "off"`), so no veto, no protocol injection
and no safety-layer latency can leak in; the plugin still registers the advisor tools. Note
that getting this right required pointing the plugin at its config explicitly
(`STEROIDS_CONFIG`) — an earlier batch was discarded after its logs showed
`"mode":"enforce"`, i.e. the board had been running in the advisor arms and contaminating
them.

**`solo-xN` is derived, not run.** For every combination of N runs drawn from the solo
pool, the attempt with the best **visible-test** score is selected — a deterministic oracle
the agent could also have used, which does **not** leak the hidden grade — and that
attempt's hidden score is the result. The oracle-leaking `max(hidden)` upper bound is
printed beside it, because that is the number a careless best-of-N evaluation would quote
and it is not a fair comparison. `solo-xN` is charged the tokens of all N attempts.

**Prompt condition.** `AGENTS.md` is byte-identical in every arm and *requires* a
second-opinion pass before finishing, in wording that resolves differently only because of
what is installed: use an advisor tool if one is available, **otherwise** re-read the spec
and self-review. The solo arm therefore runs the intrinsic-self-correction control that
`EVIDENCE.md` finding 3 predicts should not help, and the advisor arms run the
external-advice version of the same instruction. This is the only way to ask "does the
advice help" rather than "does the model think to ask", and the difference between those
two questions is itself a result (§5).

## 4. Isolation and honesty constraints

- One container per run, image `bench-adv:1` (ubuntu 24.04 + python3 + the same
  opencode 1.17.17 binary used everywhere else in `bench/`). **No host bind mounts**; task
  files and credentials go in with `docker cp`. The model runs as the unprivileged `bench`
  user: no ssh keys, no sudo, no docker socket.
- Grading happens in a *second* throwaway container with `--network none`.
- Reported per run: hidden score, visible score, total tokens (taken from opencode's own
  sqlite store, which charges every session in the container — so an advisor arm is billed
  for the advice it asked for), wall-clock, and how many advisor calls were actually made.
- n ≥ 3 per arm; the spread is reported, never the best run (`ANTICHEAT.md` R8).
- A run the provider never served (free-tier quota) is **excluded, not scored as zero**,
  and the exclusions are listed.

### Declared deviation: the primary agent ran on the paid twin of the same model

The intended primary was `opencode/mimo-v2.5-free`. Partway through setup, that model began
returning `429 FreeUsageLimitError` **to the sandbox's egress IP** while the same key on a
different egress IP still returned 200 — i.e. the free tier is quota-limited per IP, and
the sandbox-host address was exhausted (a concurrent benchmark on the same host contributed).
Free models were therefore unusable for the agent loop for the duration of these runs.

The runs below use **`opencode-go/mimo-v2.5`** — the paid endpoint of the *same model* — for
the primary agent in **every arm equally**. It is still a cheap model ($0.14/$0.28 per
Mtok; the whole experiment cost well under a dollar). **Advisors stayed on the free tier**
(`paidFallback: false`), so the mixed-roster question is still being asked of free models.
This is reported, per the free-tier-only rule, rather than quietly absorbed.

---

*(sections 5–8: results, attribution, and the answers — filled in below)*
