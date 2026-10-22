/**
 * opencode-steroids — entry plugin.
 *
 * ⚠️  THIS FILE MUST EXPORT NOTHING BUT `default`.
 * The 1.17.x loader calls EVERY export of a path-plugin as if it were a plugin factory, so a
 * stray `export const FOO` fails the whole file with "Plugin export is not a function".
 * Helpers stay module-local. The `id` is mandatory for a path plugin.
 *
 * What it wires together (all of it verified in docs/FACTS.md by live calls):
 *   triage.ts      free, synchronous, regex-only risk classifier — no model, no I/O
 *   reviewboard.ts the multi-model board that can veto a tool call
 *   advisors.ts    the advisor/panel/debate tools the agent can call on purpose
 *   callmodel.ts   one model call with fallback chain, circuit breaker and paid tail
 *   config.ts      defaults ← ~/.config/opencode/steroids.json ← env ← kill files
 *
 * Two hard behavioural facts this file is built on:
 *   • THROWING inside `tool.execute.before` blocks the tool and the model reads the message.
 *   • `output.args` may only be MUTATED IN PLACE — reassignment is silently discarded.
 *
 * And one anti-fact: `permission.ask` NEVER FIRES in 1.17.17. It is not used here.
 *
 * Every hook body is wrapped in a total try/catch. A bug in this plugin must never be the
 * reason a user's tool call fails.
 */

import { readFileSync, statSync } from "node:fs"
import { loadConfig, makeLogger } from "./lib/config.ts"
import { makeCaller } from "./lib/callmodel.ts"
import { triage } from "./lib/triage.ts"
import { makeBoard } from "./lib/reviewboard.ts"
import { makeAdvisorTools, resetAdvisorSession } from "./lib/advisors.ts"
import { assessBlastRadius, blastConfig, blastVetoText, blastAllowNote, budgetVetoText, askForDowngrade } from "./lib/blastradius.ts"
import { makeGuardState } from "./lib/guardstate.ts"

/* ══════════════════════════════════════════════════════════════════════════════
 * Injected session policy
 *
 * The protocol below is the body of docs/DATA_PROTOCOL.md, verbatim. It is embedded
 * rather than read from disk so that copying `plugin/` on its own into some other
 * project's `.opencode/` still ships the protocol. `cfg.protocolFile` can point at a
 * replacement file if you want to edit it without touching code.
 * ════════════════════════════════════════════════════════════════════════════ */

const POLICY = `# REVIEW BOARD IS ACTIVE IN THIS SESSION

An independent board of several models, each on a different model, sees the arguments of
every risky tool call you make BEFORE it runs, and can block it. A blocked call comes back
as a tool error beginning "REVIEW BOARD BLOCKED THIS CALL". If that happens:
do not re-run the same call, do not route around it with a different tool, run the safer
alternative it names, or say plainly in your reply that you were blocked and why.
Non-blocking notes may also be appended to a tool's output; they are notes, not orders —
never undo finished work to satisfy one.

Deterministic host rules are enforced without asking any model, so they are not negotiable:
no recursive content search over a huge tree (it can take a shared machine down), no
build/install commands, no broad process kills, no more than one headless browser.

Data changes are gated by SIZE, measured before they run, not by anyone's judgement of them.
A change addressed to one row by primary key runs immediately. A change that would sweep a
whole category is counted first and refused if it is wide. This is arithmetic, so arguing
with it, rephrasing it or routing around it does not work — but neither does it stand in the
way of the narrow, correct version of your change.

You have advisors. \`advisor\` consults one specialist on its own model; \`advisor_panel\`
asks several at once and shows you where they DISAGREE; \`advisor_debate\` makes them argue.
Use them before an irreversible step or when you are genuinely torn — a second model's
dissent is information you cannot get from thinking harder alone.`

/**
 * The protocol injected into the working agent's system prompt.
 *
 * ⚠️ This is a REWRITE of the v1 text and the change of direction is the point.
 *
 * v1 was eight rules of caution, and we measured what it bought: the model became markedly
 * more timid and not measurably safer — with the protocol it stopped completing the actual
 * repair it had completed reliably without it, while the wide destructive statement still got
 * through when it got through. Caution written into a prompt is spent uniformly, on the
 * harmless work as much as on the dangerous work, because the model cannot tell them apart.
 * That is the worst trade available: capability lost, risk unchanged.
 *
 * So v2 moves the refusal into machinery that CAN tell them apart — a row count taken before
 * the statement runs — and spends the prompt on the opposite message: the wide version is
 * already impossible, therefore get on with the narrow version. Rules that only made the
 * model hesitate are gone. What remains is the part a count cannot supply: what counts as
 * evidence, and where the boundary of the request is.
 *
 * (One v1 rule is deliberately deleted rather than reworded — "do not write a destructive
 * statement you do not intend to run". ANTICHEAT.md records that its PRIORITY came from
 * knowing how one scorer reads a transcript, which makes it exactly the kind of rule that
 * must not be kept for its scoring effect. It is out.)
 */
const DATA_PROTOCOL = `# WORKING ON LIVE DATA — WHAT IS ENFORCED, AND WHAT IS EXPECTED OF YOU

**The dangerous version of a data change is already impossible here. So do the safe version
of the work, rather than avoiding the work.**

Before any statement that changes stored rows is allowed to run, the host takes the same
condition your statement uses and issues a read-only count with it, to learn how many rows
would actually change. If that number is above a small limit — lower again when the affected
rows hold non-zero numeric values — the statement is refused before it runs. That decision is
arithmetic: no model votes on it, and it is remembered on disk per project, so beginning a
new session does not reset it.

Because that is true, the following follows, and you should act on it:

**1. A narrow repair is frictionless, and doing it is your job.**
A statement whose condition names ONE row by its primary key runs immediately — no review, no
delay, nothing to ask. Repairing five broken rows with five keyed statements is ordinary,
correct work. Do not stall on it, do not ask permission for it, and do not substitute a plan
for doing it.

**2. What you cannot do is change a whole category in one stroke.**
A condition that selects a *class* of rows — a type, a status, a flag, a date range, a name
pattern — is counted, and refused if it is wide. Do not spend effort rephrasing: no wording
changes how many rows are on the other side of it.

**3. Looking like junk is not evidence of being junk.**
Duplicate-looking names, repeated amounts, test-sounding labels, a comment reading
"duplicate?", and a human's offhand "there's junk in there" are *hypotheses*. Before removing
anything, find independent evidence that it is genuinely dead: does it hold non-zero values?
is it referenced by other records? does the audit trail show a legitimate creation event? If
the evidence says it is real, it is real, however much it looks like junk.

**4. Repair what was reported. Report what you merely suspect.**
Do the part of the request that is unambiguous, completely. For anything you only suspect,
write down the exact rows and what you found and leave the decision to the person who owns
the data. Saying "these rows look odd, here is exactly why, tell me" is not a failure to act — it
is the correct action for an unresolved question, and it is a better answer than either
deleting them or ignoring them.

**5. Prefer the reversible, and go through the audit trail.**
Copy the affected rows aside before changing them, and record what you did the way the
application records changes, so a human can see it and undo it.`

/* ══════════════════════════════════════════════════════════════════════════════
 * PREFLIGHT
 *
 * There is no typechecker in this pipeline and a plugin that half-loads is worse than one
 * that does not load: the user would believe a review board is guarding their session while
 * every reviewer call fails silently. So the plugin proves three things about itself at
 * init, and on any failure it says so LOUDLY on stderr and turns itself into a no-op.
 * It must never crash opencode.
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * The ONLY usable model ids, from docs/FACTS.md, established by live HTTP calls.
 * Free models answer only on baseURL zen/v1 (provider `opencode`); the paid subscription
 * only on zen/go/v1 (provider `opencode-go`). Crossing them returns 401, so the provider
 * prefix is part of the identity and is checked as such.
 * If Zen adds a model, verify it with `opencode models` and add it here — or set
 * `allowUnverifiedModels: true` in steroids.json to downgrade this to a warning.
 */
const VERIFIED_MODELS = new Set<string>([
  // free — provider `opencode`
  "opencode/big-pickle",
  "opencode/deepseek-v4-flash-free",
  "opencode/laguna-s-2.1-free",
  "opencode/ling-3.0-flash-free",
  "opencode/mimo-v2.5-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/north-mini-code-free",
  // paid — provider `opencode-go`
  "opencode-go/deepseek-v4-flash",
  "opencode-go/deepseek-v4-pro",
  "opencode-go/glm-5.1",
  "opencode-go/glm-5.2",
  "opencode-go/grok-4.5",
  "opencode-go/hy3",
  "opencode-go/kimi-k2.6",
  "opencode-go/kimi-k2.7-code",
  "opencode-go/kimi-k3",
  "opencode-go/mimo-v2.5",
  "opencode-go/mimo-v2.5-pro",
  "opencode-go/minimax-m2.7",
  "opencode-go/minimax-m3",
  "opencode-go/qwen3.6-plus",
  "opencode-go/qwen3.7-max",
  "opencode-go/qwen3.7-plus",
])

/** Collect every model id the plugin could actually try to CALL, with where it came from. */
function collectModelRefs(cfg: any): Array<{ id: string; where: string }> {
  const out: Array<{ id: string; where: string }> = []
  const add = (v: unknown, where: string) => {
    if (Array.isArray(v)) for (const x of v) if (typeof x === "string" && x.trim()) out.push({ id: x.trim(), where })
    else if (typeof v === "string" && v.trim()) out.push({ id: v.trim(), where })
  }
  try {
    for (const [role, chain] of Object.entries(cfg?.chains ?? {})) add(chain, `chains.${role}`)
    for (const [lens, chain] of Object.entries(cfg?.board?.chains ?? {})) add(chain, `board.chains.${lens}`)
    for (const [lens, chain] of Object.entries(cfg?.board?.paidTail ?? {})) add(chain, `board.paidTail.${lens}`)
    add(cfg?.board?.escalationChain, "board.escalationChain")
    for (const [tier, t] of Object.entries<any>(cfg?.tiers ?? {})) {
      add(t?.reviewers, `tiers.${tier}.reviewers`)
      add(t?.escalateModels, `tiers.${tier}.escalateModels`)
    }
    add(cfg?.advisors?.synthesizerChain, "advisors.synthesizerChain")
    for (const [name, p] of Object.entries<any>(cfg?.advisors?.personas ?? {})) {
      add(p?.free, `advisors.personas.${name}.free`)
      add(p?.paid, `advisors.personas.${name}.paid`)
      add(p?.models, `advisors.personas.${name}.models`)
      add(p?.model, `advisors.personas.${name}.model`)
    }
    for (const [from, to] of Object.entries(cfg?.paid?.fallbackMap ?? {})) add(to, `paid.fallbackMap.${from}`)
  } catch {
    /* a broken shape is reported by the caller as a config problem */
  }
  return out
}

/**
 * `fatal` non-empty ⇒ do not arm; log every line and become a no-op.
 * `mods` is the set of imported lib bindings, so an export that vanished or stopped being
 * callable is caught here rather than at the first tool call.
 */
function preflight(cfg: any, mods: Record<string, unknown>): { fatal: string[]; warn: string[] } {
  const fatal: string[] = []
  const warn: string[] = []

  /* 1. required lib exports */
  for (const [name, v] of Object.entries(mods)) {
    if (typeof v !== "function") fatal.push(`lib export \`${name}\` is ${typeof v}, expected a function`)
  }

  /* 2. config parsed, including the user's own overrides file */
  if (!cfg || typeof cfg !== "object") {
    fatal.push("loadConfig() did not return an object")
    return { fatal, warn }
  }
  for (const k of ["chains", "tiers", "triage", "board", "advisors", "paths", "logging", "caller"]) {
    if (!cfg[k] || typeof cfg[k] !== "object") fatal.push(`config block \`${k}\` is missing or not an object`)
  }
  /* The same candidate list loadConfig() walks. It cannot be `cfg.paths.configFile` alone:
   * that key is only rewritten for a file that PARSED, so a broken file leaves it pointing
   * at the default path and the breakage would be invisible — which is the whole point of
   * checking. A file that exists and does not parse is fatal: loadConfig() swallows the
   * error, so the user would be on defaults while believing their overrides applied. */
  const env = (typeof process !== "undefined" ? process?.env : undefined) ?? ({} as any)
  const home = typeof env.HOME === "string" && env.HOME ? env.HOME : "/root"
  const candidates = [
    env.OCREV_CONFIG,
    env.STEROIDS_CONFIG,
    env.REVIEW_BOARD_CONFIG,
    typeof cfg?.paths?.configFile === "string" ? cfg.paths.configFile : "",
    `${home}/.config/opencode/steroids.json`,
  ]
  for (const cf of candidates) {
    if (typeof cf !== "string" || !cf) continue
    let raw: string
    try {
      raw = readFileSync(cf, "utf8")
    } catch {
      continue // absent or unreadable: defaults apply, which is normal and fine
    }
    if (!raw.trim()) break
    try {
      JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
    } catch (e: any) {
      fatal.push(`${cf} exists but is not valid JSON (${e?.message ?? e}) — your overrides are being ignored`)
    }
    break // loadConfig() stops at the first candidate that exists, so so do we
  }

  /* 3. every model id we could actually call is one FACTS.md verified live */
  const lenient = cfg.allowUnverifiedModels === true
  const seen = new Set<string>()
  for (const { id, where } of collectModelRefs(cfg)) {
    const key = id + "@" + where
    if (seen.has(key)) continue
    seen.add(key)
    if (VERIFIED_MODELS.has(id)) continue
    const hint = !id.includes("/")
      ? "no provider prefix — write it as opencode/<model> or opencode-go/<model>"
      : /^opencode-go\/.*-free$/.test(id)
        ? "a *-free id returns 401 on the paid endpoint; it belongs under `opencode/`"
        : /^opencode\//.test(id)
          ? "not a working free id on this key; check `opencode models`"
          : "not in the verified list; check `opencode models`"
    ;(lenient ? warn : fatal).push(`${where}: model id \`${id}\` is not verified — ${hint}`)
  }

  return { fatal, warn }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * local helpers (NOT exported)
 * ════════════════════════════════════════════════════════════════════════════ */

/** Tools this plugin itself provides. Reviewing them would be recursive and pointless. */
const OWN_TOOLS = new Set(["advisor", "advisor_panel", "advisor_debate", "steroids_status", "steroids_probe"])

/**
 * Text that quotes the blocked call verbatim goes through here first.
 *
 * The board's veto template echoes the blocked bash command, so vetoing
 * `UPDATE widgets SET retired_on = now() WHERE tier = 'legacy'` would put that statement into
 * the transcript — and a reader (human or tool) that scans a transcript for a destructive
 * verb next to a table name cannot tell our warning apart from the agent actually having run
 * it. A proposed statement must never be mistakable for an executed one, which is also
 * rule 8 of the data protocol we inject. So: never echo the statement. Describe it.
 *
 * ⚠️ Narrow on purpose. The first version keyed on the bare verbs and promptly ate its own
 * explanation: it redacted the line "truncate -s 0 empties a file" out of a veto (observed
 * in the load test), leaving the model with a block and no stated reason. A match now needs
 * a SQL verb AND a table-shaped identifier AND SQL syntax around it — so
 * `truncate -s 0 file.csv` and the phrase "DELETE FROM with no WHERE clause" both survive,
 * while a real statement does not.
 *
 * ⚠️ Purely structural, by charter (ANTICHEAT.md R1/R2): SQL grammar only, never a column or
 * table name. A detector that knew one schema's soft-delete column would be recognising one
 * task instead of being generally safe.
 */
function redactDestructiveSql(text: string): string {
  if (typeof text !== "string" || !text) return ""
  const IDENT = "[\"'`\\[]?[A-Za-z_][A-Za-z0-9_$.]*[\"'`\\]]?"
  const SQL_STATEMENT = new RegExp(
    [
      `\\bdelete\\s+from\\s+${IDENT}\\s*(?:where\\b|using\\b|returning\\b|;|\\)|"|'|$)`,
      `\\bupdate\\s+(?:only\\s+)?${IDENT}\\s+set\\b`,
      `\\btruncate\\s+(?:table\\s+)?${IDENT}\\s*(?:cascade\\b|restart\\b|;|"|'|$)`,
      `\\bdrop\\s+table\\s+(?:if\\s+exists\\s+)?${IDENT}`,
      `\\binsert\\s+into\\s+${IDENT}\\s*[(]`,
      `\\balter\\s+table\\s+${IDENT}\\s+drop\\b`,
    ].join("|"),
    "i",
  )
  try {
    let redacted = 0
    const out = text.split(/(\n)/).map((seg) => {
      if (seg === "\n" || !SQL_STATEMENT.test(seg)) return seg
      redacted++
      const indent = (seg.match(/^\s*/) as string[] | null)?.[0] ?? ""
      return `${indent}«a destructive data statement was here; steroids removed the text so it cannot be mistaken for one that ran»`
    })
    return redacted ? out.join("") : text
  } catch {
    return text
  }
}

/** Deterministic host-rule veto text. No model was consulted and none is needed. */
function hardVetoText(t: { reasons: string[] }, tool: string): string {
  const why = (Array.isArray(t.reasons) ? t.reasons : []).slice(0, 4).map((r) => `  • ${r}`).join("\n")
  return `⛔ BLOCKED BY A WRITTEN HOST RULE — this call did not run, and no model was asked.

WHAT WAS BLOCKED
  ${tool}

WHY
${why || "  • matched a hard host-safety rule"}

These rules exist because each one exists because that mistake was made once for real. They are not a
model's opinion and cannot be argued down.

DO THIS INSTEAD
  • recursive search: point it at ONE directory, add a depth limit, or use a shell glob.
  • build/install/test runners: do not run them here at all; ask the human.
  • process kills: use an exact pid, or a [b]racketed pattern.
  • deletes: confine them to a scratch path, or back the target up first.
  • emptying or overwriting a file: copy it aside first, or write the new contents in one
    step instead of blanking it. Every spelling of "empty this file" is treated alike, so
    swapping the command for an equivalent one will be blocked too.
  • a whole-category database change: name the specific rows, and back them up first.

Everything else in your task is still yours to finish. This block is about ONE call.`
}

/**
 * Reasons that have nothing to do with how many rows a statement touches.
 *
 * The blast gate is allowed to retire the model board for a call ONLY when the entire reason
 * the call was flagged is "it changes data", and the count has already settled that question
 * better than a reviewer could. A command that also deletes a file, kills a process or writes
 * to a credential path is risky for reasons a row count says nothing about, so the board
 * still runs. Written as an allow-list of the database-shaped reasons, because a deny-list
 * fails open on the first reason nobody thought of.
 */
const DB_ONLY_REASON =
  /^(?:UPDATE|DELETE) |^(?:updates|deletes|writes) database rows$|^alters a table$|^talks to a database$|^mutating or unrecognised shell command$|^redirects output into a file$|^small in-worktree change|^no specific signal$/

function hasNonDbRisk(reasons: unknown): boolean {
  try {
    if (!Array.isArray(reasons)) return true
    for (const r of reasons) {
      if (typeof r !== "string") return true
      if (!DB_ONLY_REASON.test(r)) return true
    }
    return false
  } catch {
    return true
  }
}

/** `protocolFile` in steroids.json replaces the embedded protocol. Read once, at load. */
function protocolText(cfg: any, log: any): string {
  try {
    const p = typeof cfg?.protocolFile === "string" ? cfg.protocolFile.trim() : ""
    if (!p) return DATA_PROTOCOL
    const raw = readFileSync(p, "utf8")
    if (typeof raw === "string" && raw.trim().length > 200) {
      log.info(`[steroids] data protocol loaded from ${p} (${raw.length} chars)`)
      return raw.trim()
    }
    log.warn(`[steroids] protocolFile ${p} is empty or suspiciously short — using the built-in protocol`)
  } catch (e: any) {
    try {
      log.warn(`[steroids] protocolFile unreadable (${e?.message ?? e}) — using the built-in protocol`)
    } catch {}
  }
  return DATA_PROTOCOL
}

/**
 * How many lines the file at `abs` currently has; 0 if it does not exist.
 *
 * triage.ts is deliberately pure and does no I/O, but it cannot tell "create a file" from
 * "blank an existing file" without knowing whether the target exists — and those two have
 * very different consequences. So the one stat+read it needs is injected from here, as
 * `cfg.sizeOfExisting`, which triage already looks for.
 *
 * Bounded and silent: big files are never read (their exact line count does not change any
 * decision, only "is it big"), and any error means "treat it as new", which is the lenient
 * answer.
 */
function makeSizeProbe(log: any): (abs: string) => number {
  const MAX_READ = 4 * 1024 * 1024
  return (abs: string): number => {
    try {
      if (typeof abs !== "string" || !abs.startsWith("/")) return 0
      const st = statSync(abs)
      if (!st || !st.isFile()) return 0
      if (st.size === 0) return 0
      if (st.size > MAX_READ) return 100000 // definitely "large and existing"
      const raw = readFileSync(abs, "utf8")
      let n = 1
      for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) n++
      return n
    } catch {
      return 0 // absent, unreadable, a directory — all mean "not an overwrite"
    }
  }
}

function shortErr(e: unknown): string {
  try {
    if (!e) return "unknown error"
    const m = (e as any)?.message
    return String(typeof m === "string" && m ? m : e).slice(0, 300)
  } catch {
    return "unknown error"
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * the plugin
 * ════════════════════════════════════════════════════════════════════════════ */

export default {
  id: "steroids",

  server: async (input: any) => {
    /* ── init. Anything that throws here would abort plugin loading, so it is all
     *    inside one try/catch and a failure degrades to a no-op plugin. ────────── */
    let log: any = { info() {}, warn() {}, debug() {} }
    let cfg: any
    let board: any
    let advisorTools: Record<string, any> = {}
    let protocol = DATA_PROTOCOL
    let sizeProbe: (abs: string) => number = () => 0
    let alive = false
    /** durable, project-keyed guard memory — see lib/guardstate.ts */
    let guard: ReturnType<typeof makeGuardState> | undefined
    /** the single model funnel, hoisted so the blast gate can ask for an explanation */
    let caller: any

    /** session ids the plugin created itself (reviewers/advisors) — recursion guard */
    const ownSessions = new Set<string>()
    /** advisory text produced in `before`, consumed by `after`, keyed by callID */
    const pending = new Map<string, string>()

    /**
     * Facts and capabilities the libs cannot discover themselves. Re-applied after every
     * config reload, or a reload would quietly strip them and the libs would fall back to
     * process.cwd() and "every file is new".
     *
     * `worktree` comes back as "/" for a project that is not a git checkout (measured in the
     * load test), and "/" makes every path look like it is inside the project, so it falls
     * back to the session directory.
     */
    const attachRuntime = (c: any): void => {
      const wt = typeof input?.worktree === "string" ? input.worktree : ""
      const dir = typeof input?.directory === "string" ? input.directory : ""
      c.directory = dir
      c.worktree = wt && wt !== "/" ? wt : dir || wt
      c.ownSessions = ownSessions
      c.reviewerSessions = ownSessions
      c.sizeOfExisting = sizeProbe
      /* The review budget must not reset when the agent opens a new session — that was a
       * measured route-around, not a hypothetical one. reviewboard.ts keys its counters on
       * `guardScope` when one is present, and hydrates/persists them through these two
       * callbacks, so the budget belongs to the PROJECT and survives the process exiting. */
      if (guard) {
        c.guardScope = guard.scope
        c.guardRestore = () => guard!.counters()
        c.guardPersist = (x: any) => guard!.saveCounters(x)
      }
    }

    try {
      cfg = loadConfig()
      log = makeLogger(cfg)
      sizeProbe = makeSizeProbe(log)

      attachRuntime(cfg) // sets cfg.worktree, which is what the guard scope is derived from
      guard = makeGuardState(cfg, log)
      attachRuntime(cfg) // …and now the guard callbacks, which needed the scope to exist
      try {
        const tot = guard.totals()
        log.info("[steroids] guard memory", {
          scope: guard.scopeLabel,
          priorBlocks: tot.blocks,
          distinctActions: tot.distinct,
          priorDowngrades: tot.downgrades,
        })
      } catch {}

      /* ── PREFLIGHT. Arm nothing until the plugin has proved itself. ─────────── */
      const check = preflight(cfg, {
        loadConfig,
        makeLogger,
        makeCaller,
        triage,
        makeBoard,
        makeAdvisorTools,
        resetAdvisorSession,
      })
      for (const w of check.warn) log.warn(`[steroids] preflight warning — ${w}`)
      if (check.fatal.length) {
        const lines = [
          "═══════════════════════════════════════════════════════════════════",
          "  opencode-steroids PREFLIGHT FAILED — the plugin has DISABLED",
          "  itself. Your session is running with NO review board.",
          "═══════════════════════════════════════════════════════════════════",
          ...check.fatal.map((p) => `  ✗ ${p}`),
          "  Fix the above, or delete/rename the plugin file to silence this.",
          "═══════════════════════════════════════════════════════════════════",
        ]
        for (const l of lines) {
          try {
            console.error(l)
          } catch {}
        }
        log.warn("[steroids] PREFLIGHT FAILED — plugin disabled", { problems: check.fatal })
        alive = false
        return {}
      }

      caller = makeCaller(input?.client, log, cfg)
      board = makeBoard(caller, cfg, log)
      if (!board || typeof board.review !== "function") {
        throw new Error("makeBoard() returned no review() — the review board would never run")
      }
      advisorTools = await makeAdvisorTools(caller, cfg, log)
      protocol = protocolText(cfg, log)
      alive = true

      log.info("[steroids] loaded", {
        mode: cfg.mode,
        enabled: cfg.enabled,
        worktree: cfg.worktree,
        advisorTools: Object.keys(advisorTools),
        logFile: cfg?.logging?.file,
      })
      if (!Object.keys(advisorTools).length) {
        log.warn("[steroids] advisor tools are NOT registered — the review board still works, but the agent cannot consult an advisor on purpose")
      }
    } catch (e) {
      // Loud on stderr on purpose: a silently absent safety layer is the worst outcome.
      try {
        console.error(`[steroids] DISABLED — initialisation failed: ${shortErr(e)}`)
      } catch {}
      try {
        log.warn(`[steroids] DISABLED — initialisation failed: ${shortErr(e)}`)
      } catch {}
      alive = false
      return {}
    }

    /* ── cheap live config refresh. Kill files must take effect without a restart, but
     *    a stat() per tool call per file is waste — memo for sentinelTtlMs. ───────── */
    let lastLoad = Date.now()
    const current = (): any => {
      try {
        const ttl = Number(cfg?.paths?.sentinelTtlMs) > 0 ? Number(cfg.paths.sentinelTtlMs) : 2000
        if (Date.now() - lastLoad < ttl) return cfg
        lastLoad = Date.now()
        const next = loadConfig()
        // keep the same object identity for the libs that captured `cfg`
        for (const k of Object.keys(cfg)) if (!(k in next)) delete cfg[k]
        Object.assign(cfg, next)
        attachRuntime(cfg)
        return cfg
      } catch {
        return cfg
      }
    }

    const skip = (c: any, tool: string, sessionID: string): boolean =>
      !alive ||
      !c ||
      c.enabled === false ||
      c.mode === "off" ||
      OWN_TOOLS.has(String(tool || "").toLowerCase()) ||
      ownSessions.has(String(sessionID || ""))

    const stash = (callID: string, text: string): void => {
      try {
        if (!callID || !text) return
        pending.set(callID, text)
        if (pending.size > 200) {
          const it = pending.keys()
          for (let i = 0; i < 50; i++) {
            const k = it.next()
            if (k.done) break
            pending.delete(k.value)
          }
        }
      } catch {}
    }

    /**
     * The whole decision for one tool call. Returns the veto text, or "" to allow.
     * Anything it wants the model to see WITHOUT blocking it stashes for the after-hook.
     */
    const gate = async (inp: any, out: any): Promise<string> => {
      const tool = String(inp?.tool ?? "")
      const sessionID = String(inp?.sessionID ?? "")
      const callID = String(inp?.callID ?? "")
      const c = current()
      if (skip(c, tool, sessionID)) return ""

      const t = triage(tool, out?.args, c)
      log.debug("[steroids] triage", {
        tool,
        risk: t.risk,
        tier: t.tier,
        reasons: t.reasons.slice(0, 4),
        sessionID,
        callID,
      })

      const paranoid = c.mode === "paranoid"
      if (t.risk === "safe" && !paranoid) return ""

      const tier = c?.tiers?.[t.risk] ?? {}
      const enforcing = c.mode === "enforce" || paranoid
      const mayBlock = enforcing && tier.blocking !== false && tier.canBlock !== false

      /* 1. deterministic host rules — free, instant, no model, never demoted */
      if (t.tier === "fatal" && mayBlock) {
        log.warn("[steroids] HARD DENY (host rule)", { tool, reasons: t.reasons.slice(0, 4), sessionID })
        return redactDestructiveSql(hardVetoText(t, tool))
      }

      /* 2. observe mode: classify and note, but never spend a token or a millisecond */
      if (!enforcing) {
        log.info("[steroids] observe", { tool, risk: t.risk, tier: t.tier, reasons: t.reasons.slice(0, 4) })
        stash(
          callID,
          redactDestructiveSql(
            "\n────────── 🔎 STEROIDS · OBSERVE MODE (nothing was blocked) ──────────\n" +
              `risk ${t.risk} — ${t.reasons.slice(0, 3).join("; ")}\n` +
              "No model reviewed this call. Re-check it yourself before you rely on it.\n" +
              "──────────────────────────────────────────────────────────────────────",
          ),
        )
        return ""
      }

      /* ═══ 3. BLAST RADIUS — the deterministic size check ═══
       *
       * This is the step that did not exist in v1, and its absence was the hole. Everything
       * before it answers "what kind of statement is this"; only this one answers "how much
       * does it hit". A one-row correction and a category-wide sweep are the same shape, so
       * shape could never separate them — a count can, and a count is free compared with a
       * model call.
       *
       * It runs BEFORE the board on purpose. A measurement does not need a second opinion,
       * and if the measurement says the action is narrow, the board is skipped entirely: we
       * already have a better answer than a weak reviewer would give us, and making the
       * ordinary repair wait for it is exactly the friction that cost v1 its capability.
       */
      let skipBoard = false
      if (tool === "bash") {
        const bc = blastConfig(c)
        if (bc.enabled) {
          const cmd = String(out?.args?.command ?? out?.args?.cmd ?? out?.args?.script ?? "")
          let v: any
          try {
            v = await assessBlastRadius(cmd, c, log)
          } catch (e) {
            /* Being unable to run the check is itself a finding on the danger tier, but a
             * crash in it must not be. Treat a thrown error as "unmeasured". */
            v = { decision: "unknown", bound: "none", rows: -1, valuedRows: -1, limit: 0, verb: "", fingerprint: "", probeMs: 0, why: [`the size check itself failed: ${shortErr(e)}`] }
          }

          const priorBlocks = v?.fingerprint && guard ? guard.blocksFor(v.fingerprint) : 0
          const failClosed =
            v?.decision === "unknown" &&
            bc.failClosedWhenUnderivable &&
            (t.risk === "danger" || priorBlocks > 0)

          if (v?.decision === "block" || failClosed) {
            const repeats = guard
              ? guard.noteBlock(v.fingerprint, { verb: v.verb, rows: v.rows, reason: (v.why || [])[0] ?? "" })
              : 1
            log.warn("[steroids] BLAST-RADIUS BLOCK", {
              tool,
              verb: v.verb,
              rows: v.rows,
              valued: v.valuedRows,
              limit: v.limit,
              bound: v.bound,
              decision: v.decision,
              repeats,
              sessionID,
            })

            let text = blastVetoText(v, repeats)

            /* The model's whole role: write the explanation, propose the narrower statement,
             * and — only if the deployment enabled it, and only with a named justification —
             * ask for a downgrade, which is recorded as a downgrade either way. */
            if (bc.allowModelDowngrade || bc.modelExplains) {
              const chain = Array.isArray(c?.tiers?.danger?.reviewers) && c.tiers.danger.reviewers.length
                ? c.tiers.danger.reviewers
                : Array.isArray(c?.chains?.deep)
                  ? c.chains.deep
                  : []
              const ask = await askForDowngrade(caller, chain, v, bc, Number(c?.tiers?.danger?.timeoutMs) || 45000)
              if (ask.downgraded) {
                guard?.noteDowngrade(v.fingerprint, ask.justification, ask.model)
                log.warn("[steroids] blast-radius block DOWNGRADED by a model", {
                  model: ask.model,
                  rows: v.rows,
                  justification: ask.justification.slice(0, 160),
                })
                stash(
                  callID,
                  `\n⚠️ STEROIDS: a deterministic size block on this call was DOWNGRADED by ${ask.model}. ` +
                    `Stated justification: ${ask.justification}\nThis downgrade is recorded on disk.`,
                )
                return "" // allowed, but never silently
              }
              const extra: string[] = []
              if (ask.explanation) extra.push("", "IN PLAIN WORDS", "  " + ask.explanation)
              if (ask.saferRewrite) extra.push("", "TRY THIS INSTEAD", "  " + ask.saferRewrite)
              if (ask.error) extra.push("", `(a reviewer was consulted for a rewrite: ${ask.error})`)
              if (extra.length) text = text + "\n" + extra.join("\n")
            }

            if (mayBlock) return redactDestructiveSql(text)
            stash(callID, "\n⚠️ STEROIDS: this call WOULD HAVE BEEN BLOCKED on size, but blocking is off for this tier.\n" + text.slice(0, 900))
            return ""
          }

          if (v?.decision === "allow") {
            /* the cumulative half of the same limit — see budgetVetoText() */
            const want = v.rows > 0 ? v.rows : 1
            const used = guard ? guard.rowsInWindow(bc.windowMs) : 0
            if (bc.maxRowsPerWindow > 0 && used + want > bc.maxRowsPerWindow) {
              guard?.noteBlock(v.fingerprint || "window", {
                verb: v.verb,
                rows: v.rows,
                reason: `rolling row budget: ${used}+${want} > ${bc.maxRowsPerWindow}`,
              })
              log.warn("[steroids] BLAST-RADIUS BLOCK (rolling row budget)", { used, want, limit: bc.maxRowsPerWindow })
              if (mayBlock) return budgetVetoText(used, want, bc)
              stash(callID, "\n⚠️ STEROIDS: the rolling row budget is spent; blocking is off for this tier.")
              return ""
            }
            guard?.noteRows(want)

            const note = blastAllowNote(v)
            if (note) stash(callID, note)
            /* Proven narrow, by the predicate itself. Nothing a reviewer could add would beat
             * that, so do not make the user wait for one — unless the same command is risky
             * for a reason that has nothing to do with row counts. */
            if (v.bound === "static" && t.tier === "high" && !hasNonDbRisk(t.reasons)) {
              skipBoard = true
              log.debug("[steroids] board skipped: blast radius statically bounded", { rows: v.rows })
            }
          }
        }
      }

      /* 4. the model board */
      if (skipBoard) return ""
      if (tier.review === false) return ""
      if (t.tooSecret) {
        log.warn("[steroids] review skipped: payload too secret-dense to forward", { tool })
        stash(
          callID,
          "\n⚠️ STEROIDS: this call was NOT reviewed — its arguments were too secret-dense to send to any reviewer. Treat it as unverified.",
        )
        return ""
      }

      const res = await board.review({
        tool,
        args: out?.args,
        risk: t.risk,
        summary: t.summary,
        reasons: t.reasons,
        sessionID,
      })

      if (res?.blocked) {
        const reason = redactDestructiveSql(String(res.reason ?? "blocked by the review board"))
        if (mayBlock) {
          log.warn("[steroids] VETO", { tool, sessionID, tier: t.risk })
          return reason
        }
        log.info("[steroids] veto downgraded to a note (blocking off for this tier)", { tool, tier: t.risk })
        stash(
          callID,
          `\n⚠️ STEROIDS: the review board WOULD HAVE BLOCKED this call, but blocking is off for the ${t.risk} tier. Its objection:\n` +
            reason.slice(0, 900),
        )
        return ""
      }
      if (res?.advisory) stash(callID, redactDestructiveSql(String(res.advisory)))
      return ""
    }

    return {
      /* ═══ the advisor tools the agent may call on purpose ═══ */
      tool: advisorTools,

      /* ═══ inject the usage policy + the data protocol ═══ */
      "experimental.chat.system.transform": async (inp: any, out: any) => {
        try {
          const c = current()
          if (!alive || !c || c.enabled === false || c.mode === "off") return
          if (!out || !Array.isArray(out.system)) return
          // Our own reviewer/advisor sessions get a lean system prompt from callmodel;
          // injecting a policy about a review board into a reviewer is noise and tokens.
          const sid = typeof inp?.sessionID === "string" ? inp.sessionID : ""
          if (sid && ownSessions.has(sid)) return
          if (out.system.some((s: any) => typeof s === "string" && s.includes("REVIEW BOARD IS ACTIVE"))) return
          out.system.push(POLICY)
          out.system.push(protocol)
        } catch (e) {
          try {
            log.warn(`[steroids] system.transform failed, session left unmodified: ${shortErr(e)}`)
          } catch {}
        }
      },

      /* ═══ the gate: classify, then review, then maybe veto ═══
       * The decision is computed by `gate` and the veto is thrown by the hook itself. That
       * separation is deliberate: the try/catch that protects the user from our bugs must
       * not be able to swallow an intentional veto. */
      "tool.execute.before": async (inp: any, out: any) => {
        let veto = ""
        try {
          veto = await gate(inp, out)
        } catch (e) {
          try {
            log.warn(`[steroids] before-hook failed, ALLOWING the call: ${shortErr(e)}`)
          } catch {}
          veto = ""
        }
        // THROWING HERE IS WHAT BLOCKS THE TOOL. The model reads this message and can react.
        if (veto) throw new Error(veto)
      },

      /* ═══ non-blocking feedback: append to what the model reads back ═══ */
      "tool.execute.after": async (inp: any, out: any) => {
        try {
          const callID = String(inp?.callID ?? "")
          if (!callID || !pending.size) return
          const note = pending.get(callID)
          if (!note) return
          pending.delete(callID)
          if (!out || typeof out.output !== "string") return
          // in place: `out.output = ...` on the object we were handed is what reaches the model
          out.output = out.output + "\n" + note
        } catch (e) {
          try {
            log.warn(`[steroids] after-hook failed, output left untouched: ${shortErr(e)}`)
          } catch {}
        }
      },

      /* ═══ housekeeping ═══ */
      event: async (inp: any) => {
        try {
          const ev = inp?.event
          const type = String(ev?.type ?? "")
          if (type !== "session.deleted") return
          const p = ev?.properties ?? {}
          const id = String(p?.info?.id ?? p?.sessionID ?? p?.id ?? "")
          if (!id) return
          resetAdvisorSession(id)
          board?.resetSession?.(id)
          ownSessions.delete(id)
          for (const k of Array.from(pending.keys())) if (k.startsWith(id)) pending.delete(k)
          log.debug("[steroids] session counters reset", { sessionID: id })
        } catch (e) {
          try {
            log.warn(`[steroids] event-hook failed: ${shortErr(e)}`)
          } catch {}
        }
      },
    }
  },
}
