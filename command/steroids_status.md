---
description: Review board status: mode, vetoes, model health, kill switch
---
Below is the raw state of the opencode-steroids plugin. Analyse it and report to the human.

KILL SWITCH (if a file exists here the board is OFF entirely, no restart needed):
!`ls -la "${OCREV_STATE_DIR:-$HOME/.local/state/ocrev}/OFF" /tmp/review-board.off /tmp/rb.off 2>/dev/null || echo "kill switch not set - board is active"`

ENVIRONMENT OVERRIDES (empty = everything comes from the config):
!`env | grep -E '^(OCREV|STEROIDS)_' | sort || true; echo "---"; ls -la "$HOME/.config/opencode/steroids.json" 2>/dev/null || echo "no override file - defaults apply"`

LAST PLUGIN LOADS (mode, workspace, registered tools):
!`grep -h '\[steroids\] loaded' "${OCREV_STATE_DIR:-$HOME/.local/state/ocrev}/steroids.jsonl" 2>/dev/null | tail -3 || echo "no log: the plugin never loaded, or logging.level=silent, or the path differs"`

PREFLIGHT FAILURES AND WARNINGS (this should be EMPTY):
!`grep -hE 'PREFLIGHT|DISABLED|preflight warning' "${OCREV_STATE_DIR:-$HOME/.local/state/ocrev}/steroids.jsonl" 2>/dev/null | tail -5 || true`

WHAT THE BOARD DECIDED (latest vetoes, hard denies and degradations):
!`grep -hE 'HARD DENY|VETO|\[board\] (VETO|DEGRADED)|too secret' "${OCREV_STATE_DIR:-$HOME/.local/state/ocrev}/steroids.jsonl" 2>/dev/null | tail -10 || echo "no vetoes"`

COUNTS (whole log):
!`L="${OCREV_STATE_DIR:-$HOME/.local/state/ocrev}/steroids.jsonl"; if [ -f "$L" ]; then printf 'triages: %s\nallowed by board: %s\nboard vetoes: %s\nhard denies: %s\nplugin-internal errors: %s\nlog size: %s\n' "$(grep -c 'steroids\] triage' "$L")" "$(grep -c 'board\] allowed' "$L")" "$(grep -c 'steroids\] VETO' "$L")" "$(grep -c 'HARD DENY' "$L")" "$(grep -cE 'hook failed|internal error' "$L")" "$(wc -c <"$L")"; else echo "no log"; fi`

MODEL HEALTH (circuit breaker: who is benched and until when):
!`cat "${OCREV_STATE_DIR:-$HOME/.local/state/ocrev}/health.json" 2>/dev/null | head -60 || echo "no health file - no model call has been made yet"`

PAID CALLS (should be empty or rare - the free tier is the main path):
!`tail -5 "${OCREV_STATE_DIR:-$HOME/.local/state/ocrev}/paid-ledger.jsonl" 2>/dev/null || echo "no paid calls"`

Report SHORTLY, in plain language, in emoji-headed sections:

1. ✅ **Alive or not** - mode (`off`/`observe`/`enforce`/`paranoid`), whether the kill switch is set, whether the advisors are registered (`advisor`, `advisor_panel`, `advisor_debate`).
2. ⚠️ **Preflight failures** - if any, this is THE point: the board disabled itself and the session runs unguarded. Quote the reason verbatim.
3. 🛑 **What was blocked** - how many vetoes and hard denies, and what the latest ones were for. A hard deny is a written deterministic rule; no model was consulted.
4. 🐢 **Model health** - who the circuit breaker benched and why (timeout, 401, rate limit), and whether any chain is left without live candidates.
5. 💸 **Paid** - how many times it fell back to the paid `opencode-go`.
6. 🔧 **What to do** - if something is wrong, name ONE concrete action (clear the kill switch, fix the config JSON, raise a timeout, `mode: observe` to stop interfering).

If there is no log at all, say so plainly: the plugin did not load or writes elsewhere; suggest checking `plugin/` in the config directory and `logging.level`.
