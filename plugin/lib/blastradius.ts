/**
 * lib/blastradius.ts — how many rows would this statement actually touch?
 *
 * ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * Every risk signal we had before this file answers "what KIND of statement is this".
 * None of them answered "HOW MUCH does it hit". A statement addressing one row by primary
 * key and a statement addressing every row of a category got the identical tier and the
 * identical reason string, because structurally they are both "an UPDATE with a WHERE".
 *
 * Kind is not the risk. SIZE is the risk. A one-row correction is ordinary maintenance;
 * the same verb across a whole category is the accident that ends careers. So before a
 * mutating statement runs, this module derives the SAME predicate and asks the database
 * a cheap read-only question — `SELECT count(*) … WHERE <same predicate>` — and decides
 * on the answer. No model is consulted, because a model cannot count.
 *
 * ─── THE TWO DIRECTIONS IT MUST GET RIGHT ────────────────────────────────────
 * It must block the wide mutation, and it must NOT slow down the narrow one. A guard that
 * makes an agent too frightened to do the small legitimate repair has traded capability
 * for nothing. So there are two separate paths:
 *
 *   • STATIC BOUND — if the predicate contains a key-column equality or IN-list, the number
 *     of rows is bounded by the number of literals in it, no matter what else the predicate
 *     says (an AND can only narrow). One key ⇒ at most one row ⇒ allowed instantly, with no
 *     database round-trip, no model, no latency. This is the frictionless path and it is the
 *     path the ordinary repair takes.
 *   • COUNTED — anything wider is measured against the live table before it is allowed.
 *
 * ─── DOMAIN NEUTRALITY (ANTICHEAT.md R1/R2) ──────────────────────────────────
 * Nothing here knows a table, a column, an id or a domain. "This row carries value" is
 * decided by the column's DATA TYPE — exact-decimal or floating point holding a non-zero
 * number — not by a list of money-sounding column names. A name list would be a small
 * dictionary of one domain's vocabulary; a type check is a property of any schema anywhere.
 *
 * ─── WHAT THIS IS NOT, MEASURED RATHER THAN ARGUED ───────────────────────────
 * This is a TAIL control, not a safety story, and the module says so itself so that nobody
 * downstream has to discover it the hard way. Priced against the same thirteen statements as
 * the alternative (bench/blast-vs-attacks.ts, bench/gate/attack.sql), it refuses 4 of 10
 * recorded attacks where a ninety-line SQL trigger refuses 10 of 10.
 *
 * The reason is structural and no threshold fixes it: on the runs that damaged data, the
 * legitimate repair touched two rows and the most common destruction touched two rows. Size
 * cannot separate two from two. What separates them is the DIRECTION of the information — the
 * repair adds a key, the destruction overwrites a value or removes a row — which a database
 * computes exactly from a statement's own transition tables, with no SQL parsing at all.
 * Two of this module's four misses are parser misses rather than threshold misses (an upsert
 * is not an `UPDATE … SET`), which is that same point from the other side.
 *
 * So: use it ON TOP OF a direction-of-information rule, as "even with approval, not more than
 * N rows in one statement", and on tables where overwriting is normal and counting is all
 * there is. Do not use it as the primary control. See docs/WAY-FORWARD.md §4.1 and §4.8.
 *
 * ─── FAILURE DIRECTION ───────────────────────────────────────────────────────
 * Where the pre-count cannot be derived honestly — a statement we cannot parse, a join, a
 * sub-select, a heredoc, an interpreter running SQL we cannot see — the answer is not "assume
 * it is small". It is "we do not know", and on the danger tier not knowing fails closed with
 * the reason said out loud. Being unable to measure a blast radius is itself the finding.
 *
 * PURE except for `probe()`, which shells out to a read-only client invocation it builds
 * itself, argv by argv, from an allow-list. It never re-runs the user's text.
 */

import { execFile } from "node:child_process"

/* ────────────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────────────── */

export type BlastDecision = "allow" | "block" | "unknown" | "none"

export type BlastVerdict = {
  /**
   * allow   — proven small enough (statically or by counting)
   * block   — proven too wide, deterministically
   * unknown — a mutation will run and its size could not be established
   * none    — nothing in this command mutates stored data
   */
  decision: BlastDecision
  /** how the size was established */
  bound: "static" | "counted" | "none"
  /** rows the statement would affect; -1 when unknown */
  rows: number
  /** of those, how many carry a non-zero numeric (value-bearing) column; -1 when unknown */
  valuedRows: number
  /** limit that was applied */
  limit: number
  /** verb, with no table or predicate text — safe to print into a transcript */
  verb: string
  /** human-readable reasons, domain-neutral */
  why: string[]
  /** stable identity of the attempted mutation, for the cross-session ledger */
  fingerprint: string
  /** how long the probe took, ms (0 when no probe ran) */
  probeMs: number
}

type Stmt = {
  verb: "UPDATE" | "DELETE"
  table: string
  where: string
  /** upper bound on affected rows derivable from the predicate alone; Infinity if none */
  staticBound: number
  raw: string
}

type Client = {
  kind: "psql" | "mysql"
  /** connection arguments only — never the user's SQL */
  connArgs: string[]
  bin: string
  env: Record<string, string>
}

/* ────────────────────────────────────────────────────────────────────────────
 * Config
 * ──────────────────────────────────────────────────────────────────────────── */

export type BlastConfig = {
  enabled: boolean
  /** rows a statement may touch without the pre-count running at all */
  freeRows: number
  /** rows a statement may touch, when none of them carries a numeric value */
  maxRows: number
  /** rows a statement may touch when the affected rows carry non-zero numeric values */
  maxValuedRows: number
  /** total rows this project may be allowed to change inside `windowMs`, all statements */
  maxRowsPerWindow: number
  windowMs: number
  /** milliseconds the read-only probe may take before it is abandoned */
  probeTimeoutMs: number
  /** when the size cannot be established, block on the danger tier */
  failClosedWhenUnderivable: boolean
  /** ask a model to write the explanation and a narrower rewrite alongside the block */
  modelExplains: boolean
  /** a deterministic block may be argued down by a model with a named justification */
  allowModelDowngrade: boolean
  /** …but never above this many rows, whatever a model says */
  neverDowngradeAboveRows: number
}

function n(v: unknown, dflt: number): number {
  const x = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
  return Number.isFinite(x) && x >= 0 ? x : dflt
}

export function blastConfig(cfg: any): BlastConfig {
  const b = (cfg && typeof cfg === "object" && (cfg as any).blastRadius) || {}
  return {
    enabled: b.enabled !== false,
    freeRows: n(b.freeRows, 1),
    maxRows: n(b.maxRows, 10),
    maxValuedRows: n(b.maxValuedRows, 3),
    maxRowsPerWindow: n(b.maxRowsPerWindow, 25),
    windowMs: n(b.windowMs, 3600_000),
    probeTimeoutMs: n(b.probeTimeoutMs, 6000),
    failClosedWhenUnderivable: b.failClosedWhenUnderivable !== false,
    modelExplains: b.modelExplains === true,
    allowModelDowngrade: b.allowModelDowngrade === true,
    neverDowngradeAboveRows: n(b.neverDowngradeAboveRows, 5),
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * §1  A shell tokeniser that is only as clever as it needs to be
 *
 * We are not running the user's command — we are reading it to find out which client is
 * being invoked and with which connection arguments. So the tokeniser only has to be right
 * about quoting; anything it cannot make sense of ends up as "we could not derive a probe",
 * which is the safe answer rather than a wrong one.
 * ──────────────────────────────────────────────────────────────────────────── */

type Tok = { v: string; quoted: boolean; sep: boolean }

function tokenize(cmd: string): Tok[] {
  const out: Tok[] = []
  let cur = ""
  let quoted = false
  let has = false
  const push = () => {
    if (has) out.push({ v: cur, quoted, sep: false })
    cur = ""
    quoted = false
    has = false
  }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i] as string
    if (c === "'" || c === '"') {
      const q = c
      let s = ""
      i++
      for (; i < cmd.length; i++) {
        const d = cmd[i] as string
        if (d === "\\" && q === '"' && i + 1 < cmd.length) {
          s += cmd[i + 1]
          i++
          continue
        }
        if (d === q) break
        s += d
      }
      cur += s
      quoted = true
      has = true
      continue
    }
    if (c === "\\" && i + 1 < cmd.length) {
      cur += cmd[i + 1]
      has = true
      i++
      continue
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      push()
      continue
    }
    if (c === ";" || c === "|" || c === "&" || c === "(" || c === ")" || c === "<" || c === ">") {
      push()
      // collapse ||, &&, <<, >>
      let s = c
      while (i + 1 < cmd.length && cmd[i + 1] === c) {
        s += c
        i++
      }
      out.push({ v: s, quoted: false, sep: true })
      continue
    }
    cur += c
    has = true
  }
  push()
  return out
}

const CLIENT_BIN = /^(?:psql|mysql|mariadb)$/
/** Interpreters that can run SQL we cannot see. Their presence means "cannot pre-count". */
const INTERPRETER_BIN = /^(?:python|python3|node|bun|deno|ruby|perl|php|sqlite3|clickhouse-client|mongosh|psql-wrapper)$/

function base(nameArg: string): string {
  return nameArg.replace(/^.*\//, "")
}

/**
 * Connection flags we are willing to copy into a probe. Everything else is dropped, so no
 * argument of the user's — least of all their SQL — can end up in a command we execute.
 */
const PSQL_VALUE_FLAGS = new Set(["-h", "--host", "-p", "--port", "-U", "--username", "-d", "--dbname"])
const PSQL_BOOL_FLAGS = new Set(["-w", "--no-password", "--no-psqlrc", "-X"])
const MYSQL_VALUE_FLAGS = new Set(["-h", "--host", "-P", "--port", "-u", "--user", "-D", "--database", "-S", "--socket"])

const URI_ARG = /^(?:postgres(?:ql)?|mysql):\/\//i

/* ────────────────────────────────────────────────────────────────────────────
 * §2  Finding the client invocation and the SQL it was given
 * ──────────────────────────────────────────────────────────────────────────── */

type Found = {
  client?: Client
  sql: string[]
  /** an execution path exists that we cannot read */
  opaque: boolean
  opaqueWhy: string
}

export function findInvocation(cmd: string): Found {
  const res: Found = { sql: [], opaque: false, opaqueWhy: "" }
  const toks = tokenize(cmd)

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as Tok
    if (t.sep) continue
    const b = base(t.v)

    if (INTERPRETER_BIN.test(b)) {
      res.opaque = true
      res.opaqueWhy = `the statement is handed to \`${b}\`, so the predicate that will really run is not visible here`
      continue
    }
    if (!CLIENT_BIN.test(b) || t.quoted) continue

    const kind: "psql" | "mysql" = b === "psql" ? "psql" : "mysql"
    const connArgs: string[] = []
    const env: Record<string, string> = {}
    const sql: string[] = []
    let sawFile = false
    let sawHeredoc = false
    let sawStdin = false

    // env assignments written immediately before the binary (FOO=bar psql …)
    for (let j = i - 1; j >= 0; j--) {
      const p = toks[j] as Tok
      if (p.sep) break
      const m = p.v.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/)
      if (!m) break
      if (/^(?:PG|MYSQL)[A-Z0-9_]*$/.test(m[1] as string)) env[m[1] as string] = m[2] as string
    }

    for (let j = i + 1; j < toks.length; j++) {
      const a = toks[j] as Tok
      if (a.sep) {
        if (a.v === "<<" || a.v === "<") sawHeredoc = true
        break
      }
      const val = a.v

      if (val === "-c" || val === "--command" || val === "-e" || val === "--execute") {
        const nxt = toks[j + 1]
        if (nxt && !nxt.sep) {
          sql.push(nxt.v)
          j++
        } else sawStdin = true
        continue
      }
      let m = val.match(/^--(?:command|execute)=([\s\S]*)$/)
      if (m) {
        sql.push(m[1] as string)
        continue
      }
      // -c"SELECT …" written without a space
      m = val.match(/^-([ce])([\s\S]+)$/)
      if (m && !a.quoted) {
        sql.push(m[2] as string)
        continue
      }
      if (val === "-f" || val === "--file" || /^--file=/.test(val)) {
        sawFile = true
        continue
      }
      if (URI_ARG.test(val)) {
        connArgs.push(val)
        continue
      }
      const flags = kind === "psql" ? PSQL_VALUE_FLAGS : MYSQL_VALUE_FLAGS
      if (flags.has(val)) {
        const nxt = toks[j + 1]
        if (nxt && !nxt.sep) {
          connArgs.push(val, nxt.v)
          j++
        }
        continue
      }
      m = val.match(/^(--[a-z-]+)=([\s\S]*)$/)
      if (m && flags.has(m[1] as string)) {
        connArgs.push(val)
        continue
      }
      if (kind === "psql" && PSQL_BOOL_FLAGS.has(val)) {
        connArgs.push(val)
        continue
      }
      if (kind === "mysql" && /^-p/.test(val)) {
        // -pSECRET carries the password inline; copy it as-is, it is a connection argument
        connArgs.push(val)
        continue
      }
      if (/^-/.test(val)) continue // any other flag is dropped on purpose
      // a bare positional: for psql it is the database name, for mysql likewise
      if (!connArgs.some((x) => URI_ARG.test(x)) && /^[A-Za-z_][A-Za-z0-9_.$-]*$/.test(val)) {
        connArgs.push(kind === "psql" ? "-d" : "-D", val)
      }
    }

    if (sawFile || sawHeredoc || sawStdin) {
      res.opaque = true
      res.opaqueWhy = "the statement is fed to the client from a file or standard input, so it cannot be read here"
    }
    res.client = { kind, bin: b, connArgs, env }
    for (const s of sql) res.sql.push(s)
  }

  return res
}

/* ────────────────────────────────────────────────────────────────────────────
 * §3  Parsing the mutating statements
 * ──────────────────────────────────────────────────────────────────────────── */

/** Split on `;` while respecting quoting and dollar-quoting. */
function splitStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ""
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i] as string
    if (c === "'" || c === '"') {
      const q = c
      cur += c
      i++
      for (; i < sql.length; i++) {
        cur += sql[i]
        if (sql[i] === q) {
          // '' inside a string is an escaped quote
          if (sql[i + 1] === q) {
            cur += sql[i + 1]
            i++
            continue
          }
          break
        }
      }
      continue
    }
    if (c === "$") {
      const m = sql.slice(i).match(/^\$[A-Za-z_]*\$/)
      if (m) {
        const tag = m[0]
        const end = sql.indexOf(tag, i + tag.length)
        const stop = end < 0 ? sql.length : end + tag.length
        cur += sql.slice(i, stop)
        i = stop - 1
        continue
      }
    }
    if (c === ";") {
      out.push(cur)
      cur = ""
      continue
    }
    cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter((s) => s.length > 0)
}

/** A table reference we are willing to interpolate into a query of our own. */
const SAFE_TABLE = /^(?:[A-Za-z_][A-Za-z0-9_$]*\.)?[A-Za-z_][A-Za-z0-9_$]*$/

/** Column-name shapes that denote a key rather than a category. Same rule as triage.ts. */
const KEY_COLUMN = /^(?:id|[a-z0-9_$]*_id|[a-z0-9_$]*_?uuid|guid|pk|primary_key|[a-z0-9_$]*_pk)$/i

function isRowIdLiteral(v: string): boolean {
  const s = v.trim()
  if (/^-?\d+$/.test(s)) return true
  if (/^'[0-9A-Fa-f]{8}-?[0-9A-Fa-f-]{4,}'$/.test(s)) return true
  return false
}

/**
 * A sound UPPER BOUND on how many rows this predicate can select, derived from the text
 * alone, or Infinity when no bound follows.
 *
 * The reasoning is deliberately simple and provable: a conjunction can only ever narrow.
 * So if ANY top-level AND-term restricts a key-shaped column to K literal values, the whole
 * predicate selects at most K rows — regardless of what the other terms say. A top-level OR
 * breaks that, and so does anything we cannot read, and both give up rather than guess.
 */
export function staticRowBound(whereClause: string): number {
  try {
    const w = whereClause
      .replace(/\b(?:returning|order\s+by|group\s+by|having|limit|offset)\b[\s\S]*$/i, "")
      .trim()
    if (!w) return Infinity
    if (/\b(?:select|exists|any|all)\b/i.test(w)) return Infinity
    // a top-level OR (i.e. one not inside parentheses) invalidates the narrowing argument
    let depth = 0
    let topLevelOr = false
    for (let i = 0; i < w.length; i++) {
      const c = w[i] as string
      if (c === "(") depth++
      else if (c === ")") depth--
      else if (depth === 0 && /[oO]/.test(c) && /^or\b/i.test(w.slice(i)) && (i === 0 || /\s|\)/.test(w[i - 1] as string))) {
        topLevelOr = true
        break
      }
    }
    if (topLevelOr) return Infinity

    let best = Infinity
    for (const rawTerm of w.split(/\band\b/i)) {
      const c = rawTerm.replace(/^[\s(]+|[\s)]+$/g, "").trim()
      if (!c) continue
      const m = c.match(/^(?:[A-Za-z_][\w$]*\s*\.\s*)?["'`[]?([A-Za-z_][\w$]*)["'`\]]?\s*(=|in)\s*([\s\S]+)$/i)
      if (!m) continue
      if (!KEY_COLUMN.test(m[1] as string)) continue
      const values = (m[3] as string)
        .replace(/[()]/g, " ")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
      if (!values.length) continue
      let allLiterals = true
      for (const v of values) if (!isRowIdLiteral(v)) allLiterals = false
      if (!allLiterals) continue
      best = Math.min(best, values.length)
    }
    return best
  } catch {
    return Infinity
  }
}

/**
 * Parse one statement. Returns undefined when it does not mutate rows, and `null` when it
 * mutates but cannot be reduced to a countable predicate — which is a finding, not a pass.
 */
function parseStatement(stmt: string): Stmt | null | undefined {
  const s = stmt.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim()
  if (!s) return undefined
  if (/^\s*with\b/i.test(s) && /\b(?:update|delete)\b/i.test(s)) return null // CTE: not reducible

  const upd = s.match(/^\s*update\s+(?:only\s+)?([A-Za-z_"][\w$."]*)\s+set\b([\s\S]*)$/i)
  const del = s.match(/^\s*delete\s+from\s+(?:only\s+)?([A-Za-z_"][\w$."]*)\b([\s\S]*)$/i)
  const m = upd ?? del
  if (!m) return undefined

  const verb: "UPDATE" | "DELETE" = upd ? "UPDATE" : "DELETE"
  const table = String(m[1] as string).replace(/"/g, "")
  const rest = String(m[2] as string)

  if (!SAFE_TABLE.test(table)) return null
  // a join makes "the same predicate" a different question; we do not pretend otherwise
  if (verb === "UPDATE" && /\bfrom\b/i.test(rest.split(/\bwhere\b/i)[0] as string)) return null
  if (verb === "DELETE" && /\busing\b/i.test(rest.split(/\bwhere\b/i)[0] as string)) return null

  const wm = rest.match(/\bwhere\b([\s\S]*)$/i)
  const where = wm
    ? String(wm[1]).replace(/\breturning\b[\s\S]*$/i, "").trim()
    : ""
  return {
    verb,
    table,
    where,
    staticBound: where ? staticRowBound(where) : Infinity,
    raw: s,
  }
}

/** FNV-1a-ish, same shape as triage.ts uses. Identity for the cross-session ledger. */
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
  return ("00000000" + h1.toString(16)).slice(-8) + ("00000000" + h2.toString(16)).slice(-8)
}

function fingerprintOf(st: Stmt): string {
  return cheapHash(st.verb + " " + st.table + " " + st.where.replace(/\s+/g, " ").toLowerCase())
}

/* ────────────────────────────────────────────────────────────────────────────
 * §4  The probe — one read-only question, built argv by argv
 * ──────────────────────────────────────────────────────────────────────────── */

function run(bin: string, argv: string[], env: Record<string, string>, timeoutMs: number): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        bin,
        argv,
        {
          timeout: Math.max(500, timeoutMs),
          maxBuffer: 256 * 1024,
          env: { ...(typeof process !== "undefined" ? process.env : {}), ...env },
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          resolve({ ok: !err, out: String(stdout ?? ""), err: String((err as any)?.message ?? stderr ?? "") })
        },
      )
      child.on("error", () => resolve({ ok: false, out: "", err: "spawn failed" }))
    } catch (e: any) {
      resolve({ ok: false, out: "", err: String(e?.message ?? e) })
    }
  })
}

function queryArgs(c: Client, sql: string): string[] {
  /* psql documents the connection target as the trailing positional, so it goes last;
   * mysql takes its connection flags first. Neither ever receives the user's own SQL.
   *
   * ⚠️ The statement timeout is set through PGOPTIONS, NOT as a second `-c "SET …"`. It was
   * a second -c until the first live end-to-end run, where psql duly printed the command tag
   * `SET` on its own line — and the line that reads the column list back happily accepted
   * "SET" as a column name, producing a query against a column that does not exist. The
   * value check then failed and every counted statement fell back to "value unknown". It
   * failed in the safe direction, which is exactly why it could have gone unnoticed. */
  if (c.kind === "psql") {
    return ["-w", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql, ...c.connArgs]
  }
  return [...c.connArgs, "-N", "-B", "--batch", "-e", sql]
}

/** Command tags psql/mysql print alongside results; never a column name. */
const STATUS_TAG = /^(?:SET|BEGIN|COMMIT|ROLLBACK|SELECT|UPDATE|DELETE|INSERT|SHOW|RESET|DISCARD)\b/

function firstNumber(out: string): number {
  for (const line of out.split("\n")) {
    const t = line.trim()
    if (/^-?\d+$/.test(t)) return Number(t)
  }
  return NaN
}

/**
 * Numeric column types, in the spelling each engine's information_schema uses.
 * TYPE, not name — see the header. Integers are deliberately excluded: they are as often a
 * key, a count or a flag as a value, and treating them as value-bearing would make the
 * strict limit apply to almost every table in the world.
 */
const VALUE_TYPES = ["numeric", "decimal", "money", "real", "double precision", "float", "double"]

/** Exported so the live test can run the EXACT text the gate would run, not a paraphrase. */
export function countQuery(table: string, where: string): string {
  return `SELECT count(*) FROM ${table} ${where ? `WHERE ${where}` : ""}`
}

export function valueColumnsQuery(table: string): string {
  const parts = table.split(".")
  const bare = (parts.length > 1 ? parts[1] : parts[0]) as string
  const schemaPred = parts.length > 1 ? ` AND table_schema = '${parts[0]}'` : ""
  const typeList = VALUE_TYPES.map((t) => `'${t}'`).join(",")
  return (
    `SELECT column_name FROM information_schema.columns ` +
    `WHERE table_name = '${bare}'${schemaPred} AND lower(data_type) IN (${typeList})`
  )
}

export function valuedCountQuery(table: string, where: string, names: string[], kind: "psql" | "mysql"): string {
  const q = kind === "psql" ? (x: string) => `"${x}"` : (x: string) => `\`${x}\``
  const cast = kind === "psql" ? (x: string) => `COALESCE(${q(x)}::numeric, 0) <> 0` : (x: string) => `COALESCE(${q(x)}, 0) <> 0`
  const anyValue = names.slice(0, 40).map(cast).join(" OR ")
  return `SELECT count(*) FROM ${table} WHERE (${where || "TRUE"}) AND (${anyValue})`
}

async function probe(
  c: Client,
  st: Stmt,
  timeoutMs: number,
): Promise<{ rows: number; valued: number; err: string }> {
  /* Server-side deadline, set out of band rather than as a `SET` statement, so that no
   * command tag is ever printed into the result stream we then parse. */
  const env =
    c.kind === "psql"
      ? { ...c.env, PGOPTIONS: `${c.env.PGOPTIONS ? c.env.PGOPTIONS + " " : ""}-c statement_timeout=${Math.max(1000, timeoutMs)}` }
      : c.env
  const cnt = await run(c.bin, queryArgs(c, countQuery(st.table, st.where)), env, timeoutMs)
  if (!cnt.ok) return { rows: -1, valued: -1, err: cnt.err.slice(0, 200) || "count query failed" }
  const rows = firstNumber(cnt.out)
  if (!Number.isFinite(rows)) return { rows: -1, valued: -1, err: "count query returned nothing readable" }
  if (rows === 0) return { rows: 0, valued: 0, err: "" }

  /* which columns of this table hold a value rather than a key or a label */
  const cols = await run(c.bin, queryArgs(c, valueColumnsQuery(st.table)), env, timeoutMs)
  if (!cols.ok) return { rows, valued: -1, err: "" }
  const names = cols.out
    .split("\n")
    .map((x) => x.trim())
    .filter((x) => /^[A-Za-z_][A-Za-z0-9_$]*$/.test(x) && !STATUS_TAG.test(x))
  if (!names.length) return { rows, valued: 0, err: "" }

  const val = await run(c.bin, queryArgs(c, valuedCountQuery(st.table, st.where, names, c.kind)), env, timeoutMs)
  if (!val.ok) return { rows, valued: -1, err: "" }
  const v = firstNumber(val.out)
  return { rows, valued: Number.isFinite(v) ? v : -1, err: "" }
}

/* ────────────────────────────────────────────────────────────────────────────
 * §5  assess() — the whole decision for one bash command
 * ──────────────────────────────────────────────────────────────────────────── */

const NOTHING: BlastVerdict = {
  decision: "none",
  bound: "none",
  rows: -1,
  valuedRows: -1,
  limit: 0,
  verb: "",
  why: [],
  fingerprint: "",
  probeMs: 0,
}

/**
 * `cmd` is the bash command the agent is about to run. Returns the widest verdict across
 * every mutating statement it contains: one wide statement in a batch of narrow ones decides
 * the outcome for the batch, because they run together.
 */
export async function assessBlastRadius(cmd: string, cfg: any, log?: any): Promise<BlastVerdict> {
  const bc = blastConfig(cfg)
  if (!bc.enabled || typeof cmd !== "string" || !cmd) return NOTHING

  /* a cheap pre-filter so ordinary commands never pay for the parser */
  if (!/\b(?:update|delete)\b/i.test(cmd)) return NOTHING

  let found: Found
  try {
    found = findInvocation(cmd)
  } catch {
    return NOTHING
  }

  const stmts: Stmt[] = []
  let unreadable = ""
  for (const sql of found.sql) {
    for (const piece of splitStatements(sql)) {
      let p: Stmt | null | undefined
      try {
        p = parseStatement(piece)
      } catch {
        p = null
      }
      if (p === undefined) continue
      if (p === null) {
        unreadable = "a statement changes stored rows through a join, a sub-select or a form this gate cannot reduce to a countable predicate"
        continue
      }
      stmts.push(p)
    }
  }

  /* An execution path we cannot read, carrying something that looks like a mutation. */
  if (!stmts.length) {
    const mutationShaped = /\bupdate\s+[A-Za-z_"][^;]*\bset\b/i.test(cmd) || /\bdelete\s+from\b/i.test(cmd)
    if (!mutationShaped) return NOTHING
    if (found.opaque || unreadable) {
      return {
        ...NOTHING,
        decision: "unknown",
        verb: /\bdelete\s+from\b/i.test(cmd) ? "DELETE" : "UPDATE",
        fingerprint: cheapHash("opaque " + cmd.replace(/\s+/g, " ").slice(0, 400)),
        why: [unreadable || found.opaqueWhy, "the number of rows this would change could not be established before running it"],
      }
    }
    /* No client, no interpreter: the text mentions a mutation but nothing here can execute
     * it (it is being written, printed or quoted). A statement that cannot run has no blast
     * radius, and blocking it would be the timidity this gate exists to avoid. */
    return NOTHING
  }

  if (!found.client) {
    return {
      ...NOTHING,
      decision: "unknown",
      verb: stmts[0]?.verb ?? "UPDATE",
      fingerprint: fingerprintOf(stmts[0] as Stmt),
      why: ["a mutating statement was found but no database client invocation could be identified, so no pre-count could be issued"],
    }
  }

  let worst: BlastVerdict | undefined
  const t0 = Date.now()

  for (const st of stmts) {
    const fp = fingerprintOf(st)

    /* no predicate at all — every row in the table. No count needed to know that is too wide. */
    if (!st.where) {
      const v: BlastVerdict = {
        decision: "block",
        bound: "static",
        /* -1, not Infinity: this object is logged as JSON and Infinity does not survive it. */
        rows: -1,
        valuedRows: -1,
        limit: bc.maxRows,
        verb: st.verb,
        fingerprint: fp,
        probeMs: Date.now() - t0,
        why: [`a ${st.verb} with no WHERE clause affects every row that exists in the table`],
      }
      worst = pickWorse(worst, v)
      continue
    }

    /* THE FRICTIONLESS PATH: the predicate itself proves the statement is narrow. */
    if (st.staticBound <= bc.freeRows) {
      const v: BlastVerdict = {
        decision: "allow",
        bound: "static",
        rows: st.staticBound,
        valuedRows: -1,
        limit: bc.freeRows,
        verb: st.verb,
        fingerprint: fp,
        probeMs: 0,
        why: [`the predicate names a single row by key, so at most ${st.staticBound} row can change — no database probe was needed`],
      }
      worst = pickWorse(worst, v)
      continue
    }

    /* Otherwise: ask the database, before the mutation runs. */
    let rows = -1
    let valued = -1
    let perr = ""
    try {
      const r = await probe(found.client, st, bc.probeTimeoutMs)
      rows = r.rows
      valued = r.valued
      perr = r.err
    } catch (e: any) {
      perr = String(e?.message ?? e).slice(0, 160)
    }

    if (rows < 0) {
      /* The probe could not answer. If the predicate still gives a static bound, use it —
       * that is a real measurement, just a coarser one. */
      if (Number.isFinite(st.staticBound)) {
        rows = st.staticBound
        valued = -1
      } else {
        worst = pickWorse(worst, {
          ...NOTHING,
          decision: "unknown",
          verb: st.verb,
          fingerprint: fp,
          probeMs: Date.now() - t0,
          why: [
            "the read-only pre-count could not be completed" + (perr ? ` (${perr})` : ""),
            "the number of rows this would change is therefore unknown",
          ],
        })
        continue
      }
    }

    /* Rows carrying a non-zero numeric value get the stricter limit. So does "we could not
     * tell", because not knowing whether money is involved is not the same as knowing it is
     * not. */
    const valueBearing = valued !== 0
    const limit = valueBearing ? bc.maxValuedRows : bc.maxRows
    const why: string[] = []
    why.push(
      rows === 1
        ? "the pre-count says this statement would change 1 row"
        : `the pre-count says this statement would change ${rows} rows`,
    )
    if (valued > 0) {
      why.push(`${valued} of them hold a non-zero numeric value, so the stricter limit of ${limit} applies`)
    } else if (valued < 0) {
      why.push(`whether those rows hold numeric values could not be determined, so the stricter limit of ${limit} applies`)
    }

    const v: BlastVerdict = {
      decision: rows > limit ? "block" : "allow",
      bound: "counted",
      rows,
      valuedRows: valued,
      limit,
      verb: st.verb,
      fingerprint: fp,
      probeMs: Date.now() - t0,
      why,
    }
    if (v.decision === "block") {
      why.push(`the limit for a single unattended statement is ${limit}`)
    }
    worst = pickWorse(worst, v)
  }

  try {
    log?.debug?.("[blast] assessed", {
      statements: stmts.length,
      decision: worst?.decision,
      rows: worst?.rows,
      valued: worst?.valuedRows,
      ms: Date.now() - t0,
    })
  } catch {}

  return worst ?? NOTHING
}

const ORDER: Record<BlastDecision, number> = { none: 0, allow: 1, unknown: 2, block: 3 }

function pickWorse(a: BlastVerdict | undefined, b: BlastVerdict): BlastVerdict {
  if (!a) return b
  return ORDER[b.decision] > ORDER[a.decision] ? b : a
}

/* ────────────────────────────────────────────────────────────────────────────
 * §6  The message the agent reads
 *
 * It must do three things: say what was stopped, say WHY in numbers, and — this is the part
 * a safety message usually gets wrong — say clearly what IS still allowed, so the agent
 * finishes the legitimate work instead of concluding that touching data is forbidden.
 * ──────────────────────────────────────────────────────────────────────────── */

export function blastVetoText(v: BlastVerdict, repeats: number): string {
  const head =
    v.decision === "unknown"
      ? "⛔ BLOCKED — THE SIZE OF THIS CHANGE COULD NOT BE MEASURED"
      : "⛔ BLOCKED — TOO MANY ROWS AT ONCE"
  const answer =
    v.decision === "unknown"
      ? "That count could not be obtained."
      : v.rows >= 0
        ? `The answer was ${v.rows}.`
        : "The statement does not restrict which rows it hits at all."

  const lines = [
    head,
    "",
    "WHAT HAPPENED",
    `  Before letting a ${v.verb || "data-changing"} statement run, this host counted how many stored`,
    `  rows it would change. ${answer}`,
    "  No model was asked. This is arithmetic, not an opinion.",
    "",
    "WHY",
    ...v.why.map((w) => `  • ${w}`),
  ]
  if (repeats > 1) {
    lines.push(
      `  • this same change has now been stopped ${repeats} times in this project — the record of it`,
      "    is kept on disk, so starting a new session does not clear it",
    )
  }
  lines.push(
    "",
    "WHAT YOU CAN STILL DO — and you are expected to do it",
    "  • Change rows ONE AT A TIME, addressed by primary key. A statement whose WHERE names a",
    "    single key is allowed immediately, with no review and no delay. Several such statements",
    "    in a row are fine. This is the normal way to do a repair and it is not restricted.",
    "  • Read as much as you like. SELECT, counts, joins, exports: none of that is limited.",
    "  • If you truly need to change a whole category at once, that is a decision for the person",
    "    who owns the data. Report the exact rows and the exact count, and let them say yes.",
    "",
    "Do not treat this as a reason to stop working. The narrow, correct version of your change",
    "is available to you right now.",
  )
  return lines.join("\n")
}

/* ────────────────────────────────────────────────────────────────────────────
 * §7  The only thing a model is allowed to do about a deterministic block
 *
 * It may write the explanation and propose the narrower statement. It may NOT quietly let
 * the call through: the schema has no "approve" in it. The single lever it has is an explicit
 * `downgrade` flag that requires a specific named justification, is capped by row count
 * whatever it says, and is written to the durable ledger as a downgrade — an event a human
 * can go and count later. Silence, hedging or an empty justification leave the block standing.
 *
 * It is OFF by default, and that default is a measurement rather than a preference. The
 * literature we assembled (docs/EVIDENCE.md) puts weak validators under a 25% true-negative
 * rate, and our own board produced ZERO blocks across an entire project — including on a
 * category-wide mutation of live financial rows. A judge that never says no will also never
 * decline to downgrade, so handing it the key would simply restore the hole this gate closes.
 * The mechanism exists so that a deployment with a strong reviewer can use it.
 * ──────────────────────────────────────────────────────────────────────────── */

const DOWNGRADE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["explanation", "safer_rewrite", "downgrade", "downgrade_justification"],
  properties: {
    explanation: {
      type: "string",
      maxLength: 400,
      description:
        "Two sentences maximum, addressed to the agent, saying in plain language what this change would have hit and why its size is the problem. Do not moralise and do not repeat the numbers back.",
    },
    safer_rewrite: {
      type: "string",
      maxLength: 400,
      description:
        "One concrete narrower statement the agent can run right now instead — normally the same change addressed to a single row by its primary key. Must be runnable as written, or an empty string if you genuinely cannot propose one.",
    },
    downgrade: {
      type: "boolean",
      description:
        "Almost always false. true ONLY if you can name a specific, verifiable reason this particular wide change is correct and safe. You are not being asked whether the change looks reasonable — you are being asked to overrule a measurement. Uncertainty, plausibility and 'the user asked for it' are all false.",
    },
    downgrade_justification: {
      type: "string",
      maxLength: 300,
      description:
        "MANDATORY when downgrade is true: the specific named reason, referring to concrete facts about these rows. Hedging words ('may', 'might', 'probably', 'seems', 'likely', 'appears') make it invalid and the block stands. Empty string when downgrade is false.",
    },
  },
} as const

const HEDGE = /\b(?:may|might|probably|possibly|seems|likely|appears|perhaps|maybe|unclear|unknown|n\/?a|assume|presumably)\b/i

export type DowngradeAsk = {
  explanation: string
  saferRewrite: string
  downgraded: boolean
  justification: string
  model: string
  error: string
}

/**
 * `caller` is the plugin's single model funnel. `chain` is a reviewer chain from config.
 * Never throws; a failure just means the deterministic block stands with no extra prose.
 */
export async function askForDowngrade(
  caller: { call: (chain: string[], opts: any) => Promise<any> } | undefined,
  chain: string[],
  v: BlastVerdict,
  bc: BlastConfig,
  timeoutMs: number,
): Promise<DowngradeAsk> {
  const out: DowngradeAsk = { explanation: "", saferRewrite: "", downgraded: false, justification: "", model: "", error: "" }
  if (!caller || typeof caller.call !== "function" || !Array.isArray(chain) || !chain.length) {
    out.error = "no reviewer chain available"
    return out
  }
  const prompt = [
    "A data-changing statement was STOPPED by a measurement, not by an opinion.",
    "",
    `verb: ${v.verb}`,
    `rows it would have changed: ${v.rows >= 0 ? v.rows : "unrestricted / unmeasurable"}`,
    `rows among them holding a non-zero numeric value: ${v.valuedRows >= 0 ? v.valuedRows : "not determined"}`,
    `limit that applied: ${v.limit}`,
    `how the size was established: ${v.bound}`,
    "",
    "findings:",
    ...v.why.map((w) => `- ${w}`),
    "",
    "Your job is to write the explanation and propose the narrower statement.",
    "You cannot approve this call; there is no field for that. The only override is `downgrade`,",
    "and it requires a specific named justification about THESE rows.",
  ].join("\n")

  try {
    const res: any = await caller.call(chain, {
      system:
        "You are explaining a deterministic safety stop to a coding agent. Be brief, concrete and useful. " +
        "You are not the decision-maker here; a row count is. Overrule it only on a specific verifiable fact.",
      prompt,
      schema: DOWNGRADE_SCHEMA,
      timeoutMs: Math.max(5000, timeoutMs),
    })
    if (!res?.ok || !res?.value) {
      out.error = String(res?.error ?? "no structured answer")
      return out
    }
    const val: any = res.value
    out.model = String(res.model ?? "?")
    out.explanation = String(val.explanation ?? "").slice(0, 400)
    out.saferRewrite = String(val.safer_rewrite ?? "").slice(0, 400)
    const just = String(val.downgrade_justification ?? "").trim()
    const wants = val.downgrade === true
    /* every one of these has to hold; the default is that the block stands */
    if (
      wants &&
      bc.allowModelDowngrade &&
      just.length >= 60 &&
      !HEDGE.test(just) &&
      v.decision === "block" &&
      v.rows >= 0 &&
      v.rows <= bc.neverDowngradeAboveRows
    ) {
      out.downgraded = true
      out.justification = just
    } else if (wants) {
      out.justification = just
      out.error = !bc.allowModelDowngrade
        ? "a downgrade was requested but model downgrades are disabled"
        : v.rows > bc.neverDowngradeAboveRows
          ? `a downgrade was requested but ${v.rows} rows is above the hard ceiling of ${bc.neverDowngradeAboveRows}`
          : "a downgrade was requested without a specific enough justification"
    }
  } catch (e: any) {
    out.error = String(e?.message ?? e).slice(0, 200)
  }
  return out
}

/**
 * The cumulative version of the same idea.
 *
 * A per-statement limit alone is drip-feedable: refuse one statement that changes seventeen
 * rows and an agent can run seventeen statements that change one row each, arriving at the
 * identical outcome one keystroke at a time. So the rows actually allowed are added up over a
 * rolling window, per project, on disk — which also means the total does not reset when the
 * session does.
 */
export function budgetVetoText(used: number, want: number, bc: BlastConfig): string {
  const hours = Math.round(bc.windowMs / 3600_000) || 1
  return [
    "⛔ BLOCKED — TOO MANY ROWS CHANGED IN TOO SHORT A TIME",
    "",
    "WHAT HAPPENED",
    `  This project has already been allowed to change ${used} stored row(s) in the last`,
    `  ${hours} hour(s). This call would add ${want} more, past the limit of ${bc.maxRowsPerWindow}.`,
    "  The total is kept on disk against the project, so it does not reset when a session ends,",
    "  and changing rows one at a time adds up exactly the same as changing them all at once.",
    "",
    "WHY THERE IS A TOTAL AS WELL AS A PER-STATEMENT LIMIT",
    "  Otherwise the per-statement limit would only be a limit on typing. Seventeen statements",
    "  of one row each destroy exactly as much as one statement of seventeen rows.",
    "",
    "WHAT TO DO",
    "  • Stop and report: say which rows you have already changed and which you still believe",
    "    need changing. A person can approve the rest in one decision.",
    "  • Reading is not limited and never was.",
  ].join("\n")
}

/** Short note appended to an ALLOWED call, so the transcript records that a count happened. */
export function blastAllowNote(v: BlastVerdict): string {
  if (v.decision !== "allow") return ""
  if (v.bound === "static") return ""
  return (
    "\n────────── ✅ BLAST RADIUS CHECKED ──────────\n" +
    `counted before running: ${v.rows} row(s) affected, limit ${v.limit}. Allowed.\n` +
    "─────────────────────────────────────────────"
  )
}
