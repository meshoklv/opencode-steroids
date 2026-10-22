/**
 * lib/callmodel.ts — THE single funnel for every model call the "steroids" plugin makes.
 *
 * Nothing else in the plugin may call `client.session.prompt` directly. This module owns:
 *   • the free-primary / paid-fallback candidate walk (in the order the caller gave)
 *   • the error taxonomy (MODEL_DEAD / AUTH_DEAD / EDGE_BAN / RATE_LIMIT / SERVER_5XX /
 *     NET_TIMEOUT / NO_SO / SCHEMA_INVALID / EMPTY / CTX_OVERFLOW / CONFIG_ERROR)
 *   • at-most-one in-chain retry per candidate, sub-second fixed backoff (never exponential)
 *   • a per-model circuit breaker with a bench ladder, persisted best-effort to disk
 *   • throwaway reviewer sessions that are ALWAYS deleted in a finally block
 *   • StructuredOutput parsing exactly as verified live in FACTS.md
 *
 * Hard rules honoured here:
 *   - never throws out of call(); every failure is data
 *   - `opencode-go/<...>-free` is a caller bug (401 always) → rejected before any HTTP call
 *   - AUTH_DEAD is global (one key serves both baseURLs) → never "escalate to paid" on it
 *   - nothing is ever written under ~/.config/opencode/
 */

import type { Attempt, CallOpts, CallResult, Caller, Logger } from "./types.ts"

/* ────────────────────────────── error taxonomy ────────────────────────────── */

export type ErrClass =
  | "MODEL_DEAD"        // 401 "Model X is not supported" → permanent, never retry, never re-add
  | "AUTH_DEAD"         // the API key itself is bad → abort chain, paid is NOT a workaround
  | "EDGE_BAN"          // Cloudflare 403 / "error code: 1010" → whole edge, not this model
  | "RATE_LIMIT"        // 429 → bench this model for max(Retry-After, 60s)
  | "SERVER_5XX"        // 500/502/503 → one immediate retry (mimo-v2.5-free did 500 then 200)
  | "NET_TIMEOUT"       // deadline hit / socket dropped / abort
  | "NO_SO"             // no StructuredOutput part came back at all
  | "SCHEMA_INVALID"    // StructuredOutput part present but not schema-valid
  | "EMPTY"             // valid but empty / required keys missing / no text at all
  | "CTX_OVERFLOW"      // finish === "length" — our payload was too big, not the model's fault
  | "CONFIG_ERROR"      // impossible candidate (paid+free id, missing provider, no client)
  | "SESSION_ERROR"     // could not create the throwaway session
  | "SKIPPED_DEAD"      // permanently disabled or quarantined
  | "SKIPPED_BENCHED"   // circuit breaker open (bench / probation cooldown)
  | "SKIPPED_SLOW"      // measured latency cannot fit the per-call deadline
  | "SKIPPED_PAID"      // paid candidate blocked by kill switch / cap / auth-dead
  | "BUDGET_EXHAUSTED"  // chain-wide wall-clock budget spent
  | "UNKNOWN"

/** Result of {@link freeTierStatus} — the board reads this to decide about paid escalation. */
export type FreeTierStatus = {
  freeExhausted: boolean
  paidWorthTrying: boolean
  authDead: boolean
  edgeBanned: boolean
  freeTried: number
  freeFailed: number
  freeSkipped: number
  paidTried: number
  succeededOn?: string
  classes: string[]
  summary: string
}

/* ────────────────────────────── module constants ────────────────────────────── */

/** Every mutating (and every reading) tool disabled — a reviewer must never be able to act.
 *  NOTE: never pass `{"*": false}` — a wildcard deny rule also hides the synthetic
 *  `StructuredOutput` tool and silently kills structured output. Enumerate real ids only. */
const TOOL_LOCKDOWN: Record<string, boolean> = {
  bash: false,
  edit: false,
  write: false,
  patch: false,
  apply_patch: false,
  multiedit: false,
  read: false,
  list: false,
  glob: false,
  grep: false,
  task: false,
  webfetch: false,
  websearch: false,
  todowrite: false,
  todoread: false,
  skill: false,
  question: false,
  invalid: false,
  execute: false,
  lsp_diagnostics: false,
  lsp_hover: false,
  list_mcp_resources: false,
  list_mcp_resource_templates: false,
  read_mcp_resource: false,
}

/** Fallback lean system prompt. An explicit `system` is ALWAYS sent so a reviewer session
 *  never relies on the default agent's persona. */
const DEFAULT_SYSTEM =
  "You are a terse automated reviewer inside a tool pipeline. Answer only through the " +
  "structured verdict you were given. No prose, no markdown, no questions, no tool use."

const HARDEN_SCHEMA =
  "\n\nIMPORTANT: Return ONLY one object that matches the required schema. " +
  "No prose, no markdown fences, no explanation outside the object."

const HARDEN_EMPTY =
  "\n\nIMPORTANT: You MUST fill EVERY required field of the schema with a real value. " +
  "Empty or omitted required fields are invalid."

/** Context windows from FACTS.md — used only to decide whether a CTX_OVERFLOW is worth
 *  retrying here or is better handed to a bigger-context candidate later in the chain. */
const MODEL_CTX: Record<string, number> = {
  "opencode/nemotron-3-ultra-free": 1000000,
  "opencode/ling-3.0-flash-free": 262100,
  "opencode/north-mini-code-free": 256000,
  "opencode/mimo-v2.5-free": 200000,
  "opencode/big-pickle": 200000,
  "opencode/deepseek-v4-flash-free": 200000,
  "opencode/laguna-s-2.1-free": 200000,
  "opencode-go/mimo-v2.5": 1000000,
  "opencode-go/mimo-v2.5-pro": 1000000,
  "opencode-go/deepseek-v4-flash": 1000000,
  "opencode-go/deepseek-v4-pro": 1000000,
  "opencode-go/glm-5.2": 1000000,
  "opencode-go/qwen3.7-plus": 1000000,
  "opencode-go/hy3": 200000,
}

const DEFAULT_QUARANTINE = ["opencode/laguna-s-2.1-free"]

/* ────────────────────────────── module state ────────────────────────────── */

type Health = {
  id: string
  consecutiveFailures: number
  soFailures: number
  soSuccesses: number
  benchedUntil: number
  benchTier: number
  lastBenchAt: number
  probation: boolean
  lastProbeAt: number
  lastForcedAt: number
  permanentlyDisabled: boolean
  quarantined: boolean
  ewmaLatencyMs: number
  calls: number
  okCalls: number
  lastError?: { cls: string; at: number; note?: string }
}

const HEALTH: Map<string, Health> = new Map()
let healthLoad: Promise<void> | null = null
let healthSaveTimer: any = null
/** Set when the API KEY itself was rejected. Sticky for a cooldown (not forever: one flaky
 *  401 must not disable reviewing for the rest of a long session), and never a reason to
 *  "escalate to paid" — the same key authenticates both baseURLs. */
let AUTH_DEAD_UNTIL = 0
let EDGE_BAN_UNTIL = 0
let PAID_CALLS = 0

function authDead(): boolean {
  return AUTH_DEAD_UNTIL > now()
}

/* ────────────────────────────── tiny utils ────────────────────────────── */

const now = (): number => Date.now()

function num(v: any, d: number): number {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : d
}
function bool(v: any, d: boolean): boolean {
  return typeof v === "boolean" ? v : d
}
function str(v: any, d: string): string {
  return typeof v === "string" && v.length > 0 ? v : d
}
function list(v: any, d: string[]): string[] {
  if (!Array.isArray(v)) return d
  const out: string[] = []
  for (const x of v) if (typeof x === "string" && x.length) out.push(x)
  return out.length ? out : d
}
function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return n < lo ? lo : n > hi ? hi : n
}
function errText(e: unknown): string {
  try {
    if (e === null || e === undefined) return ""
    if (typeof e === "string") return e
    const m = (e as any)?.message
    if (typeof m === "string" && m.length) return m
    return JSON.stringify(e).slice(0, 2000)
  } catch {
    try {
      return String(e).slice(0, 500)
    } catch {
      return "unserializable error"
    }
  }
}
function jsonish(v: unknown, cap: number): string {
  try {
    if (v === null || v === undefined) return ""
    if (typeof v === "string") return v.slice(0, cap)
    return JSON.stringify(v).slice(0, cap)
  } catch {
    return ""
  }
}
/** NOTE: deliberately NOT unref'd — an unref'd timer can be starved when the event loop is
 *  otherwise idle, which would leave a retry hanging forever. Only the debounced health
 *  flush is unref'd, because that one may legitimately be dropped at process exit. */
function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    try {
      setTimeout(res, clamp(num(ms, 0), 0, 30000))
    } catch {
      res()
    }
  })
}
function mkLog(log: any): Logger {
  const fire = (k: string, m: string, x?: unknown) => {
    try {
      const f = log && typeof log[k] === "function" ? log[k] : null
      if (f) f.call(log, m, x)
    } catch {
      /* a logger must never break a review */
    }
  }
  return {
    info: (m: string, x?: unknown) => fire("info", m, x),
    warn: (m: string, x?: unknown) => fire("warn", m, x),
    debug: (m: string, x?: unknown) => fire("debug", m, x),
  }
}
/** Encode a failure into the single documented `Attempt.error` string shape:
 *  `"<CLASS>[<httpStatus>] <message>"`. Parsed back by {@link freeTierStatus}. */
function encodeErr(cls: ErrClass, status: number, msg: string): string {
  const m = String(msg ?? "").replace(/\s+/g, " ").trim().slice(0, 400)
  return `${cls}[${num(status, 0)}] ${m}`
}
function classOf(errStr: string): ErrClass {
  const m = /^([A-Z_]+)\[/.exec(String(errStr ?? ""))
  return (m ? (m[1] as ErrClass) : "UNKNOWN") as ErrClass
}

/** Middle-elide an oversized payload; never truncate blindly at the tail. */
function truncateMiddle(s: string, max: number): string {
  const t = typeof s === "string" ? s : ""
  if (max <= 0 || t.length <= max) return t
  const head = Math.max(200, Math.floor(max * 0.6))
  const tail = Math.max(100, max - head - 60)
  const cut = t.length - head - tail
  if (cut <= 0) return t.slice(0, max)
  return `${t.slice(0, head)}\n\n…[${cut} characters elided by the review board]…\n\n${t.slice(t.length - tail)}`
}

function splitModel(spec: string, defaultProvider: string): { providerID: string; modelID: string } | null {
  const s = String(spec ?? "").trim()
  if (!s) return null
  const i = s.indexOf("/")
  if (i < 0) return { providerID: defaultProvider, modelID: s }
  const providerID = s.slice(0, i).trim()
  const modelID = s.slice(i + 1).trim()
  if (!providerID || !modelID) return null
  return { providerID, modelID }
}

/* ────────────────────────────── config resolution ────────────────────────────── */

type Resolved = {
  timeoutMs: number
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
  retryCount: number
  agent: string
  system: string
  titlePrefix: string
  defaultProvider: string
  quarantined: string[]
  disabledTools: string[]
  persist: boolean
  stateDir: string
  healthFile: string
  ledgerFile: string
  paidEnabled: boolean
  maxPaidCalls: number
  onSessionCreated?: (id: string, model: string) => void
  onSessionClosed?: (id: string) => void
  onPaidCall?: (info: { model: string; ok: boolean; ms: number; costUsd: number }) => void
  reviewerSessions?: any
}

function resolveCfg(cfg: any): Resolved {
  const c = cfg && typeof cfg === "object" && cfg.caller && typeof cfg.caller === "object" ? cfg.caller : {}
  const top = cfg && typeof cfg === "object" ? cfg : {}
  const paths = top && typeof top.paths === "object" && top.paths ? top.paths : {}
  const home = str(process?.env?.HOME, "/root")
  const envState = str(process?.env?.STEROIDS_STATE_DIR, "")
  const paidEnv = String(str(process?.env?.STEROIDS_PAID, "")).toLowerCase()
  const timeoutMs = clamp(num(c.timeoutMs, num(top.timeoutMs, 25000)), 2000, 300000)
  const stateDir = envState || str(c.stateDir, str(paths.stateDir, str(top.stateDir, `${home}/.local/share/opencode/steroids`)))
  return {
    timeoutMs,
    chainBudgetMs: clamp(num(c.chainBudgetMs, num(top.chainBudgetMs, timeoutMs * 3 + 5000)), timeoutMs, 900000),
    maxAttempts: clamp(num(c.maxAttempts, 8), 1, 24),
    breakerFails: clamp(num(c.breakerFails, 3), 1, 20),
    benchLadderMs: (() => {
      const raw = Array.isArray(c.benchLadderMs) ? c.benchLadderMs : null
      const out: number[] = []
      if (raw) for (const x of raw) if (Number.isFinite(Number(x)) && Number(x) > 0) out.push(Number(x))
      return out.length ? out : [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000]
    })(),
    soBenchMs: clamp(num(c.soBenchMs, 30 * 60 * 1000), 10000, 6 * 60 * 60 * 1000),
    rateLimitBenchMs: clamp(num(c.rateLimitBenchMs, 60 * 1000), 5000, 60 * 60 * 1000),
    probeCooldownMs: clamp(num(c.probeCooldownMs, 5 * 60 * 1000), 100, 60 * 60 * 1000),
    edgeBanCooldownMs: clamp(num(c.edgeBanCooldownMs, 60 * 1000), 250, 30 * 60 * 1000),
    authDeadCooldownMs: clamp(num(c.authDeadCooldownMs, 10 * 60 * 1000), 1, 6 * 60 * 60 * 1000),
    slowSkipFactor: clamp(num(c.slowSkipFactor, 1.5), 1, 10),
    retryDelayServerMs: clamp(num(c.retryDelayServerMs, 750), 0, 10000),
    retryDelaySchemaMs: clamp(num(c.retryDelaySchemaMs, 250), 0, 10000),
    maxPromptChars: clamp(num(c.maxPromptChars, num(top.maxPromptChars, 12000)), 500, 400000),
    retryCount: clamp(num(c.retryCount, 3), 0, 5),
    agent: str(c.agent, str(top.reviewerAgent, "")),
    system: str(c.system, DEFAULT_SYSTEM),
    titlePrefix: str(c.sessionTitlePrefix, "«ocrev»"),
    defaultProvider: str(c.defaultProvider, "opencode"),
    quarantined: list(c.quarantined, DEFAULT_QUARANTINE),
    disabledTools: list(c.disabledTools, []),
    persist: bool(c.persist, true),
    stateDir,
    healthFile: str(c.healthFile, str(paths.healthFile, `${stateDir}/health.json`)),
    ledgerFile: str(c.ledgerFile, str(paths.ledgerFile, `${stateDir}/paid-ledger.jsonl`)),
    paidEnabled:
      paidEnv === "off" || paidEnv === "0" || paidEnv === "false"
        ? false
        : bool(c.paidEnabled, bool(top.paidEnabled, true)),
    maxPaidCalls: clamp(num(c.maxPaidCalls, num(top.maxPaidCalls, 12)), 0, 500),
    onSessionCreated: typeof c.onSessionCreated === "function" ? c.onSessionCreated : undefined,
    onSessionClosed: typeof c.onSessionClosed === "function" ? c.onSessionClosed : undefined,
    onPaidCall: typeof c.onPaidCall === "function" ? c.onPaidCall : undefined,
    reviewerSessions: c.reviewerSessions ?? top.reviewerSessions,
  }
}

/* ────────────────────────────── health / circuit breaker ────────────────────────────── */

function freshHealth(id: string, quarantined: boolean): Health {
  return {
    id,
    consecutiveFailures: 0,
    soFailures: 0,
    soSuccesses: 0,
    benchedUntil: 0,
    benchTier: 0,
    lastBenchAt: 0,
    probation: false,
    lastProbeAt: 0,
    lastForcedAt: 0,
    permanentlyDisabled: false,
    quarantined,
    ewmaLatencyMs: 0,
    calls: 0,
    okCalls: 0,
  }
}

function healthOf(id: string, R: Resolved): Health {
  let h = HEALTH.get(id)
  if (!h) {
    h = freshHealth(id, R.quarantined.indexOf(id) >= 0)
    HEALTH.set(id, h)
  } else if (!h.quarantined && R.quarantined.indexOf(id) >= 0) {
    h.quarantined = true
  }
  return h
}

async function loadHealth(R: Resolved, log: Logger): Promise<void> {
  if (!R.persist) return
  try {
    const file = R.healthFile
    let text = ""
    const B: any = (globalThis as any).Bun
    if (B && typeof B.file === "function") {
      const f = B.file(file)
      const exists = typeof f.exists === "function" ? await f.exists() : true
      if (!exists) return
      text = await f.text()
    } else {
      const fs: any = await import("node:fs/promises")
      text = await fs.readFile(file, "utf8")
    }
    if (!text || !text.trim()) return
    const parsed = JSON.parse(text)
    const models = parsed && typeof parsed === "object" ? parsed.models : null
    if (!models || typeof models !== "object") return
    let n = 0
    for (const id of Object.keys(models)) {
      const v = (models as any)[id]
      if (!v || typeof v !== "object") continue
      const h = freshHealth(id, bool(v.quarantined, false))
      h.consecutiveFailures = clamp(num(v.consecutiveFailures, 0), 0, 1000)
      h.soFailures = clamp(num(v.soFailures, 0), 0, 1000)
      h.soSuccesses = clamp(num(v.soSuccesses, 0), 0, 1000000)
      h.benchedUntil = clamp(num(v.benchedUntil, 0), 0, now() + 7 * 24 * 3600 * 1000)
      h.benchTier = clamp(num(v.benchTier, 0), 0, 9)
      h.lastBenchAt = clamp(num(v.lastBenchAt, 0), 0, now())
      h.probation = bool(v.probation, false)
      h.lastProbeAt = clamp(num(v.lastProbeAt, 0), 0, now())
      h.lastForcedAt = clamp(num(v.lastForcedAt, 0), 0, now())
      h.permanentlyDisabled = bool(v.permanentlyDisabled, false)
      h.ewmaLatencyMs = clamp(num(v.ewmaLatencyMs, 0), 0, 600000)
      h.calls = clamp(num(v.calls, 0), 0, 1e9)
      h.okCalls = clamp(num(v.okCalls, 0), 0, 1e9)
      if (v.lastError && typeof v.lastError === "object") {
        h.lastError = {
          cls: str(v.lastError.cls, "UNKNOWN"),
          at: num(v.lastError.at, 0),
          note: typeof v.lastError.note === "string" ? v.lastError.note.slice(0, 300) : undefined,
        }
      }
      if (!HEALTH.has(id)) HEALTH.set(id, h)
      n++
    }
    log.debug(`callmodel: loaded health for ${n} model(s) from ${file}`)
  } catch (e) {
    log.debug("callmodel: no usable health file (starting fresh)", errText(e))
  }
}

function ensureHealth(R: Resolved, log: Logger): Promise<void> {
  if (!healthLoad) {
    healthLoad = loadHealth(R, log).catch(() => undefined)
  }
  return healthLoad
}

async function saveHealth(R: Resolved, log: Logger): Promise<void> {
  if (!R.persist) return
  try {
    const file = R.healthFile
    const cut = file.lastIndexOf("/")
    const dir = cut > 0 ? file.slice(0, cut) : R.stateDir
    const models: Record<string, Health> = {}
    for (const [k, v] of HEALTH) models[k] = v
    const payload = JSON.stringify({ version: 1, savedAt: now(), models })
    let fs: any = null
    try {
      fs = await import("node:fs/promises")
    } catch {
      fs = null
    }
    if (fs && typeof fs.mkdir === "function") {
      try {
        await fs.mkdir(dir, { recursive: true })
      } catch {
        /* dir may already exist */
      }
    }
    const B: any = (globalThis as any).Bun
    if (fs && typeof fs.writeFile === "function" && typeof fs.rename === "function") {
      const tmp = `${file}.tmp-${num(process?.pid, 0)}`
      await fs.writeFile(tmp, payload, "utf8")
      await fs.rename(tmp, file)
    } else if (B && typeof B.write === "function") {
      await B.write(file, payload)
    }
  } catch (e) {
    log.debug("callmodel: health save failed", errText(e))
  }
}

function scheduleSave(R: Resolved, log: Logger): void {
  if (!R.persist) return
  if (healthSaveTimer) return
  try {
    healthSaveTimer = setTimeout(() => {
      healthSaveTimer = null
      void saveHealth(R, log)
    }, 2000)
    if (healthSaveTimer && typeof healthSaveTimer.unref === "function") healthSaveTimer.unref()
  } catch {
    healthSaveTimer = null
  }
}

function benchFor(h: Health, ms: number): void {
  const until = now() + Math.max(1000, ms)
  if (until > h.benchedUntil) h.benchedUntil = until
  h.lastBenchAt = now()
  h.probation = false
}

function recordOk(h: Health, ms: number, usedSchema: boolean): void {
  h.calls++
  h.okCalls++
  h.consecutiveFailures = 0
  h.benchedUntil = 0
  h.probation = false
  h.benchTier = h.benchTier > 0 ? h.benchTier - 1 : 0
  h.ewmaLatencyMs = h.ewmaLatencyMs > 0 ? 0.3 * ms + 0.7 * h.ewmaLatencyMs : ms
  if (usedSchema) h.soSuccesses++
}

function recordFail(h: Health, cls: ErrClass, note: string, R: Resolved, extra: { retryAfterMs?: number; ms?: number }): void {
  h.calls++
  h.lastError = { cls, at: now(), note: String(note ?? "").slice(0, 300) }
  const latency = num(extra?.ms, 0)
  if (latency > 0) h.ewmaLatencyMs = h.ewmaLatencyMs > 0 ? 0.3 * latency + 0.7 * h.ewmaLatencyMs : latency

  if (cls === "MODEL_DEAD") {
    h.permanentlyDisabled = true
    h.consecutiveFailures++
    return
  }
  if (cls === "AUTH_DEAD" || cls === "EDGE_BAN") {
    // not this model's fault — no per-model penalty at all
    return
  }
  if (cls === "CTX_OVERFLOW") {
    // our payload was too big — no penalty
    return
  }

  h.consecutiveFailures++

  if (cls === "NO_SO" || cls === "SCHEMA_INVALID") {
    h.soFailures++
    if (h.soFailures >= 2 && h.soSuccesses === 0) {
      benchFor(h, R.soBenchMs)
      return
    }
  }

  if (cls === "RATE_LIMIT") {
    benchFor(h, Math.max(num(extra?.retryAfterMs, 0), R.rateLimitBenchMs))
    return
  }

  if (h.consecutiveFailures >= R.breakerFails) {
    const flapping = h.benchTier > 0 && now() < h.benchedUntil + 10 * 60 * 1000
    h.benchTier = flapping ? Math.min(h.benchTier + 1, R.benchLadderMs.length) : Math.max(1, h.benchTier)
    const idx = clamp(h.benchTier, 1, R.benchLadderMs.length) - 1
    benchFor(h, R.benchLadderMs[idx])
    h.consecutiveFailures = 0
  }
}

/** Availability decision for one candidate. `force` ignores bench (never permanent bans). */
function availability(
  id: string,
  providerID: string,
  modelID: string,
  R: Resolved,
  perCallMs: number,
): { ok: true } | { ok: false; cls: ErrClass; why: string; benchLike: boolean } {
  if (providerID === "opencode-go" && /-free$/.test(modelID)) {
    return {
      ok: false,
      cls: "CONFIG_ERROR",
      why: "free model id on the paid provider always returns 401 — caller bug",
      benchLike: false,
    }
  }
  const h = healthOf(id, R)
  if (h.permanentlyDisabled) {
    return { ok: false, cls: "SKIPPED_DEAD", why: "permanently disabled (model not supported on this key)", benchLike: false }
  }
  if (h.quarantined) {
    return { ok: false, cls: "SKIPPED_DEAD", why: "quarantined by config", benchLike: false }
  }
  if (providerID === "opencode-go") {
    if (!R.paidEnabled) return { ok: false, cls: "SKIPPED_PAID", why: "paid fallback disabled", benchLike: false }
    if (authDead())
      return {
        ok: false,
        cls: "SKIPPED_PAID",
        why: `api key was rejected ${Math.round((R.authDeadCooldownMs - (AUTH_DEAD_UNTIL - now())) / 1000)}s ago — paid uses the SAME key`,
        benchLike: false, // never force a paid attempt while the key is known-bad
      }
    if (PAID_CALLS >= R.maxPaidCalls)
      return { ok: false, cls: "SKIPPED_PAID", why: `paid cap reached (${PAID_CALLS}/${R.maxPaidCalls})`, benchLike: false }
  }
  const t = now()
  if (h.benchedUntil > t) {
    return {
      ok: false,
      cls: "SKIPPED_BENCHED",
      why: `benched for ${Math.round((h.benchedUntil - t) / 1000)}s (tier ${h.benchTier}, last ${h.lastError?.cls ?? "?"})`,
      benchLike: true,
    }
  }
  if (h.benchedUntil > 0 && h.benchedUntil <= t) {
    h.benchedUntil = 0
    h.probation = true
  }
  if (h.probation && t - h.lastProbeAt < R.probeCooldownMs) {
    return { ok: false, cls: "SKIPPED_BENCHED", why: "on probation, probe cooldown not elapsed", benchLike: true }
  }
  if (h.ewmaLatencyMs > 0 && h.ewmaLatencyMs > R.slowSkipFactor * perCallMs) {
    return {
      ok: false,
      cls: "SKIPPED_SLOW",
      why: `measured ${Math.round(h.ewmaLatencyMs)}ms > ${R.slowSkipFactor}× the ${perCallMs}ms budget`,
      benchLike: true,
    }
  }
  return { ok: true }
}

/* ────────────────────────────── response classification ────────────────────────────── */

function unwrap(res: any): { data: any; error: any; status: number; headers: any } {
  if (!res || typeof res !== "object") return { data: undefined, error: undefined, status: 0, headers: undefined }
  const status = num(res?.response?.status, 0)
  const headers = res?.response?.headers
  if ("data" in res || "error" in res) return { data: (res as any).data, error: (res as any).error, status, headers }
  return { data: res, error: undefined, status, headers }
}

function retryAfterMs(headers: any): number {
  try {
    if (!headers || typeof headers.get !== "function") return 0
    const raw = headers.get("retry-after")
    if (!raw) return 0
    const secs = Number(raw)
    if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 60 * 60 * 1000)
    const when = Date.parse(String(raw))
    if (Number.isFinite(when)) return clamp(when - now(), 0, 60 * 60 * 1000)
  } catch {
    /* header parsing must never throw */
  }
  return 0
}

/** Classify a transport/provider failure. Returns null when nothing looks wrong yet. */
function classifyFailure(
  thrown: unknown,
  res: any,
  ms: number,
  budgetMs: number,
  timedOut: boolean,
): { cls: ErrClass; status: number; msg: string } | null {
  const { data, error, status } = unwrap(res)
  const infoErr = data?.info?.error
  const blob = [
    errText(thrown),
    jsonish(error, 1500),
    jsonish(infoErr, 1500),
    typeof (thrown as any)?.name === "string" ? (thrown as any).name : "",
  ]
    .filter((x) => x && x.length)
    .join(" | ")
    .slice(0, 4000)
  const httpStatus = num(status, 0) || num((thrown as any)?.status, 0) || num((thrown as any)?.response?.status, 0)
  const has = (re: RegExp) => {
    try {
      return re.test(blob)
    } catch {
      return false
    }
  }
  const errName = str(infoErr?.name, "")

  if (timedOut) return { cls: "NET_TIMEOUT", status: httpStatus, msg: `deadline ${budgetMs}ms exceeded` }
  if (errName === "MessageAbortedError") return { cls: "NET_TIMEOUT", status: httpStatus, msg: "message aborted" }
  if (has(/error code:\s*1010/i) || has(/cloudflare/i))
    return { cls: "EDGE_BAN", status: httpStatus || 403, msg: "cloudflare edge ban (error 1010)" }
  if (has(/is not supported/i))
    return { cls: "MODEL_DEAD", status: httpStatus || 401, msg: "model is not supported on this key" }
  if (has(/rate ?limit|too many requests|quota exceeded|429/i) || httpStatus === 429)
    return { cls: "RATE_LIMIT", status: httpStatus || 429, msg: "rate limited by the provider" }
  if (
    httpStatus === 401 ||
    (httpStatus === 403 && has(/api ?key|unauthor|invalid ?token|credential|forbidden/i)) ||
    has(/invalid ?api ?key|unauthorized|no auth|authentication failed|401/i)
  )
    return { cls: "AUTH_DEAD", status: httpStatus || 401, msg: "api key rejected (global — paid uses the same key)" }
  if (httpStatus === 403) return { cls: "EDGE_BAN", status: 403, msg: "http 403 from the edge" }
  if (errName === "MessageOutputLengthError") return { cls: "CTX_OVERFLOW", status: httpStatus, msg: "output length exceeded" }
  if (errName === "StructuredOutputError")
    return { cls: "SCHEMA_INVALID", status: httpStatus, msg: str(infoErr?.data?.message, "structured output failed") }
  if (httpStatus >= 500 || has(/bad gateway|service unavailable|internal server error|upstream|502|503|504/i))
    return { cls: "SERVER_5XX", status: httpStatus || 500, msg: "provider server error" }
  if (
    has(/timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang ?up|fetch failed|network|aborted/i) ||
    ms >= budgetMs
  )
    return { cls: "NET_TIMEOUT", status: httpStatus, msg: "network failure or deadline hit" }
  if (errName === "ProviderAuthError")
    return { cls: "AUTH_DEAD", status: httpStatus || 401, msg: str(infoErr?.data?.message, "provider auth error") }
  if (errName) return { cls: "SERVER_5XX", status: httpStatus, msg: `provider error ${errName}` }
  if (error !== undefined && error !== null) return { cls: "SERVER_5XX", status: httpStatus, msg: jsonish(error, 200) }
  if (thrown !== undefined && thrown !== null) return { cls: "UNKNOWN", status: httpStatus, msg: errText(thrown) }
  return null
}

function textFromParts(data: any): string {
  try {
    const parts = Array.isArray(data?.parts) ? data.parts : []
    const out: string[] = []
    for (const p of parts) {
      if (p && p.type === "text" && typeof p.text === "string" && p.text.length) out.push(p.text)
    }
    return out.join("\n").trim()
  } catch {
    return ""
  }
}

function findStructured(data: any): { value: any; validFlag: any; present: boolean } {
  let value: any = undefined
  let validFlag: any = undefined
  let present = false
  try {
    const parts = Array.isArray(data?.parts) ? data.parts : []
    for (const p of parts) {
      if (p && p.type === "tool" && p.tool === "StructuredOutput") {
        present = true
        const st = p.state
        if (st && typeof st === "object") {
          if (st.input !== undefined) value = st.input
          if (st.metadata && typeof st.metadata === "object" && "valid" in st.metadata) validFlag = st.metadata.valid
        }
      }
    }
  } catch {
    /* fall through to info.structured */
  }
  if (value === undefined) {
    try {
      const s = data?.info?.structured
      if (s !== undefined && s !== null) {
        value = s
        present = true
      }
    } catch {
      /* ignore */
    }
  }
  return { value, validFlag, present }
}

function requiredKeys(schema: any): string[] {
  try {
    const r = schema && typeof schema === "object" ? (schema as any).required : null
    if (!Array.isArray(r)) return []
    const out: string[] = []
    for (const k of r) if (typeof k === "string" && k.length) out.push(k)
    return out
  } catch {
    return []
  }
}

function tryParseJson(text: string): any {
  const t = String(text ?? "").trim()
  if (!t) return undefined
  const candidates: string[] = []
  candidates.push(t)
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)
  if (fence && fence[1]) candidates.push(fence[1].trim())
  const first = t.indexOf("{")
  const last = t.lastIndexOf("}")
  if (first >= 0 && last > first) candidates.push(t.slice(first, last + 1))
  for (const c of candidates) {
    try {
      const v = JSON.parse(c)
      if (v && typeof v === "object") return v
    } catch {
      /* try the next shape */
    }
  }
  return undefined
}

/* ────────────────────────────── the caller ────────────────────────────── */

/**
 * Build the one and only model caller.
 *
 * @param client the plugin's pre-bound opencode client (`PluginInput.client`)
 * @param log    a Logger (info/warn/debug); any missing method is tolerated
 * @param cfg    the steroids config; only `cfg.caller.*` (plus a few top-level
 *               fallbacks) is read, and it is re-read on EVERY call so live
 *               config edits take effect without a restart
 */
export function makeCaller(client: any, log: Logger, cfg: any): Caller {
  const L = mkLog(log)

  async function call<T = unknown>(chain: string[], opts: CallOpts): Promise<CallResult<T>> {
    const started = now()
    const attempts: Attempt[] = []
    let lastError = ""

    const finish = (extra: { ok: boolean; model?: string; value?: any; text?: string; error?: string }): CallResult<T> => {
      const out: CallResult<T> = {
        ok: extra.ok === true,
        attempts,
        ms: now() - started,
      }
      if (extra.model) out.model = extra.model
      if (extra.value !== undefined) out.value = extra.value as T
      if (typeof extra.text === "string" && extra.text.length) out.text = extra.text
      if (!extra.ok) out.error = extra.error || lastError || "no candidate produced a usable answer"
      return out
    }

    let R: Resolved
    try {
      R = resolveCfg(cfg)
    } catch (e) {
      lastError = encodeErr("CONFIG_ERROR", 0, `config unreadable: ${errText(e)}`)
      return finish({ ok: false })
    }

    try {
      if (!client || !client.session || typeof client.session.prompt !== "function") {
        lastError = encodeErr("CONFIG_ERROR", 0, "opencode client has no session.prompt — cannot review")
        return finish({ ok: false })
      }

      const rawPrompt = typeof opts?.prompt === "string" ? opts.prompt : ""
      if (!rawPrompt.trim()) {
        lastError = encodeErr("CONFIG_ERROR", 0, "empty prompt")
        return finish({ ok: false })
      }
      const basePrompt = truncateMiddle(rawPrompt, R.maxPromptChars)

      const candidates = Array.isArray(chain) ? chain.filter((x) => typeof x === "string" && x.trim().length) : []
      if (!candidates.length) {
        lastError = encodeErr("CONFIG_ERROR", 0, "empty model chain")
        return finish({ ok: false })
      }

      await ensureHealth(R, L)

      const perCallMs = clamp(num(opts?.timeoutMs, R.timeoutMs), 2000, 300000)
      const chainDeadline = started + Math.max(R.chainBudgetMs, perCallMs + 1000)
      const schema = opts?.schema && typeof opts.schema === "object" ? opts.schema : undefined
      const needKeys = schema ? requiredKeys(schema) : []
      const baseSystem = str(opts?.system, R.system)
      const agent = str(opts?.agent, R.agent)

      if (authDead()) {
        lastError = encodeErr(
          "AUTH_DEAD",
          401,
          `api key rejected — cooling down ${Math.round((AUTH_DEAD_UNTIL - now()) / 1000)}s (paid uses the same key)`,
        )
        attempts.push({ model: candidates[0], ms: 0, error: lastError })
        return finish({ ok: false })
      }
      if (EDGE_BAN_UNTIL > now()) {
        lastError = encodeErr("EDGE_BAN", 403, `edge ban cooldown for ${Math.round((EDGE_BAN_UNTIL - now()) / 1000)}s`)
        attempts.push({ model: candidates[0], ms: 0, error: lastError })
        return finish({ ok: false })
      }

      // ── build the plan, preserving the caller's order ──
      type Plan = { id: string; providerID: string; modelID: string; skip?: { cls: ErrClass; why: string; benchLike: boolean } }
      const plan: Plan[] = []
      for (const spec of candidates) {
        const parsed = splitModel(spec, R.defaultProvider)
        if (!parsed) {
          plan.push({
            id: String(spec),
            providerID: "",
            modelID: "",
            skip: { cls: "CONFIG_ERROR", why: "unparseable model id", benchLike: false },
          })
          continue
        }
        const id = `${parsed.providerID}/${parsed.modelID}`
        const av = availability(id, parsed.providerID, parsed.modelID, R, perCallMs)
        plan.push({
          id,
          providerID: parsed.providerID,
          modelID: parsed.modelID,
          skip: av.ok ? undefined : { cls: av.cls, why: av.why, benchLike: av.benchLike },
        })
      }

      // A stale bench must never create a total outage: if EVERY candidate is skipped and at
      // least one was skipped for a soft (bench-like) reason, force the first such candidate.
      // Throttled by probeCooldownMs so a genuinely broken single-model chain is probed
      // occasionally instead of on every single tool call.
      if (plan.length > 0 && plan.every((p) => !!p.skip)) {
        const forced = plan.find((p) => p.skip?.benchLike === true)
        if (forced) {
          const fh = healthOf(forced.id, R)
          if (now() - fh.lastForcedAt >= R.probeCooldownMs) {
            fh.lastForcedAt = now()
            L.warn(`callmodel: every candidate unavailable — probing ${forced.id} anyway (${forced.skip?.why})`)
            forced.skip = undefined
          } else {
            L.debug(`callmodel: every candidate unavailable and the probe window is closed — failing open`)
          }
        }
      }

      let attemptsUsed = 0
      const largestLaterCtx = (idx: number): number => {
        let best = 0
        for (let i = idx + 1; i < plan.length; i++) {
          if (plan[i].skip) continue
          const c = num(MODEL_CTX[plan[i].id], 0)
          if (c > best) best = c
        }
        return best
      }

      for (let i = 0; i < plan.length; i++) {
        const p = plan[i]
        if (p.skip) {
          attempts.push({ model: p.id, ms: 0, error: encodeErr(p.skip.cls, 0, p.skip.why) })
          lastError = encodeErr(p.skip.cls, 0, `${p.id}: ${p.skip.why}`)
          continue
        }
        if (attemptsUsed >= R.maxAttempts) {
          attempts.push({ model: p.id, ms: 0, error: encodeErr("BUDGET_EXHAUSTED", 0, `attempt cap ${R.maxAttempts} reached`) })
          break
        }
        if (now() >= chainDeadline) {
          attempts.push({ model: p.id, ms: 0, error: encodeErr("BUDGET_EXHAUSTED", 0, "chain wall-clock budget spent") })
          lastError = encodeErr("BUDGET_EXHAUSTED", 0, "chain wall-clock budget spent")
          break
        }

        const isPaid = p.providerID === "opencode-go"
        const h = healthOf(p.id, R)
        if (h.probation) h.lastProbeAt = now()

        let system = baseSystem
        let prompt = basePrompt
        let forceUa = false
        let retriedFor: ErrClass | null = null
        let breakChain = false

        // at most TWO physical calls per candidate (the second only per the retry rules)
        for (let phys = 0; phys < 2; phys++) {
          const remaining = chainDeadline - now()
          if (remaining <= 1500) {
            attempts.push({ model: p.id, ms: 0, error: encodeErr("BUDGET_EXHAUSTED", 0, "no time left for this candidate") })
            lastError = encodeErr("BUDGET_EXHAUSTED", 0, "no time left for this candidate")
            breakChain = true
            break
          }
          const budget = Math.min(perCallMs, remaining)
          attemptsUsed++

          const one = await attemptOnce({
            client,
            log: L,
            R,
            id: p.id,
            providerID: p.providerID,
            modelID: p.modelID,
            prompt,
            system,
            agent,
            schema,
            retryCount: R.retryCount,
            budgetMs: budget,
            forceUa,
          })

          if (isPaid) {
            PAID_CALLS++
            try {
              R.onPaidCall?.({ model: p.id, ok: one.ok, ms: one.ms, costUsd: one.costUsd })
            } catch {
              /* disclosure must never break the call */
            }
            void appendLedger(R, L, {
              ts: now(),
              model: p.id,
              ok: one.ok,
              ms: one.ms,
              costUsd: one.costUsd,
              cls: one.ok ? "OK" : one.cls,
              paidCalls: PAID_CALLS,
              inChars: prompt.length,
            })
          }

          if (one.ok) {
            // ── success: validate the payload before we call it a verdict ──
            if (schema) {
              const missing = needKeys.filter((k) => one.value === null || typeof one.value !== "object" || one.value[k] === undefined)
              if (missing.length) {
                const cls: ErrClass = "EMPTY"
                const msg = `required key(s) missing from the verdict: ${missing.join(", ")}`
                attempts.push({ model: p.id, ms: one.ms, error: encodeErr(cls, one.status, msg) })
                lastError = encodeErr(cls, one.status, `${p.id}: ${msg}`)
                recordFail(h, cls, msg, R, { ms: one.ms })
                scheduleSave(R, L)
                if (!isPaid && retriedFor !== cls && phys === 0) {
                  retriedFor = cls
                  system = baseSystem + HARDEN_EMPTY
                  await sleep(R.retryDelaySchemaMs)
                  continue
                }
                break
              }
            }
            attempts.push({ model: p.id, ms: one.ms })
            recordOk(h, one.ms, !!schema)
            scheduleSave(R, L)
            if (isPaid) {
              L.warn(
                `callmodel: PAID FALLBACK USED — ${p.id} (${Math.round(one.ms)}ms, ~$${one.costUsd.toFixed(4)}, ${PAID_CALLS}/${R.maxPaidCalls} this process)`,
              )
            } else {
              L.debug(`callmodel: ${p.id} answered in ${Math.round(one.ms)}ms`)
            }
            return finish({ ok: true, model: p.id, value: one.value, text: one.text })
          }

          // ── failure ──
          const cls = one.cls
          attempts.push({ model: p.id, ms: one.ms, error: encodeErr(cls, one.status, one.msg) })
          lastError = encodeErr(cls, one.status, `${p.id}: ${one.msg}`)
          recordFail(h, cls, one.msg, R, { retryAfterMs: one.retryAfterMs, ms: one.ms })
          // a permanent ban or a fresh bench is rare and valuable across restarts → flush now,
          // ordinary failures ride the 2 s debounce so we never hammer the disk
          if (h.permanentlyDisabled || h.benchedUntil > now()) void saveHealth(R, L)
          else scheduleSave(R, L)

          if (cls === "AUTH_DEAD") {
            AUTH_DEAD_UNTIL = now() + R.authDeadCooldownMs
            L.warn(
              `callmodel: API KEY REJECTED — aborting the chain; paid fallback uses the SAME key (no reviews for ${Math.round(R.authDeadCooldownMs / 1000)}s)`,
            )
            breakChain = true
            break
          }
          if (cls === "EDGE_BAN") {
            if (!isPaid && !forceUa && phys === 0) {
              forceUa = true
              retriedFor = cls
              continue
            }
            EDGE_BAN_UNTIL = now() + R.edgeBanCooldownMs
            L.warn(`callmodel: CLOUDFLARE EDGE BAN — every model behind the edge answers 403; cooling down ${R.edgeBanCooldownMs}ms`)
            breakChain = true
            break
          }
          if (isPaid) break // one paid attempt per candidate, ever
          if (retriedFor) break // already spent this candidate's single retry

          if (cls === "SERVER_5XX") {
            retriedFor = cls
            await sleep(R.retryDelayServerMs + Math.floor(Math.random() * 500) - 250)
            continue
          }
          if (cls === "SCHEMA_INVALID") {
            retriedFor = cls
            system = baseSystem + HARDEN_SCHEMA
            await sleep(R.retryDelaySchemaMs)
            continue
          }
          if (cls === "EMPTY") {
            retriedFor = cls
            system = baseSystem + HARDEN_EMPTY
            await sleep(R.retryDelaySchemaMs)
            continue
          }
          if (cls === "NET_TIMEOUT") {
            // a dropped socket is worth one immediate retry; a real deadline hit is not
            if (one.ms < 2000 && !one.timedOut) {
              retriedFor = cls
              await sleep(500)
              continue
            }
            break
          }
          if (cls === "CTX_OVERFLOW") {
            const later = largestLaterCtx(i)
            const mine = num(MODEL_CTX[p.id], 0)
            if (later <= mine) {
              retriedFor = cls
              prompt = truncateMiddle(basePrompt, Math.max(1000, Math.floor(basePrompt.length / 2)))
              continue
            }
            break // a bigger-context candidate is coming — give it the full payload
          }
          break // NO_SO, MODEL_DEAD, RATE_LIMIT, SESSION_ERROR, UNKNOWN → advance
        }

        if (breakChain) break
      }

      L.warn(`callmodel: chain exhausted after ${attempts.length} attempt(s) — ${lastError}`)
      return finish({ ok: false })
    } catch (e) {
      // absolutely last resort: a bug in here must degrade to "no review", never to a throw
      lastError = encodeErr("UNKNOWN", 0, `internal caller error: ${errText(e)}`)
      try {
        L.warn("callmodel: internal error (failing open)", errText(e))
      } catch {
        /* ignore */
      }
      return finish({ ok: false })
    }
  }

  return { call }
}

/* ────────────────────────────── one physical model call ────────────────────────────── */

type OnceOut = {
  ok: boolean
  value?: any
  text?: string
  ms: number
  status: number
  cls: ErrClass
  msg: string
  retryAfterMs: number
  timedOut: boolean
  costUsd: number
}

async function attemptOnce(a: {
  client: any
  log: Logger
  R: Resolved
  id: string
  providerID: string
  modelID: string
  prompt: string
  system: string
  agent: string
  schema: any
  retryCount: number
  budgetMs: number
  forceUa: boolean
}): Promise<OnceOut> {
  const t0 = now()
  const out: OnceOut = {
    ok: false,
    ms: 0,
    status: 0,
    cls: "UNKNOWN",
    msg: "",
    retryAfterMs: 0,
    timedOut: false,
    costUsd: 0,
  }
  let sessionID = ""
  let timedOut = false

  try {
    // ── 1. throwaway session ──
    try {
      const title = `${a.R.titlePrefix} ${a.modelID} ${Math.random().toString(36).slice(2, 8)}`
      const created = await withDeadline(
        () => a.client.session.create({ body: { title } }),
        Math.min(10000, Math.max(3000, Math.floor(a.budgetMs / 3))),
      )
      if (created.timedOut) {
        out.cls = "NET_TIMEOUT"
        out.msg = "session create timed out"
        out.timedOut = true
        out.ms = now() - t0
        return out
      }
      const u = unwrap(created.value)
      sessionID = str(u.data?.id, str((created.value as any)?.id, ""))
      if (!sessionID) {
        const fail = classifyFailure(created.error, created.value, now() - t0, a.budgetMs, false)
        // a generic create failure is a session problem, not a model problem
        out.cls = fail && fail.cls !== "UNKNOWN" ? fail.cls : "SESSION_ERROR"
        out.status = fail ? fail.status : u.status
        out.msg = fail
          ? `session create failed: ${fail.msg}`
          : `session create returned no id (${jsonish(u.error ?? u.data, 200)})`
        out.ms = now() - t0
        return out
      }
    } catch (e) {
      out.cls = "SESSION_ERROR"
      out.msg = `session create threw: ${errText(e)}`
      out.ms = now() - t0
      return out
    }

    // tell the safety layer this session is ours BEFORE any prompt (recursion guard)
    try {
      const set = a.R.reviewerSessions
      if (set && typeof set.add === "function") set.add(sessionID)
    } catch {
      /* ignore */
    }
    try {
      a.R.onSessionCreated?.(sessionID, a.id)
    } catch {
      /* ignore */
    }

    // ── 2. the prompt ──
    const tools: Record<string, boolean> = {}
    for (const k of Object.keys(TOOL_LOCKDOWN)) tools[k] = false
    for (const k of a.R.disabledTools) if (k && k !== "*") tools[k] = false

    const body: any = {
      parts: [{ type: "text", text: a.prompt }],
      model: { providerID: a.providerID, modelID: a.modelID },
      tools,
      system: a.system && a.system.length ? a.system : DEFAULT_SYSTEM,
    }
    if (a.agent) body.agent = a.agent
    if (a.schema) body.format = { type: "json_schema", schema: a.schema, retryCount: a.retryCount }

    const reqOpts: any = { path: { id: sessionID }, body }
    if (a.forceUa) reqOpts.headers = { "user-agent": "opencode-steroids/1.0" }

    const promptStart = now()
    const r = await withDeadline(() => a.client.session.prompt(reqOpts), a.budgetMs)
    const ms = now() - promptStart
    timedOut = r.timedOut
    out.ms = ms

    if (r.timedOut) {
      out.cls = "NET_TIMEOUT"
      out.status = 0
      out.msg = `no answer within ${a.budgetMs}ms`
      out.timedOut = true
      return out
    }

    const u = unwrap(r.value)
    out.status = u.status
    out.retryAfterMs = retryAfterMs(u.headers)
    out.costUsd = num(u.data?.info?.cost, 0)

    const fail = classifyFailure(r.error, r.value, ms, a.budgetMs, false)
    if (fail) {
      out.cls = fail.cls
      out.status = fail.status || out.status
      out.msg = fail.msg
      return out
    }

    const data = u.data
    const text = textFromParts(data)
    out.text = text
    const finishReason = str(data?.info?.finish, "")

    if (a.schema) {
      const found = findStructured(data)
      if (found.value === undefined) {
        const fromText = tryParseJson(text)
        if (fromText !== undefined) {
          out.ok = true
          out.value = fromText
          return out
        }
        if (finishReason === "length") {
          out.cls = "CTX_OVERFLOW"
          out.msg = "answer truncated before the verdict tool was called"
          return out
        }
        out.cls = "NO_SO"
        out.msg = found.present
          ? "StructuredOutput part present but carried no input"
          : "no StructuredOutput part in the answer"
        return out
      }
      if (found.validFlag === false) {
        out.cls = "SCHEMA_INVALID"
        out.msg = "StructuredOutput part was not schema-valid"
        return out
      }
      if (found.value === null || typeof found.value !== "object" || Object.keys(found.value).length === 0) {
        out.cls = "EMPTY"
        out.msg = "verdict object was empty"
        return out
      }
      out.ok = true
      out.value = found.value
      return out
    }

    if (finishReason === "length") {
      out.cls = "CTX_OVERFLOW"
      out.msg = "answer hit the output length limit"
      return out
    }
    if (!text) {
      out.cls = "EMPTY"
      out.msg = "no text came back"
      return out
    }
    out.ok = true
    out.value = text
    return out
  } catch (e) {
    out.ms = out.ms || now() - t0
    out.cls = "UNKNOWN"
    out.msg = `attempt threw: ${errText(e)}`
    return out
  } finally {
    // ── 3. cleanup, ALWAYS: abort if we bailed, then delete the throwaway session ──
    if (sessionID) {
      if (timedOut) {
        try {
          if (typeof a.client?.session?.abort === "function") {
            await withDeadline(() => a.client.session.abort({ path: { id: sessionID } }), 3000)
          }
        } catch {
          /* best effort */
        }
      }
      try {
        if (typeof a.client?.session?.delete === "function") {
          const d = await withDeadline(() => a.client.session.delete({ path: { id: sessionID } }), 5000)
          if (d.timedOut) a.log.debug(`callmodel: session ${sessionID} delete timed out (leaked)`)
        }
      } catch (e) {
        a.log.debug(`callmodel: session ${sessionID} delete failed`, errText(e))
      }
      try {
        a.R.onSessionClosed?.(sessionID)
      } catch {
        /* ignore */
      }
      // the reviewer-session marker is intentionally NOT removed here: late
      // tool.execute.after / event deliveries must still be recognised as ours.
    }
  }
}

/** Run a thunk under a hard deadline. Never throws; never leaves an unhandled rejection. */
async function withDeadline(
  thunk: () => any,
  ms: number,
): Promise<{ value?: any; error?: unknown; timedOut: boolean }> {
  let ac: any = undefined
  try {
    if (typeof (globalThis as any).AbortController === "function") ac = new (globalThis as any).AbortController()
  } catch {
    ac = undefined
  }
  let started: any
  try {
    started = thunk()
  } catch (e) {
    return { error: e, timedOut: false }
  }
  const guarded: Promise<{ value?: any; error?: unknown }> = Promise.resolve(started).then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  let timer: any = null
  const timeout: Promise<{ timedOut: true }> = new Promise((res) => {
    try {
      timer = setTimeout(() => {
        try {
          ac?.abort?.()
        } catch {
          /* ignore */
        }
        res({ timedOut: true })
      }, clamp(num(ms, 1000), 1, 600000))
      // not unref'd on purpose: the deadline must fire even on an idle loop; it is always
      // cleared as soon as the race settles, so it never holds the process open.
    } catch {
      res({ timedOut: true })
    }
  })
  const winner: any = await Promise.race([guarded, timeout])
  try {
    if (timer) clearTimeout(timer)
  } catch {
    /* ignore */
  }
  if (winner && winner.timedOut === true) return { timedOut: true }
  return { value: winner?.value, error: winner?.error, timedOut: false }
}

/** Append one line to the paid-call ledger. Best effort, never throws, never awaited by call(). */
async function appendLedger(R: Resolved, log: Logger, row: Record<string, unknown>): Promise<void> {
  if (!R.persist) return
  try {
    const line = `${JSON.stringify(row)}\n`
    let fs: any = null
    try {
      fs = await import("node:fs/promises")
    } catch {
      fs = null
    }
    const cut = R.ledgerFile.lastIndexOf("/")
    if (fs && typeof fs.mkdir === "function") {
      try {
        await fs.mkdir(cut > 0 ? R.ledgerFile.slice(0, cut) : R.stateDir, { recursive: true })
      } catch {
        /* exists */
      }
    }
    if (fs && typeof fs.appendFile === "function") {
      await fs.appendFile(R.ledgerFile, line, "utf8")
    }
  } catch (e) {
    log.debug("callmodel: ledger append failed", errText(e))
  }
}

/* ────────────────────────────── free-tier exhaustion helper ────────────────────────────── */

/**
 * Read a {@link CallResult} and say whether the FREE segment of the chain is genuinely
 * exhausted — the question the review board must answer before it considers spending the
 * paid subscription.
 *
 * `paidWorthTrying` is the one the board should branch on: it is false when the failure was
 * an auth problem or a Cloudflare edge ban, because both hit `opencode-go` identically
 * (one API key, one edge) and paying would change nothing.
 */
export function freeTierStatus(res: any): FreeTierStatus {
  const attempts: any[] = Array.isArray(res?.attempts) ? res.attempts : []
  let freeTried = 0
  let freeFailed = 0
  let freeSkipped = 0
  let paidTried = 0
  let freeOk = false
  let keyDead = authDead()
  let edgeBanned = EDGE_BAN_UNTIL > now()
  const classes: string[] = []
  let succeededOn: string | undefined

  for (const a of attempts) {
    const id = typeof a?.model === "string" ? a.model : ""
    const isPaid = id.indexOf("opencode-go/") === 0
    const errStr = typeof a?.error === "string" ? a.error : ""
    if (!errStr) {
      if (!succeededOn) succeededOn = id
      if (isPaid) paidTried++
      else {
        freeTried++
        freeOk = true
      }
      continue
    }
    const cls = classOf(errStr)
    classes.push(`${id || "?"}:${cls}`)
    if (cls === "AUTH_DEAD") keyDead = true
    if (cls === "EDGE_BAN") edgeBanned = true
    if (isPaid) {
      paidTried++
      continue
    }
    freeTried++
    if (cls === "SKIPPED_BENCHED" || cls === "SKIPPED_DEAD" || cls === "SKIPPED_SLOW" || cls === "SKIPPED_PAID") freeSkipped++
    else freeFailed++
  }

  const freeExhausted = freeTried > 0 && !freeOk
  const paidWorthTrying = freeExhausted && !keyDead && !edgeBanned
  const summary = freeExhausted
    ? `free tier exhausted (${freeFailed} failed, ${freeSkipped} unavailable of ${freeTried}) — ${classes.join(" · ") || "no detail"}`
    : freeOk
      ? `a free model answered${succeededOn ? ` (${succeededOn})` : ""}`
      : "no free candidate was in the chain"

  return {
    freeExhausted,
    paidWorthTrying,
    authDead: keyDead,
    edgeBanned,
    freeTried,
    freeFailed,
    freeSkipped,
    paidTried,
    succeededOn,
    classes,
    summary,
  }
}

/** Convenience boolean wrapper around {@link freeTierStatus}. */
export function isFreeExhausted(res: any): boolean {
  try {
    return freeTierStatus(res).freeExhausted
  } catch {
    return false
  }
}
