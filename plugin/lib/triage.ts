/**
 * lib/triage.ts — the cost/latency governor of the review board.
 *
 * PURE. SYNCHRONOUS. ZERO network. ZERO filesystem. NEVER THROWS.
 *
 * `triage()` decides whether an LLM review happens at all, and how expensive it may be.
 * Every mutation the coding agent attempts passes through here first, so it must be
 * dirt cheap: a handful of regex tests over strings that are already in memory.
 *
 * Exports (and nothing else):
 *   - triage(tool, args, cfg) -> { risk, reasons, summary, ... }
 *   - redact(text, cfg)       -> string
 *
 * Contract note: `risk` is the documented 3-value `Risk` from ./types.ts. The finer
 * 5-value `tier` (free|low|medium|high|fatal) is returned ALONGSIDE it as an extra
 * field so reviewboard.ts can pick a roster/timeout without re-deriving anything.
 * Consumers that only know about `risk` keep working.
 */

import type { Risk } from "./types.ts"

/* ────────────────────────────────────────────────────────────────────────────
 * Tiers
 * ──────────────────────────────────────────────────────────────────────────── */

type Tier = "free" | "low" | "medium" | "high" | "fatal"

const TIER_RANK: Record<Tier, number> = { free: 0, low: 1, medium: 2, high: 3, fatal: 4 }

function maxTier(a: Tier, b: Tier): Tier {
  return (TIER_RANK[b] ?? 0) > (TIER_RANK[a] ?? 0) ? b : a
}

/** tier -> the documented coarse Risk. */
function tierToRisk(t: Tier): Risk {
  if (t === "free") return "safe"
  if (t === "high" || t === "fatal") return "danger"
  return "review"
}

export type TriageResult = {
  /** documented coarse verdict */
  risk: Risk
  /** human-readable reasons, deduped, capped */
  reasons: string[]
  /** short description of the action, redacted + truncated, for a reviewer prompt */
  summary: string
  /** finer-grained tier (extra field, safe to ignore) */
  tier: Tier
  /** cheap diff/size metrics (extra field) */
  metrics: Record<string, number | boolean | string[]>
  /** stable key for the verdict cache (extra field) */
  cacheKey: string
  /** true when this call's OUTPUT must never be forwarded to a reviewer (env/auth dumps) */
  withholdOutput: boolean
  /** true when the payload was so secret-dense that reviewing it is not worth the risk */
  tooSecret: boolean
  /** number of redactions applied while building `summary` */
  redactions: number
}

/* ────────────────────────────────────────────────────────────────────────────
 * Defensive config access.  Accepts flat keys or a nested `cfg.triage.*`.
 * ──────────────────────────────────────────────────────────────────────────── */

function pick(cfg: any, key: string): any {
  try {
    if (cfg && typeof cfg === "object") {
      const t = (cfg as any).triage
      if (t && typeof t === "object" && (t as any)[key] !== undefined) return (t as any)[key]
      if ((cfg as any)[key] !== undefined) return (cfg as any)[key]
    }
  } catch {}
  return undefined
}

function cfgNum(cfg: any, key: string, dflt: number): number {
  const v = pick(cfg, key)
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
  return Number.isFinite(n) && n >= 0 ? n : dflt
}

function cfgStr(cfg: any, key: string, dflt: string): string {
  const v = pick(cfg, key)
  return typeof v === "string" && v.length ? v : dflt
}

function cfgBool(cfg: any, key: string, dflt: boolean): boolean {
  const v = pick(cfg, key)
  if (typeof v === "boolean") return v
  if (v === "true" || v === 1 || v === "1") return true
  if (v === "false" || v === 0 || v === "0") return false
  return dflt
}

function cfgStrArr(cfg: any, key: string): string[] {
  const v = pick(cfg, key)
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) if (typeof x === "string" && x.length) out.push(x)
  return out
}

function cwdSafe(): string {
  try {
    const p: any = (globalThis as any)?.process
    const d = typeof p?.cwd === "function" ? p.cwd() : ""
    return typeof d === "string" ? d : ""
  } catch {
    return ""
  }
}

function homeSafe(): string {
  try {
    const h = (globalThis as any)?.process?.env?.HOME
    return typeof h === "string" && h.length ? h : "/root"
  } catch {
    return "/root"
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Regex construction helpers.
 *
 * Lookbehind is used by three redaction rules. It parses fine on modern JSC/V8,
 * but a literal regex that fails to parse would be a SyntaxError that kills the
 * whole module at import time — so those are built at runtime and dropped if the
 * engine refuses them.
 * ──────────────────────────────────────────────────────────────────────────── */

function safeRe(source: string, flags?: string): RegExp | undefined {
  try {
    return new RegExp(source, flags)
  } catch {
    return undefined
  }
}

function compact<T>(xs: Array<T | undefined>): T[] {
  const out: T[] = []
  for (const x of xs) if (x !== undefined) out.push(x)
  return out
}

/* ────────────────────────────────────────────────────────────────────────────
 * §1  PATH CLASSES
 * ──────────────────────────────────────────────────────────────────────────── */

/** Touching these is never worth a model's opinion — deterministic stop. */
const PATH_FATAL: RegExp[] = [
  // the user's LIVE opencode config, and the credential store next to it
  /\/\.config\/opencode\//,
  /\/\.local\/share\/opencode\/auth\.json$/,
  // the supervisor cannot be allowed to disarm itself
  /\/plugin(?:s)?\/(?:steroids|reviewboard|review-board)\.[cm]?[jt]s$/,
  /\/plugin(?:s)?\/lib\/(?:triage|callmodel|reviewboard|advisors|config|types|gate|budget|redact|danger|state|blastradius|guardstate)\.[cm]?[jt]s$/,
  /(?:^|\/)(?:steroids|review-board)\.json$/,
  /\/\.local\/state\/ocrev\//,
  // host integrity
  /^\/etc\//,
  /^\/boot\//,
  /^\/sys\//,
  /^\/proc\//,
  /^\/dev\/(?!null$|zero$|stdout$|stderr$|tty$)/,
  /^\/usr\/(?:bin|sbin|lib)\//,
  /^\/bin\//,
  /^\/sbin\//,
  // authorized_keys is a permanent-backdoor class of change
  /\/\.ssh\/authorized_keys$/,
]

/** Secret-bearing paths: the FACT of touching them is reviewable, the CONTENT never leaves. */
const PATH_SECRET: RegExp[] = [
  /(?:^|\/)\.env(?:\.[A-Za-z0-9._-]+)?$/,
  /\.env$/,
  /\/\.ssh\//,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/,
  /\.(?:pem|key|pfx|p12|jks|keystore|kdbx|ovpn)$/,
  /\/\.aws\//,
  /\/\.kube\/config$/,
  /\/\.docker\/config\.json$/,
  /(?:^|\/)\.npmrc$/,
  /(?:^|\/)\.netrc$/,
  /(?:^|\/)\.pgpass$/,
  /(?:^|\/)\.git-credentials$/,
  /(?:^|\/)secrets?[A-Za-z0-9._-]*$/i,
  /secret[A-Za-z0-9._-]*\.(?:json|ya?ml|env|txt|ts|js)$/i,
  /(?:^|\/)wg[A-Za-z0-9._-]*\.conf$/,
  /\/auth\.json$/,
  /(?:^|\/)credentials?(?:\.[A-Za-z0-9]+)?$/i,
]

/** High-risk files: an edit here can break auth, CI, deploys or the shared host. */
const PATH_HIGH: RegExp[] = [
  /(?:^|\/)\.github\/workflows\//,
  /(?:^|\/)(?:Dockerfile|docker-compose(?:\.[A-Za-z0-9-]+)?\.ya?ml)$/,
  /(?:^|\/)(?:\.gitlab-ci\.yml|Jenkinsfile|\.circleci\/config\.yml)$/,
  /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.ya?ml|bun\.lockb?)$/,
  /\/(?:migrations?|migrate)\/[^/]+\.(?:sql|ts|js)$/,
  /(?:^|\/)(?:drizzle|prisma)\/.*\.(?:sql|prisma)$/,
  /(?:^|\/)(?:middleware|auth|authorization|permission|permissions)\.[cm]?[jt]sx?$/,
  /(?:^|\/)systemd\/|\.service$|\.timer$/,
  /(?:^|\/)Caddyfile$/,
  /(?:^|\/)nginx(?:\.conf)?$/,
  /(?:^|\/)\.bashrc$|(?:^|\/)\.zshrc$|(?:^|\/)\.profile$/,
  /(?:^|\/)crontab$|\/cron\.d\//,
  /(?:^|\/)AGENTS\.md$|(?:^|\/)CLAUDE\.md$/,
]

/** Sensitive but ordinary: worth a note, not a stop. */
const PATH_MEDIUM: RegExp[] = [
  /(?:^|\/)package\.json$/,
  /(?:^|\/)tsconfig(?:\.[A-Za-z0-9-]+)?\.json$/,
  /(?:^|\/)(?:next|vite|webpack|rollup|tailwind|postcss|eslint|jest|vitest|babel)\.config\.[cm]?[jt]s$/,
  /(?:^|\/)\.eslintrc(?:\.[A-Za-z0-9]+)?$/,
  /(?:^|\/)\.gitignore$/,
  /(?:^|\/)\.opencode\//,
  /(?:^|\/)opencode\.jsonc?$/,
  /(?:^|\/)README(?:\.[A-Za-z]+)?$/,
]

const TEST_FILE_PATH =
  /(?:^|\/)(?:tests?|__tests__|spec|specs|e2e)\/|(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|(?:^|\/)[^/]+_test\.(?:go|py|rb)$/

/** Trees a recursive content search must never be pointed at (unbounded-search rule). */
const BIG_TREE_PATTERNS: RegExp[] = [
  /^\/?$/,
  /^~\/?$/,
  /^\$HOME\/?$/,
  /^\/root\/?$/,
  /^\/home\/?$/,
  /^\/home\/[A-Za-z0-9._-]+\/?$/,
  /^\/opt\/?$/,
  /^\/var\/?$/,
  /^\/usr\/?$/,
  /\.claude(?:\/|$)/,
]

/* ────────────────────────────────────────────────────────────────────────────
 * §2  CONTENT SIGNALS
 * ──────────────────────────────────────────────────────────────────────────── */

/** A credential-shaped literal appearing in written content. No /g — used with .test(). */
const SECRET_IN_CONTENT =
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bsk-ant-[A-Za-z0-9_-]{20,}|\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}|\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{33,42}\b|\bxox[abposr]-[A-Za-z0-9-]{10,}\b|\bglpat-[A-Za-z0-9_-]{20,}\b|\bnpm_[A-Za-z0-9]{36}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\bsk_live_[A-Za-z0-9]{16,}\b/

const TEST_WEAKENED_INTRODUCED =
  /\b(?:it|test|describe|context)\.(?:skip|only|todo|failing)\s*\(|\b(?:xit|xdescribe|fdescribe|fit)\s*\(|@pytest\.mark\.(?:skip|xfail)|@unittest\.skip|\/\/\s*@ts-nocheck|#\s*type:\s*ignore|\bt\.Skip\s*\(|\/\/\s*eslint-disable(?!-next-line\s+no-console)/

const GUARD_REMOVED =
  /\b(?:assert|invariant|require|validate|verify|authorize|authenticate|checkPermission|hasPermission|isAdmin|isAuthorized|requireAuth|requireUser|csrf|sanitize|escapeHtml|zod|safeParse|\.parse\(|throw new (?:Error|ForbiddenError|UnauthorizedError))/

/* ────────────────────────────────────────────────────────────────────────────
 * §3  REDACTION (safety spec 7b) — pure, exported
 * ──────────────────────────────────────────────────────────────────────────── */

type RedactRule = { re: RegExp; label: string; repl?: (...m: any[]) => string }

const MARK = (label: string) => "«REDACTED:" + label + "»"

const REDACT_RULES: RedactRule[] = compact<RedactRule>([
  {
    re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    label: "private-key",
  },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, label: "anthropic-key" },
  { re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, label: "sk-key" },
  { re: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g, label: "telegram-bot-token" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, label: "github-token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: "github-pat" },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, label: "aws-access-key-id" },
  { re: /\bAIza[0-9A-Za-z_-]{33,42}\b/g, label: "google-api-key" },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, label: "slack-token" },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, label: "gitlab-token" },
  { re: /\bnpm_[A-Za-z0-9]{36}\b/g, label: "npm-token" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: "jwt" },
  { re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g, label: "stripe-key" },
  {
    re: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp|clickhouse):\/\/\S+/gi,
    label: "connection-string",
  },
  // 44-char base64 (WireGuard keys and friends). Lookbehind/lookahead built at runtime.
  (() => {
    const re = safeRe("(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])", "g")
    return re ? { re, label: "wireguard-or-b64-key" } : undefined
  })(),
  // url basic auth: keep the user, kill the password
  (() => {
    const re = safeRe("(?<=:\\/\\/)([^\\/\\s:@]{1,64}):([^\\/\\s@]{1,128})@", "g")
    return re
      ? {
          re,
          label: "url-basic-auth",
          repl: (_m: string, user: string) => String(user) + ":" + MARK("url-basic-auth") + "@",
        }
      : undefined
  })(),
  {
    re: /(--?(?:password|passwd|pass|token|api[-_]?key|apikey|secret|auth|bearer)(?:[= ]))\s*("[^"]*"|'[^']*'|\S+)/gi,
    label: "cli-secret-flag",
    repl: (_m: string, flag: string) => String(flag) + MARK("cli-secret-flag"),
  },
  {
    re: /\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic|token|digest)\s+\S+/gi,
    label: "auth-header",
  },
  {
    re: /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?|COOKIE|SESSION_KEY)[A-Z0-9_]*)\s*([:=])\s*("[^"]*"|'[^']*'|[^\s;&|]{4,})/g,
    label: "env-assignment",
    repl: (_m: string, name: string, sep: string) => String(name) + String(sep) + MARK("env-assignment"),
  },
  {
    re: /\bSTRIPE_[A-Z_]*\s*[:=]\s*\S+/g,
    label: "stripe-key",
  },
])

/** Shannon entropy of a token, bits per char. Cheap: only called on ≥32-char tokens. */
function entropy(s: string): number {
  const n = s.length
  if (n < 8) return 0
  const freq: Record<string, number> = Object.create(null)
  for (let i = 0; i < n; i++) {
    const c = s[i] as string
    freq[c] = (freq[c] ?? 0) + 1
  }
  let h = 0
  for (const k in freq) {
    const p = (freq[k] as number) / n
    h -= p * Math.log2(p)
  }
  return h
}

const HIGH_ENTROPY_VALUE =
  /((?:[:=]|--?[A-Za-z0-9_-]+[= ])\s*)("?)([A-Za-z0-9+/=_-]{32,})\2/g

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

type RedactOut = { text: string; hits: number }

function redactCore(text: string, cfg: any): RedactOut {
  let out = typeof text === "string" ? text : ""
  if (!out.length) return { text: "", hits: 0 }

  const mode = cfgStr(cfg, "redact", "standard")
  if (mode === "off") return { text: out, hits: 0 }

  let hits = 0

  for (const rule of REDACT_RULES) {
    try {
      out = out.replace(rule.re, (...m: any[]) => {
        hits++
        return rule.repl ? rule.repl(...m) : MARK(rule.label)
      })
    } catch {
      /* one broken rule must never break redaction as a whole */
    }
  }

  // literal denylist supplied by config (host-specific known secrets)
  for (const lit of cfgStrArr(cfg, "extraSecrets")) {
    if (lit.length < 6) continue
    try {
      const re = safeRe(escapeRe(lit), "g")
      if (!re) continue
      out = out.replace(re, () => {
        hits++
        return MARK("configured-secret")
      })
    } catch {}
  }

  // high-entropy value heuristic (values only, never whole lines)
  const entThreshold = cfgNum(cfg, "entropyThreshold", 3.5)
  try {
    out = out.replace(HIGH_ENTROPY_VALUE, (m: string, lead: string, q: string, val: string) => {
      if (entropy(val) < entThreshold) return m
      hits++
      return String(lead) + String(q) + MARK("high-entropy") + String(q)
    })
  } catch {}

  return { text: out, hits }
}

/**
 * redact(text, cfg) — strip credential-shaped values from any text before it is
 * handed to a reviewer model. Pure, synchronous, never throws.
 *
 * cfg.redact: "off" | "standard" | "paranoid"  (default "standard")
 * cfg.extraSecrets: string[] — literal values to blank out (min length 6)
 */
export function redact(text: string, cfg: any): string {
  try {
    return redactCore(text, cfg).text
  } catch {
    // If redaction itself fails we must NOT return the raw text.
    return "«REDACTED:redactor-error»"
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * §4  BASH ANALYSIS
 * ──────────────────────────────────────────────────────────────────────────── */

/** Read-only verbs. A bash call is `free` only if EVERY segment starts with one. */
const SAFE_VERBS = new Set([
  "ls", "cat", "head", "tail", "wc", "echo", "printf", "pwd", "which", "whoami", "id",
  "date", "uname", "hostname", "uptime", "free", "df", "du", "stat", "file", "basename",
  "dirname", "realpath", "readlink", "nl", "sort", "uniq", "cut", "tr", "column", "diff",
  "cmp", "jq", "yq", "true", "false", "sleep", "test", "seq", "md5sum", "sha1sum",
  "sha256sum",
])

/** Verbs whose safety depends on their subcommand. */
const GIT_SAFE_SUB = new Set([
  "status", "diff", "log", "show", "branch", "describe", "rev-parse", "blame", "shortlog",
  "ls-files", "ls-tree", "cat-file", "tag", "remote", "whatchanged", "count-objects",
])

/** Commands whose OUTPUT must never be forwarded to a reviewer (7c). */
const OUTPUT_WITHHOLD =
  /(?:^|[\s;&|(])(?:env|printenv|set|export\s*$|gh\s+auth\s+token|pass\s+show|security\s+find-generic-password|aws\s+configure\s+get|op\s+read)\b|(?:docker|systemctl)\s+(?:inspect|show)\b|cat\s+\S*(?:auth\.json|\.env|\.npmrc|\.netrc|id_[a-z0-9]+|credentials)/

/** Host-rule build commands — never on this shared box. */
const BUILD_BANNED =
  /(?:^|[\s;&|(])(?:npm\s+(?:i|install|ci|rebuild)|yarn(?:\s+(?:install|add))?|pnpm\s+(?:i|install|add)|bun\s+(?:install|add|i)|tsc|tsx|ts-node|next\s+(?:build|dev|start|lint)|webpack|turbo(?:\s+\w+)?|vitest|jest|playwright|eslint|nest\s+build|ng\s+build|cargo\s+build|go\s+build|mvn|gradle)\b|npm\s+run\s+(?:build|dev|lint|start|test)/

/** Deterministic destroyers. */
const DANGER_CMD: Array<{ re: RegExp; why: string }> = [
  { re: /(?:^|[\s;&|(])dd\s+[^;|&]*\bof=/, why: "dd writes directly to a device or file" },
  { re: /(?:^|[\s;&|(])mkfs(?:\.[a-z0-9]+)?\b/, why: "mkfs formats a filesystem" },
  { re: /(?:^|[\s;&|(])shred\b/, why: "shred destroys data unrecoverably" },
  { re: /(?:^|[\s;&|(])truncate\s+[^;|&]*-s\s*0\b/, why: "truncate -s 0 empties a file" },
  { re: />\s*\/dev\/(?:sd|nvme|hd|vd)[a-z]/, why: "raw write to a block device" },
  { re: /(?:^|[\s;&|(])(?:mkswap|swapoff|fdisk|parted|wipefs)\b/, why: "disk-level operation" },
  { re: /:\s*\(\s*\)\s*\{[^}]*\|\s*:\s*&/, why: "fork bomb" },
  { re: /(?:^|[\s;&|(])chmod\s+(?:-[A-Za-z]+\s+)*777\b/, why: "chmod 777 makes files world-writable" },
  { re: /(?:^|[\s;&|(])chown\s+-[A-Za-z]*R/, why: "recursive ownership change" },
  { re: /(?:^|[\s;&|(])chmod\s+-[A-Za-z]*R/, why: "recursive permission change" },
  { re: /(?:curl|wget)\b[^;|&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k|s)?sh\b/, why: "piping a download straight into a shell" },
  { re: /(?:^|[\s;&|(])git\s+push\b[^;|&]*(?:--force(?!-with-lease)|(?:^|\s)-f(?:\s|$))/, why: "force-push overwrites remote history" },
  { re: /(?:^|[\s;&|(])git\s+reset\s+[^;|&]*--hard/, why: "git reset --hard destroys uncommitted work" },
  { re: /(?:^|[\s;&|(])git\s+clean\s+[^;|&]*-[A-Za-z]*[fx]/, why: "git clean -fd deletes untracked files" },
  { re: /(?:^|[\s;&|(])git\s+checkout\s+--\s/, why: "git checkout -- discards uncommitted changes" },
  { re: /(?:^|[\s;&|(])git\s+branch\s+-D\b/, why: "force-deletes a branch" },
  { re: /(?:^|[\s;&|(])npm\s+publish\b/, why: "publishing a package is irreversible" },
  { re: /(?:^|[\s;&|(])(?:docker\s+(?:system\s+prune|volume\s+rm|rm\s+-f)|docker\s+compose\s+down\s+[^;|&]*-v)/, why: "destroys container state or volumes" },
  { re: /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i, why: "drops a database object" },
  { re: /\bTRUNCATE\s+(?:TABLE\s+)?[A-Za-z_"`]/i, why: "truncates a table" },
  { re: /\bALTER\s+TABLE\b[^;]*\bDROP\s+COLUMN\b/i, why: "drops a column" },
  { re: /(?:^|[\s;&|(])(?:shutdown|reboot|halt|poweroff|init\s+0)\b/, why: "would take the host down" },
  { re: /(?:^|[\s;&|(])(?:iptables|nft|ufw)\s+(?:-F|--flush|flush|reset)/, why: "flushes firewall rules (kill-switch!)" },
  { re: /(?:^|[\s;&|(])wg-quick\s+down\b/, why: "tears down the VPN tunnel" },
]

/** Mutating and consequential: worth a blocking look (tier `high`). */
const HIGH_CMD: Array<{ re: RegExp; why: string }> = [
  { re: /(?:^|[\s;&|(])git\s+push\b/, why: "pushes to a remote" },
  { re: /(?:^|[\s;&|(])(?:systemctl|service|pm2|supervisorctl)\s+(?:stop|restart|disable|kill|delete|reload|start)/, why: "controls a live service" },
  { re: /(?:^|[\s;&|(])docker\s+(?:stop|kill|rm|restart|compose\s+(?:down|restart|up))\b/, why: "changes running containers" },
  { re: /(?:^|[\s;&|(])(?:mv|cp)\s+[^;|&]*(?:^|\s)-[A-Za-z]*f/, why: "force move/copy overwrites the destination" },
  { re: /(?:^|[\s;&|(])(?:curl|wget)\b[^;|&]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--data|(?:^|\s)-d\s|--upload-file|(?:^|\s)-T\s)/, why: "sends data to a remote host" },
  { re: /(?:^|[\s;&|(])(?:crontab|at)\s/, why: "schedules background work" },
  { re: /(?:^|[\s;&|(])(?:apt|apt-get|dpkg|yum|dnf|brew)\s+(?:install|remove|purge|upgrade)/, why: "installs or removes system packages" },
  { re: /(?:^|[\s;&|(])pip3?\s+(?:install|uninstall)/, why: "installs python packages" },
  { re: /\bUPDATE\s+[A-Za-z_"`][^;]*\bSET\b/i, why: "updates database rows" },
  /* There was no DELETE rule here at all until the load test caught it: UPDATE was covered
   * and its destructive sibling was not. Row removal is not recoverable without a backup. */
  { re: /\bDELETE\s+FROM\b/i, why: "deletes database rows" },
  { re: /\bINSERT\s+INTO\b/i, why: "writes database rows" },
  { re: /\bALTER\s+TABLE\b/i, why: "alters a table" },
]

/** Mutating but easily recoverable: fast gate is enough (tier `medium`). */
const MEDIUM_CMD: Array<{ re: RegExp; why: string }> = [
  { re: /(?:^|[\s;&|(])git\s+(?:commit|merge|rebase|cherry-pick|revert|stash|apply|am|tag)\b/, why: "changes local git state" },
  { re: /(?:^|[\s;&|(])git\s+(?:add|rm|mv|fetch|pull|switch|checkout)\b/, why: "moves the working tree or index" },
  { re: /(?:^|[\s;&|(])sed\s+[^;|&]*-i\b/, why: "sed -i edits files in place" },
  { re: /(?:^|[\s;&|(])tee\b/, why: "writes files" },
  { re: /(?:^|[\s;&|(])(?:scp|rsync|ssh)\b/, why: "acts on another machine" },
  { re: /(?:^|[\s;&|(])(?:touch|mkdir|ln|install)\s/, why: "creates files or links" },
  { re: /(?:^|[\s;&|(])(?:mv|cp)\s/, why: "moves or copies files" },
  { re: /(?:^|[\s;&|(])opencode\s+(?:run|serve)\b/, why: "spawns a nested opencode process" },
  { re: /(?:^|[\s;&|(])(?:psql|mysql|sqlite3|clickhouse-client)\b/, why: "talks to a database" },
  { re: /(?:^|[\s;&|(])(?:python3?|node|bun)\s+\S+\.(?:py|[cm]?js|ts)\b/, why: "runs a script" },
  { re: /(?:^|[\s;&|(])(?:pm2|systemctl|service|docker)\b/, why: "service/container command" },
]

/** Writing into a file via redirection — the target decides how bad it is. */
const REDIRECT_CMD = /(?:^|[^0-9>])>>?\s*(?!\s*\/dev\/(?:null|stdout|stderr)\b)[^\s;|&]+/

const CHROMIUM_CMD =
  /(?:^|[\s;&|(])(?:puppeteer|playwright|chromium|google-chrome|chrome)\b|--headless|puppeteer\.launch/

const PKILL_CMD = /(?:^|[\s;&|(])(?:pkill|killall)\b|(?:^|[\s;&|(])kill\s/

const SEARCH_VERB = /(?:^|[\s;&|(])(find|grep|egrep|fgrep|rg|ugrep|ack|ag)\b/

const DEPTH_LIMITED =
  /-maxdepth\s+[0-2]\b|--max-depth[= ]?[0-2]\b|--maxdepth[= ]?[0-2]\b|-depth\s+[0-2]\b/

const RECURSIVE_GREP_FLAG = /(?:^|\s)-[a-zA-Z]{0,6}[rR][a-zA-Z]{0,6}(?=\s|$)|--recursive\b|--include\b/

/** Split a command into pipeline/list segments without a real shell parser. */
function segments(cmd: string): string[] {
  /* `2>&1` is a file-descriptor duplication, not a background/AND separator. Splitting on its
   * `&` cuts the command in two and leaves a stray "1" that no rule recognises, so a
   * harmless `ls -la 2>&1` was scored as an unknown mutating command. Dropping a no-op
   * stream redirect changes nothing for any other rule (they all test the whole command). */
  const parts = cmd.replace(/(?:^|\s)\d*>&\d(?=\s|$)/g, " ").split(/(?:\|\||&&|[;\n|&])+/g)
  const out: string[] = []
  for (const p of parts) {
    const t = p.trim()
    if (t.length) out.push(t)
  }
  return out.length ? out : [cmd.trim()]
}

function firstToken(seg: string): string {
  // strip leading env assignments and simple wrappers
  let s = seg.trim()
  for (let i = 0; i < 4; i++) {
    const m = s.match(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)/)
    if (!m) break
    s = s.slice(m[0].length)
  }
  s = s.replace(/^(?:sudo|command|time|nohup|env)\s+(?:-\S+\s+)*/, "")
  const m = s.match(/^([A-Za-z0-9_./:-]+)/)
  return m ? (m[1] as string).replace(/^.*\//, "") : ""
}

function looksLikeSafeSegment(seg: string): boolean {
  /* Discarding a stream is not a write, so `cmd 2>/dev/null` stays as safe as `cmd`. It is
   * far too common an idiom to push every read-only command into a model review — and being
   * slow on harmless calls is how a safety layer gets switched off. Strip those first, then
   * treat any REMAINING redirect or substitution as unknown. */
  seg = seg.replace(/(?:^|\s)\d*>>?\s*\/dev\/(?:null|stdout|stderr)\b/g, " ").replace(/(?:^|\s)\d*>&\d\b/g, " ")
  if (/[><`]|\$\(/.test(seg)) return false
  const verb = firstToken(seg)
  if (!verb) return false
  if (verb === "git") {
    const m = seg.match(/\bgit\s+(?:-[^\s]+\s+)*([a-z-]+)/)
    const sub = m ? (m[1] as string) : ""
    if (!GIT_SAFE_SUB.has(sub)) return false
    if (sub === "remote" && !/\bremote\s+(?:-v|--verbose|show|get-url)?\s*$|remote\s+(?:-v|show|get-url)/.test(seg)) return false
    return true
  }
  if (verb === "du") return /-s|--summarize/.test(seg)
  if (verb === "sed") return !/-i\b/.test(seg)
  if (verb === "grep" || verb === "egrep" || verb === "fgrep") {
    // a non-recursive grep over named files is as harmless as `cat`
    return !RECURSIVE_GREP_FLAG.test(seg)
  }
  if (verb === "find" || verb === "rg" || verb === "ugrep" || verb === "ack" || verb === "ag") {
    return DEPTH_LIMITED.test(seg)
  }
  if (verb === "opencode") return /\bopencode\s+(?:models|agent|stats|debug|--version|-v)\b/.test(seg)
  if (verb === "rtk") return /\brtk\s+(?:gain|discover|--version)\b/.test(seg)
  if (verb === "node" || verb === "bun" || verb === "python3" || verb === "python") {
    return /\s(?:-v|--version)\s*$/.test(seg)
  }
  if (verb === "env" || verb === "printenv" || verb === "set" || verb === "export") return false
  return SAFE_VERBS.has(verb)
}

/** Extract path-ish arguments from a command segment (cheap, best effort). */
function pathArgs(cmd: string): string[] {
  const out: string[] = []
  const re = /(?:^|\s)((?:~|\$HOME|\.{1,2})?\/[^\s;|&"'()]*|~\/?|\$HOME\/?)/g
  let m: RegExpExecArray | null
  let guard = 0
  while ((m = re.exec(cmd)) !== null && guard++ < 60) {
    const p = (m[1] as string).replace(/[.,]$/, "")
    if (p.length) out.push(p)
  }
  return out
}

function isBigTree(p: string): boolean {
  const norm = p.replace(/\/{2,}/g, "/")
  for (const re of BIG_TREE_PATTERNS) {
    try {
      if (re.test(norm)) return true
    } catch {}
  }
  return false
}

function isTmpish(p: string, worktree: string): boolean {
  return (
    /^\/tmp\//.test(p) ||
    /^\/var\/tmp\//.test(p) ||
    /\/scratchpad\//.test(p) ||
    /\/node_modules(?:\/|$)/.test(p) ||
    (worktree.length > 1 && (p === worktree + "/dist" || p.startsWith(worktree + "/dist/") || p.startsWith(worktree + "/.next/")))
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * §5  apply_patch metrics (Codex envelope)
 * ──────────────────────────────────────────────────────────────────────────── */

function patchMetrics(patchText: unknown) {
  const t = typeof patchText === "string" ? patchText : ""
  const lines = t.split("\n")
  const paths = new Set<string>()
  let deleteFileOps = 0
  let addFileOps = 0
  let updateOps = 0
  let added = 0
  let removed = 0
  for (const ln of lines) {
    const m = ln.match(/^\*\*\*\s+(Add|Delete|Update)\s+File:\s*(.+?)\s*$/)
    if (m) {
      paths.add(m[2] as string)
      if (m[1] === "Delete") deleteFileOps++
      else if (m[1] === "Add") addFileOps++
      else updateOps++
      continue
    }
    if (/^\*\*\*\s+Move\s+to:/.test(ln)) {
      const p = ln.split(":")[1]
      if (p) paths.add(p.trim())
      continue
    }
    if (/^@@/.test(ln) || /^\*\*\*/.test(ln) || /^(?:---|\+\+\+)\s/.test(ln)) continue
    if (/^\+/.test(ln)) added++
    else if (/^-/.test(ln)) removed++
  }
  return {
    paths: [...paths],
    files: paths.size,
    deleteFileOps,
    addFileOps,
    updateOps,
    added,
    removed,
    net: removed - added,
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * §6  Summary helpers
 * ──────────────────────────────────────────────────────────────────────────── */

function countLines(s: unknown): number {
  return typeof s === "string" && s.length ? s.split("\n").length : 0
}

/** Head+tail truncation with an explicit elision marker. */
function clip(s: string, max: number): string {
  if (typeof s !== "string") return ""
  if (max <= 0) return ""
  if (s.length <= max) return s
  const head = Math.max(1, Math.floor(max * 0.66))
  const tail = Math.max(0, max - head - 40)
  const elided = s.length - head - tail
  return (
    s.slice(0, head) +
    "\n…[" +
    String(elided) +
    " chars elided]…\n" +
    (tail > 0 ? s.slice(s.length - tail) : "")
  )
}

/** In paranoid mode a diff excerpt keeps only the +/- lines. */
function stripContext(diff: string): string {
  const out: string[] = []
  const lines = diff.split("\n")
  for (let i = 0; i < lines.length && out.length < 400; i++) {
    const l = lines[i] as string
    if (/^[+\-@]/.test(l) || /^\*\*\*/.test(l)) out.push(l)
  }
  return out.join("\n")
}

function firstString(...xs: any[]): string {
  for (const x of xs) if (typeof x === "string" && x.length) return x
  return ""
}

function pathOf(args: any): string {
  try {
    return firstString(args?.filePath, args?.file_path, args?.path, args?.file, args?.target)
  } catch {
    return ""
  }
}

function absPath(raw: string, worktree: string): string {
  if (!raw) return ""
  let p = raw
  if (p.startsWith("~")) p = homeSafe() + p.slice(1)
  if (p.startsWith("$HOME")) p = homeSafe() + p.slice(5)
  if (!p.startsWith("/")) p = (worktree || cwdSafe() || "") + "/" + p
  return p.replace(/\/{2,}/g, "/")
}

/** Deterministic, bounded JSON for the cache key. */
function stableStringify(v: any, depth = 0): string {
  try {
    if (v === null || v === undefined) return "null"
    const t = typeof v
    if (t === "number" || t === "boolean") return String(v)
    if (t === "string") return JSON.stringify((v as string).slice(0, 4000))
    if (depth > 4) return '"…"'
    if (Array.isArray(v)) {
      const parts: string[] = []
      for (let i = 0; i < v.length && i < 50; i++) parts.push(stableStringify(v[i], depth + 1))
      return "[" + parts.join(",") + "]"
    }
    if (t === "object") {
      const keys = Object.keys(v).sort().slice(0, 40)
      const parts: string[] = []
      for (const k of keys) parts.push(JSON.stringify(k) + ":" + stableStringify((v as any)[k], depth + 1))
      return "{" + parts.join(",") + "}"
    }
    return '"?"'
  } catch {
    return '"?"'
  }
}

/** FNV-1a, 32-bit, twice with different offsets → 16 hex chars. No crypto import. */
function cheapHash(s: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 ^= c
    h1 = (h1 * 0x01000193) >>> 0
    h2 = (h2 + c * (i + 1)) >>> 0
    h2 = (h2 ^ (h2 << 13)) >>> 0
  }
  const a = ("00000000" + h1.toString(16)).slice(-8)
  const b = ("00000000" + h2.toString(16)).slice(-8)
  return a + b
}

/* ────────────────────────────────────────────────────────────────────────────
 * How a mutating SQL statement selects its rows.
 *
 * The dangerous shape is a CATEGORY-WIDE mutation: a WHERE that picks a *class* of rows
 * (a type, a status, a flag, a name pattern, a date range) instead of naming the specific
 * rows to change. That is forbidden by the data protocol we inject, and it is the shape of
 * every "clean up the junk" accident.
 *
 * Recognised STRUCTURALLY — SQL grammar and nothing else. No table name, no column name,
 * no domain vocabulary (ANTICHEAT.md R1/R2): a detector that knew one schema's status column
 * would be recognising one task instead of being generally safe. The generic part is
 * "a column whose NAME SHAPE says primary key, compared against literal ids" — that
 * generalises to any schema, including soft-delete columns nobody told us about.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Column-name shapes that denote a primary/foreign key, not a category. */
const KEY_COLUMN = /^(?:id|[a-z0-9_$]*_id|[a-z0-9_$]*_?uuid|guid|pk|primary_key|[a-z0-9_$]*_pk)$/i

/** A literal that identifies one row: an integer id or a uuid-ish quoted string. */
function isRowIdLiteral(v: string): boolean {
  const s = v.trim()
  if (/^-?\d+$/.test(s)) return true
  if (/^'[0-9A-Fa-f]{8}-?[0-9A-Fa-f-]{4,}'$/.test(s)) return true
  return false
}

/**
 * true ⇒ the WHERE clause names specific rows by key and nothing else.
 * false ⇒ it selects a class of rows (or we could not prove otherwise, which is the same
 * thing for safety purposes).
 */
function whereNamesRowsExplicitly(whereClause: string): boolean {
  try {
    const w = whereClause
      .replace(/\b(?:returning|order\s+by|group\s+by|having|limit|offset)\b[\s\S]*$/i, "")
      .replace(/["'`]?\s*$/, "")
      .trim()
    if (!w) return false
    // Any range, pattern, null-test or negation is a class selector by definition.
    if (/\b(?:like|ilike|similar\s+to|between|is\s+null|is\s+not\s+null|regexp|rlike|any|all|exists|select)\b/i.test(w)) {
      return false
    }
    if (/(?:<|>|<>|!=|~|@>|&&)/.test(w)) return false
    if (/\bnot\b/i.test(w)) return false
    const clauses = w.split(/\b(?:and|or)\b/i)
    let named = false
    for (const raw of clauses) {
      const c = raw.replace(/[()]/g, " ").trim()
      if (!c) continue
      const m = c.match(/^(?:[A-Za-z_][\w$]*\s*\.\s*)?["'`[]?([A-Za-z_][\w$]*)["'`\]]?\s*(=|in)\s*([\s\S]+)$/i)
      if (!m) return false
      if (!KEY_COLUMN.test(m[1])) return false
      const values = m[3].replace(/[()]/g, " ").split(",").map((x) => x.trim()).filter(Boolean)
      if (!values.length) return false
      for (const v of values) if (!isRowIdLiteral(v)) return false
      named = true
    }
    return named
  } catch {
    return false
  }
}

function normTool(tool: any): string {
  const t = typeof tool === "string" ? tool.trim().toLowerCase() : ""
  if (t === "shell" || t === "execute" || t === "run") return "bash"
  if (t === "multiedit" || t === "multi_edit") return "edit"
  if (t === "patch") return "apply_patch"
  if (t === "str_replace_editor") return "edit"
  return t
}

const FREE_TOOLS = new Set([
  "read", "list", "glob", "grep", "todowrite", "todoread", "question",
  "webfetch", "websearch", "lsp_diagnostics", "lsp_hover", "lsp", "invalid",
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
  "steroids_status", "steroids_probe",
])

/* ────────────────────────────────────────────────────────────────────────────
 * §7  triage()
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Classify one tool call. Pure, synchronous, never throws, no I/O.
 *
 * Config keys read (all optional, all with defaults — see the summary at the
 * bottom of this file):
 *   maxSummaryChars, maxPatchExcerpt, maxCommandChars, redact, redactMaxHits,
 *   extraSecrets, worktree, directory, safeBashExtra, dangerBashExtra,
 *   protectedPathsExtra, allowBigTreeSearch, sizeOfExisting
 */
export function triage(
  tool: string,
  args: any,
  cfg: any,
): TriageResult {
  try {
    return triageInner(tool, args, cfg)
  } catch (e: any) {
    // A bug in triage must never break the agent and must never silently pass a
    // mutation as safe. Land in the middle: reviewable, not blocked.
    let msg = "unknown"
    try {
      msg = String(e?.message ?? e).slice(0, 200)
    } catch {}
    return {
      risk: "review",
      tier: "medium",
      reasons: ["triage internal error: " + msg],
      summary: String(tool ?? "unknown") + " (arguments could not be analysed)",
      metrics: {},
      cacheKey: "",
      withholdOutput: true,
      tooSecret: false,
      redactions: 0,
    }
  }
}

function triageInner(toolRaw: string, argsRaw: any, cfg: any): TriageResult {
  const tool = normTool(toolRaw)
  const args = argsRaw && typeof argsRaw === "object" ? argsRaw : {}

  const maxSummary = cfgNum(cfg, "maxSummaryChars", 3000)
  const maxExcerpt = cfgNum(cfg, "maxPatchExcerpt", 2000)
  const maxCmd = cfgNum(cfg, "maxCommandChars", 1200)
  const redactMode = cfgStr(cfg, "redact", "standard")
  const redactMaxHits = cfgNum(cfg, "redactMaxHits", 8)
  const worktree = (cfgStr(cfg, "worktree", "") || cfgStr(cfg, "directory", "") || cwdSafe() || "").replace(/\/$/, "")

  const reasons: string[] = []
  let tier: Tier = "free"
  const metrics: Record<string, number | boolean | string[]> = {}
  let withholdOutput = false

  const bump = (t: Tier, why: string) => {
    tier = maxTier(tier, t)
    if (why && reasons.length < 14 && !reasons.includes(why)) reasons.push(why)
  }

  /* ---- pieces of the summary, assembled at the end ---- */
  let head = tool
  let body = ""

  const extraProtected = cfgStrArr(cfg, "protectedPathsExtra")
  const protectedExtraRes: RegExp[] = []
  for (const s of extraProtected) {
    const re = safeRe(s)
    if (re) protectedExtraRes.push(re)
  }

  const classifyPath = (rawPath: string, netDeletion: number) => {
    const abs = absPath(rawPath, worktree)
    if (!abs) return
    let fatal = false
    for (const re of PATH_FATAL) {
      try {
        if (re.test(abs)) {
          bump("fatal", "protected path: " + abs)
          fatal = true
          break
        }
      } catch {}
    }
    if (!fatal) {
      for (const re of protectedExtraRes) {
        try {
          if (re.test(abs)) {
            bump("fatal", "protected path (config): " + abs)
            fatal = true
            break
          }
        } catch {}
      }
    }
    if (fatal) return
    let secret = false
    for (const re of PATH_SECRET) {
      try {
        if (re.test(abs)) {
          secret = true
          break
        }
      } catch {}
    }
    if (secret) bump("high", "secret-bearing file: " + abs)
    if (worktree.length > 1 && !abs.startsWith(worktree + "/") && !isTmpish(abs, worktree)) {
      bump("high", "path outside the worktree: " + abs)
    }
    let hi = false
    for (const re of PATH_HIGH) {
      try {
        if (re.test(abs)) {
          hi = true
          break
        }
      } catch {}
    }
    if (hi) bump("high", "high-risk file: " + abs)
    else {
      for (const re of PATH_MEDIUM) {
        try {
          if (re.test(abs)) {
            bump("medium", "sensitive file: " + abs)
            break
          }
        } catch {}
      }
    }
    try {
      if (TEST_FILE_PATH.test(abs) && netDeletion > 10) {
        bump("high", "test file shrinking by " + netDeletion + " lines: " + abs)
      }
    } catch {}
  }

  /* ═══════════════ read-only / free tools ═══════════════ */
  if (FREE_TOOLS.has(tool)) {
    // one exception: the search tools can be pointed at a huge tree
    const p = pathOf(args)
    if ((tool === "grep" || tool === "glob") && p) {
      const abs = absPath(p, worktree)
      if (isBigTree(abs) && !cfgBool(cfg, "allowBigTreeSearch", false)) {
        // transcript trees and filesystem/home roots are the ones that actually OOM'd
        // the host; other large trees only earn a fast-gate look.
        const worst = /\.claude(?:\/|$)/.test(abs) || /^(?:\/|\/root\/?|\/home\/?)$/.test(abs)
        bump(worst ? "high" : "medium", "search rooted at a huge tree: " + abs + " (unbounded-search rule)")
      }
    }
    // reads are never reviewed, but their OUTPUT must still never be forwarded
    // anywhere if it came out of a credential file.
    if (p) {
      const abs = absPath(p, worktree)
      for (const re of PATH_SECRET) {
        try {
          if (re.test(abs)) {
            withholdOutput = true
            break
          }
        } catch {}
      }
    }
    const target = firstString(p, args?.pattern, args?.url, args?.query, args?.description)
    head = tool + (target ? " " + target : "")
    body = ""
    metrics.readOnly = true
  } else if (tool === "bash") {
    /* ═══════════════ bash ═══════════════ */
    const cmd = firstString(args?.command, args?.cmd, args?.script)
    metrics.commandChars = cmd.length
    if (args?.background === true) metrics.background = true

    if (!cmd) {
      bump("medium", "bash call with no command string")
      head = "bash (no command)"
    } else {
      head = "bash: " + clip(cmd, Math.max(maxCmd, 120))

      try {
        if (OUTPUT_WITHHOLD.test(cmd)) {
          withholdOutput = true
          bump("medium", "command dumps environment/credentials — its output is withheld from reviewers")
        }
      } catch {}

      // ---- host-rule hard denies (fatal, no model needed) ----
      try {
        if (BUILD_BANNED.test(cmd)) {
          bump("fatal", "build/install command banned on this shared host (npm/tsc/next/webpack/jest…)")
        }
      } catch {}

      // recursive content search over a huge tree
      try {
        const sv = cmd.match(SEARCH_VERB)
        if (sv) {
          const verb = (sv[1] as string) || ""
          const recursive =
            verb === "find" || verb === "rg" || verb === "ugrep" || verb === "ack" || verb === "ag"
              ? true
              : RECURSIVE_GREP_FLAG.test(cmd)
          const depthOk = DEPTH_LIMITED.test(cmd)
          if (recursive && !depthOk) {
            const targets = pathArgs(cmd)
            // no explicit absolute target => it walks the cwd; that is only OK if the
            // cwd itself is not one of the huge trees.
            const bare = targets.length === 0
            let big = bare && isBigTree(worktree || cwdSafe())
            for (const t of targets) if (isBigTree(absPath(t, worktree))) big = true
            if (big && !cfgBool(cfg, "allowBigTreeSearch", false)) {
              bump(
                "fatal",
                "recursive content search over a huge tree (unbounded-search rule: such a scan once consumed 3.5 GB in 4 min)",
              )
            } else {
              bump("low", "recursive search (" + verb + ") without a depth limit")
            }
          }
        }
      } catch {}

      // rm
      try {
        if (/(?:^|[\s;&|(])rm\s/.test(cmd)) {
          const force = /(?:^|[\s;&|(])rm\s+(?:-[A-Za-z]*\s+)*-{1,2}[A-Za-z]*[rRf]/.test(cmd) || /\brm\s+-[A-Za-z]*[rRf]/.test(cmd)
          const targets = pathArgs(cmd)
          const rootish = targets.some((t) => /^\/?$|^\/\*?$|^~\/?$|^\$HOME\/?$/.test(t.replace(/\/{2,}/g, "/")))
          const allTmp = targets.length > 0 && targets.every((t) => isTmpish(absPath(t, worktree), worktree))
          if (rootish) bump("fatal", "rm targeting a filesystem or home root")
          else if (force && allTmp) bump("medium", "recursive delete confined to a temp/scratch path")
          else if (force) bump("fatal", "recursive/forced delete (rm -rf) outside a temp path")
          else bump("high", "file deletion via rm")
          for (const t of targets) classifyPath(t, 0)
        }
      } catch {}

      // pkill / kill
      try {
        if (PKILL_CMD.test(cmd)) {
          const bracketed = /\[[^\]]\]/.test(cmd)
          const exactPid = /(?:^|[\s;&|(])kill\s+(?:-[A-Za-z0-9]+\s+)*\d+(?:\s+\d+)*\s*$/.test(cmd)
          const sessionish = /\b(?:tmux|screen|ttyd)\b/.test(cmd)
          if (bracketed || exactPid) {
            // the narrow, safe form
            if (sessionish) bump("high", "narrow kill, but it targets live terminal-session processes (tmux/screen/ttyd)")
            else bump("medium", "process kill with a narrow pattern or an exact pid")
          } else if (sessionish) {
            bump("fatal", "broad kill pattern aimed at live terminal sessions (tmux/screen/ttyd)")
          } else {
            bump(
              "fatal",
              "pkill/killall with a broad pattern (it also matches itself and kills live sessions; use a [b]racketed pattern or an exact pid)",
            )
          }
        }
      } catch {}

      // headless browsers (host rule: never several at once)
      try {
        if (CHROMIUM_CMD.test(cmd)) {
          bump("high", "starts a headless browser — headless browsers are heavy; keep to one at a time")
        }
      } catch {}

      // deterministic destroyers
      for (const d of DANGER_CMD) {
        try {
          if (d.re.test(cmd)) bump("fatal", d.why)
        } catch {}
      }

      /* How does a mutating statement choose its rows? Structural check only — see
       * whereNamesRowsExplicitly(). No WHERE at all is unarguable and gets no model vote.
       * A class selector still goes to the board (a bulk delete CAN be the right answer,
       * e.g. expiring a cache), but it goes there with the objection spelled out, which is
       * what makes the reviewers block the bad ones. */
      try {
        const mutating = /\bDELETE\s+FROM\b/i.test(cmd) || /\bUPDATE\s+[A-Za-z_."`][^;]*\bSET\b/i.test(cmd)
        if (mutating) {
          const verb = /\bDELETE\s+FROM\b/i.test(cmd) ? "DELETE" : "UPDATE"
          const where = cmd.match(/\bWHERE\b([\s\S]*)$/i)
          if (!where) {
            bump("fatal", `${verb} with no WHERE clause — that is every row in the table`)
          } else if (!whereNamesRowsExplicitly(where[1])) {
            bump(
              "high",
              `${verb} selects rows by CLASS (a type/status/flag/pattern/range), not by an explicit list of primary keys — a category-wide mutation`,
            )
          } else {
            bump("high", `${verb} targets rows named explicitly by key`)
          }
        }
      } catch {}

      // consequential but recoverable
      for (const s of HIGH_CMD) {
        try {
          if (s.re.test(cmd)) bump("high", s.why)
        } catch {}
      }
      for (const s of MEDIUM_CMD) {
        try {
          if (s.re.test(cmd)) bump("medium", s.why)
        } catch {}
      }
      /* A redirect whose producing command outputs NOTHING empties the target. That is the
       * same effect as `truncate -s 0`, so it earns the same verdict.
       *
       * Learned the hard way in the load test: `truncate -s 0 x` was vetoed, and the agent
       * immediately achieved the identical result with `> x`, which scored two tiers lower
       * and was allowed. A gate that ranks two spellings of one action differently is a gate
       * that can be walked around, so the rule is written on the EFFECT, not the verb. */
      try {
        const EMPTYING_REDIRECT =
          /^\s*(?::|true|echo\s*(?:-n)?\s*(?:''|"")?|printf\s*(?:''|"")?|cat\s+\/dev\/null)?\s*>\s*(?!\s*\/dev\/)[^\s;|&<>]+\s*$/
        for (const seg of segments(cmd)) {
          if (/>>/.test(seg)) continue // append adds, it does not destroy
          if (EMPTYING_REDIRECT.test(seg)) {
            bump("fatal", "empties an existing file by redirection — the same effect as truncate -s 0")
          }
        }
      } catch {}
      try {
        if (REDIRECT_CMD.test(cmd)) bump("medium", "redirects output into a file")
      } catch {}

      // writes into a protected/secret path via redirection or an editor-ish tool
      try {
        const targets = pathArgs(cmd)
        metrics.pathCount = targets.length
        /* REDIRECT_CMD rather than a bare `>`: a bare `>` also matches `2>/dev/null`, which
         * made every read-only command carrying it look like a write. Live consequence: a
         * plain `ls <protected dir> 2>/dev/null || echo none` was hard-denied as if it were
         * writing there. One definition of "writes a file", used everywhere. */
        const writesFiles =
          REDIRECT_CMD.test(cmd) ||
          /(?:\btee\b|\bsed\s+-i\b|\bmv\b|\bcp\b|\btouch\b|\bmkdir\b|\bchmod\b|\bchown\b|\bln\b)/.test(cmd)
        if (writesFiles) for (const t of targets) classifyPath(t, 0)
      } catch {}

      // if nothing fired, decide between free and low
      if (tier === "free") {
        const segs = segments(cmd)
        let allSafe = segs.length > 0
        for (const s of segs) if (!looksLikeSafeSegment(s)) allSafe = false
        if (allSafe) {
          metrics.safeBash = true
        } else {
          bump("low", "mutating or unrecognised shell command")
        }
      }

      body = ""
    }
  } else if (tool === "apply_patch") {
    /* ═══════════════ apply_patch ═══════════════ */
    const patchText = firstString(args?.patchText, args?.patch, args?.diff, args?.input)
    const m = patchMetrics(patchText)
    metrics.files = m.files
    metrics.added = m.added
    metrics.removed = m.removed
    metrics.net = m.net
    metrics.deleteFileOps = m.deleteFileOps
    metrics.addFileOps = m.addFileOps
    metrics.updateOps = m.updateOps
    metrics.paths = m.paths.slice(0, 20)

    if (m.deleteFileOps >= 3) bump("fatal", "patch deletes " + m.deleteFileOps + " files")
    else if (m.deleteFileOps > 0) bump("high", "patch deletes " + m.deleteFileOps + " file(s)")
    if (m.files > 12) bump("high", "patch spans " + m.files + " files")
    else if (m.files > 5) bump("medium", "patch spans " + m.files + " files")
    if (m.removed > 60 && m.removed > 3 * m.added) {
      bump("high", "deletion-heavy patch (-" + m.removed + "/+" + m.added + ")")
    }
    sizeSignals(m.added, m.removed, bump)
    contentSignals(patchText, "", bump)

    let anySecretPath = false
    for (const p of m.paths) {
      classifyPath(p, m.net)
      const abs = absPath(p, worktree)
      for (const re of PATH_SECRET) {
        try {
          if (re.test(abs)) anySecretPath = true
        } catch {}
      }
    }

    head = "apply_patch: " + (m.paths.length ? m.paths.slice(0, 6).join(", ") : "(no file headers)") +
      " (-" + m.removed + "/+" + m.added + ")"
    body = anySecretPath
      ? "<patch body withheld: touches a secret-bearing path>"
      : redactMode === "paranoid"
        ? stripContext(patchText)
        : patchText
  } else if (tool === "edit" || tool === "write") {
    /* ═══════════════ edit / write ═══════════════ */
    const p = pathOf(args)
    const abs = absPath(p, worktree)
    let added = 0
    let removed = 0
    let newFile = false

    /** Lines the target has right now; 0 = it does not exist. Injected, see cfg.sizeOfExisting. */
    const existingLines = (): number | undefined => {
      try {
        const fn = pick(cfg, "sizeOfExisting")
        if (typeof fn === "function") {
          const v = fn(abs)
          if (typeof v === "number" && Number.isFinite(v)) return v
        }
      } catch {}
      return undefined
    }

    if (tool === "edit") {
      removed = countLines(args?.oldString ?? args?.old_string)
      added = countLines(args?.newString ?? args?.new_string)
      if (args?.replaceAll === true || args?.replace_all === true) {
        bump("medium", "replaceAll: unbounded occurrence count")
      }
      const ns = firstString(args?.newString, args?.new_string)
      if (args?.newString === "" || ns.trim() === "") {
        /* Replacing the WHOLE file with nothing is a blanking however few lines it has — the
         * 10-line floor below is for "a big chunk went away", which is a different signal.
         * Learned live: with truncate, `>` and write-empty all blocked, the agent emptied a
         * 3-line file with an edit whose oldString was the entire file, and slipped under the
         * floor. Every spelling of one destructive effect must get one verdict. */
        const old = existingLines()
        if (old !== undefined && old > 0 && removed + 1 >= old) {
          bump("fatal", "replaces the entire contents of an existing file with nothing — the same effect as truncate -s 0")
        } else if (removed > 10) {
          bump("high", "wholesale deletion of " + removed + " lines")
        }
      }
    } else {
      added = countLines(args?.content ?? args?.text ?? args?.newString)
      const old: number | undefined = existingLines()
      if (old === undefined || old === 0) {
        newFile = true
        metrics.newFile = true
        if (added > 400) bump("medium", "new file, " + added + " lines")
      } else {
        removed = old
        /* Writing NOTHING over a file that exists is a blanking, whatever its size. It is the
         * same act as `truncate -s 0` and `> file`, so it gets the same verdict — a gate that
         * blocks the shell spelling and waves the tool spelling through is not a gate.
         * Learned live: with `truncate` and `>` both blocked, the agent emptied the file with
         * the write tool and empty content, and nothing objected. */
        const blob = firstString(args?.content, args?.text, args?.newString)
        if (blob.trim().length === 0) {
          bump("fatal", "writes empty content over an existing file — the same effect as truncate -s 0")
        } else if (old > 120 && added < old * 0.5) {
          bump("high", "truncating rewrite: " + old + " → " + added + " lines")
        }
      }
    }

    metrics.added = added
    metrics.removed = removed
    metrics.net = removed - added
    sizeSignals(added, removed, bump)

    const blob = firstString(args?.newString, args?.new_string, args?.content, args?.text)
    const oldBlob = firstString(args?.oldString, args?.old_string)
    contentSignals(blob, oldBlob, bump)

    classifyPath(p || abs, removed - added)

    let secretPath = false
    for (const re of PATH_SECRET) {
      try {
        if (re.test(abs)) secretPath = true
      } catch {}
    }

    head =
      tool +
      ": " +
      (abs || "(no path)") +
      " (-" +
      removed +
      "/+" +
      added +
      (newFile ? ", new file" : "") +
      ")"

    if (secretPath) {
      body = "<file redacted: secret-bearing path> " + abs
    } else if (tool === "edit") {
      const oldPart = oldBlob ? "--- removed ---\n" + oldBlob : ""
      const newPart = blob ? "+++ added +++\n" + blob : ""
      body = [oldPart, newPart].filter((x) => x.length).join("\n")
      if (redactMode === "paranoid") body = clip(body, Math.min(maxExcerpt, 800))
    } else {
      body = blob
      if (redactMode === "paranoid") body = clip(body, Math.min(maxExcerpt, 800))
    }
  } else if (tool === "task") {
    /* ═══════════════ task (delegation) ═══════════════ */
    const sub = firstString(args?.subagent_type, args?.agent, args?.subagentType)
    const desc = firstString(args?.description, args?.title)
    const prompt = firstString(args?.prompt, args?.message, args?.input)
    metrics.promptChars = prompt.length
    if (args?.background === true) metrics.background = true

    bump("medium", "delegates work to a subagent" + (sub ? " (" + sub + ")" : ""))
    try {
      if (BUILD_BANNED.test(prompt)) bump("high", "delegated prompt asks for a banned build/install command")
      if (SEARCH_VERB.test(prompt) && !DEPTH_LIMITED.test(prompt)) {
        bump("high", "delegated prompt asks for an unbounded recursive search")
      }
      if (CHROMIUM_CMD.test(prompt)) bump("high", "delegated prompt asks a subagent to drive a headless browser")
      if (SECRET_IN_CONTENT.test(prompt)) bump("high", "a credential-shaped literal is being forwarded to a subagent")
    } catch {}

    head = "task → " + (sub || "?") + (desc ? ": " + desc : "")
    body = prompt
  } else {
    /* ═══════════════ unknown tool ═══════════════ */
    bump("low", "unrecognised tool '" + tool + "' — treated as a mutation")
    const p = pathOf(args)
    if (p) classifyPath(p, 0)
    head = (tool || "unknown") + (p ? " " + p : "")
    try {
      body = stableStringify(args)
    } catch {
      body = ""
    }
  }

  /* ═══════════════ assemble the summary ═══════════════ */
  // order (safety spec §7): path blocklist (done above) → value redaction → size cap.
  // `body` is pre-sliced generously first so redaction cost stays bounded on huge blobs.
  const preSlice = Math.max(maxExcerpt * 4, 8000)
  let rawBody = body.length > preSlice ? clip(body, preSlice) : body
  const rHead = redactCore(head, cfg)
  const rBody = redactCore(rawBody, cfg)
  const redactions = rHead.hits + rBody.hits

  let tooSecret = false
  let bodyOut = clip(rBody.text, maxExcerpt)
  if (redactMode === "paranoid" && redactions > redactMaxHits) {
    tooSecret = true
    bodyOut = "<payload withheld: " + redactions + " secrets redacted — too secret to send>"
  }

  let summary = rHead.text
  if (bodyOut.length) summary = summary + "\n" + bodyOut
  summary = clip(summary, Math.max(maxSummary, 200))

  metrics.redactions = redactions
  metrics.summaryChars = summary.length

  const cacheKey = cheapHash(tool + "\u0000" + stableStringify(args))

  return {
    risk: tierToRisk(tier),
    tier,
    reasons: reasons.length ? reasons : tier === "free" ? ["read-only or allow-listed action"] : ["no specific signal"],
    summary,
    metrics,
    cacheKey,
    withholdOutput,
    tooSecret,
    redactions,
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * shared signal helpers (used by both the patch and the edit/write branches)
 * ──────────────────────────────────────────────────────────────────────────── */

function sizeSignals(added: number, removed: number, bump: (t: Tier, why: string) => void) {
  const net = removed - added
  if (net > 80) bump("high", "net deletion of " + net + " lines")
  else if (removed > 200) bump("high", removed + " lines removed")
  else if (removed > 40 || net > 5 || added > 200) {
    bump("medium", "diff size (-" + removed + "/+" + added + ")")
  } else if (added > 0 || removed > 0) {
    bump("low", "small in-worktree change (-" + removed + "/+" + added + ")")
  }
}

function contentSignals(blob: string, oldBlob: string, bump: (t: Tier, why: string) => void) {
  const b = typeof blob === "string" ? blob : ""
  const o = typeof oldBlob === "string" ? oldBlob : ""
  try {
    if (SECRET_IN_CONTENT.test(b)) bump("high", "a credential-shaped literal is being written")
  } catch {}
  try {
    if (TEST_WEAKENED_INTRODUCED.test(b) && !TEST_WEAKENED_INTRODUCED.test(o)) {
      bump("high", "a test skip/only marker is being introduced")
    }
  } catch {}
  try {
    if (GUARD_REMOVED.test(o) && !GUARD_REMOVED.test(b)) {
      bump("high", "a validation/authorization check is being removed")
    }
  } catch {}
}
