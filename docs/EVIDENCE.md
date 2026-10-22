# What the literature actually says about making small models competitive

Assembled by six parallel research agents, deliberately asked for negative results too.
This file exists so the architecture is driven by evidence rather than by hope, and so that
the honest limits are on record BEFORE we claim any benchmark win (see `ANTICHEAT.md` R10).

## The one-line verdict

**Structure converts external verifier signal into accuracy. It does not manufacture signal.**
Where there is a cheap oracle (tests, compiler, exit codes, a database you can query), a swarm
of small models genuinely competes with a much larger one. Where there is no oracle and the
judge is drawn from the same small-model family, structure buys cost and latency — not
correctness.

## Findings that CONSTRAIN the design

**1. Small self-judging has a hard accuracy ceiling.**
"Inference Scaling fLaws" (arXiv:2411.17501): with an imperfect verifier there is a non-zero
false-positive rate that resampling **cannot** reduce, and FP rate correlates with the model's
own single-sample accuracy. Their conclusion is blunt: *no amount of inference scaling of
weaker models can enable them to match the single-sample accuracy of a sufficiently strong
model.* Gao et al. (arXiv:2210.10760): optimising against a proxy reward model makes the proxy
score rise while the true score peaks and declines — and the penalty is **worse for smaller**
reward models. Weaver (arXiv:2506.18203): weak-verifier best-of-N plateaus after a few
generations; on GPQA Diamond, oracle pass@100 = 81.0% but majority voting captured only 47.4%
— a 33.6-point gap left on the table.
→ **Consequence:** the review board must not be the primary detector of danger. A weak model
cannot be trusted to *find* the problem.

**2. Weak judges almost never say "no".**
Jain et al. (arXiv:2510.11822): weak LLM validators show ~96% true-positive rate but **under
25% true-negative rate** — an "agreeableness bias" that systematically overestimates quality
and rarely flags bad output. "Judging the Judges" (arXiv:2406.12624): judges below ~30B align
weakly with humans, are poorly calibrated and lenient. Stephan et al. (arXiv:2409.04168):
reliable judging needs a ≥10–15 point capability gap over the generator; below that, sub-10B
judges drop to chance on adjudication.
→ **Consequence, and it inverts our first design:** for a SAFETY gate, "rarely flags bad
output" is the worst possible failure mode. So **deterministic triage decides what is
dangerous**, and the model is used mainly to *justify allowing* a flagged action — never as the
sole thing standing between the agent and destruction. Default must be block-on-uncertainty,
because the model's default is approve-on-uncertainty.

**3. Intrinsic self-correction makes things worse.**
Huang et al., ICLR 2024 (arXiv:2310.01798): with no external signal, self-correction degrades
reasoning — GSM8K 75.9 → 75.1 → 74.7; CommonSenseQA **75.8 → 38.1**. With an external
correctness signal it helps a lot (GSM8K 75.9 → 84.3). Earlier positive results leaked oracle
labels by using ground truth to decide *when to stop*. Kamoi et al. (2024) survey: no prior
work demonstrates successful intrinsic self-correction from the model's own feedback alone.
→ **Consequence:** the user asked for "constant re-checking". Implemented naively as the
model re-reading itself, that measurably *hurts*. Every re-verification loop must terminate on
an **external check** — a parse, an exit code, an invariant query, a load test, the anticheat
script. This is what we already do (invariant gate 17/30/8/2/22/17, `node --check`, live plugin
load) and it must stay the rule.

**4. Models can fix an error, but cannot find it.**
Tyen et al. (ACL 2024 Findings): LLMs cannot reliably locate reasoning errors, but *can* correct
them once told where. Later work ("self-correction blind spot") finds models miss errors in
their own output that they would catch in someone else's.
→ **Consequence — the most actionable split in this document:** give LOCALIZATION to cheap
deterministic detectors (regex, parser, diff, invariant query, exit code) and give REPAIR to the
model. Never ask a small model to answer "is anything wrong here?" over a wide surface.

**5. Debate loses to plain voting at equal compute.**
Huang et al. contains a section titled "Multi-Agent Debate Does Not Outperform
Self-Consistency". Smit et al. (arXiv:2311.17371, ICML 2024): MAD does not reliably beat
self-consistency/ensembling and is highly sensitive to the tuned *agent agreement level* — i.e.
its failure mode is conformity. arXiv:2502.08788: MAD often loses to single-agent CoT despite far
more compute; gains appear mainly with **heterogeneous** models. Sycophancy work
(arXiv:2509.23055, arXiv:2509.05396): unconstrained debate drives premature convergence on a
confident wrong majority — minority-correct agents conform.
→ **Consequence:** this is *exactly* the user's Kimi-swarm complaint, with citations. Debate is
therefore a **hypothesis on probation**, not a default. And reviewers must commit their verdicts
**independently, in parallel, with no visibility of each other's output or confidence**, because
that visibility is the channel through which a wrong majority recruits the minority.

**6. Mixing weaker models in can hurt.**
Li et al. (arXiv:2502.00674): **Self-MoA** — resampling the single best model — beats mixed
Mixture-of-Agents by ~6.6% on AlpacaEval 2.0 and ~3.8% average across MMLU/CRUX/MATH. There is
a real quality–diversity tradeoff and dragging in lower-quality proposers degrades the result.
Also, MoA's headline numbers sit on LLM-judge preference benchmarks, not objective ground truth.
→ **Consequence, and it challenges the premise we were given:** "a team of MiMo + DeepSeek" is
not automatically better than "MiMo sampled N times". That is now a **measurable question**, and
we must actually run MiMo×N against the mixed roster at equal token cost before asserting the
mix helps. If Self-MoA wins, we report that, even though it is not the answer that was hoped for.

**7. Voting is undefined over free-form trajectories.**
arXiv:2402.13212: for bash-program prediction with 5 samples, standard self-consistency **fails
to produce any majority action 86% of the time**. Soft-SC (likelihood weighting) recovers
+1.3pp bash / +6.6pp WebShop / +4.7pp ALFWorld.
→ **Consequence:** never vote on plans or trajectories. Vote only where the output space is tiny
and canonical — which is why our reviewers are forced through a fixed schema
(`approved` bool + `severity` enum), a space where majority voting IS well defined.

**8. Judge biases we must design around.**
Zheng et al. (arXiv:2306.05685): position bias (GPT-4 verdict-consistent under answer swap only
~65% of the time; weaker judges far worse — Claude-v1 23.8%), verbosity bias (a repetitive-list
padding attack fooled GPT-3.5/Claude-v1 in 91.3% of cases), self-enhancement bias (+10% for its
own outputs; Claude-v1 +25%). Eiras et al. (arXiv:2503.04474): weak safety judges shift up to
+0.24 false-negative rate under meaning-preserving rephrasing.
→ **Consequence:** never show a reviewer the acting agent's justification — only the proposed
action. Chain-of-Verification (arXiv:2309.11495) found the *joint* variant fails precisely
because a model attending to its own hallucinations repeats them; factored, isolated
verification is what works. Also: judge one action at a time (no A/B ordering to be biased by),
and strip stylistic padding before review.

## Findings that SUPPORT the plan

- **Verifiers really can substitute for scale — when the signal is external.** Cobbe et al.
  (arXiv:2110.14168): a 6B verifier re-ranking 100 samples lifts GSM8K ~20.6% → ~79–88%, roughly
  a 30× effective model-size gain. Lightman et al. (arXiv:2305.20050): process reward beats
  outcome reward beats majority voting (78.2 / 72.4 / 69.6). Caveat: both verifiers were
  separately and heavily trained, not same-family self-judges.
- **Test-time compute genuinely beats a much larger model — on easy/medium items.** Snell et al.
  (arXiv:2408.03314): beats a 14× larger model on easy and medium questions; on the hardest,
  pretraining scale still wins. Honest boundary for our ambition.
- **A heterogeneous panel of small judges beats one big judge.** "Replacing Judges with Juries"
  (arXiv:2404.18796): a panel of 3 smaller judges reaches higher human agreement than a single
  GPT-4 judge at >7× lower cost, because independent biases partially cancel. This is direct
  support for a *diverse* review board over a single reviewer — provided the members stay
  independent (see finding 5).
- **Reflexion/Self-Refine gains are real where an oracle exists.** Reflexion (arXiv:2303.11366):
  HumanEval pass@1 91% vs 80.1%; +22pp AlfWorld. Note its coding gains come from **test
  execution**, not introspection — which is the same lesson as finding 3.

## Honest limits to state up front

1. "An army of free models equals Opus" is **not supported as a general claim.** It is supported
   narrowly: on easy/medium tasks, and on tasks with a cheap external oracle.
2. For open-ended work with no oracle, a small-model swarm mostly buys **cost and latency**, not
   correctness.
3. A swarm **cannot exceed its own pass@k coverage.** If no member ever generates the right
   answer, no amount of aggregation, debate or judging recovers it.
4. Our own measurement already shows a sharper limit than any paper: `nemotron-3-ultra-free`
   passes a single-shot structured-output probe 5/5 but **derails out of the tool-call protocol
   on step two** of a real agent loop and silently stops. Loop stability, not one-shot accuracy,
   is the binding constraint for cheap models — and it produced a **false 🟢** on the safety
   benchmark by doing nothing. Any "more agents is all you need" reasoning must survive that.
