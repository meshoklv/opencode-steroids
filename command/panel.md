---
description: Advisor panel on DIFFERENT models - where they agree, where they disagree
---
Question for the panel: $ARGUMENTS

Call the `advisor_panel` tool ONCE. Fill the arguments honestly, otherwise the advisors answer with fluff:

- `question` - one sentence: which decision has to be made. Not "help with the task", but a concrete choice.
- `blocker` - what exactly stops you RIGHT NOW (specifics, not a retelling of the task).
- `attempted` - what you already tried yourself and what happened. At least one real attempt is required: advisors without your attempt are useless.
- `context` - a short digest: the relevant code, the error text, the constraints. Secrets are stripped automatically, but do not paste anything extra.
- `who` - optional (the default panel sits). Or list them comma-separated: `architect`, `debugger`, `security`, `skeptic`, `simplifier`, `perf`, or `all`.

Every advisor runs on ITS OWN model and looks only through its own lens. Then:

1. Read the DISAGREEMENTS block first - agreement between models carries little information, the value is in the argument.
2. For each disagreement, say whose position applies to OUR code specifically, and why - you are the only one who can see the repository.
3. Give a verdict: what we do, what we deliberately do NOT do, and which step stays reversible.
4. If a disagreement stays unresolved, pick the reversible option and say so plainly.

Do not present their text as verified fact: the advisors did not see the repository and did not run code. The decision and the responsibility are yours. If you need a two-round argument where they may change position, use `advisor_debate` instead of the panel (roughly twice the cost).
