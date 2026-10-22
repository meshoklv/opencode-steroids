/**
 * lib/advisors.ts — THE MULTI-ADVISOR PANEL
 *
 * Headline feature: several independent advisors, each pinned to a DIFFERENT free
 * OpenCode Zen model, each with its own lens. Disagreement between them is the
 * product — it is the signal the calling agent cannot get from one model.
 *
 * Public surface (nothing else is exported):
 *   makeAdvisorTools(caller, cfg, log) -> { advisor, advisor_panel, advisor_debate }
 *
 * Every model call goes through `caller.call(chain, opts)` (lib/callmodel.ts) — this
 * file never touches `client` and never creates a session itself.
 *
 * Hard rules honoured here:
 *  - NEVER throws. Every failure path returns an informative "[advisor unavailable: …]"
 *    string so the calling agent keeps working.
 *  - Only model ids from FACTS.md are used (6 working free ids + the paid opencode-go
 *    ids). Nothing invented.
 *  - No top-level side effects beyond pure definitions (module-level Maps/Sets used as
 *    per-process budget state, bounded and pruned).
 */

import type { Caller, CallResult, Logger } from "./types.ts"

/**
 * `tool` (and its `tool.schema` = zod) comes from @opencode-ai/plugin. That package is a
 * real node_modules dependency, so it resolves in the global opencode config dir but is NOT
 * guaranteed to resolve for a plugin dropped into an arbitrary project's `.opencode/plugin/`.
 * A failed STATIC import would abort loading the whole plugin, so it is imported lazily and
 * a failure only costs us the three advisor tools.
 */
async function loadToolHelper(log: Logger): Promise<any> {
  try {
    const mod: any = await import("@opencode-ai/plugin")
    return mod?.tool
  } catch (e: any) {
    log.warn(`[advisors] @opencode-ai/plugin not resolvable here (${e?.message ?? e}) — advisor tools NOT registered`)
    return undefined
  }
}

/* ────────────────────────────── logging helper ───────────────────────────── */

function mkLog(log: any): Logger {
  const safe = (fn: any) => (m: string, x?: unknown) => {
    try {
      if (typeof fn === "function") fn(m, x)
    } catch {
      /* a logger must never break a tool call */
    }
  }
  const l: any = log && typeof log === "object" ? log : {}
  return {
    info: safe(l.info ? l.info.bind(l) : undefined),
    warn: safe(l.warn ? l.warn.bind(l) : undefined),
    debug: safe(l.debug ? l.debug.bind(l) : undefined),
  }
}

/* ─────────────────────────────── persona table ───────────────────────────── */

type Persona = {
  name: string
  speciality: string
  /** free candidates, in order. First = this persona's identity model. */
  free: string[]
  /** paid opencode-go candidates, appended only when cfg.advisors.paidFallback === true */
  paid: string[]
  /** per-call deadline for this persona (ms) */
  timeoutMs: number
  /** lens/system prompt (SHARED_PREAMBLE is prepended at call time) */
  lens: string
}

const SHARED_PREAMBLE = [
  "You are ONE advisor on a panel of independent advisors. Each advisor runs on a",
  "DIFFERENT model and sees the same question. A coding agent is blocked and asked us.",
  "",
  "HOW TO ANSWER:",
  '- First line MUST start with "RECOMMEND: " followed by ONE concrete course of action',
  "  in a single sentence. Everything after that first line is your reasoning.",
  "- Then at most 5 short numbered steps. Total answer under 200 words. Be terse.",
  "- Answer ONLY through your lens (below). Do not try to cover every angle — other",
  "  advisors cover the others. Staying narrow is what makes this panel useful.",
  "- If you disagree with the obvious or default approach, SAY SO EXPLICITLY and say why.",
  "  Honest disagreement is the whole point of this panel; agreeing to be agreeable is",
  "  worse than useless.",
  "- Never invent facts about code, files or systems you were not shown. If the decisive",
  '  information is missing, write one line starting with "NEED: " naming exactly what is',
  "  missing, then give your best conditional advice anyway.",
  "- You have NO tools. Do not ask to run commands, do not claim you inspected anything.",
  "- Short snippets only (a few lines). Never output a whole file.",
].join("\n")

const PERSONAS: Record<string, Persona> = {
  architect: {
    name: "architect",
    speciality: "system design, boundaries, sequencing, long-term consequences",
    free: ["opencode/nemotron-3-ultra-free", "opencode/big-pickle", "opencode/north-mini-code-free"],
    paid: ["opencode-go/deepseek-v4-pro"],
    timeoutMs: 60000,
    lens: [
      "YOUR LENS: ARCHITECTURE. Judge the SHAPE of the solution, not its syntax.",
      "Ask: where does this responsibility belong; what will this decision force us to do",
      "later; which boundary is being crossed; is there a simpler decomposition; what is",
      "the migration/rollback path. Prefer the option that keeps the blast radius small and",
      "the number of moving parts low. Call out coupling that will hurt in a month.",
    ].join("\n"),
  },
  debugger: {
    name: "debugger",
    speciality: "root cause of a concrete failure",
    free: ["opencode/mimo-v2.5-free", "opencode/nemotron-3-ultra-free", "opencode/big-pickle"],
    paid: ["opencode-go/mimo-v2.5"],
    timeoutMs: 45000,
    lens: [
      "YOUR LENS: ROOT CAUSE. Assume the surface explanation is wrong.",
      "Ask: what is the exact mechanism that produces the observed symptom; what is",
      "silently swallowing an error, returning a default, shadowing a name, or running in",
      "the wrong order; what single cheap experiment would DISCRIMINATE between the two",
      "most likely causes. Name the mechanism, then name that one experiment. Do not",
      "propose a fix before you have named a mechanism.",
    ].join("\n"),
  },
  security: {
    name: "security",
    speciality: "safety, blast radius, secrets, irreversibility",
    free: ["opencode/north-mini-code-free", "opencode/mimo-v2.5-free", "opencode/big-pickle"],
    paid: ["opencode-go/mimo-v2.5-pro"],
    timeoutMs: 90000,
    lens: [
      "YOUR LENS: SAFETY AND BLAST RADIUS. Ask one question: if this is wrong, what cannot",
      "be undone? Look for destroyed uncommitted work, overwritten live config, leaked",
      "credentials, data sent to a third party, a shared host taken down by an unbounded",
      "scan or build, processes killed by a broad pattern, auth checks removed, tests",
      "disabled. Name the irreversible consequence concretely (which file, which key,",
      "which host) and give the cheapest way to make the step reversible first.",
      "Ignore style. Only consequences.",
    ].join("\n"),
  },
  skeptic: {
    name: "skeptic",
    speciality: "adversarial review of the plan itself",
    free: ["opencode/big-pickle", "opencode/nemotron-3-ultra-free", "opencode/ling-3.0-flash-free"],
    paid: ["opencode-go/hy3"],
    timeoutMs: 45000,
    lens: [
      "YOUR LENS: SKEPTIC. Your job is to be the dissenting voice.",
      "Attack the framing: is the stated problem the real problem; is the question hiding",
      "an assumption that is probably false; what would make this whole approach the wrong",
      "one; what is the failure mode nobody mentioned; what is the cheapest way to find out",
      "we are wrong BEFORE doing the work. If you genuinely see no problem, say so in one",
      "line and name the single riskiest assumption anyway.",
    ].join("\n"),
  },
  simplifier: {
    name: "simplifier",
    speciality: "the smallest thing that could possibly work",
    free: ["opencode/ling-3.0-flash-free", "opencode/mimo-v2.5-free", "opencode/big-pickle"],
    paid: ["opencode-go/mimo-v2.5"],
    timeoutMs: 20000,
    lens: [
      "YOUR LENS: SIMPLIFY. Ask: what is the smallest change that resolves the blocker",
      "today, and what part of the proposed work can simply be deleted or deferred?",
      "Favour boring, obvious, local solutions over clever general ones. Point at any",
      "abstraction, layer, config knob or dependency being added for a need nobody has yet.",
      "If the simple version is genuinely inadequate, say in one line what breaks it.",
    ].join("\n"),
  },
  perf: {
    name: "perf",
    speciality: "latency, cost, memory, resource limits",
    free: ["opencode/deepseek-v4-flash-free", "opencode/big-pickle", "opencode/nemotron-3-ultra-free"],
    paid: ["opencode-go/deepseek-v4-flash"],
    timeoutMs: 40000,
    lens: [
      "YOUR LENS: COST AND LATENCY. Ask: what does this do per call, per item, per request,",
      "and what does it do to wall-clock time, memory and money at real volume?",
      "Look for work inside a loop that belongs outside it, unbounded reads of big trees,",
      "N+1 round trips, missing caching or batching, serial awaits that could be parallel,",
      "and state that grows forever. Give the order of magnitude, not a micro-optimisation.",
    ].join("\n"),
  },
}

const DEFAULT_PANEL = ["architect", "debugger", "skeptic"]

/** question keyword → persona, first match wins. Used when `who` is omitted. */
const AUTO_RULES: Array<{ persona: string; re: RegExp }> = [
  {
    persona: "security",
    re: /\b(secret|token|api[- ]?key|password|credential|leak|exfiltrat|auth|permission|rm -rf|delete|destroy|irreversib|backup|rollback|prod(uction)?\s+(deploy|data)|migrat\w*\s+(down|rollback)|chmod|sudo)\b/i,
  },
  // perf before debugger on purpose: "why is X slow" is a cost question, not a bug hunt
  {
    persona: "perf",
    re: /\b(slow|slower|latency|perf(ormance)?|timeout|timing out|memory|oom|ram|cpu|expensive|throughput|scale|scaling|n\+1|cache|caching|batch|quota|rate ?limit)\b/i,
  },
  {
    persona: "debugger",
    re: /\b(bug|crash|fail(s|ing|ure)?|error|exception|stack ?trace|regress|flaky|hang|deadlock|wrong (value|result|output)|returns? (null|nil|none|undefined|empty)|why (does|is|isn'?t|doesn'?t)|reproduc)\b/i,
  },
  {
    persona: "architect",
    re: /\b(architect\w*|design|structure|refactor|module|boundar\w+|abstraction|pattern|schema|api (shape|design)|where should|how should i (structure|organi[sz]e)|trade[- ]?off)\b/i,
  },
  {
    persona: "simplifier",
    re: /\b(simpl\w+|overkill|too complex|complicated|minimal|smallest|do i (really )?need|worth it|yagni)\b/i,
  },
  { persona: "skeptic", re: /\b(review|sanity|am i (wrong|right)|second opinion|risk|assumption|critique|blind spot)\b/i },
]

/* ─────────────────────────── per-process budget state ────────────────────── */

/** model calls charged per session id */
const CALLS = new Map<string, number>()
/** panel/debate invocations charged per session id */
const PANELS = new Map<string, number>()
/** advisor tool invocations currently in flight, process-wide (recursion guard) */
const INFLIGHT = new Set<string>()

let inflightCount = 0

function prune(m: Map<string, number>, max: number) {
  try {
    if (m.size <= max) return
    const keys = Array.from(m.keys())
    for (let i = 0; i < keys.length - max; i++) m.delete(keys[i])
  } catch {
    /* ignore */
  }
}

function charge(m: Map<string, number>, key: string, n: number): number {
  const cur = (m.get(key) ?? 0) + n
  m.set(key, cur)
  prune(m, 200)
  return cur
}

function used(m: Map<string, number>, key: string): number {
  return m.get(key) ?? 0
}

/**
 * Forget a finished session's advisor budget. Called from the `event` hook on
 * `session.deleted` so a long-lived opencode process does not leak counters.
 */
export function resetAdvisorSession(sessionID: string): void {
  try {
    if (typeof sessionID !== "string" || !sessionID) return
    CALLS.delete(sessionID)
    PANELS.delete(sessionID)
    INFLIGHT.delete(sessionID)
  } catch {
    /* housekeeping must never throw */
  }
}

/* ───────────────────────────────── config ───────────────────────────────── */

type AdvisorCfg = {
  enabled: boolean
  panel: string[]
  debatePanel: string[]
  personas: Record<string, Persona>
  maxCallsPerSession: number
  maxPanelsPerSession: number
  maxConcurrentToolCalls: number
  paidFallback: boolean
  synthesize: boolean
  synthesizerChain: string[]
  maxContextChars: number
  maxAnswerChars: number
  agent?: string
  debug: boolean
}

function num(v: unknown, dflt: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
  return Number.isFinite(n) && n >= 0 ? n : dflt
}

function bool(v: unknown, dflt: boolean): boolean {
  if (typeof v === "boolean") return v
  if (typeof v === "string") {
    const s = v.trim().toLowerCase()
    if (["1", "true", "yes", "on"].includes(s)) return true
    if (["0", "false", "no", "off"].includes(s)) return false
  }
  return dflt
}

function strList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const out = v.filter((x) => typeof x === "string" && x.trim()).map((x) => String(x).trim())
    return out.length ? out : undefined
  }
  if (typeof v === "string" && v.trim()) {
    const out = v
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean)
    return out.length ? out : undefined
  }
  return undefined
}

function mergePersonas(raw: unknown): Record<string, Persona> {
  const out: Record<string, Persona> = {}
  for (const k of Object.keys(PERSONAS)) out[k] = { ...PERSONAS[k] }
  if (!raw || typeof raw !== "object") return out
  try {
    for (const [k, v] of Object.entries(raw as Record<string, any>)) {
      if (!v || typeof v !== "object") continue
      const key = String(k).trim().toLowerCase()
      if (!key) continue
      const base: Persona =
        out[key] ??
        ({
          name: key,
          speciality: "custom advisor",
          free: ["opencode/mimo-v2.5-free"],
          paid: [],
          timeoutMs: 45000,
          lens: "YOUR LENS: as described by the operator.",
        } as Persona)
      const free = strList(v.free) ?? strList(v.models) ?? (typeof v.model === "string" ? [v.model] : undefined)
      out[key] = {
        name: key,
        speciality: typeof v.speciality === "string" && v.speciality.trim() ? v.speciality.trim() : base.speciality,
        free: free ?? base.free,
        paid: strList(v.paid) ?? base.paid,
        timeoutMs: num(v.timeoutMs, base.timeoutMs),
        lens: typeof v.lens === "string" && v.lens.trim() ? v.lens.trim() : typeof v.system === "string" && v.system.trim() ? v.system.trim() : base.lens,
      }
    }
  } catch {
    /* fall back to whatever merged so far */
  }
  return out
}

function readCfg(cfg: any): AdvisorCfg {
  const a = cfg && typeof cfg === "object" && cfg.advisors && typeof cfg.advisors === "object" ? cfg.advisors : {}
  const env = typeof process !== "undefined" && process && process.env ? process.env : ({} as Record<string, string | undefined>)

  let enabled = bool(a.enabled, true)
  const envSwitch = (env.STEROIDS_ADVISORS ?? env.ADVISORS ?? "").trim().toLowerCase()
  if (["0", "off", "false", "no", "disable", "disabled"].includes(envSwitch)) enabled = false
  if (["1", "on", "true", "yes"].includes(envSwitch)) enabled = true
  if (env.STEROIDS_NESTED === "1" || env.OCREV_NESTED === "1") enabled = false

  const personas = mergePersonas(a.personas)
  const panel = (strList(a.panel) ?? DEFAULT_PANEL).filter((p) => !!personas[p.toLowerCase()])
  const debatePanel = (strList(a.debatePanel) ?? panel).filter((p) => !!personas[p.toLowerCase()])

  return {
    enabled,
    panel: panel.length ? panel.map((p) => p.toLowerCase()) : DEFAULT_PANEL.slice(),
    debatePanel: debatePanel.length ? debatePanel.map((p) => p.toLowerCase()) : DEFAULT_PANEL.slice(),
    personas,
    maxCallsPerSession: num(env.STEROIDS_ADVISOR_MAX_CALLS ?? a.maxCallsPerSession, 60),
    maxPanelsPerSession: num(a.maxPanelsPerSession, 12),
    maxConcurrentToolCalls: Math.max(1, num(a.maxConcurrentToolCalls, 2)),
    paidFallback: bool(a.paidFallback, false),
    synthesize: bool(a.synthesize, true),
    synthesizerChain:
      strList(a.synthesizerChain) ?? ["opencode/ling-3.0-flash-free", "opencode/mimo-v2.5-free", "opencode/big-pickle"],
    maxContextChars: num(a.maxContextChars, 6000),
    maxAnswerChars: num(a.maxAnswerChars, 1600),
    agent: typeof a.agent === "string" && a.agent.trim() ? a.agent.trim() : undefined,
    debug: bool(a.debug ?? (cfg && cfg.debug), false),
  }
}

/* ───────────────────────────── text utilities ───────────────────────────── */

const SECRET_RULES: Array<[RegExp, string]> = [
  [/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, "private-key"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "anthropic-key"],
  [/\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, "sk-key"],
  [/\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g, "telegram-bot-token"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "github-token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github-pat"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "aws-access-key-id"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "google-api-key"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, "slack-token"],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "gitlab-token"],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "npm-token"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "jwt"],
  [/\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp|clickhouse):\/\/\S+/gi, "connection-string"],
  [/(?:--?(?:password|passwd|pass|token|api[-_]?key|secret|auth)[= ])\s*("[^"]*"|'[^']*'|\S+)/gi, "cli-secret-flag"],
  [
    /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL|CREDENTIALS|COOKIE)[A-Z0-9_]*)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s;&|]{4,})/g,
    "env-assignment",
  ],
]

/** Best-effort local scrub. The dedicated redactor lives elsewhere; this is a floor, not a ceiling. */
function scrub(s: string): string {
  let out = typeof s === "string" ? s : ""
  for (const [re, label] of SECRET_RULES) {
    try {
      out = out.replace(re, (m, g1) => {
        if (label === "env-assignment" && typeof g1 === "string") return `${g1}=«REDACTED:env-assignment»`
        if (label === "cli-secret-flag") {
          const head = m.slice(0, m.length - String(g1 ?? "").length)
          return `${head}«REDACTED:cli-secret-flag»`
        }
        return `«REDACTED:${label}»`
      })
    } catch {
      /* a bad regex must never break a review */
    }
  }
  return out
}

function clip(s: unknown, max: number): string {
  const t = typeof s === "string" ? s : s === undefined || s === null ? "" : String(s)
  if (max <= 0 || t.length <= max) return t
  const head = Math.max(1, Math.floor(max * 0.65))
  const tail = Math.max(1, max - head - 40)
  return `${t.slice(0, head)}\n…[${t.length - head - tail} chars elided]…\n${t.slice(t.length - tail)}`
}

function nonEmpty(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

const STOP = new Set([
  "the","a","an","and","or","but","if","then","to","of","in","on","for","with","is","are","be","it","this","that","as","at","by","from","not","no","do","does","should","would","could","can","will","use","using","you","your","i","we","its","it's","into","via","so","than","there","their","them","also","just","only","more","most","because","when","while","which","what","how",
])

function words(s: string): Set<string> {
  const out = new Set<string>()
  try {
    for (const w of String(s).toLowerCase().split(/[^a-z0-9_.+-]+/)) {
      if (w.length < 3) continue
      if (STOP.has(w)) continue
      out.add(w)
    }
  } catch {
    /* ignore */
  }
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const w of a) if (b.has(w)) inter++
  const union = a.size + b.size - inter
  return union > 0 ? inter / union : 0
}

function firstLine(s: string): string {
  const t = nonEmpty(s)
  if (!t) return ""
  const line = t.split("\n").find((l) => l.trim().length > 0) ?? ""
  return line.replace(/^\s*RECOMMEND\s*:?\s*/i, "").trim()
}

/* ───────────────────────────── prompt building ──────────────────────────── */

type Ask = { question: string; blocker: string; attempted: string; context?: string }

function buildAsk(args: any, maxContext: number): { ok: true; ask: Ask } | { ok: false; msg: string } {
  const question = nonEmpty(args?.question)
  const blocker = nonEmpty(args?.blocker)
  const attempted = nonEmpty(args?.attempted)
  if (!question || !blocker || !attempted) {
    return {
      ok: false,
      msg:
        "[advisor skipped: consult advisors only when actually blocked. Provide all three: " +
        "`question` (the specific decision you need), `blocker` (what is stopping you right now), " +
        "`attempted` (what you already tried). Try one concrete approach yourself first.]",
    }
  }
  const ctxRaw = nonEmpty(args?.context)
  return {
    ok: true,
    ask: {
      question: scrub(clip(question, 2000)),
      blocker: scrub(clip(blocker, 2000)),
      attempted: scrub(clip(attempted, 2000)),
      context: ctxRaw ? scrub(clip(ctxRaw, maxContext)) : undefined,
    },
  }
}

function askText(ask: Ask): string {
  const blocks = [
    `QUESTION\n${ask.question}`,
    `BLOCKER (what is stopping the agent right now)\n${ask.blocker}`,
    `ALREADY TRIED\n${ask.attempted}`,
  ]
  if (ask.context) blocks.push(`CONTEXT\n${ask.context}`)
  blocks.push("Give your advice now, in your lens, first line starting with `RECOMMEND: `.")
  return blocks.join("\n\n")
}

function systemFor(p: Persona): string {
  return `${SHARED_PREAMBLE}\n\n${p.lens}\n\n(Your advisor name is "${p.name}" — speciality: ${p.speciality}.)`
}

/* ───────────────────────────── persona selection ────────────────────────── */

function pickPersona(ask: Ask, cfg: AdvisorCfg): string {
  const hay = `${ask.question}\n${ask.blocker}\n${ask.attempted}`
  for (const r of AUTO_RULES) {
    try {
      if (cfg.personas[r.persona] && r.re.test(hay)) return r.persona
    } catch {
      /* ignore */
    }
  }
  return cfg.personas.architect ? "architect" : Object.keys(cfg.personas)[0] ?? "architect"
}

/** Personas explicitly named by the caller. Empty array = nothing valid was named. */
function matchNames(raw: unknown, cfg: AdvisorCfg): string[] {
  const asked = strList(raw)
  const out: string[] = []
  if (!asked) return out
  for (const nRaw of asked) {
    const n = nRaw.toLowerCase()
    if (n === "all" || n === "*") {
      for (const k of Object.keys(cfg.personas)) if (!out.includes(k)) out.push(k)
      continue
    }
    if (cfg.personas[n] && !out.includes(n)) out.push(n)
  }
  return out.slice(0, 6)
}

/** Named personas if any, else the given fallback roster, else the first configured persona. */
function resolveNames(raw: unknown, cfg: AdvisorCfg, fallback: string[]): string[] {
  const named = matchNames(raw, cfg)
  if (named.length) return named
  const out: string[] = []
  for (const n of fallback) if (cfg.personas[n] && !out.includes(n)) out.push(n)
  if (!out.length) {
    const k = Object.keys(cfg.personas)[0]
    if (k) out.push(k)
  }
  return out.slice(0, 6)
}

function unknownWho(raw: unknown, cfg: AdvisorCfg): string {
  const names = Object.keys(cfg.personas).join(" | ")
  return `[advisor unavailable: unknown advisor ${JSON.stringify(String(raw ?? ""))}. Available: ${names}. Omit \`who\` to let the panel decide.]`
}

/** Chain for a persona, with paid tail only when explicitly allowed. `claimed` gives panel diversity. */
function chainFor(p: Persona, cfg: AdvisorCfg, claimed: Set<string>): string[] {
  const free = (Array.isArray(p.free) ? p.free : []).filter((m) => typeof m === "string" && m.includes("/"))
  const ordered = free.slice()
  // diversity: prefer a primary no other panel member has already claimed
  const idx = ordered.findIndex((m) => !claimed.has(m))
  if (idx > 0) {
    const [pick] = ordered.splice(idx, 1)
    ordered.unshift(pick)
  }
  if (ordered[0]) claimed.add(ordered[0])
  const chain = ordered.slice()
  if (cfg.paidFallback) {
    for (const m of Array.isArray(p.paid) ? p.paid : []) {
      if (typeof m === "string" && m.includes("/") && !/-free$/.test(m)) chain.push(m)
    }
  }
  return chain.length ? chain : ["opencode/mimo-v2.5-free"]
}

/* ─────────────────────────────── model calls ───────────────────────────── */

type Answer = {
  persona: string
  model: string
  ms: number
  text: string
  error?: string
  ok: boolean
}

async function askOne(
  caller: Caller,
  cfg: AdvisorCfg,
  log: Logger,
  p: Persona,
  chain: string[],
  prompt: string,
  sessionID: string,
): Promise<Answer> {
  const started = Date.now()
  try {
    charge(CALLS, sessionID, 1)
    const res = (await caller.call<unknown>(chain, {
      system: systemFor(p),
      prompt,
      timeoutMs: p.timeoutMs,
      agent: cfg.agent,
    })) as CallResult<unknown> | undefined

    const ms = typeof res?.ms === "number" ? res.ms : Date.now() - started
    const model = typeof res?.model === "string" ? res.model : (chain[0] ?? "unknown")
    let text = typeof res?.text === "string" ? res.text.trim() : ""
    if (!text && res && typeof (res as any).value === "string") text = String((res as any).value).trim()

    if (!res || res.ok !== true || !text) {
      const err =
        (res && typeof res.error === "string" && res.error) ||
        (text ? "" : "empty answer") ||
        "unknown error"
      const tried = Array.isArray(res?.attempts)
        ? res!.attempts.map((a: any) => `${a?.model ?? "?"}${a?.error ? `(${String(a.error).slice(0, 60)})` : ""}`).join(", ")
        : chain.join(", ")
      log.warn(`[advisors] ${p.name} unavailable: ${err}`, { tried })
      return { persona: p.name, model, ms, text: "", ok: false, error: `${err}${tried ? ` · tried: ${tried}` : ""}` }
    }
    return { persona: p.name, model, ms, text: clip(text, cfg.maxAnswerChars), ok: true }
  } catch (e: any) {
    const msg = e && e.message ? String(e.message) : String(e)
    log.warn(`[advisors] ${p.name} threw: ${msg}`)
    return {
      persona: p.name,
      model: chain[0] ?? "unknown",
      ms: Date.now() - started,
      text: "",
      ok: false,
      error: msg.slice(0, 200),
    }
  }
}

/* ───────────────────────────────── synthesis ───────────────────────────── */

const SYNTH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["agreements", "disagreements", "recommendation"],
  properties: {
    agreements: { type: "array", maxItems: 6, items: { type: "string", maxLength: 220 } },
    disagreements: { type: "array", maxItems: 6, items: { type: "string", maxLength: 260 } },
    recommendation: { type: "string", maxLength: 700 },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    open_questions: { type: "array", maxItems: 4, items: { type: "string", maxLength: 180 } },
  },
} as const

const SYNTH_SYSTEM = [
  "You merge the answers of several independent advisors into one decision brief for a",
  "coding agent. You did not see the code; do not add opinions of your own and do not",
  "invent facts. Report only what the advisors actually said.",
  "",
  "- agreements: points where two or more advisors say the same thing. Merge duplicates.",
  "- disagreements: THE MOST IMPORTANT FIELD. Where advisors actually conflict, state the",
  '  conflict as "X says A, Y says B" so the reader sees the fork. If they genuinely do not',
  "  conflict, return an empty array — never manufacture a conflict.",
  "- recommendation: the course of action best supported by the advisors, in 2-4 sentences,",
  "  naming what to do FIRST. If the disagreement is unresolved, say which choice depends on",
  "  what, instead of guessing.",
  "- open_questions: facts the advisors said were missing.",
  "Be terse. No preamble.",
].join("\n")

type Synth = {
  agreements: string[]
  disagreements: string[]
  recommendation: string
  confidence?: string
  open_questions?: string[]
  by: string
}

function localSynth(answers: Answer[]): Synth {
  const good = answers.filter((a) => a.ok && a.text)
  const heads = good.map((a) => ({ persona: a.persona, head: firstLine(a.text), w: words(firstLine(a.text)) }))
  const agreements: string[] = []
  const disagreements: string[] = []

  // cluster the RECOMMEND lines by lexical overlap
  const clusters: Array<{ members: string[]; head: string; w: Set<string> }> = []
  for (const h of heads) {
    if (!h.head) continue
    let placed = false
    for (const c of clusters) {
      if (jaccard(c.w, h.w) >= 0.42) {
        c.members.push(h.persona)
        placed = true
        break
      }
    }
    if (!placed) clusters.push({ members: [h.persona], head: h.head, w: h.w })
  }
  clusters.sort((a, b) => b.members.length - a.members.length)
  for (const c of clusters) {
    if (c.members.length >= 2) agreements.push(`${c.members.join(" + ")}: ${c.head}`)
  }
  if (clusters.length > 1) {
    for (const c of clusters) disagreements.push(`${c.members.join(" + ")} → ${c.head}`)
  }
  const need = good
    .map((a) => {
      const m = a.text.match(/^\s*NEED\s*:\s*(.+)$/im)
      return m ? `${a.persona}: ${m[1].trim().slice(0, 160)}` : ""
    })
    .filter(Boolean)

  const rec =
    clusters.length === 0
      ? "No advisor answered. Proceed with your own judgement and prefer the reversible option."
      : clusters.length === 1
        ? `All responding advisors converge: ${clusters[0].head}`
        : `Advisors split ${clusters.map((c) => c.members.length).join("/")}. The majority line is: ${clusters[0].head} — but read the disagreement below before committing; where they disagree is where the real risk is.`

  return {
    agreements,
    disagreements,
    recommendation: rec,
    confidence: clusters.length === 1 && good.length >= 2 ? "high" : good.length >= 2 ? "medium" : "low",
    open_questions: need,
    by: "local (deterministic)",
  }
}

async function synthesize(
  caller: Caller,
  cfg: AdvisorCfg,
  log: Logger,
  answers: Answer[],
  ask: Ask,
  sessionID: string,
): Promise<Synth> {
  const local = localSynth(answers)
  const good = answers.filter((a) => a.ok && a.text)
  if (!cfg.synthesize || good.length < 2) return local
  if (used(CALLS, sessionID) >= cfg.maxCallsPerSession) return local

  const body = good
    .map((a, i) => `ADVISOR ${i + 1} — ${a.persona} (lens: ${cfg.personas[a.persona]?.speciality ?? a.persona})\n${a.text}`)
    .join("\n\n---\n\n")
  const prompt = [
    `QUESTION THE AGENT ASKED\n${ask.question}`,
    `BLOCKER\n${ask.blocker}`,
    `ADVISOR ANSWERS\n${clip(body, 9000)}`,
    "Produce the decision brief now.",
  ].join("\n\n")

  try {
    charge(CALLS, sessionID, 1)
    const res = (await caller.call<any>(cfg.synthesizerChain, {
      system: SYNTH_SYSTEM,
      prompt,
      schema: SYNTH_SCHEMA,
      timeoutMs: 45000,
      agent: cfg.agent,
    })) as CallResult<any> | undefined
    const v = res && res.ok === true ? res.value : undefined
    if (v && typeof v === "object") {
      const ags = Array.isArray(v.agreements) ? v.agreements.filter((x: any) => typeof x === "string" && x.trim()) : []
      const dis = Array.isArray(v.disagreements) ? v.disagreements.filter((x: any) => typeof x === "string" && x.trim()) : []
      const rec = typeof v.recommendation === "string" && v.recommendation.trim() ? v.recommendation.trim() : local.recommendation
      const oq = Array.isArray(v.open_questions) ? v.open_questions.filter((x: any) => typeof x === "string" && x.trim()) : local.open_questions
      return {
        agreements: ags.length ? ags : local.agreements,
        disagreements: dis.length ? dis : local.disagreements,
        recommendation: rec,
        confidence: typeof v.confidence === "string" ? v.confidence : local.confidence,
        open_questions: oq,
        by: `${res?.model ?? "synthesizer"}`,
      }
    }
    log.debug("[advisors] synthesizer produced no structured value; using local synthesis")
  } catch (e: any) {
    log.warn(`[advisors] synthesis failed: ${e && e.message ? e.message : String(e)}`)
  }
  return local
}

/* ───────────────────────────────── rendering ───────────────────────────── */

function bullets(items: string[] | undefined, empty: string): string {
  const list = Array.isArray(items) ? items.filter((x) => typeof x === "string" && x.trim()) : []
  if (!list.length) return `  ${empty}`
  return list.map((x) => `  • ${x.trim()}`).join("\n")
}

function renderPanel(title: string, answers: Answer[], s: Synth, extra?: string): string {
  const good = answers.filter((a) => a.ok && a.text)
  const bad = answers.filter((a) => !a.ok)
  const head = `🧠 ${title} — ${good.length}/${answers.length} advisors answered, each on a different model`
  const parts: string[] = [head, ""]

  parts.push("── WHERE THEY AGREE ──", bullets(s.agreements, "(no two advisors made the same point)"), "")
  parts.push(
    "── WHERE THEY DISAGREE (this is the signal) ──",
    bullets(s.disagreements, "(no material disagreement — treat the recommendation as well supported)"),
    "",
  )
  parts.push("── RECOMMENDED COURSE ──", `  ${s.recommendation.trim()}`, "")
  if (s.open_questions && s.open_questions.length) {
    parts.push("── MISSING INFORMATION THE ADVISORS ASKED FOR ──", bullets(s.open_questions, "(none)"), "")
  }
  if (extra && extra.trim()) parts.push(extra.trim(), "")

  parts.push("── FULL ANSWERS ──")
  for (const a of good) {
    parts.push(`▸ ${a.persona} · ${a.model} · ${(a.ms / 1000).toFixed(1)}s`, a.text, "")
  }
  if (bad.length) {
    parts.push(
      "── ADVISORS THAT DID NOT ANSWER ──",
      bullets(bad.map((a) => `${a.persona}: ${a.error ?? "no answer"}`), "(none)"),
      "",
    )
  }
  parts.push(
    `(synthesis by ${s.by}${s.confidence ? `, confidence ${s.confidence}` : ""}. These are opinions from models that ` +
      "cannot see your repo — you own the decision. Do not re-ask the same question; act, or ask a narrower one.)",
  )
  return parts.join("\n")
}

/* ───────────────────────────── budget / guards ──────────────────────────── */

function guardEntry(
  cfg: AdvisorCfg,
  sessionID: string,
  needCalls: number,
  kind: "advisor" | "panel",
  outerCfg: any,
): string | undefined {
  if (!cfg.enabled) return "[advisor unavailable: advisors disabled by configuration or environment]"
  if (!sessionID) return "[advisor unavailable: no session id on the tool context]"

  // recursion: advisor sessions must never consult advisors
  try {
    const own = outerCfg && outerCfg.ownSessions
    if (own && typeof own.has === "function" && own.has(sessionID)) {
      return "[advisor unavailable: recursive advisor call blocked (this IS an advisor session)]"
    }
    if (outerCfg && typeof outerCfg.isOwnSession === "function" && outerCfg.isOwnSession(sessionID) === true) {
      return "[advisor unavailable: recursive advisor call blocked (this IS an advisor session)]"
    }
  } catch {
    /* an unusable guard hook must not break the tool */
  }
  if (INFLIGHT.has(sessionID)) {
    return "[advisor unavailable: an advisor call for this session is already in flight — wait for it instead of nesting]"
  }
  if (inflightCount >= cfg.maxConcurrentToolCalls) {
    return `[advisor unavailable: ${inflightCount} advisor calls already running process-wide (cap ${cfg.maxConcurrentToolCalls}) — likely a recursive or runaway call]`
  }
  const c = used(CALLS, sessionID)
  if (c + needCalls > cfg.maxCallsPerSession) {
    return `[advisor unavailable: session advisor budget exhausted (${c}/${cfg.maxCallsPerSession} model calls used). Decide with what you have; prefer the reversible option.]`
  }
  if (kind === "panel") {
    const p = used(PANELS, sessionID)
    if (p >= cfg.maxPanelsPerSession) {
      return `[advisor unavailable: panel budget exhausted (${p}/${cfg.maxPanelsPerSession} panels this session). Use \`advisor\` with one persona, or decide yourself.]`
    }
  }
  return undefined
}

/* ─────────────────────────────── debate round 2 ─────────────────────────── */

const REVISE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["position", "changed_mind", "dissent"],
  properties: {
    position: { type: "string", maxLength: 900 },
    changed_mind: { type: "boolean" },
    dissent: { type: "string", maxLength: 400 },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
} as const

type Revision = { persona: string; model: string; position: string; changed: boolean; dissent: string; ok: boolean; ms: number; error?: string }

async function reviseOne(
  caller: Caller,
  cfg: AdvisorCfg,
  log: Logger,
  p: Persona,
  chain: string[],
  ask: Ask,
  mine: Answer,
  others: Answer[],
  sessionID: string,
): Promise<Revision> {
  const started = Date.now()
  const letters = "ABCDEFGH"
  const shown = others
    .filter((o) => o.ok && o.text)
    .map((o, i) => `ADVISOR ${letters[i] ?? "X"} said:\n${clip(o.text, 900)}`)
    .join("\n\n---\n\n")

  const prompt = [
    `QUESTION\n${ask.question}`,
    `BLOCKER\n${ask.blocker}`,
    `YOUR ROUND-1 ANSWER\n${clip(mine.text, 900)}`,
    `OTHER ADVISORS (anonymous, different models, they did not see your answer either)\n${shown || "(none answered)"}`,
    [
      "ROUND 2. Read the other positions honestly.",
      "- If another advisor is right about something you missed, say so and update: that is a WIN, not a loss.",
      "- If you still disagree, hold your position and state the disagreement in one sharp sentence.",
      "- Do NOT converge just to agree. A false consensus is the worst outcome of this process.",
      "Fill the schema: `position` = your final advice (<=120 words), `changed_mind` = did the",
      "other answers change it, `dissent` = the single point you still disagree with (empty if none).",
    ].join("\n"),
  ].join("\n\n")

  const system = `${systemFor(p)}\n\nYou are now in round 2 of a two-round debate. Answer ONLY by filling the schema object.`

  try {
    charge(CALLS, sessionID, 1)
    const res = (await caller.call<any>(chain, { system, prompt, schema: REVISE_SCHEMA, timeoutMs: p.timeoutMs, agent: cfg.agent })) as
      | CallResult<any>
      | undefined
    const ms = typeof res?.ms === "number" ? res.ms : Date.now() - started
    const model = typeof res?.model === "string" ? res.model : (chain[0] ?? "unknown")
    const v = res && res.ok === true ? res.value : undefined
    if (v && typeof v === "object" && typeof v.position === "string" && v.position.trim()) {
      return {
        persona: p.name,
        model,
        position: clip(v.position.trim(), 1200),
        changed: v.changed_mind === true,
        dissent: typeof v.dissent === "string" ? v.dissent.trim() : "",
        ok: true,
        ms,
      }
    }
    // structured output missing — accept plain text if the caller surfaced any
    const txt = typeof res?.text === "string" ? res.text.trim() : ""
    if (txt) {
      return { persona: p.name, model, position: clip(txt, 1200), changed: false, dissent: "", ok: true, ms }
    }
    const err = (res && typeof res.error === "string" && res.error) || "no round-2 answer"
    log.warn(`[advisors] ${p.name} round-2 unavailable: ${err}`)
    return { persona: p.name, model, position: "", changed: false, dissent: "", ok: false, ms, error: err }
  } catch (e: any) {
    return {
      persona: p.name,
      model: chain[0] ?? "unknown",
      position: "",
      changed: false,
      dissent: "",
      ok: false,
      ms: Date.now() - started,
      error: (e && e.message ? String(e.message) : String(e)).slice(0, 200),
    }
  }
}

/* ──────────────────────────────── the tools ─────────────────────────────── */

export async function makeAdvisorTools(caller: Caller, cfg: any, log: Logger): Promise<Record<string, any>> {
  const L = mkLog(log)
  const outerCfg = cfg && typeof cfg === "object" ? cfg : {}

  // If this build of the SDK does not expose `tool` (or its zod-like schema factory),
  // register nothing rather than crash.
  const toolFn: any = await loadToolHelper(L)
  if (typeof toolFn !== "function" || !toolFn.schema || typeof toolFn.schema.string !== "function") {
    L.warn("[advisors] `tool` helper or tool.schema unavailable — advisor tools NOT registered")
    return {}
  }

  const personaList = () => {
    const c = readCfg(outerCfg)
    return Object.keys(c.personas)
      .map((k) => `${k} (${c.personas[k].speciality}; ${c.personas[k].free[0] ?? "?"})`)
      .join(", ")
  }

  async function withInflight<T>(sessionID: string, fn: () => Promise<T>, onBusy: T): Promise<T> {
    INFLIGHT.add(sessionID)
    inflightCount++
    try {
      return await fn()
    } catch (e: any) {
      L.warn(`[advisors] internal error: ${e && e.message ? e.message : String(e)}`)
      return onBusy
    } finally {
      INFLIGHT.delete(sessionID)
      inflightCount = Math.max(0, inflightCount - 1)
    }
  }

  function meta(ctx: any, title: string) {
    try {
      if (ctx && typeof ctx.metadata === "function") ctx.metadata({ title })
    } catch {
      /* metadata is cosmetic */
    }
  }

  const commonArgs = () => ({
    question: toolFn.schema.string().describe("The specific decision or question you need guidance on. One sentence is best."),
    blocker: toolFn.schema.string().describe("Exactly what is stopping you right now — the concrete blocker, not a summary of the task."),
    attempted: toolFn.schema.string().describe("What you already tried yourself, and what happened. Required: try at least one concrete approach first."),
    context: toolFn.schema
      .string()
      .optional()
      .describe("Optional supporting evidence: the relevant code excerpt, error text, constraints. Keep it short and relevant; secrets are stripped."),
  })

  /* ── advisor: one persona ─────────────────────────────────────────────── */

  const advisor = toolFn({
    description:
      "Consult ONE specialist advisor running on its own separate model. Use when you are blocked and want a second brain on a specific angle. " +
      `Personas: ${Object.keys(PERSONAS).join(", ")}. Omit \`who\` to auto-pick from the question. ` +
      "Returns that advisor's guidance as text. Never fails the turn — on any problem it returns a short '[advisor unavailable: …]' note.",
    args: {
      ...commonArgs(),
      who: toolFn.schema
        .string()
        .optional()
        .describe(
          "Which advisor: architect | debugger | security | skeptic | simplifier | perf. Omit to auto-pick by question. Each runs on a different model.",
        ),
    },
    execute: async (args: any, ctx: any) => {
      const c = readCfg(outerCfg)
      const sessionID = ctx && typeof ctx.sessionID === "string" ? ctx.sessionID : ""
      const built = buildAsk(args, c.maxContextChars)
      if (!built.ok) return built.msg

      const g = guardEntry(c, sessionID, 1, "advisor", outerCfg)
      if (g) return g
      if (ctx && ctx.abort && ctx.abort.aborted) return "[advisor unavailable: request aborted]"

      const named = matchNames(args?.who, c)
      if (nonEmpty(args?.who) && !named.length) return unknownWho(args?.who, c)
      const name = named.length ? named[0] : pickPersona(built.ask, c)
      const p = c.personas[name]
      if (!p) return `[advisor unavailable: no usable advisor persona configured. Known: ${personaList()}]`

      meta(ctx, `advisor: ${p.name}`)
      return await withInflight(
        sessionID,
        async () => {
          const chain = chainFor(p, c, new Set<string>())
          const a = await askOne(caller, c, L, p, chain, askText(built.ask), sessionID)
          if (!a.ok) {
            return `[advisor unavailable: ${p.name} could not be reached — ${a.error ?? "unknown error"}. Proceed on your own judgement and prefer the reversible option.]`
          }
          L.info(`[advisors] ${p.name} answered via ${a.model} in ${(a.ms / 1000).toFixed(1)}s`)
          return [
            `🧠 ADVISOR "${p.name}" · ${a.model} · ${(a.ms / 1000).toFixed(1)}s`,
            `lens: ${p.speciality}`,
            "",
            a.text,
            "",
            "(One model's opinion; it cannot see your repo. You own the decision. For conflicting views on the same question use `advisor_panel`.)",
          ].join("\n")
        },
        "[advisor unavailable: internal error while consulting the advisor]",
      )
    },
  })

  /* ── advisor_panel: all advisors in parallel ──────────────────────────── */

  const advisor_panel = toolFn({
    description:
      "Ask the SAME question to SEVERAL advisors AT ONCE, each on a DIFFERENT model, then get a merged brief: where they agree, where they DISAGREE, and the recommended course. " +
      "Use for decisions with real consequences, when you are torn between approaches, or before an irreversible step. Costs several parallel model calls; the disagreement is the point.",
    args: {
      ...commonArgs(),
      who: toolFn.schema
        .string()
        .optional()
        .describe(
          "Optional comma-separated advisor names (architect, debugger, security, skeptic, simplifier, perf), or 'all'. Default: the configured panel.",
        ),
    },
    execute: async (args: any, ctx: any) => {
      const c = readCfg(outerCfg)
      const sessionID = ctx && typeof ctx.sessionID === "string" ? ctx.sessionID : ""
      const built = buildAsk(args, c.maxContextChars)
      if (!built.ok) return built.msg

      if (nonEmpty(args?.who) && !matchNames(args?.who, c).length) return unknownWho(args?.who, c)
      const names = resolveNames(args?.who, c, c.panel)
      const g = guardEntry(c, sessionID, names.length + 1, "panel", outerCfg)
      if (g) return g
      if (ctx && ctx.abort && ctx.abort.aborted) return "[advisor unavailable: request aborted]"

      meta(ctx, `advisor panel: ${names.join(", ")}`)
      charge(PANELS, sessionID, 1)

      return await withInflight(
        sessionID,
        async () => {
          const claimed = new Set<string>()
          const prompt = askText(built.ask)
          const jobs = names.map((n) => {
            const p = c.personas[n]
            const chain = chainFor(p, c, claimed)
            return askOne(caller, c, L, p, chain, prompt, sessionID)
          })
          const answers = await Promise.all(jobs)
          const good = answers.filter((a) => a.ok && a.text)
          if (!good.length) {
            return (
              "[advisor unavailable: no advisor on the panel answered — " +
              answers.map((a) => `${a.persona}: ${a.error ?? "no answer"}`).join(" · ") +
              ". Proceed on your own judgement and prefer the reversible option.]"
            )
          }
          const s = await synthesize(caller, c, L, answers, built.ask, sessionID)
          L.info(`[advisors] panel ${names.join("+")} → ${good.length} answers, ${s.disagreements.length} disagreement(s)`)
          return renderPanel("ADVISOR PANEL", answers, s)
        },
        "[advisor unavailable: internal error while running the panel]",
      )
    },
  })

  /* ── advisor_debate: two rounds ───────────────────────────────────────── */

  const advisor_debate = toolFn({
    description:
      "Two-round debate between advisors on different models: each answers independently, then each sees the others' answers (anonymised) and may revise. " +
      "Returns the converged position plus any REMAINING dissent. Use only for genuinely hard, high-stakes calls — it costs roughly twice a panel in time and quota.",
    args: {
      ...commonArgs(),
      who: toolFn.schema
        .string()
        .optional()
        .describe("Optional comma-separated advisor names, or 'all'. Default: the configured debate panel (2-4 advisors is the useful range)."),
    },
    execute: async (args: any, ctx: any) => {
      const c = readCfg(outerCfg)
      const sessionID = ctx && typeof ctx.sessionID === "string" ? ctx.sessionID : ""
      const built = buildAsk(args, c.maxContextChars)
      if (!built.ok) return built.msg

      if (nonEmpty(args?.who) && !matchNames(args?.who, c).length) return unknownWho(args?.who, c)
      const names = resolveNames(args?.who, c, c.debatePanel).slice(0, 4)
      if (names.length < 2) {
        return "[advisor unavailable: a debate needs at least 2 advisors — pass `who` with two or more names, or use `advisor_panel`]"
      }
      const g = guardEntry(c, sessionID, names.length * 2 + 1, "panel", outerCfg)
      if (g) return g
      if (ctx && ctx.abort && ctx.abort.aborted) return "[advisor unavailable: request aborted]"

      meta(ctx, `advisor debate: ${names.join(" vs ")}`)
      charge(PANELS, sessionID, 1)

      return await withInflight(
        sessionID,
        async () => {
          const claimed = new Set<string>()
          const chains: Record<string, string[]> = {}
          for (const n of names) chains[n] = chainFor(c.personas[n], c, claimed)

          // ── round 1: independent answers
          const prompt = askText(built.ask)
          const r1 = await Promise.all(names.map((n) => askOne(caller, c, L, c.personas[n], chains[n], prompt, sessionID)))
          const answered = r1.filter((a) => a.ok && a.text)
          if (!answered.length) {
            return (
              "[advisor unavailable: nobody answered round 1 — " +
              r1.map((a) => `${a.persona}: ${a.error ?? "no answer"}`).join(" · ") +
              ". Proceed on your own judgement.]"
            )
          }
          if (answered.length === 1) {
            const s = localSynth(r1)
            return renderPanel(
              "ADVISOR DEBATE (degraded: only one advisor answered, no debate possible)",
              r1,
              s,
            )
          }
          if (ctx && ctx.abort && ctx.abort.aborted) {
            const s = await synthesize(caller, c, L, r1, built.ask, sessionID)
            return renderPanel("ADVISOR DEBATE (round 1 only — aborted)", r1, s)
          }

          // ── round 2: each sees the others, may revise. Budget may cut this short.
          const remaining = c.maxCallsPerSession - used(CALLS, sessionID)
          if (remaining < answered.length) {
            const s = await synthesize(caller, c, L, r1, built.ask, sessionID)
            return renderPanel(
              "ADVISOR DEBATE (round 1 only — session budget too low for round 2)",
              r1,
              s,
            )
          }

          const r2 = await Promise.all(
            answered.map((a) =>
              reviseOne(
                caller,
                c,
                L,
                c.personas[a.persona],
                chains[a.persona] ?? [a.model],
                built.ask,
                a,
                answered.filter((o) => o.persona !== a.persona),
                sessionID,
              ),
            ),
          )

          // final answers = round-2 position where available, else round-1 text
          const finals: Answer[] = answered.map((a) => {
            const rev = r2.find((r) => r.persona === a.persona)
            if (rev && rev.ok && rev.position) {
              return {
                persona: a.persona,
                model: rev.model || a.model,
                ms: a.ms + rev.ms,
                text: rev.position + (rev.dissent ? `\nSTILL DISAGREES: ${rev.dissent}` : ""),
                ok: true,
              }
            }
            return a
          })
          for (const a of r1) if (!a.ok) finals.push(a)

          const s = await synthesize(caller, c, L, finals, built.ask, sessionID)
          const changed = r2.filter((r) => r.ok && r.changed).map((r) => r.persona)
          const dissent = r2.filter((r) => r.ok && r.dissent).map((r) => `${r.persona}: ${r.dissent}`)
          const extra = [
            "── AFTER SEEING EACH OTHER ──",
            `  moved position: ${changed.length ? changed.join(", ") : "nobody"}`,
            dissent.length ? `  remaining dissent:\n${dissent.map((d) => `    • ${d}`).join("\n")}` : "  remaining dissent: none stated",
            dissent.length
              ? "  ⚠️ unresolved dissent survived a full debate round — treat that point as genuinely uncertain and choose the reversible option there."
              : "  Convergence after an explicit anti-consensus instruction is a meaningful signal.",
          ].join("\n")

          L.info(`[advisors] debate ${names.join("+")} → moved:${changed.length} dissent:${dissent.length}`)
          return renderPanel("ADVISOR DEBATE (2 rounds)", finals, s, extra)
        },
        "[advisor unavailable: internal error while running the debate]",
      )
    },
  })

  L.info(`[advisors] registered advisor, advisor_panel, advisor_debate — personas: ${Object.keys(PERSONAS).join(", ")}`)
  return { advisor, advisor_panel, advisor_debate }
}
