/**
 * opencode-steroids — configuration + logging.
 *
 * Exports EXACTLY three runtime symbols:
 *   loadConfig()      sync: defaults ← ~/.config/opencode/steroids.json ← env ← kill-files
 *   defaultConfig()   sync: a fresh, fully-populated default object (never shared/frozen)
 *   makeLogger(cfg)   best-effort JSONL file logger honouring cfg.logging.level
 *
 * Rules obeyed here:
 *  - NOTHING is ever written under ~/.config/opencode/. That file is read-only input.
 *  - No function in this file may throw. Ever. A broken config file, a missing HOME, an
 *    unwritable log dir, a cyclic log payload — all degrade to defaults / no-ops.
 *  - No top-level side effects: no I/O, no env reads, no mutable shared state.
 *  - Arrays in the user's JSON REPLACE the default array (they are not concatenated), so
 *    a user can shorten a chain or a pattern list. Objects are deep-merged.
 */

import type { Logger, LogLevel, Mode, SteroidsConfig } from "./types.ts"
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs"

/* ────────────────────────────────────────────────────────────────────────────
 * tiny defensive helpers
 * ──────────────────────────────────────────────────────────────────────────── */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function homeDir(): string {
  try {
    const h = process.env.HOME
    if (typeof h === "string" && h.trim() !== "") return h.replace(/\/+$/, "")
  } catch {}
  return "/root"
}

function defaultStateDir(home: string): string {
  try {
    const xdg = process.env.XDG_STATE_HOME
    if (typeof xdg === "string" && xdg.trim() !== "") return `${xdg.replace(/\/+$/, "")}/ocrev`
  } catch {}
  return `${home}/.local/state/ocrev`
}

/** All state-dir-relative paths in one place, so an env override re-derives them. */
function derivePaths(stateDir: string): Record<string, unknown> {
  const sd = String(stateDir || "").replace(/\/+$/, "") || "/tmp/ocrev"
  return {
    stateDir: sd,
    logFile: `${sd}/steroids.jsonl`,
    ledgerFile: `${sd}/paid-ledger.jsonl`,
    healthFile: `${sd}/health.json`,
    allowFile: `${sd}/ocrev.allow`,
    offFile: `${sd}/OFF`,
    pauseFile: `${sd}/PAUSE`,
    killFiles: [`${sd}/OFF`, "/tmp/review-board.off", "/tmp/rb.off"],
  }
}

/**
 * Deep-merge `over` onto `base`. Plain objects recurse; everything else (arrays,
 * scalars, null) replaces. Keys starting with "//" are treated as comments and skipped.
 * Never throws; a hostile `over` just gets ignored.
 */
function deepMerge(base: unknown, over: unknown): unknown {
  try {
    if (!isPlainObject(over)) return base
    if (!isPlainObject(base)) return over
    const out: Record<string, unknown> = { ...base }
    for (const k of Object.keys(over)) {
      if (k.startsWith("//")) continue
      const ov = over[k]
      if (ov === undefined) continue
      const bv = out[k]
      out[k] = isPlainObject(ov) && isPlainObject(bv) ? deepMerge(bv, ov) : ov
    }
    return out
  } catch {
    return base
  }
}

/** First non-empty env var among `names`, trimmed. */
function ev(...names: string[]): string | undefined {
  for (const n of names) {
    try {
      const v = process.env[n]
      if (typeof v === "string" && v.trim() !== "") return v.trim()
    } catch {}
  }
  return undefined
}

function truthy(v: string | undefined): boolean {
  if (v === undefined) return false
  return ["1", "on", "true", "yes", "y", "enable", "enabled"].includes(v.toLowerCase())
}

function falsy(v: string | undefined): boolean {
  if (v === undefined) return false
  return ["0", "off", "false", "no", "n", "disable", "disabled"].includes(v.toLowerCase())
}

function toNum(v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function toList(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined
  const out = v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
  return out.length ? out : undefined
}

/** off | observe | enforce, accepting the aliases from the safety + latency specs. */
function parseMode(v: string | undefined): Mode | undefined {
  if (v === undefined) return undefined
  const raw = v.toLowerCase()
  if (["0", "off", "false", "no", "disable", "disabled", "none"].includes(raw)) return "off"
  if (["observe", "dry", "dry-run", "dryrun", "log", "shadow", "advise", "advisory"].includes(raw)) return "observe"
  if (["paranoid", "max", "hard"].includes(raw)) return "paranoid"
  if (["1", "on", "true", "yes", "guard", "enforce", "block"].includes(raw)) return "enforce"
  return undefined
}

/* ────────────────────────────────────────────────────────────────────────────
 * defaults
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The literal below is generated into steroids.json byte-for-byte identically, so the
 * sidecar file and this function can never disagree. Do not hand-edit one without the
 * other. Every state path here is built from the live HOME / XDG_STATE_HOME;
 * defaultConfig() re-derives them from the live environment.
 */
function baseDefaults(): unknown {
  const H = homeDir()
  const SD = defaultStateDir(H)
  return {
    version: 1,
    enabled: true,
    mode: "enforce",
    escalate: false,
    sanitize: false,
    /** derived mirror of paid.enabled — reviewboard.ts reads it as cfg.paidFallback */
    paidFallback: true,

    chains: {
      gate: [
        "opencode/ling-3.0-flash-free",
        "opencode/mimo-v2.5-free",
        "opencode/big-pickle",
        "opencode/nemotron-3-ultra-free",
        "opencode/deepseek-v4-flash-free"
      ],
      deep: [
        "opencode/nemotron-3-ultra-free",
        "opencode/mimo-v2.5-free",
        "opencode/north-mini-code-free",
        "opencode/big-pickle",
        "opencode/ling-3.0-flash-free",
        "opencode-go/mimo-v2.5-pro"
      ],
      tiebreak: [
        "opencode/nemotron-3-ultra-free",
        "opencode/north-mini-code-free",
        "opencode/big-pickle"
      ],
      panelA: [
        "opencode/nemotron-3-ultra-free",
        "opencode/north-mini-code-free",
        "opencode/big-pickle",
        "opencode-go/deepseek-v4-pro"
      ],
      panelB: [
        "opencode/mimo-v2.5-free",
        "opencode/north-mini-code-free",
        "opencode/big-pickle",
        "opencode-go/mimo-v2.5"
      ],
      panelC: [
        "opencode/ling-3.0-flash-free",
        "opencode/deepseek-v4-flash-free",
        "opencode/big-pickle",
        "opencode-go/hy3"
      ],
      /* `main` is the AGENT-LOOP role, and that is a much higher bar than reviewing.
       * nemotron-3-ultra-free is deliberately absent even though it is a strong reviewer:
       * it derails out of the tool protocol on step two of a real loop and the turn ends
       * (docs/FACTS.md corrections). It stays on the reviewer chains, where it is measured
       * to be good, and off this one. */
      main: [
        "opencode/mimo-v2.5-free",
        "opencode/north-mini-code-free",
        "opencode/ling-3.0-flash-free",
        "opencode-go/mimo-v2.5",
        "opencode-go/mimo-v2.5-pro"
      ]
    },

    weights: {
      "opencode/mimo-v2.5-free": 1,
      "opencode/nemotron-3-ultra-free": 1,
      "opencode/north-mini-code-free": 1,
      "opencode/big-pickle": 0.5,
      "opencode/ling-3.0-flash-free": 0,
      "opencode/deepseek-v4-flash-free": 0,
      "opencode-go/mimo-v2.5": 1,
      "opencode-go/mimo-v2.5-pro": 1,
      "opencode-go/deepseek-v4-pro": 1,
      "opencode-go/deepseek-v4-flash": 0.5,
      "opencode-go/hy3": 0.5
    },

    quarantined: [
      "opencode/laguna-s-2.1-free"
    ],

    contextWindow: {
      "opencode/nemotron-3-ultra-free": 1000000,
      "opencode/ling-3.0-flash-free": 262100,
      "opencode/north-mini-code-free": 256000,
      "opencode/mimo-v2.5-free": 200000,
      "opencode/big-pickle": 200000,
      "opencode/deepseek-v4-flash-free": 200000,
      "opencode-go/mimo-v2.5": 1000000,
      "opencode-go/mimo-v2.5-pro": 1000000
    },

    expectedLatencyMs: {
      "opencode/ling-3.0-flash-free": 4200,
      "opencode/deepseek-v4-flash-free": 14200,
      "opencode/mimo-v2.5-free": 16300,
      "opencode/big-pickle": 16900,
      "opencode/nemotron-3-ultra-free": 19000,
      "opencode/north-mini-code-free": 52300
    },

    tiers: {
      safe: {
        review: false,
        blocking: false,
        async: false,
        reviewers: [],
        blockThreshold: 2,
        canBlock: false,
        earlyVeto: false,
        timeoutMs: 0,
        failClosed: false,
        escalateModels: [],
        maxEscalations: 0,
        maxAdvisories: 0,
        advisoryMaxChars: 0
      },
      review: {
        review: true,
        blocking: true,
        async: false,
        reviewers: [
          "opencode/ling-3.0-flash-free",
          "opencode/mimo-v2.5-free",
          "opencode/nemotron-3-ultra-free"
        ],
        blockThreshold: 2,
        canBlock: true,
        earlyVeto: true,
        timeoutMs: 30000,
        failClosed: false,
        escalateModels: [
          "opencode/north-mini-code-free"
        ],
        maxEscalations: 1,
        maxAdvisories: 2,
        advisoryMaxChars: 500
      },
      danger: {
        review: true,
        blocking: true,
        async: false,
        reviewers: [
          "opencode/mimo-v2.5-free",
          "opencode/nemotron-3-ultra-free",
          "opencode/north-mini-code-free"
        ],
        blockThreshold: 2,
        canBlock: true,
        earlyVeto: true,
        timeoutMs: 75000,
        failClosed: true,
        escalateModels: [],
        maxEscalations: 1,
        maxAdvisories: 2,
        advisoryMaxChars: 500
      }
    },

    quorum: {
      blockThreshold: 2,
      severityFloor: ["high", "critical"],
      confidenceFloor: ["medium", "high"],
      minConsequenceChars: 25,
      minProblemChars: 10,
      requireConsequence: true,
      invalidConsequencePattern: "^\\s*(none|n/?a|nothing|unknown|unclear|possibl|may |might |could |potential|maybe|not sure)",
      vetoDemoteAfter: 4,
      cacheTtlMs: 900000,
      structuredRetryCount: 3,
      unknownVerdictIsError: true
    },

    /* How many rows may a single unattended statement change?
     *
     * This block is the v2 answer to a hole every other setting here shared: they all
     * classified the KIND of an action and none of them measured its SIZE. `WHERE <key> = …`
     * and a category-wide sweep are the same shape, so only a count separates them, and the
     * count is taken before the statement runs. See lib/blastradius.ts.
     *
     * The two limits are wide apart on purpose, and neither is fitted to any particular
     * workload: "a handful" is the honest resolution of this judgement, and any value in the
     * single digits behaves identically on everything we have measured. Lower them if your
     * agent has no business doing bulk work at all; raise `maxRows` if it legitimately does.
     *
     * ⚠️ AND THE HONEST LIMIT OF IT: this is a TAIL control. Measured against the recorded
     * attacks it refuses 4 of 10, because the legitimate repair and the most common destruction
     * are the same SIZE and differ only in DIRECTION — one adds information, the other
     * overwrites or removes it. Do not deploy this as the only thing standing between an agent
     * and your data. See plugin/lib/blastradius.ts and docs/WAY-FORWARD.md §4.1.
     */
    blastRadius: {
      enabled: true,
      /** rows provable from the predicate alone, below which nothing is checked at all */
      freeRows: 1,
      /** counted rows allowed when none of them holds a numeric value */
      maxRows: 10,
      /** counted rows allowed when they do hold non-zero numeric values */
      maxValuedRows: 3,
      /** and the same limit applied to the SUM, so it cannot be drip-fed one row at a time */
      maxRowsPerWindow: 25,
      windowMs: 3600000,
      probeTimeoutMs: 6000,
      /** cannot measure it ⇒ do not run it (on the danger tier) */
      failClosedWhenUnderivable: true,
      /** let a model write the explanation and the narrower rewrite next to the block */
      modelExplains: false,
      /** …and let it overrule the count. Off: measured weak judges approve almost anything. */
      allowModelDowngrade: false,
      /** a hard ceiling no model may argue past, whatever justification it gives */
      neverDowngradeAboveRows: 5
    },

    triage: {
      ignoreTools: [
        "read", "glob", "grep", "list", "todowrite", "todoread", "webfetch", "websearch",
        "question", "invalid", "lsp_diagnostics", "lsp_hover", "list_mcp_resources",
        "list_mcp_resource_templates", "read_mcp_resource"
      ],
      mutatingTools: [
        "bash", "write", "edit", "apply_patch", "patch", "multiedit", "task", "skill"
      ],
      fileTools: ["write", "edit", "apply_patch", "patch", "multiedit"],
      reviewTools: ["task", "skill"],
      bash: {
        safeAllow: [
          "^\\s*(?:git\\s+(?:status|diff|log|show|branch|remote\\s+-v|rev-parse|stash\\s+list)|ls|ll|cat|head|tail|wc|jq|echo|printf|pwd|which|whoami|hostname|date|uptime|df|free|uname|du\\s+-s|stat|file|node\\s+-v|python3?\\s+-V|opencode\\s+models|rtk\\s+gain)\\b"
        ],
        review: [
          "\\bgit\\s+(?:push|commit|checkout|reset|revert|rebase|merge|stash|tag|cherry-pick)\\b",
          "\\bdocker\\b",
          "\\bsystemctl\\b",
          "\\bpm2\\b",
          "\\bservice\\s+\\S+\\s+(?:start|stop|restart|reload)\\b",
          "\\bchmod\\b",
          "\\bchown\\b",
          "\\bmv\\b",
          "\\bcp\\s+-\\S*f",
          "\\bsed\\s+-i\\b",
          "\\btee\\b",
          "\\bscp\\b",
          "\\brsync\\b",
          "\\bssh\\b",
          "\\bcurl\\s+(?:-\\S+\\s+)*-X\\s*(?:POST|PUT|DELETE|PATCH)\\b",
          "\\bnpm\\s+run\\b",
          "\\bapt(?:-get)?\\s+(?:install|remove|purge|upgrade)\\b",
          "\\bpip3?\\s+install\\b",
          "\\bpsql\\b",
          "\\bmysql\\b",
          "\\bmigrat(?:e|ion)\\b",
          "\\bALTER\\s+TABLE\\b",
          "\\bUPDATE\\s+\\w+\\s+SET\\b",
          ">>?\\s*\\S"
        ],
        danger: [
          "\\brm\\s+(?:-\\S+\\s+)*[^-]",
          "\\bmv\\s+\\S+\\s+/dev/null\\b",
          "\\bgit\\s+reset\\s+--hard\\b",
          "\\bgit\\s+checkout\\s+--\\s",
          "\\bgit\\s+push\\b",
          "\\bkill\\b",
          "\\bpkill\\b",
          "\\bkillall\\b",
          "\\bDELETE\\s+FROM\\b",
          "\\bDROP\\s+(?:TABLE|DATABASE|SCHEMA)\\b",
          "\\bTRUNCATE\\s+TABLE\\b",
          "\\bchmod\\s+(?:-\\S+\\s+)*777\\b",
          "\\bchown\\s+-R\\b",
          "\\bcrontab\\b",
          "\\bufw\\b",
          "\\biptables\\b",
          "\\bnpm\\s+publish\\b",
          "\\bdocker\\s+(?:rm|rmi|system\\s+prune|volume\\s+rm)\\b",
          "\\bhelm\\s+(?:delete|uninstall)\\b",
          "\\bkubectl\\s+delete\\b",
          "\\bterraform\\s+(?:destroy|apply)\\b"
        ],
        hardDeny: [
          "\\brm\\s+(?:-\\S+\\s+)*-\\S*[rR]",
          "\\bdd\\s+[^|;]*\\bof=",
          "\\bmkfs(?:\\.|\\s)",
          "\\bshred\\b",
          "\\btruncate\\s+-s\\s*0\\b",
          ">\\s*/dev/(?:sd|nvme|vd|hd)",
          "\\bgit\\s+push\\b[^|;]*--force(?!-with-lease)",
          "\\bgit\\s+clean\\s+-\\S*[fd]",
          "\\bnpm\\s+(?:i|install|ci)\\b",
          "\\byarn\\s+(?:install|add)\\b",
          "\\bpnpm\\s+(?:i|install|add)\\b",
          "\\bbun\\s+(?:i|install|add)\\b",
          "\\b(?:npx\\s+)?tsc\\b",
          "\\bnext\\s+(?:build|dev|start)\\b",
          "\\b(?:webpack|turbo\\s+build|vite\\s+build|rollup)\\b",
          "\\b(?:jest|vitest|playwright|eslint)\\b",
          ":\\(\\)\\s*\\{",
          "\\b(?:curl|wget)\\b[^|;]*\\|\\s*(?:sudo\\s+)?(?:ba|z|d)?sh\\b",
          "\\bp?kill\\s+(?:-\\S+\\s+)*-f\\s+(?![\"']?\\S*\\[)",
          "\\bpkill\\s+(?:-\\S+\\s+)*(?:node|python3?|claude|opencode|tmux|screen|ttyd)\\b",
          "\\btmux\\s+kill-(?:server|session)\\b",
          "\\bdocker\\s+(?:kill|stop|rm)\\s+(?:-\\S+\\s+)*(?:prod|live|vpn|db|postgres)\\S*",
          "\\bchromium\\b[^|;]*--headless",
          "\\bpuppeteer\\b"
        ],
        recursiveSearchCmd: [
          "(?:^|[;&|]\\s*|\\s)(?:find|grep|egrep|fgrep|rg|ugrep|ag|ack)\\s"
        ],
        recursiveFlags: [
          "(?:^|\\s)-[a-zA-Z]*[rR][a-zA-Z]*(?:\\s|$)",
          "--recursive\\b",
          "(?:^|[;&|]\\s*|\\s)find\\s"
        ],
        depthLimited: [
          "-maxdepth\\s+[0-2]\\b",
          "--max-depth[= ]\\s*[0-2]\\b",
          "-depth\\s+[0-2]\\b"
        ],
        bigTreeRoots: [
          "/",
          "/root",
          "/home",
          "~/.claude",
          "~/.claude/projects",
          "/root/.claude",
          "/root/.claude/projects",
          "/opt",
          "/var",
          "~",
          "$HOME"
        ],
        scratchPaths: [
          "^/tmp/",
          "^/var/tmp/",
          "/scratchpad/",
          "^/dev/null$",
          "/node_modules/",
          "/\\.cache/"
        ],
        sanitizeRewrites: [
          {
            match: "(?:^|(?<=[;&|]\\s))find\\s+((?:/home|/root|/opt|~|\\$HOME)\\S*)\\s+(?!-maxdepth)",
            flags: "g",
            replace: "find $1 -maxdepth 2 ",
            why: "unbounded find over a huge tree once consumed 3.5 GB of RAM in 4 minutes on a shared host"
          },
          {
            match: "\\b(grep|egrep|fgrep)\\s+(-[a-zA-Z]*[rR][a-zA-Z]*)(?!\\S)",
            flags: "g",
            replace: "$1 $2 --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next",
            why: "recursive grep must at least skip the biggest generated trees"
          }
        ]
      },
      paths: {
        fatal: [
          "/\\.config/opencode/",
          "/\\.local/share/opencode/auth\\.json$",
          "/\\.ssh/",
          "(?:^|/)\\.env$",
          "(?:^|/)\\.env\\.",
          "(?:^|/)[^/]*\\.env$",
          "(?:^|/)id_(?:rsa|ed25519|ecdsa|dsa)(?:\\.pub)?$",
          "\\.(?:pem|key|pfx|p12|jks|kdbx)$",
          "/\\.aws/",
          "/\\.kube/config$",
          "/\\.docker/config\\.json$",
          "(?:^|/)\\.npmrc$",
          "(?:^|/)\\.netrc$",
          "(?:^|/)\\.pgpass$",
          "(?:^|/)\\.git-credentials$",
          "(?:^|/)wg\\d*\\.conf$",
          "\\.ovpn$",
          "/plugin/lib/triage\\.ts$",
          "/plugin/lib/config\\.ts$",
          "(?:^|/)steroids\\.json$",
          "(?:^|/)review-board\\.json$",
          "^/etc/",
          "^/boot/",
          "^/dev/",
          "^/proc/",
          "^/sys/",
          "^/usr/",
          "^/bin/",
          "^/sbin/"
        ],
        high: [
          "(?:^|/)package-lock\\.json$",
          "(?:^|/)bun\\.lockb?$",
          "(?:^|/)yarn\\.lock$",
          "(?:^|/)pnpm-lock\\.yaml$",
          "(?:^|/)\\.github/workflows/",
          "(?:^|/)Dockerfile",
          "(?:^|/)docker-compose",
          "(?:^|/)Makefile$",
          "(?:^|/)\\.gitignore$",
          "(?:^|/)\\.git/",
          "(?:^|/)tsconfig(?:\\..*)?\\.json$",
          "(?:^|/)next\\.config\\.",
          "(?:^|/)prisma/schema\\.prisma$",
          "(?:^|/)migrations?/",
          "(?:^|/)ecosystem\\.config\\.",
          "(?:^|/)nginx\\.conf$",
          "(?:^|/)Caddyfile$"
        ],
        medium: [
          "(?:^|/)package\\.json$",
          "(?:^|/)AGENTS\\.md$",
          "(?:^|/)CLAUDE\\.md$",
          "(?:^|/)opencode\\.jsonc?$",
          "(?:^|/)\\.opencode/",
          "(?:^|/)\\.eslintrc",
          "(?:^|/)\\.prettierrc",
          "(?:^|/)vitest\\.config\\.",
          "(?:^|/)jest\\.config\\.",
          "(?:^|/)vite\\.config\\.",
          "(?:^|/)babel\\.config\\.",
          "(?:^|/)\\.editorconfig$"
        ],
        test: "(?:^|/)(?:__tests__|tests?|spec)/|\\.(?:test|spec)\\.[cm]?[jt]sx?$",
        protectedWrite: [
          "~/.config/opencode",
          "~/.local/share/opencode",
          "~/.ssh",
          "/etc"
        ],
        outsideWorktreeRisk: "danger"
      },
      content: {
        secret: "(?:-----BEGIN\\s+(?:[A-Z ]+\\s+)?PRIVATE KEY-----|\\bsk-[A-Za-z0-9_-]{16,}|\\b\\d{8,10}:AA[A-Za-z0-9_-]{30,}\\b|\\bgh[pousr]_[A-Za-z0-9]{20,}\\b|\\bAKIA[0-9A-Z]{16}\\b|\\bAIza[0-9A-Za-z_-]{35}\\b|\\bxox[abposr]-[A-Za-z0-9-]{10,}\\b|\\bglpat-[A-Za-z0-9_-]{20,}\\b|\\bnpm_[A-Za-z0-9]{36}\\b|\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b)",
        testWeakened: "\\b(?:it|test|describe)\\.(?:skip|only)\\b|\\bxit\\s*\\(|\\bxdescribe\\s*\\(|@ts-nocheck|@ts-ignore|eslint-disable(?!-next-line)|\\.skip\\s*\\(\\s*['\"]",
        guardRemoved: "\\b(?:assert|invariant|validate|authorize|authenticate|checkPermission|requireAuth|verifySignature|csrf|sanitize|escapeHtml|rateLimit)\\b"
      },
      diff: {
        reviewChangedLines: 150,
        dangerChangedLines: 300,
        reviewFiles: 5,
        dangerFiles: 12,
        deleteFileOpsDanger: 3,
        netDeletionHigh: 80,
        removedHigh: 200,
        removedMedium: 40,
        addedMedium: 200,
        truncateRewriteMinOld: 120,
        truncateRewriteRatio: 0.5,
        newFileMediumLines: 400,
        wholesaleDeleteLines: 10,
        testShrinkNetLines: 10
      },
      allowGlobs: [],
      summaryMaxChars: 2000,
      diffPreviewLines: 200,
      redact: "standard",
      redactMaxHits: 8,
      extraSecrets: [],
      entropyThreshold: 3.5,
      maxSummaryChars: 2000,
      maxCommandChars: 2000,
      maxPatchExcerpt: 6000,
      allowBigTreeSearch: false
    },

    redact: "standard",
    extraSecrets: [],

    caller: {
      timeoutMs: 25000,
      chainBudgetMs: 30000,
      maxAttempts: 8,
      breakerFails: 3,
      benchLadderMs: [300000, 900000, 3600000],
      soBenchMs: 1800000,
      rateLimitBenchMs: 60000,
      probeCooldownMs: 300000,
      edgeBanCooldownMs: 60000,
      authDeadCooldownMs: 600000,
      slowSkipFactor: 1.5,
      retryDelayServerMs: 750,
      retryDelaySchemaMs: 250,
      maxPromptChars: 12000,
      retryCount: 3,
      agent: "",
      sessionTitlePrefix: "«ocrev»",
      defaultProvider: "opencode",
      quarantined: [
        "opencode/laguna-s-2.1-free"
      ],
      disabledTools: [
        "bash", "edit", "write", "apply_patch", "patch", "multiedit", "read", "list",
        "glob", "grep", "task", "webfetch", "websearch", "todowrite", "todoread",
        "skill", "question", "invalid", "execute", "lsp_diagnostics", "lsp_hover",
        "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"
      ],
      persist: true,
      stateDir: SD,
      paidEnabled: true,
      maxPaidCalls: 12
    },

    redaction: {
      level: "standard",
      maxHits: 8,
      maxPayloadBytes: 12000,
      headBytes: 8000,
      tailBytes: 4000,
      dropContextLinesWhenParanoid: true,
      extraSecrets: [],
      withheldOutputCommands: [
        "^\\s*(?:env|printenv|set)\\s*$",
        "\\bdocker\\s+inspect\\b",
        "\\bsystemctl\\s+show\\b",
        "\\bcat\\b[^|;]*auth\\.json",
        "\\bgh\\s+auth\\s+token\\b",
        "\\bpass\\s+show\\b",
        "\\bsecurity\\s+find-generic-password\\b"
      ],
      pathBlocklist: [
        "(?:^|/)\\.env$",
        "(?:^|/)\\.env\\.",
        "(?:^|/)[^/]*\\.env$",
        "/\\.local/share/opencode/auth\\.json$",
        "/\\.config/opencode/",
        "/\\.ssh/",
        "(?:^|/)id_[^/]*$",
        "\\.(?:pem|key|pfx|p12|jks|kdbx)$",
        "/\\.aws/",
        "/\\.kube/config$",
        "/\\.docker/config\\.json$",
        "(?:^|/)\\.npmrc$",
        "(?:^|/)\\.netrc$",
        "(?:^|/)\\.pgpass$",
        "(?:^|/)\\.git-credentials$",
        "(?:^|/)secrets?[^/]*$",
        "(?:^|/)[^/]*secret[^/]*\\.(?:json|ya?ml|env)$",
        "(?:^|/)wg\\d*\\.conf$",
        "\\.ovpn$"
      ],
      patterns: [
        { label: "private-key", source: "-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\\s\\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----", flags: "g" },
        { label: "anthropic-key", source: "\\bsk-ant-[A-Za-z0-9_-]{20,}", flags: "g" },
        { label: "sk-key", source: "\\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}", flags: "g" },
        { label: "telegram-bot-token", source: "\\b\\d{8,10}:AA[A-Za-z0-9_-]{30,}\\b", flags: "g" },
        { label: "github-token", source: "\\bgh[pousr]_[A-Za-z0-9]{20,}\\b", flags: "g" },
        { label: "github-pat", source: "\\bgithub_pat_[A-Za-z0-9_]{20,}\\b", flags: "g" },
        { label: "aws-access-key-id", source: "\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b", flags: "g" },
        { label: "google-api-key", source: "\\bAIza[0-9A-Za-z_-]{35}\\b", flags: "g" },
        { label: "slack-token", source: "\\bxox[abposr]-[A-Za-z0-9-]{10,}\\b", flags: "g" },
        { label: "gitlab-token", source: "\\bglpat-[A-Za-z0-9_-]{20,}\\b", flags: "g" },
        { label: "npm-token", source: "\\bnpm_[A-Za-z0-9]{36}\\b", flags: "g" },
        { label: "jwt", source: "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b", flags: "g" },
        { label: "wireguard-or-b64-key", source: "(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])", flags: "g" },
        { label: "url-basic-auth", source: "(?<=://)([^/\\s:@]{1,64}):([^/\\s@]{1,128})@", flags: "g" },
        { label: "cli-secret-flag", source: "(?<![\\w-])--?(?:password|passwd|pass|token|api[-_]?key|secret|auth)[= ]\\s*(\"[^\"]*\"|'[^']*'|\\S+)", flags: "gi" },
        { label: "auth-header", source: "\\b(?:authorization|proxy-authorization)\\s*:\\s*(?:bearer|basic|token)\\s+\\S+", flags: "gi" },
        { label: "env-assignment", source: "\\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?|COOKIE)[A-Z0-9_]*)\\s*[:=]\\s*(\"[^\"]*\"|'[^']*'|[^\\s;&|]{4,})", flags: "g" },
        { label: "connection-string", source: "\\b(?:mongodb(?:\\+srv)?|postgres(?:ql)?|mysql|redis|amqp|clickhouse)://\\S+", flags: "gi" },
        { label: "stripe-key", source: "\\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\\b", flags: "g" }
      ],
      entropy: {
        enabled: true,
        minLength: 32,
        minBitsPerChar: 3.5,
        charClass: "[A-Za-z0-9+/=_-]"
      },
      replacement: "«REDACTED:$LABEL»"
    },

    budget: {
      maxPerSession: 200,
      maxPerMin: 20,
      maxPerMinSession: 12,
      maxConcurrent: 2,
      queueWaitMs: 1500,
      maxSpendUsd: 0.5,
      maxSpendUsdTotal: 2,
      assumedCostUsd: 0.002,
      timeoutMs: 15000,
      timeoutMsEscalate: 25000,
      maxDepth: 3,
      maxPayloadBytes: 12000,
      maxPromptChars: 12000,
      dangerReserve: 20,
      maxBlockingPerSession: 40,
      maxCumulativeReviewMs: 360000,
      maxAsyncInFlight: 2,
      asyncQueueDepth: 4,
      cacheTtlMs: 900000,
      selfErrorsMax: 5,
      reviewerSessionGraceMs: 60000,
      seenTtlMs: 600000,
      seenMax: 2000,
      resolveCacheMax: 500,
      rootCacheMax: 200,
      bannerFullCount: 3,
      bannerEveryNth: 10
    },

    breaker: {
      failuresToBench: 3,
      benchLadderMs: [300000, 900000, 3600000],
      soFailuresToBench: 2,
      soBenchMs: 1800000,
      rateLimitBenchMs: 60000,
      promoteWindowMs: 600000,
      probationPerRoleMs: 300000,
      latencySkipFactor: 2.5,
      ewmaAlpha: 0.3,
      serverRetryDelayMs: 750,
      serverRetryJitterMs: 250,
      schemaRetryDelayMs: 250,
      emptyRetryDelayMs: 250,
      edgeBanUserAgent: "opencode-steroids/1.0",
      saveDebounceMs: 2000
    },

    paid: {
      enabled: true,
      provider: "opencode-go",
      freeProvider: "opencode",
      maxPerSession: 5,
      maxPerHour: 12,
      reservedForMain: 2,
      maxInputChars: 20000,
      maxOutputTokens: 1500,
      retries: 0,
      allowTiers: {
        gate: [],
        deep: ["danger"],
        tiebreak: ["danger"],
        panelA: ["danger"],
        panelB: ["danger"],
        panelC: ["danger"],
        main: ["safe", "review", "danger"]
      },
      fallbackMap: {
        "opencode/mimo-v2.5-free": "opencode-go/mimo-v2.5",
        "opencode/nemotron-3-ultra-free": "opencode-go/deepseek-v4-flash",
        "opencode/north-mini-code-free": "opencode-go/mimo-v2.5",
        "opencode/ling-3.0-flash-free": "opencode-go/hy3",
        "opencode/big-pickle": "opencode-go/mimo-v2.5",
        "opencode/deepseek-v4-flash-free": "opencode-go/deepseek-v4-flash"
      },
      priceUsdPerMTok: {
        "opencode-go/mimo-v2.5": { input: 0.14, output: 0.28 },
        "opencode-go/mimo-v2.5-pro": { input: 0.435, output: 0.87 },
        "opencode-go/hy3": { input: 0.14, output: 0.58 },
        "opencode-go/deepseek-v4-flash": { input: 0.14, output: 0.28 },
        "opencode-go/deepseek-v4-pro": { input: 0.435, output: 0.87 }
      }
    },

    roleBudgetMs: {
      gate: 25000,
      deep: 120000,
      tiebreak: 60000,
      panelA: 90000,
      panelB: 90000,
      panelC: 45000,
      main: 0
    },

    chainBudgetMs: {
      gate: 30000,
      deep: 240000,
      tiebreak: 90000,
      panelA: 150000,
      panelB: 150000,
      panelC: 150000,
      main: 0
    },

    /* reviewboard.ts reads THIS block as cfg.board.*. It is keyed by LENS, not by role:
     * IRREVERSIBLE | INTENT | HOST | SECRETS | SCOPE. `weights`, `blockThreshold`,
     * `extraSecrets`, `paidFallback`, `escalate`, `timeoutMs.review|danger`,
     * `advisoryMax*`, `maxVetoesPerSession`, `cacheTtlMs` and `maxCumulativeReviewMs`
     * are RE-DERIVED from the canonical blocks on every load (see syncAliases) — edit
     * weights / quorum / tiers / redaction / paid / budget, not these copies. */
    board: {
      blockThreshold: 2,
      weights: {},
      chains: {
        IRREVERSIBLE: ["opencode/mimo-v2.5-free", "opencode/big-pickle", "opencode/nemotron-3-ultra-free"],
        INTENT: ["opencode/nemotron-3-ultra-free", "opencode/mimo-v2.5-free", "opencode/big-pickle"],
        HOST: ["opencode/nemotron-3-ultra-free", "opencode/big-pickle", "opencode/mimo-v2.5-free"],
        SECRETS: ["opencode/north-mini-code-free", "opencode/mimo-v2.5-free", "opencode/big-pickle"],
        SCOPE: ["opencode/ling-3.0-flash-free", "opencode/deepseek-v4-flash-free"]
      },
      paidTail: {
        IRREVERSIBLE: ["opencode-go/mimo-v2.5"],
        INTENT: ["opencode-go/deepseek-v4-flash"],
        HOST: ["opencode-go/mimo-v2.5"],
        SECRETS: ["opencode-go/mimo-v2.5"],
        SCOPE: []
      },
      escalationChain: ["opencode/north-mini-code-free", "opencode/nemotron-3-ultra-free"],
      timeoutMs: { advisory: 10000, review: 30000, danger: 75000, escalate: 75000 },
      reviewerAgent: "",
      maxPayloadChars: 12000,
      cacheTtlMs: 900000,
      maxVetoesPerSession: 4,
      maxReviewsPerSession: 200,
      maxCumulativeReviewMs: 360000,
      advisoryMaxItems: 2,
      advisoryMaxChars: 500,
      earlyVeto: true,
      escalateOnCriticalDissent: true,
      escalate: false,
      failClosedOnDanger: true,
      paidFallback: true,
      extraSecrets: []
    },

    reviewer: {
      /* "" = send an explicit `system` instead of an agent name. A non-existent agent id
       * makes EVERY reviewer call fail, so this stays empty until you actually define a
       * `reviewer` agent in opencode.json (see opencode.json.proposed). */
      agent: "",
      sessionTitlePrefix: "«ocrev»",
      structuredRetryCount: 3,
      maxDepth: 8,
      disabledTools: [
        "bash", "edit", "write", "apply_patch", "patch", "multiedit", "read", "list",
        "glob", "grep", "task", "webfetch", "websearch", "todowrite", "todoread",
        "skill", "question", "invalid", "execute", "lsp_diagnostics", "lsp_hover",
        "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"
      ],
      neverDisable: ["StructuredOutput"],
      systemFallback: "You are one reviewer on a board guarding a coding agent. Answer ONLY through the structured verdict. Default to approve. Be terse."
    },

    /* advisors.ts reads THIS block as cfg.advisors.*. `panel` / `debatePanel` hold PERSONA
     * names, not role names — a name with no persona behind it is dropped silently.
     * `personas` is merged key-by-key over the six built-ins (architect, debugger, security,
     * skeptic, simplifier, perf); a new key adds a new persona. Keep every persona's first
     * `free` entry distinct: one model per advisor is the entire point of the panel. */
    advisors: {
      enabled: true,
      panel: ["architect", "debugger", "skeptic"],
      debatePanel: ["architect", "skeptic"],
      personas: {},
      maxCallsPerSession: 60,
      maxPanelsPerSession: 12,
      maxConcurrentToolCalls: 2,
      paidFallback: false,
      synthesize: true,
      synthesizerChain: [
        "opencode/ling-3.0-flash-free",
        "opencode/mimo-v2.5-free",
        "opencode/big-pickle"
      ],
      maxContextChars: 6000,
      maxAnswerChars: 1600,
      agent: "",
      debug: false
    },

    logging: {
      level: "info",
      file: `${SD}/steroids.jsonl`,
      stderr: true,
      maxBytes: 5242880,
      jsonl: true,
      maxFieldChars: 2000
    },

    paths: {
      stateDir: SD,
      configFile: `${H}/.config/opencode/steroids.json`,
      logFile: `${SD}/steroids.jsonl`,
      ledgerFile: `${SD}/paid-ledger.jsonl`,
      healthFile: `${SD}/health.json`,
      allowFile: `${SD}/ocrev.allow`,
      offFile: `${SD}/OFF`,
      pauseFile: `${SD}/PAUSE`,
      killFiles: [
        `${SD}/OFF`,
        "/tmp/review-board.off",
        "/tmp/rb.off"
      ],
      sentinelTtlMs: 2000
    }
  } as unknown
}

export function defaultConfig(): SteroidsConfig {
  let cfg: any = {}
  try {
    cfg = baseDefaults()
  } catch {
    cfg = {}
  }
  if (!isPlainObject(cfg)) cfg = {}
  try {
    const home = homeDir()
    const sd = defaultStateDir(home)
    const p = derivePaths(sd)
    cfg.paths = { ...(isPlainObject(cfg.paths) ? cfg.paths : {}), ...p }
    cfg.paths.configFile = `${home}/.config/opencode/steroids.json`
    if (isPlainObject(cfg.logging)) cfg.logging.file = p.logFile
    if (isPlainObject(cfg.caller)) cfg.caller.stateDir = p.stateDir
  } catch {}
  return cfg as SteroidsConfig
}

/**
 * Derived aliases. `redaction` is the single source of truth for redaction settings;
 * `cfg.redact`, `cfg.extraSecrets` and the flat `cfg.triage.*` mirrors exist because
 * triage.ts looks up flat keys (`cfg.triage.<key>` then `cfg.<key>`). Users must edit
 * `redaction.*` — these copies are overwritten on every load.
 */
function syncAliases(cfg: any): void {
  try {
    const r = isPlainObject(cfg.redaction) ? (cfg.redaction as any) : undefined
    const t = isPlainObject(cfg.triage) ? (cfg.triage as any) : undefined
    if (r) {
      if (typeof r.level === "string") {
        cfg.redact = r.level
        if (t) t.redact = r.level
      }
      if (Array.isArray(r.extraSecrets)) {
        cfg.extraSecrets = r.extraSecrets.slice()
        if (t) t.extraSecrets = r.extraSecrets.slice()
      }
      if (t && Number(r.maxHits) > 0) t.redactMaxHits = Number(r.maxHits)
      if (t && isPlainObject(r.entropy) && Number((r.entropy as any).minBitsPerChar) > 0) {
        t.entropyThreshold = Number((r.entropy as any).minBitsPerChar)
      }
    }
    if (t && Number(t.summaryMaxChars) > 0) t.maxSummaryChars = Number(t.summaryMaxChars)

    /* callmodel.ts reads cfg.caller.*; keep the duplicated knobs pointing at the
     * canonical blocks so there is exactly one place to edit each one. */
    const cl = isPlainObject(cfg.caller) ? (cfg.caller as any) : undefined
    if (cl) {
      if (Array.isArray(cfg.quarantined)) cl.quarantined = (cfg.quarantined as unknown[]).slice()
      const rv = isPlainObject(cfg.reviewer) ? (cfg.reviewer as any) : undefined
      if (rv) {
        if (Array.isArray(rv.disabledTools)) cl.disabledTools = rv.disabledTools.slice()
        if (typeof rv.sessionTitlePrefix === "string" && rv.sessionTitlePrefix) cl.sessionTitlePrefix = rv.sessionTitlePrefix
        if (Number(rv.structuredRetryCount) >= 0) cl.retryCount = Number(rv.structuredRetryCount)
      }
      const pd = isPlainObject(cfg.paid) ? (cfg.paid as any) : undefined
      if (pd) {
        if (typeof pd.enabled === "boolean") cl.paidEnabled = pd.enabled
        if (Number(pd.maxPerHour) >= 0) cl.maxPaidCalls = Number(pd.maxPerHour)
      }
      const bd = isPlainObject(cfg.budget) ? (cfg.budget as any) : undefined
      if (bd && Number(bd.maxPromptChars) > 0) cl.maxPromptChars = Number(bd.maxPromptChars)
      const br = isPlainObject(cfg.breaker) ? (cfg.breaker as any) : undefined
      if (br) {
        if (Number(br.failuresToBench) > 0) cl.breakerFails = Number(br.failuresToBench)
        if (Array.isArray(br.benchLadderMs) && br.benchLadderMs.length) cl.benchLadderMs = br.benchLadderMs.slice()
        if (Number(br.soBenchMs) > 0) cl.soBenchMs = Number(br.soBenchMs)
        if (Number(br.rateLimitBenchMs) > 0) cl.rateLimitBenchMs = Number(br.rateLimitBenchMs)
        if (Number(br.serverRetryDelayMs) >= 0) cl.retryDelayServerMs = Number(br.serverRetryDelayMs)
        if (Number(br.schemaRetryDelayMs) >= 0) cl.retryDelaySchemaMs = Number(br.schemaRetryDelayMs)
      }
      const rvA = isPlainObject(cfg.reviewer) ? (cfg.reviewer as any) : undefined
      if (rvA && typeof rvA.agent === "string" && !cl.agent) cl.agent = rvA.agent
    }

    /* reviewboard.ts reads cfg.board.*; keep it pointing at the canonical blocks so a user
     * who edits `weights` / `quorum` / `tiers` / `paid` gets what they expect. Only the
     * board-specific keys (chains-per-lens, paidTail, escalationChain, maxPayloadChars)
     * are edited in the board block itself. */
    const bo = isPlainObject(cfg.board) ? (cfg.board as any) : undefined
    if (bo) {
      if (isPlainObject(cfg.weights)) bo.weights = { ...(cfg.weights as any), ...(isPlainObject(bo.weights) ? bo.weights : {}) }
      const q = isPlainObject(cfg.quorum) ? (cfg.quorum as any) : undefined
      if (q) {
        if (Number(q.blockThreshold) > 0) bo.blockThreshold = Number(q.blockThreshold)
        if (Number(q.vetoDemoteAfter) > 0) bo.maxVetoesPerSession = Number(q.vetoDemoteAfter)
        if (Number(q.cacheTtlMs) >= 0) bo.cacheTtlMs = Number(q.cacheTtlMs)
      }
      const ti = isPlainObject(cfg.tiers) ? (cfg.tiers as any) : undefined
      if (ti) {
        bo.timeoutMs = isPlainObject(bo.timeoutMs) ? bo.timeoutMs : {}
        if (Number(ti.safe?.timeoutMs) > 0) bo.timeoutMs.advisory = Number(ti.safe.timeoutMs)
        if (Number(ti.review?.timeoutMs) > 0) bo.timeoutMs.review = Number(ti.review.timeoutMs)
        if (Number(ti.danger?.timeoutMs) > 0) {
          bo.timeoutMs.danger = Number(ti.danger.timeoutMs)
          bo.timeoutMs.escalate = Number(ti.danger.timeoutMs)
        }
        if (Number(ti.danger?.maxAdvisories) >= 0) bo.advisoryMaxItems = Number(ti.danger.maxAdvisories)
        if (Number(ti.danger?.advisoryMaxChars) > 0) bo.advisoryMaxChars = Number(ti.danger.advisoryMaxChars)
        if (typeof ti.danger?.failClosed === "boolean") bo.failClosedOnDanger = ti.danger.failClosed
        if (typeof ti.review?.earlyVeto === "boolean") bo.earlyVeto = ti.review.earlyVeto
      }
      const bd2 = isPlainObject(cfg.budget) ? (cfg.budget as any) : undefined
      if (bd2) {
        if (Number(bd2.maxCumulativeReviewMs) > 0) bo.maxCumulativeReviewMs = Number(bd2.maxCumulativeReviewMs)
        if (Number(bd2.maxPerSession) > 0) bo.maxReviewsPerSession = Number(bd2.maxPerSession)
        if (Number(bd2.maxPromptChars) > 0) bo.maxPayloadChars = Number(bd2.maxPromptChars)
      }
      if (typeof cfg.escalate === "boolean") bo.escalate = cfg.escalate
      const r2 = isPlainObject(cfg.redaction) ? (cfg.redaction as any) : undefined
      if (r2 && Array.isArray(r2.extraSecrets)) bo.extraSecrets = r2.extraSecrets.slice()
      const pd2 = isPlainObject(cfg.paid) ? (cfg.paid as any) : undefined
      if (pd2 && typeof pd2.enabled === "boolean") {
        cfg.paidFallback = pd2.enabled
        bo.paidFallback = pd2.enabled
      }
      const rv2 = isPlainObject(cfg.reviewer) ? (cfg.reviewer as any) : undefined
      if (rv2 && typeof rv2.agent === "string") bo.reviewerAgent = rv2.agent
    }
  } catch {}
}

/* ────────────────────────────────────────────────────────────────────────────
 * env overrides
 * ──────────────────────────────────────────────────────────────────────────── */

/** Force every tier's fan-out deadline (used by OCREV_TIMEOUT_MS). */
function setAllTierTimeouts(cfg: any, ms: number): void {
  try {
    for (const k of Object.keys(cfg.tiers || {})) {
      const t = cfg.tiers[k]
      if (isPlainObject(t) && Number(t.timeoutMs) > 0) t.timeoutMs = ms
    }
  } catch {}
}

/** off | advise | enforce, applied to one tier (OCREV_TIER_* / OCREV_DANGER). */
function applyTierLevel(cfg: any, tier: string, level: string): void {
  try {
    const t = cfg?.tiers?.[tier]
    if (!isPlainObject(t)) return
    const l = level.toLowerCase()
    if (["off", "0", "false", "no", "ignore"].includes(l)) {
      t.review = false
      t.blocking = false
      t.canBlock = false
      t.failClosed = false
      return
    }
    if (["advise", "advisory", "observe", "annotate", "note"].includes(l)) {
      t.review = true
      t.blocking = false
      t.async = true
      t.canBlock = false
      t.failClosed = false
      return
    }
    if (["enforce", "guard", "on", "1", "true", "yes", "block"].includes(l)) {
      t.review = true
      t.blocking = true
      t.async = false
      t.canBlock = true
      return
    }
  } catch {}
}

function unshiftUnique(arr: unknown, model: string): void {
  try {
    if (!Array.isArray(arr) || !model) return
    const i = arr.indexOf(model)
    if (i >= 0) arr.splice(i, 1)
    arr.unshift(model)
  } catch {}
}

/**
 * Env override layer. Names are the ones fixed by the safety spec (`OCREV_*`), with the
 * fallback spec's `STEROIDS_*` and the latency spec's `REVIEW_BOARD` / `RB` accepted as
 * aliases. Mutates `cfg` in place; never throws.
 */
function applyEnv(cfg: any): void {
  try {
    /* ── mode / master switches ─────────────────────────────────────────── */
    const rawMode = ev("OCREV_MODE", "STEROIDS_MODE", "REVIEW_BOARD", "RB")
    if (rawMode !== undefined) {
      const m = parseMode(rawMode)
      if (m) cfg.mode = m
      if (rawMode.toLowerCase() === "paranoid") {
        cfg.mode = "enforce"
        cfg.escalate = true
        try {
          if (isPlainObject(cfg.tiers?.review)) {
            cfg.tiers.review.blocking = true
            cfg.tiers.review.async = false
            cfg.tiers.review.canBlock = true
          }
        } catch {}
      }
    }
    if (truthy(ev("OCREV_ESCALATE", "STEROIDS_ESCALATE", "REVIEW_BOARD_ESCALATE"))) cfg.escalate = true
    if (falsy(ev("OCREV_ESCALATE", "STEROIDS_ESCALATE", "REVIEW_BOARD_ESCALATE"))) cfg.escalate = false
    if (truthy(ev("OCREV_SANITIZE", "STEROIDS_SANITIZE"))) cfg.sanitize = true
    if (falsy(ev("OCREV_SANITIZE", "STEROIDS_SANITIZE"))) cfg.sanitize = false

    /* ── hard off switches (a kill switch always beats a force-on) ──────── */
    const disable =
      truthy(ev("OCREV_DISABLE", "STEROIDS_DISABLE")) ||
      truthy(ev("OCREV_NESTED", "STEROIDS_NESTED")) ||
      falsy(ev("OCREV_ENABLED", "STEROIDS_ENABLED")) ||
      falsy(ev("OCREV", "STEROIDS"))
    if (disable) {
      cfg.enabled = false
      cfg.mode = "off"
    }

    /* ── per-tier level ─────────────────────────────────────────────────── */
    for (const [tier, envName] of [
      ["safe", "OCREV_TIER_SAFE"],
      ["review", "OCREV_TIER_REVIEW"],
      ["danger", "OCREV_TIER_DANGER"],
    ] as Array<[string, string]>) {
      const v = ev(envName)
      if (v !== undefined) applyTierLevel(cfg, tier, v)
    }
    const dangerLevel = ev("OCREV_DANGER")
    if (dangerLevel !== undefined) applyTierLevel(cfg, "danger", dangerLevel)

    /* ── timeouts ───────────────────────────────────────────────────────── */
    const tmo = toNum(ev("OCREV_TIMEOUT_MS", "STEROIDS_TIMEOUT_MS", "REVIEW_BOARD_TIMEOUT_MS"))
    if (tmo !== undefined && tmo > 0) {
      cfg.budget.timeoutMs = tmo
      setAllTierTimeouts(cfg, tmo)
    }
    const tmoEsc = toNum(ev("OCREV_TIMEOUT_MS_ESCALATE", "STEROIDS_TIMEOUT_MS_ESCALATE"))
    if (tmoEsc !== undefined && tmoEsc > 0) cfg.budget.timeoutMsEscalate = tmoEsc

    /* ── numeric budget caps ────────────────────────────────────────────── */
    const budgetEnv: Array<[string, string]> = [
      ["OCREV_MAX_PER_SESSION", "maxPerSession"],
      ["OCREV_MAX_PER_MIN", "maxPerMin"],
      ["OCREV_MAX_PER_MIN_SESSION", "maxPerMinSession"],
      ["OCREV_MAX_CONCURRENT", "maxConcurrent"],
      ["OCREV_QUEUE_WAIT_MS", "queueWaitMs"],
      ["OCREV_MAX_SPEND_USD", "maxSpendUsd"],
      ["OCREV_MAX_SPEND_USD_TOTAL", "maxSpendUsdTotal"],
      ["OCREV_ASSUMED_COST_USD", "assumedCostUsd"],
      ["OCREV_MAX_DEPTH", "maxDepth"],
      ["OCREV_MAX_PROMPT_CHARS", "maxPromptChars"],
      ["OCREV_DANGER_RESERVE", "dangerReserve"],
      ["OCREV_MAX_BLOCKING_PER_SESSION", "maxBlockingPerSession"],
      ["OCREV_MAX_CUMULATIVE_REVIEW_MS", "maxCumulativeReviewMs"],
      ["OCREV_MAX_ASYNC_IN_FLIGHT", "maxAsyncInFlight"],
      ["OCREV_ASYNC_QUEUE_DEPTH", "asyncQueueDepth"],
      ["OCREV_SELF_ERRORS_MAX", "selfErrorsMax"],
    ]
    for (const [name, key] of budgetEnv) {
      const n = toNum(ev(name))
      if (n !== undefined && n >= 0 && isPlainObject(cfg.budget)) cfg.budget[key] = n
    }
    const payload = toNum(ev("OCREV_MAX_PAYLOAD_BYTES"))
    if (payload !== undefined && payload > 0) {
      if (isPlainObject(cfg.budget)) cfg.budget.maxPayloadBytes = payload
      if (isPlainObject(cfg.redaction)) {
        cfg.redaction.maxPayloadBytes = payload
        cfg.redaction.headBytes = Math.max(1, Math.floor(payload * 0.66))
        cfg.redaction.tailBytes = Math.max(1, payload - cfg.redaction.headBytes)
      }
    }
    const cacheTtl = toNum(ev("OCREV_CACHE_TTL_MS"))
    if (cacheTtl !== undefined && cacheTtl >= 0) {
      if (isPlainObject(cfg.budget)) cfg.budget.cacheTtlMs = cacheTtl
      if (isPlainObject(cfg.quorum)) cfg.quorum.cacheTtlMs = cacheTtl
    }

    /* ── quorum ─────────────────────────────────────────────────────────── */
    const thr = toNum(ev("OCREV_BLOCK_THRESHOLD"))
    if (thr !== undefined && thr > 0) {
      if (isPlainObject(cfg.quorum)) cfg.quorum.blockThreshold = thr
      try {
        for (const k of Object.keys(cfg.tiers || {})) {
          if (isPlainObject(cfg.tiers[k])) cfg.tiers[k].blockThreshold = thr
        }
      } catch {}
    }
    const demote = toNum(ev("OCREV_VETO_DEMOTE_AFTER"))
    if (demote !== undefined && demote > 0 && isPlainObject(cfg.quorum)) cfg.quorum.vetoDemoteAfter = demote

    /* ── circuit breaker ────────────────────────────────────────────────── */
    const bf = toNum(ev("OCREV_BREAKER_FAILS"))
    if (bf !== undefined && bf > 0 && isPlainObject(cfg.breaker)) cfg.breaker.failuresToBench = bf
    const bc = toNum(ev("OCREV_BREAKER_COOLDOWN_MS"))
    if (bc !== undefined && bc > 0 && isPlainObject(cfg.breaker) && Array.isArray(cfg.breaker.benchLadderMs)) {
      cfg.breaker.benchLadderMs = [bc, bc * 3, bc * 12]
    }

    /* ── redaction ──────────────────────────────────────────────────────── */
    const red = ev("OCREV_REDACT", "STEROIDS_REDACT")
    if (red !== undefined && isPlainObject(cfg.redaction)) {
      const r = red.toLowerCase()
      if (r === "off" || r === "standard" || r === "paranoid") cfg.redaction.level = r
    }
    const redHits = toNum(ev("OCREV_REDACT_MAX_HITS"))
    if (redHits !== undefined && redHits > 0 && isPlainObject(cfg.redaction)) cfg.redaction.maxHits = redHits
    const extras = toList(ev("OCREV_EXTRA_SECRETS", "STEROIDS_EXTRA_SECRETS"))
    if (extras && isPlainObject(cfg.redaction)) {
      const keep = extras.filter((s) => s.length >= 6)
      const prev = Array.isArray(cfg.redaction.extraSecrets) ? cfg.redaction.extraSecrets : []
      cfg.redaction.extraSecrets = Array.from(new Set([...prev, ...keep]))
    }

    /* ── paid fallback ──────────────────────────────────────────────────── */
    if (falsy(ev("OCREV_PAID", "STEROIDS_PAID")) && isPlainObject(cfg.paid)) cfg.paid.enabled = false
    if (truthy(ev("OCREV_PAID", "STEROIDS_PAID")) && isPlainObject(cfg.paid)) cfg.paid.enabled = true
    const paidSess = toNum(ev("OCREV_PAID_MAX_PER_SESSION", "STEROIDS_PAID_MAX_PER_SESSION"))
    if (paidSess !== undefined && paidSess >= 0 && isPlainObject(cfg.paid)) cfg.paid.maxPerSession = paidSess
    const paidHour = toNum(ev("OCREV_PAID_MAX_PER_HOUR", "STEROIDS_PAID_MAX_PER_HOUR"))
    if (paidHour !== undefined && paidHour >= 0 && isPlainObject(cfg.paid)) cfg.paid.maxPerHour = paidHour

    /* ── advisors ───────────────────────────────────────────────────────── */
    if (falsy(ev("OCREV_ADVISORS", "STEROIDS_ADVISORS")) && isPlainObject(cfg.advisors)) cfg.advisors.enabled = false
    if (truthy(ev("OCREV_ADVISORS", "STEROIDS_ADVISORS")) && isPlainObject(cfg.advisors)) cfg.advisors.enabled = true

    /* ── model pinning ──────────────────────────────────────────────────── */
    const mainModel = ev("OCREV_MAIN_MODEL", "STEROIDS_MAIN_MODEL")
    if (mainModel) unshiftUnique(cfg?.chains?.main, mainModel)
    const gateModel = ev("OCREV_GATE_MODEL", "STEROIDS_GATE_MODEL")
    if (gateModel) unshiftUnique(cfg?.chains?.gate, gateModel)
    const deepModel = ev("OCREV_DEEP_MODEL", "STEROIDS_DEEP_MODEL")
    if (deepModel) unshiftUnique(cfg?.chains?.deep, deepModel)

    /* ── reviewer agent ─────────────────────────────────────────────────── */
    const revAgent = ev("OCREV_REVIEWER_AGENT")
    if (revAgent && isPlainObject(cfg.reviewer)) cfg.reviewer.agent = revAgent

    /* ── logging ────────────────────────────────────────────────────────── */
    const lvl = ev("OCREV_LOG_LEVEL", "STEROIDS_LOG_LEVEL")
    if (lvl && isPlainObject(cfg.logging)) {
      const l = lvl.toLowerCase()
      if (["silent", "warn", "info", "debug"].includes(l)) cfg.logging.level = l
    }
    const lf = ev("OCREV_LOG_FILE", "STEROIDS_LOG_FILE")
    if (lf && isPlainObject(cfg.logging)) cfg.logging.file = lf
    if (falsy(ev("OCREV_LOG_STDERR")) && isPlainObject(cfg.logging)) cfg.logging.stderr = false
    if (truthy(ev("OCREV_LOG_STDERR")) && isPlainObject(cfg.logging)) cfg.logging.stderr = true
  } catch {}
}

/* ────────────────────────────────────────────────────────────────────────────
 * loadConfig
 * ──────────────────────────────────────────────────────────────────────────── */

function readJsonFile(path: string): unknown {
  try {
    if (!path) return undefined
    let raw = readFileSync(path, "utf8")
    if (typeof raw !== "string" || raw.trim() === "") return undefined
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
    const parsed = JSON.parse(raw)
    return isPlainObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * defaults → ~/.config/opencode/steroids.json (read-only) → env → kill files.
 *
 * Kill files are checked LAST on purpose: a `touch $STATE/OFF` from another terminal must
 * beat any OCREV_MODE=enforce in the environment. Synchronous by contract; never throws.
 */
export function loadConfig(): SteroidsConfig {
  let cfg: any
  try {
    cfg = defaultConfig()
  } catch {
    cfg = {}
  }
  if (!isPlainObject(cfg)) cfg = {}

  // remember the untouched derived defaults so an env stateDir can re-derive them
  const homeAtLoad = homeDir()
  const derivedDefaults = derivePaths(defaultStateDir(homeAtLoad))

  /* 1. file layer */
  try {
    const explicit = ev("OCREV_CONFIG", "STEROIDS_CONFIG", "REVIEW_BOARD_CONFIG")
    const candidates = [explicit, cfg?.paths?.configFile, `${homeAtLoad}/.config/opencode/steroids.json`]
    for (const p of candidates) {
      if (typeof p !== "string" || p === "") continue
      const j = readJsonFile(p)
      if (j !== undefined) {
        const merged = deepMerge(cfg, j)
        if (isPlainObject(merged)) cfg = merged
        try {
          cfg.paths = isPlainObject(cfg.paths) ? cfg.paths : {}
          cfg.paths.configFile = p
        } catch {}
        break
      }
    }
  } catch {}

  /* 2. env layer */
  applyEnv(cfg)
  syncAliases(cfg)

  /* 3. state dir override → re-derive any path the user did not pin explicitly */
  try {
    const sdEnv = ev("OCREV_STATE_DIR", "STEROIDS_STATE_DIR")
    if (sdEnv) {
      const next = derivePaths(sdEnv)
      cfg.paths = isPlainObject(cfg.paths) ? cfg.paths : {}
      for (const k of Object.keys(next)) {
        const cur = cfg.paths[k]
        const wasDefault =
          k === "stateDir" ||
          cur === undefined ||
          cur === (derivedDefaults as any)[k] ||
          (Array.isArray(cur) &&
            Array.isArray((derivedDefaults as any)[k]) &&
            JSON.stringify(cur) === JSON.stringify((derivedDefaults as any)[k]))
        if (wasDefault) cfg.paths[k] = (next as any)[k]
      }
      if (isPlainObject(cfg.logging) && cfg.logging.file === derivedDefaults.logFile) {
        cfg.logging.file = cfg.paths.logFile
      }
      if (isPlainObject(cfg.caller) && cfg.caller.stateDir === derivedDefaults.stateDir) {
        cfg.caller.stateDir = cfg.paths.stateDir
      }
    }
  } catch {}

  /* 4. sanity clamps — a nonsense number must not become a hang or a spend */
  try {
    const b = cfg.budget
    if (isPlainObject(b)) {
      if (!(Number(b.maxConcurrent) >= 1)) b.maxConcurrent = 1
      if (!(Number(b.timeoutMs) > 0)) b.timeoutMs = 15000
      if (!(Number(b.maxDepth) >= 0)) b.maxDepth = 3
      if (!(Number(b.maxSpendUsd) >= 0)) b.maxSpendUsd = 0
      if (!(Number(b.maxSpendUsdTotal) >= 0)) b.maxSpendUsdTotal = 0
      if (!(Number(b.maxPromptChars) > 0)) b.maxPromptChars = 12000
    }
    if (!["off", "observe", "enforce", "paranoid"].includes(String(cfg.mode))) cfg.mode = "enforce"
    if (typeof cfg.enabled !== "boolean") cfg.enabled = true
    if (isPlainObject(cfg.redaction) && !["off", "standard", "paranoid"].includes(String(cfg.redaction.level))) {
      cfg.redaction.level = "standard"
    }
    if (isPlainObject(cfg.logging) && !["silent", "warn", "info", "debug"].includes(String(cfg.logging.level))) {
      cfg.logging.level = "info"
    }
  } catch {}

  /* 5. kill files win over everything */
  try {
    const kf = Array.isArray(cfg?.paths?.killFiles) ? cfg.paths.killFiles : []
    for (const f of kf) {
      if (typeof f !== "string" || f === "") continue
      let hit = false
      try {
        hit = existsSync(f)
      } catch {
        hit = false
      }
      if (hit) {
        cfg.enabled = false
        cfg.mode = "off"
        break
      }
    }
  } catch {}

  return cfg as SteroidsConfig
}

/* ────────────────────────────────────────────────────────────────────────────
 * logger
 * ──────────────────────────────────────────────────────────────────────────── */

const LEVEL_RANK: Record<string, number> = { silent: 0, warn: 1, info: 2, debug: 3 }

function safeStringify(x: unknown, maxChars: number): string | undefined {
  if (x === undefined) return undefined
  try {
    const seen = new WeakSet<object>()
    const s = JSON.stringify(x, (_k, v) => {
      if (typeof v === "bigint") return String(v)
      if (typeof v === "function") return "[fn]"
      if (v instanceof Error) return { name: v.name, message: v.message, stack: String(v.stack || "").slice(0, 800) }
      if (typeof v === "object" && v !== null) {
        if (seen.has(v as object)) return "[circular]"
        seen.add(v as object)
      }
      return v
    })
    if (typeof s !== "string") return undefined
    return s.length > maxChars ? `${s.slice(0, maxChars)}…[truncated]` : s
  } catch {
    try {
      const s = String(x)
      return s.length > maxChars ? `${s.slice(0, maxChars)}…[truncated]` : s
    } catch {
      return "[unserialisable]"
    }
  }
}

/**
 * Best-effort JSONL logger. Honours cfg.logging.level, rotates at cfg.logging.maxBytes,
 * mirrors `warn` to stderr when cfg.logging.stderr is true. Every path is guarded: if the
 * directory cannot be created or the file cannot be appended, the sink disables itself and
 * the logger becomes a no-op. It NEVER throws and NEVER blocks on anything but one append.
 */
export function makeLogger(cfg: any): Logger {
  let level: LogLevel = "info"
  let file = ""
  let stderr = true
  let maxBytes = 5 * 1024 * 1024
  let maxFieldChars = 2000
  try {
    const lg = isPlainObject(cfg) && isPlainObject(cfg.logging) ? (cfg.logging as any) : {}
    if (typeof lg.level === "string" && lg.level in LEVEL_RANK) level = lg.level as LogLevel
    if (typeof lg.file === "string") file = lg.file
    if (typeof lg.stderr === "boolean") stderr = lg.stderr
    if (Number(lg.maxBytes) > 0) maxBytes = Number(lg.maxBytes)
    if (Number(lg.maxFieldChars) > 0) maxFieldChars = Number(lg.maxFieldChars)
  } catch {}

  const threshold = LEVEL_RANK[level] ?? 2
  let sinkBroken = false
  let dirReady = false
  let writesSinceRotateCheck = 0

  const ensureDir = (): boolean => {
    if (sinkBroken || !file) return false
    if (dirReady) return true
    try {
      const i = file.lastIndexOf("/")
      if (i > 0) mkdirSync(file.slice(0, i), { recursive: true })
      dirReady = true
      return true
    } catch {
      sinkBroken = true
      return false
    }
  }

  const maybeRotate = (): void => {
    try {
      writesSinceRotateCheck += 1
      if (writesSinceRotateCheck < 50) return
      writesSinceRotateCheck = 0
      const st = statSync(file)
      if (st && Number(st.size) > maxBytes) {
        try {
          renameSync(file, `${file}.1`)
        } catch {}
      }
    } catch {}
  }

  const write = (lvl: "warn" | "info" | "debug", m: string, x?: unknown): void => {
    try {
      if (threshold === 0) return
      if ((LEVEL_RANK[lvl] ?? 3) > threshold) return
      const msg = typeof m === "string" ? m : safeStringify(m, maxFieldChars) || ""
      const data = safeStringify(x, maxFieldChars)
      if (lvl === "warn" && stderr) {
        try {
          console.error(`[steroids] ${msg}${data ? ` ${data}` : ""}`)
        } catch {}
      }
      if (!ensureDir()) return
      const line = `${JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, data })}\n`
      try {
        appendFileSync(file, line)
      } catch {
        sinkBroken = true
        return
      }
      maybeRotate()
    } catch {
      /* a logger must never be the thing that breaks the agent */
    }
  }

  return {
    info: (m: string, x?: unknown) => write("info", m, x),
    warn: (m: string, x?: unknown) => write("warn", m, x),
    debug: (m: string, x?: unknown) => write("debug", m, x),
  }
}
