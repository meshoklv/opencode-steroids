/**
 * opencode-steroids — shared type surface.
 *
 * TYPES ONLY. This file must never contain a runtime value: it is imported with
 * `import type` from every other module, and the plugin loader would call any
 * runtime export it found (see FACTS: "the loader calls EVERY export as a plugin").
 * It lives in plugin/lib/ which the loader's `{plugin,plugins}/*.{ts,js}` glob does
 * not reach (one level deep only), but keeping it value-free is a second belt.
 *
 * The first block (Risk … Caller) is the FIXED inter-module contract — do not change
 * a field name or a union member. Everything after it describes SteroidsConfig.
 */

/* ══════════════════════════════════════════════════════════════════════════
 * 1. FIXED CONTRACT — agreed with callmodel.ts / triage.ts / reviewboard.ts /
 *    advisors.ts / steroids.ts. Byte-for-byte as specified.
 * ══════════════════════════════════════════════════════════════════════════ */

export type Risk = "safe" | "review" | "danger"

export type Verdict = {
  approved: boolean
  severity: "none" | "low" | "high" | "critical"
  problem: string
  fix?: string
}

export type Logger = {
  info(m: string, x?: unknown): void
  warn(m: string, x?: unknown): void
  debug(m: string, x?: unknown): void
}

export type CallOpts = {
  system?: string
  prompt: string
  schema?: unknown
  timeoutMs?: number
  agent?: string
}

export type Attempt = { model: string; ms: number; error?: string }

export type CallResult<T = unknown> = {
  ok: boolean
  model?: string
  value?: T
  text?: string
  error?: string
  attempts: Attempt[]
  ms: number
}

export type Caller = {
  call<T = unknown>(chain: string[], opts: CallOpts): Promise<CallResult<T>>
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. SUPPORTING TYPES for SteroidsConfig
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Global behaviour switch.
 * - `off`      — every hook returns immediately, zero tokens, zero latency.
 * - `observe`  — full deterministic classification + logging + a zero-cost advisory note.
 *                Never calls a model, never blocks, never delays.
 * - `enforce`  — the default. Deterministic host rules veto outright; risky calls are
 *                reviewed by the model board inside `tool.execute.before` and can be vetoed.
 * - `paranoid` — like `enforce`, plus a third reviewer on `review` and a fast-gate look at
 *                calls triage rated `safe`. Slow and chatty; for high-stakes sessions only.
 */
export type Mode = "off" | "observe" | "enforce" | "paranoid"

/** Log verbosity. `silent` suppresses everything, including the file sink. */
export type LogLevel = "silent" | "warn" | "info" | "debug"

/**
 * A reviewer/advisor slot. Each role owns one ordered fallback chain in `chains`.
 * `main` is the primary agent's own model preference (advisory — a plugin cannot
 * hot-swap the running agent's model; see the fallback spec §2.5).
 */
export type Role = "gate" | "deep" | "tiebreak" | "panelA" | "panelB" | "panelC" | "main"

/** `"<providerID>/<modelID>"`, e.g. `"opencode/mimo-v2.5-free"`. */
export type ModelRef = string

/** A regex kept as a JSON-safe source string plus optional flags. */
export type PatternSpec = { label: string; source: string; flags?: string }

/** A deterministic command rewrite applied only when `cfg.sanitize` is true. */
export type RewriteSpec = { match: string; flags?: string; replace: string; why?: string }

/** Per-risk-tier review + blocking policy. */
export type TierPolicy = {
  /** false ⇒ no model is ever called for this tier (0 tokens, 0 ms). */
  review: boolean
  /** true ⇒ reviewed inside `tool.execute.before` (can veto); false ⇒ advisory only. */
  blocking: boolean
  /** true ⇒ run the review in `tool.execute.after` / detached; never awaited on the hot path. */
  async: boolean
  /** Fan-out roster for this tier (model refs, run in parallel). */
  reviewers: ModelRef[]
  /** Weighted dissent required to veto. Weights come from `cfg.weights`. */
  blockThreshold: number
  /** Hard off-switch for this tier's veto power, independent of the threshold. */
  canBlock: boolean
  /** Veto as soon as one reviewer dissents, without waiting for the slow ones. */
  earlyVeto: boolean
  /** Wall-clock deadline for the whole fan-out. */
  timeoutMs: number
  /** true ⇒ "no reviewer reachable" blocks; false ⇒ allow + loud banner. */
  failClosed: boolean
  /** Extra models consulted when the quorum is split (tie-breakers). */
  escalateModels: ModelRef[]
  maxEscalations: number
  /** How many advisory notes may be appended to the tool output. */
  maxAdvisories: number
  advisoryMaxChars: number
}

/** Verdict-normalisation rules shared by every tier (anti-false-positive ladder). */
export type QuorumConfig = {
  blockThreshold: number
  /** Only these severities may block; anything else is downgraded to a note. */
  severityFloor: string[]
  /** Only these confidence values may block. */
  confidenceFloor: string[]
  minConsequenceChars: number
  minProblemChars: number
  requireConsequence: boolean
  /** Regex (source, matched case-insensitively) marking a hedged, invalid consequence. */
  invalidConsequencePattern: string
  /** After this many vetoes in one session the board self-demotes to advisory. */
  vetoDemoteAfter: number
  cacheTtlMs: number
  structuredRetryCount: number
  /** true ⇒ an unparseable verdict counts as an error, never as an approval. */
  unknownVerdictIsError: boolean
}

export type BashTriageConfig = {
  /** Read-only allowlist ⇒ Risk "safe" with no model call. */
  safeAllow: string[]
  /** Mutating-but-recoverable ⇒ Risk "review". */
  review: string[]
  /** Irreversible/blast-radius ⇒ Risk "danger". */
  danger: string[]
  /** Written host rules. Deterministic veto, no model, never demoted. */
  hardDeny: string[]
  recursiveSearchCmd: string[]
  recursiveFlags: string[]
  depthLimited: string[]
  bigTreeRoots: string[]
  /** Paths where a mutation is cheap and reversible (temp/scratch/node_modules). */
  scratchPaths: string[]
  sanitizeRewrites: RewriteSpec[]
}

export type PathTriageConfig = {
  fatal: string[]
  high: string[]
  medium: string[]
  /** Regex identifying a test file (shrinking one is suspicious). */
  test: string
  /** Literal path prefixes that must never be written by the agent. */
  protectedWrite: string[]
  /** Risk assigned when a target escapes the worktree. */
  outsideWorktreeRisk: Risk
}

export type ContentTriageConfig = {
  /** Credential-shaped literal appearing in written content. */
  secret: string
  /** `it.only` / `@ts-nocheck` / `describe.skip` being INTRODUCED. */
  testWeakened: string
  /** Validation/authorization identifiers being REMOVED. */
  guardRemoved: string
}

export type DiffTriageConfig = {
  reviewChangedLines: number
  dangerChangedLines: number
  reviewFiles: number
  dangerFiles: number
  deleteFileOpsDanger: number
  netDeletionHigh: number
  removedHigh: number
  removedMedium: number
  addedMedium: number
  truncateRewriteMinOld: number
  truncateRewriteRatio: number
  newFileMediumLines: number
  wholesaleDeleteLines: number
  testShrinkNetLines: number
}

export type TriageConfig = {
  /** Tools that are never reviewed (reads cannot break anything). */
  ignoreTools: string[]
  mutatingTools: string[]
  fileTools: string[]
  /** Tools that are at least Risk "review" regardless of their args. */
  reviewTools: string[]
  bash: BashTriageConfig
  paths: PathTriageConfig
  content: ContentTriageConfig
  diff: DiffTriageConfig
  /** Glob-ish strings that bypass "danger"; mirrors the live allow-file. */
  allowGlobs: string[]
  summaryMaxChars: number
  diffPreviewLines: number

  /* ── flat mirrors ────────────────────────────────────────────────────────
   * triage.ts resolves its knobs as `cfg.triage.<key>` first, then `cfg.<key>`.
   * These are DERIVED by loadConfig() from `redaction.*` / `summaryMaxChars` —
   * edit the canonical block, not these. */
  redact: "off" | "standard" | "paranoid"
  redactMaxHits: number
  extraSecrets: string[]
  entropyThreshold: number
  maxSummaryChars: number
  maxCommandChars: number
  maxPatchExcerpt: number
  /** true ⇒ do not hard-deny an unbounded recursive search over a huge tree. */
  allowBigTreeSearch: boolean
}

/**
 * Knobs read by callmodel.ts as `cfg.caller.*`. Several are mirrors of the canonical
 * blocks (`quarantined`, `reviewer.disabledTools`, `paid.enabled`, `breaker.*`,
 * `budget.maxPromptChars`) and are re-derived by loadConfig() on every load.
 */
export type CallerConfig = {
  /** Per-model call deadline. */
  timeoutMs: number
  /** Deadline for walking the whole chain. */
  chainBudgetMs: number
  maxAttempts: number
  breakerFails: number
  benchLadderMs: number[]
  soBenchMs: number
  rateLimitBenchMs: number
  probeCooldownMs: number
  edgeBanCooldownMs: number
  authDeadCooldownMs: number
  slowSkipFactor: number
  retryDelayServerMs: number
  retryDelaySchemaMs: number
  maxPromptChars: number
  /** `format.retryCount` for structured output. */
  retryCount: number
  /** "" ⇒ send an explicit `system` instead of an agent name (safe when no lean
   *  reviewer agent is defined in opencode.json; NEVER leave both empty). */
  agent: string
  sessionTitlePrefix: string
  /** Provider used when a chain entry has no "provider/" prefix. */
  defaultProvider: string
  quarantined: ModelRef[]
  disabledTools: string[]
  /** Persist breaker health to `stateDir`. */
  persist: boolean
  stateDir: string
  paidEnabled: boolean
  maxPaidCalls: number
}

export type RedactionConfig = {
  level: "off" | "standard" | "paranoid"
  /** More hits than this in one payload ⇒ abandon the review rather than send it. */
  maxHits: number
  maxPayloadBytes: number
  headBytes: number
  tailBytes: number
  dropContextLinesWhenParanoid: boolean
  /** Literal secrets known to this host; each is regex-escaped before use. */
  extraSecrets: string[]
  /** Commands whose OUTPUT must never be forwarded, only the command itself. */
  withheldOutputCommands: string[]
  /** Paths whose CONTENT must never be forwarded, only the path. */
  pathBlocklist: string[]
  patterns: PatternSpec[]
  entropy: {
    enabled: boolean
    minLength: number
    minBitsPerChar: number
    charClass: string
  }
  /** `$LABEL` is substituted with the matched rule's label. */
  replacement: string
}

export type BudgetConfig = {
  maxPerSession: number
  maxPerMin: number
  maxPerMinSession: number
  maxConcurrent: number
  queueWaitMs: number
  maxSpendUsd: number
  maxSpendUsdTotal: number
  assumedCostUsd: number
  timeoutMs: number
  timeoutMsEscalate: number
  maxDepth: number
  maxPayloadBytes: number
  maxPromptChars: number
  dangerReserve: number
  maxBlockingPerSession: number
  maxCumulativeReviewMs: number
  maxAsyncInFlight: number
  asyncQueueDepth: number
  cacheTtlMs: number
  selfErrorsMax: number
  reviewerSessionGraceMs: number
  seenTtlMs: number
  seenMax: number
  resolveCacheMax: number
  rootCacheMax: number
  bannerFullCount: number
  bannerEveryNth: number
}

export type BreakerConfig = {
  failuresToBench: number
  /** Bench ladder in ms; each re-bench promotes one rung, last rung is the cap. */
  benchLadderMs: number[]
  soFailuresToBench: number
  soBenchMs: number
  rateLimitBenchMs: number
  promoteWindowMs: number
  probationPerRoleMs: number
  /** Skip a model for a role when ewma latency exceeds factor × role budget. */
  latencySkipFactor: number
  ewmaAlpha: number
  serverRetryDelayMs: number
  serverRetryJitterMs: number
  schemaRetryDelayMs: number
  emptyRetryDelayMs: number
  /** UA to force after a Cloudflare 1010; `Python-urllib/*` is banned at the edge. */
  edgeBanUserAgent: string
  saveDebounceMs: number
}

export type PaidConfig = {
  enabled: boolean
  /** Paid baseURL provider id. `*-free` ids 401 here — never pair them. */
  provider: string
  freeProvider: string
  maxPerSession: number
  maxPerHour: number
  /** Paid slots reserved for `main`; reviewers may not consume them. */
  reservedForMain: number
  maxInputChars: number
  maxOutputTokens: number
  retries: number
  /** Which risk tiers may spend money, per role. Empty array ⇒ never. */
  allowTiers: Record<Role, Risk[]>
  fallbackMap: Record<string, ModelRef>
  priceUsdPerMTok: Record<string, { input: number; output: number }>
}

export type ReviewerConfig = {
  /** Lean agent for reviewer sessions. Omitting it inherits `lead` = 31 084 tokens. */
  agent: string
  /** Title marker so reviewer sessions stay identifiable across a restart. */
  sessionTitlePrefix: string
  structuredRetryCount: number
  /** Max `parentID` hops walked when resolving taint. */
  maxDepth: number
  /** Every id here is sent as `tools:{id:false}`. NEVER send `{"*":false}`. */
  disabledTools: string[]
  /** Tool ids that must stay enabled — `StructuredOutput` carries the verdict. */
  neverDisable: string[]
  /** Fallback `system` when the lean agent does not exist. */
  systemFallback: string
}

/**
 * One advisor persona. `free[0]` is that persona's identity model — the panel's whole value
 * is that two personas never share a primary model, so keep the first entries distinct.
 * Every id must appear in FACTS.md's verified list.
 */
export type PersonaConfig = {
  /** One line, shown to the agent in the tool description. */
  speciality: string
  /** Free candidates in order; `free[0]` is the identity model. */
  free: ModelRef[]
  /** Paid `opencode-go` tail, appended ONLY when `advisors.paidFallback` is true. */
  paid: ModelRef[]
  /** Per-call deadline for this persona. */
  timeoutMs: number
  /** This persona's lens. The shared preamble is prepended at call time. */
  lens: string
}

/**
 * Knobs read by advisors.ts as `cfg.advisors.*`. Field names are the contract — advisors.ts
 * reads exactly these and nothing else.
 */
export type AdvisorConfig = {
  enabled: boolean
  /** Persona names seated by `advisor_panel` when the agent does not pass `who`. */
  panel: string[]
  /** Persona names seated by `advisor_debate`. Defaults to `panel`. */
  debatePanel: string[]
  /** Overrides merged key-by-key over the six built-in personas. New keys add personas. */
  personas: Record<string, Partial<PersonaConfig>>
  /** Hard cap on advisor model calls per agent session. */
  maxCallsPerSession: number
  /** Hard cap on `advisor_panel` + `advisor_debate` invocations per agent session. */
  maxPanelsPerSession: number
  /** Process-wide cap on concurrent advisor tool calls (runaway/recursion guard). */
  maxConcurrentToolCalls: number
  /** true ⇒ a persona may fall back to its paid `opencode-go` tail. */
  paidFallback: boolean
  /** true ⇒ merge the panel's answers with one extra structured call. */
  synthesize: boolean
  synthesizerChain: ModelRef[]
  /** Cap on the `context` argument the agent may forward to an advisor. */
  maxContextChars: number
  /** Cap on each advisor's answer. */
  maxAnswerChars: number
  /** Lean agent for advisor sessions. Omit unless that agent exists in opencode.json. */
  agent?: string
  debug: boolean
}

/**
 * Knobs read by reviewboard.ts as `cfg.board.*`. Keyed by LENS
 * (IRREVERSIBLE | INTENT | HOST | SECRETS | SCOPE), not by Role — the board seats lenses,
 * while `cfg.chains` seats roles for the advisors and the main agent.
 */
export type BoardConfig = {
  /** Weighted dissent required to veto. */
  blockThreshold: number
  /** Blocking weight per model; 0 ⇒ advisory only, can never veto. Merged over the built-ins. */
  weights: Record<string, number>
  /** Free candidate chain per lens. */
  chains: Record<string, ModelRef[]>
  /** Paid tail per lens, appended only on the `danger` tier and only if `paidFallback`. */
  paidTail: Record<string, ModelRef[]>
  /** Tie-breakers consulted when exactly one deep reviewer blocks with severity critical. */
  escalationChain: ModelRef[]
  timeoutMs: { advisory: number; review: number; danger: number; escalate: number }
  /** "" ⇒ send an explicit `system` instead of an agent name. Set this ONLY to an agent
   *  that really exists in opencode.json, otherwise every reviewer call fails. */
  reviewerAgent: string
  maxPayloadChars: number
  cacheTtlMs: number
  /** After this many vetoes the board self-demotes to advisory for the rest of the session. */
  maxVetoesPerSession: number
  maxReviewsPerSession: number
  maxCumulativeReviewMs: number
  advisoryMaxItems: number
  advisoryMaxChars: number
  /** Veto as soon as the threshold is reached, without waiting for the slow reviewers. */
  earlyVeto: boolean
  escalateOnCriticalDissent: boolean
  /** true ⇒ always seat a fourth reviewer on the danger tier. */
  escalate: boolean
  /** true ⇒ "no reviewer reachable" blocks a danger-tier call. */
  failClosedOnDanger: boolean
  paidFallback: boolean
  /** Literal secrets to scrub from a reviewer payload, on top of the built-in patterns. */
  extraSecrets: string[]
}

export type LoggingConfig = {
  level: LogLevel
  file: string
  stderr: boolean
  maxBytes: number
  jsonl: boolean
  maxFieldChars: number
}

export type PathsConfig = {
  stateDir: string
  /** Read-only source of user overrides. NOTHING is ever written here. */
  configFile: string
  logFile: string
  ledgerFile: string
  healthFile: string
  allowFile: string
  offFile: string
  pauseFile: string
  /** Any of these existing ⇒ hard off. Checked live, no restart needed. */
  killFiles: string[]
  /** Memo window for the sentinel-file stats, so it is one stat per N ms. */
  sentinelTtlMs: number
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. SteroidsConfig — what loadConfig() returns
 * ══════════════════════════════════════════════════════════════════════════ */

export type SteroidsConfig = {
  /** Schema version of this config object. */
  version: number
  /** Master switch. false ⇒ every hook returns immediately. */
  enabled: boolean
  mode: Mode
  /** Allow the slow escalation model (north-mini, ~52 s) into blocking paths. */
  escalate: boolean
  /** Enable deterministic command rewrites (bash.sanitizeRewrites). */
  sanitize: boolean

  /** Ordered free-first / paid-last fallback chain per role. */
  chains: Record<Role, ModelRef[]>
  /** Blocking weight per model. 0 ⇒ advisory only, can never veto. */
  weights: Record<string, number>
  /** Never called unless explicitly probed (e.g. a model that only ever 429'd). */
  quarantined: ModelRef[]
  contextWindow: Record<string, number>
  /** Measured average latency, used for budget/latency demotion decisions. */
  expectedLatencyMs: Record<string, number>

  tiers: Record<Risk, TierPolicy>
  quorum: QuorumConfig
  board: BoardConfig
  triage: TriageConfig
  redaction: RedactionConfig
  budget: BudgetConfig
  breaker: BreakerConfig
  paid: PaidConfig
  caller: CallerConfig

  /** Derived from `redaction.level` — read-only mirror for triage.ts. */
  redact: "off" | "standard" | "paranoid"
  /** Derived from `redaction.extraSecrets` — read-only mirror for triage.ts. */
  extraSecrets: string[]

  /** Per-call deadline per role. */
  roleBudgetMs: Record<Role, number>
  /** Whole-chain deadline per role. */
  chainBudgetMs: Record<Role, number>

  reviewer: ReviewerConfig
  advisors: AdvisorConfig
  logging: LoggingConfig
  paths: PathsConfig

  /** Derived from `paid.enabled` — read-only mirror for reviewboard.ts. */
  paidFallback: boolean

  /* ── injected at runtime by steroids.ts, NOT settable from steroids.json ──
   * These are how the entry plugin hands per-instance facts to the libs. */
  /** Project worktree root, from PluginInput. triage.ts uses it to spot escapes. */
  worktree?: string
  /** Session directory, from PluginInput. Fallback for `worktree`. */
  directory?: string
  /** Session ids the plugin itself created. Recursion guard for advisors.ts. */
  ownSessions?: Set<string>
  /** Same set under the name callmodel.ts looks for. */
  reviewerSessions?: Set<string>

  /** Forward compatibility: unknown keys from steroids.json survive the merge. */
  [extra: string]: unknown
}
