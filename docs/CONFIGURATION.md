# Configuration reference

Everything lives in **`~/.config/opencode/steroids.json`**. Every key is optional. Precedence:

```
built-in defaults  <  steroids.json  <  OCREV_* / STEROIDS_* env  <  kill files
```

Objects merge key-by-key; **arrays replace the default array wholesale**; keys starting with
`//` are ignored, so you can comment your file. [`steroids.json`](../steroids.json) in this repo is generated from
the defaults and carries a long `//` header describing every block — copy it and delete what
you do not want to change. **Nothing is ever written into `~/.config/opencode/`.**

### Master switches

| key | default | what it does |
|---|---|---|
| `enabled` | `true` | `false` ⇒ every hook returns immediately |
| `mode` | `enforce` | `off` \| `observe` (classify+log+annotate, no model, no delay) \| `enforce` \| `paranoid` (adds a third reviewer on the review tier and a fast-gate look at calls rated safe) |
| `escalate` | `false` | allow the slow ~52 s escalation model into blocking paths |
| `sanitize` | `false` | apply `triage.bash.sanitizeRewrites` instead of only judging |
| `paidFallback` | `true` | mirror of `paid.enabled`; may the board fall back to paid |
| `allowUnverifiedModels` | absent | `true` ⇒ preflight only *warns* about a model id it cannot verify instead of disabling the plugin. Use when Zen adds a model |
| `protocolFile` | absent | path to a file replacing the injected data protocol |
| `version` | `1` | schema version of the config object |

### Which models do what

| key | shape | notes |
|---|---|---|
| `chains` | `{gate, deep, tiebreak, panelA, panelB, panelC, main: [id,…]}` | ordered fallback per role, free first and paid last. **Never put a `*-free` id under `opencode-go`** — it returns 401. `main` is the agent-loop role and has a higher bar than reviewing |
| `weights` | `{id: number}` | blocking power. `0` ⇒ advisory only, can never veto |
| `quarantined` | `[id,…]` | never called unless explicitly probed |
| `contextWindow`, `expectedLatencyMs` | `{id: number}` | measured facts used for routing and latency demotion |
| `roleBudgetMs`, `chainBudgetMs` | `{role: ms}` | per-call and whole-chain deadline per role |

### `tiers.safe` / `tiers.review` / `tiers.danger`

Per-risk policy. `review` (call a model at all), `blocking` (veto inside
`tool.execute.before`), `async` (annotate afterwards instead), `canBlock` (hard off-switch for
veto power), `failClosed` (block when no reviewer answered — on by default for `danger` only),
`blockThreshold`, `earlyVeto`, `timeoutMs`, `reviewers`, `escalateModels`, `maxEscalations`,
`maxAdvisories`, `advisoryMaxChars`.

### `quorum` — the anti-false-positive ladder

`blockThreshold`, `severityFloor` (only `high`/`critical` may block), `confidenceFloor` (a
low-confidence block counts as a note), `requireConsequence`, `minConsequenceChars`,
`minProblemChars`, `invalidConsequencePattern` (hedging words invalidate a block),
`vetoDemoteAfter` (after N vetoes the board self-demotes to advisory for that session),
`cacheTtlMs`, `structuredRetryCount`, `unknownVerdictIsError` (an unparseable verdict is never
an approval).

### `board` — the review board itself

Keyed by **lens** (`IRREVERSIBLE`, `INTENT`, `HOST`, `SECRETS`, `SCOPE`), not by role.

| key | notes |
|---|---|
| `chains` | which models sit on each lens |
| `paidTail` | paid models appended per lens, only on the `danger` tier and only if `paidFallback` |
| `escalationChain` | tie-breakers when exactly one deep reviewer blocks with severity `critical` |
| `timeoutMs` | `{advisory, review, danger, escalate}` |
| `reviewerAgent` | **`""` by default, and that is the safe value.** A name that does not exist in `opencode.json` makes *every* reviewer call fail. Set it to `"reviewer"` only after installing an agent by that name |
| `maxPayloadChars`, `cacheTtlMs`, `maxReviewsPerSession`, `maxVetoesPerSession`, `maxCumulativeReviewMs`, `advisoryMaxItems`, `advisoryMaxChars` | budgets and caps |
| `earlyVeto`, `escalateOnCriticalDissent`, `escalate`, `failClosedOnDanger`, `paidFallback` | behaviour flags |
| `extraSecrets` | literal strings to scrub from a reviewer payload |

Most of these are **re-derived on every load** from `weights`, `quorum`, `tiers`, `budget`,
`redaction` and `paid` — edit those, not the copies.

### `triage` — the free classifier

`ignoreTools`, `mutatingTools`, `fileTools`, `reviewTools`, `allowGlobs`, and the rule groups
`bash` (`safeAllow`, `review`, `danger`, `hardDeny`, `recursiveSearchCmd`, `recursiveFlags`,
`depthLimited`, `bigTreeRoots`, `scratchPaths`, `sanitizeRewrites`), `paths`, `content`,
`diff`. Size/redaction knobs actually read at runtime: `maxSummaryChars` (`summaryMaxChars`),
`maxCommandChars`, `maxPatchExcerpt`, `redact`, `redactMaxHits`, `extraSecrets`,
`entropyThreshold`, `diffPreviewLines`, and **`allowBigTreeSearch`** (`true` un-blocks an
unbounded recursive search over a huge tree — the rule that exists because such a search once
consumed 3.5 GB in 4 minutes on a shared host; leave it `false`).

### `redaction` — what must never leave the machine

`level` (`off`/`standard`/`paranoid`), `maxHits` (more secret-shaped hits than this and the
review is abandoned rather than sent), `maxPayloadBytes`, `headBytes`, `tailBytes`,
`dropContextLinesWhenParanoid`, `extraSecrets`, `withheldOutputCommands` (commands whose
*output* is never forwarded), `pathBlocklist` (paths whose *content* is never forwarded),
`patterns`, `entropy` (`enabled`, `minLength`, `minBitsPerChar`, `charClass`), `replacement`.
This block is canonical; `redact`, `extraSecrets` and the flat `triage.*` mirrors are derived
from it.

### `budget`, `breaker`, `caller`

- **`budget`** — rate, spend, depth and latency caps: `maxPerSession`, `maxPerMin`,
  `maxPerMinSession`, `maxConcurrent`, `queueWaitMs`, `maxSpendUsd`, `maxSpendUsdTotal`,
  `assumedCostUsd`, `timeoutMs`, `timeoutMsEscalate`, `maxDepth`, `maxPayloadBytes`,
  `maxPromptChars`, `dangerReserve`, `maxBlockingPerSession`, `maxCumulativeReviewMs`,
  `maxAsyncInFlight`, `asyncQueueDepth`, `cacheTtlMs`, `selfErrorsMax`,
  `reviewerSessionGraceMs`, `seenTtlMs`, `seenMax`, `resolveCacheMax`, `rootCacheMax`,
  `bannerFullCount`, `bannerEveryNth`.
- **`breaker`** — per-model circuit breaker: `failuresToBench`, `benchLadderMs` (each
  re-failure promotes a rung), `soFailuresToBench`, `soBenchMs`, `rateLimitBenchMs`,
  `promoteWindowMs`, `probationPerRoleMs`, `latencySkipFactor`, `ewmaAlpha`,
  `serverRetryDelayMs`, `serverRetryJitterMs`, `schemaRetryDelayMs`, `emptyRetryDelayMs`,
  `saveDebounceMs`, and `edgeBanUserAgent` — the UA to switch to after a Cloudflare 1010,
  because `Python-urllib/*` is banned at the edge.
- **`caller`** — low-level call knobs: `timeoutMs`, `chainBudgetMs`, `maxAttempts`,
  `retryCount`, `maxPromptChars`, `defaultProvider`, `agent`, `sessionTitlePrefix`,
  `disabledTools`, `persist`, `stateDir`, `paidEnabled`, `maxPaidCalls`, plus cooldowns
  (`probeCooldownMs`, `edgeBanCooldownMs`, `authDeadCooldownMs`) and `slowSkipFactor`. The
  duplicated ones mirror `quarantined` / `reviewer.disabledTools` / `paid.*` / `breaker.*` and
  are re-derived on load.

### `paid` — when the subscription may be spent

`enabled`, `provider` (`opencode-go`), `freeProvider` (`opencode`), `maxPerSession`,
`maxPerHour`, `reservedForMain` (paid slots reviewers may not consume), `maxInputChars`,
`maxOutputTokens`, `retries`, `allowTiers` (which risk tiers may spend, per role — empty array
means never; the fast gate never spends), `fallbackMap` (free id → paid replacement),
`priceUsdPerMTok`.

### `reviewer`, `advisors`, `logging`, `paths`

- **`reviewer`** — `agent` (see `board.reviewerAgent`; `""` is safe, a wrong name breaks every
  review), `sessionTitlePrefix`, `structuredRetryCount`, `maxDepth`, `disabledTools` (sent as
  `tools:{id:false}` — **never** send `{"*":false}`), `neverDisable` (must include
  `StructuredOutput`, which is how the verdict arrives), `systemFallback`.
- **`advisors`** — `enabled`, `panel` and `debatePanel` (**persona names**, not roles: a name
  with no persona behind it is silently dropped), `personas` (merged key-by-key over the six
  built-ins `architect`/`debugger`/`security`/`skeptic`/`simplifier`/`perf`; a new key adds a
  new advisor; each takes `speciality`, `free`, `paid`, `timeoutMs`, `lens`),
  `maxCallsPerSession`, `maxPanelsPerSession`, `maxConcurrentToolCalls`, `paidFallback`,
  `synthesize`, `synthesizerChain`, `maxContextChars`, `maxAnswerChars`, `agent`, `debug`.
  **Keep every persona's first `free` model distinct** — one model per advisor is the whole
  point.
- **`logging`** — `level` (`silent`/`warn`/`info`/`debug`), `file`, `stderr` (mirror warnings
  to stderr), `maxBytes` (rotate), `jsonl`, `maxFieldChars`.
- **`paths`** — `stateDir`, `configFile`, `logFile`, `ledgerFile`, `healthFile`, `allowFile`,
  `offFile`, `pauseFile`, `killFiles` (any existing ⇒ hard off), `sentinelTtlMs` (how often
  the kill files are re-checked).

### Environment overrides

`OCREV_MODE` (`STEROIDS_MODE`, `REVIEW_BOARD`, `RB`) · `OCREV_CONFIG` (`STEROIDS_CONFIG`) ·
`OCREV_STATE_DIR` (`STEROIDS_STATE_DIR`) · `OCREV_LOG_LEVEL`, `OCREV_LOG_FILE`,
`OCREV_LOG_STDERR` · `OCREV_ADVISORS` / `STEROIDS_ADVISORS` ·
`STEROIDS_ADVISOR_MAX_CALLS` · `STEROIDS_PAID` · `OCREV_TIMEOUT_MS` ·
`OCREV_TIER_SAFE` / `OCREV_TIER_REVIEW` / `OCREV_TIER_DANGER` / `OCREV_DANGER`
(`off` | `advise` | `enforce`) · `STEROIDS_NESTED=1` (disables advisors inside a nested run).
