/**
 * lib/guardstate.ts — guard memory that outlives a session.
 *
 * ─── THE DEFECT THIS FIXES ───────────────────────────────────────────────────
 * Every counter the guard kept — reviews spent, vetoes issued, whether the board had
 * self-demoted — lived in a Map keyed by session id, inside one process. That is a door.
 * An agent that is blocked, or that exhausts the review budget, only has to begin a new
 * session: the key changes, the counters are zero again, and the action that was refused a
 * minute ago is now merely "the first risky call of a fresh session". We watched exactly
 * that happen, and the destructive statement went through on the second attempt.
 *
 * A limit that resets when the party being limited asks for it is not a limit.
 *
 * ─── WHAT IT IS KEYED TO INSTEAD ─────────────────────────────────────────────
 * The PROJECT, not the conversation: host name plus the working tree the agent was pointed
 * at. That is the thing a blast radius is actually a property of — the same rows are on the
 * other side of the same statement whether it is attempt one or attempt five, and whether it
 * is one session or three. It is written to disk, so it also survives the process dying.
 *
 * Two things are recorded:
 *   • a BLOCK LEDGER, keyed by the fingerprint of the attempted change, so a repeat of a
 *     refused action is recognised as a repeat however it arrives;
 *   • the review-budget counters, so a new session inherits what the last one spent.
 *
 * Every function swallows its own errors. A guard that crashes the agent when its state file
 * is unreadable has made things worse, so the failure mode is "no memory", never "no agent".
 * The state file itself sits inside the protected state directory, which triage refuses to
 * let a tool write to — otherwise the ledger would be the first thing an agent deletes.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from "node:fs"
import { hostname } from "node:os"

export type Counters = { reviews: number; vetoes: number; ms: number; demoted: boolean }

export type BlockRecord = {
  count: number
  firstAt: number
  lastAt: number
  verb: string
  rows: number
  reason: string
}

type ScopeState = {
  counters: Counters
  blocks: Record<string, BlockRecord>
  /** rows this project has been allowed to change, with timestamps — see rowsInWindow() */
  mutations: Array<{ at: number; rows: number }>
  downgrades: number
  updatedAt: number
}

type FileShape = { version: 1; scopes: Record<string, ScopeState> }

export type GuardState = {
  /** the durable key: identifies the project, not the conversation */
  scope: string
  scopeLabel: string
  counters(): Counters
  saveCounters(c: Counters): void
  /** record a deterministic block; returns how many times this exact change has been stopped */
  noteBlock(fingerprint: string, meta: { verb: string; rows: number; reason: string }): number
  blocksFor(fingerprint: string): number
  /** a model talked a deterministic block down — this is never silent */
  noteDowngrade(fingerprint: string, justification: string, model: string): void
  /** rows this project has been allowed to change in the last `windowMs` */
  rowsInWindow(windowMs: number): number
  /** record rows we are about to allow */
  noteRows(rows: number): void
  totals(): { blocks: number; distinct: number; downgrades: number }
}

function nowMs(): number {
  try {
    return Date.now()
  } catch {
    return 0
  }
}

function h32(s: string): string {
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

function emptyScope(): ScopeState {
  return {
    counters: { reviews: 0, vetoes: 0, ms: 0, demoted: false },
    blocks: {},
    mutations: [],
    downgrades: 0,
    updatedAt: nowMs(),
  }
}

export function makeGuardState(cfg: any, log?: any): GuardState {
  let dir = ""
  try {
    const p = cfg?.paths?.stateDir
    dir = typeof p === "string" && p ? p : ""
  } catch {}
  if (!dir) {
    const home = (typeof process !== "undefined" && process?.env?.HOME) || "/tmp"
    dir = `${home}/.local/state/ocrev`
  }
  const file = `${dir}/guard-state.json`
  const ledger = `${dir}/guard-ledger.jsonl`

  let host = "host"
  try {
    host = String(hostname() || "host")
  } catch {}
  let tree = ""
  try {
    tree = String(cfg?.worktree || cfg?.directory || "")
  } catch {}
  if (!tree) {
    try {
      tree = String(process?.cwd?.() ?? "")
    } catch {}
  }
  const scopeLabel = `${host}:${tree || "-"}`
  const scope = h32(scopeLabel)

  const ensureDir = (): void => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    } catch {}
  }

  const readAll = (): FileShape => {
    try {
      const raw = readFileSync(file, "utf8")
      const j = JSON.parse(raw)
      if (j && typeof j === "object" && j.scopes && typeof j.scopes === "object") return j as FileShape
    } catch {}
    return { version: 1, scopes: {} }
  }

  const writeAll = (data: FileShape): void => {
    try {
      ensureDir()
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
      renameSync(tmp, file)
    } catch (e: any) {
      try {
        log?.warn?.(`[guardstate] could not persist guard memory (${String(e?.message ?? e).slice(0, 120)}) — the guard still works, but it forgets between sessions`)
      } catch {}
    }
  }

  const mutate = (fn: (s: ScopeState) => void): ScopeState => {
    const all = readAll()
    const s = all.scopes[scope] ?? emptyScope()
    try {
      fn(s)
    } catch {}
    s.updatedAt = nowMs()
    all.scopes[scope] = s
    /* keep the file from growing without bound across many projects */
    try {
      const keys = Object.keys(all.scopes)
      if (keys.length > 64) {
        keys
          .sort((a, b) => (all.scopes[a]?.updatedAt ?? 0) - (all.scopes[b]?.updatedAt ?? 0))
          .slice(0, keys.length - 64)
          .forEach((k) => {
            if (k !== scope) delete all.scopes[k]
          })
      }
    } catch {}
    writeAll(all)
    return s
  }

  const append = (rec: Record<string, unknown>): void => {
    try {
      ensureDir()
      appendFileSync(ledger, JSON.stringify({ ts: new Date().toISOString(), scope, scopeLabel, ...rec }) + "\n", { mode: 0o600 })
    } catch {}
  }

  return {
    scope,
    scopeLabel,

    counters(): Counters {
      try {
        const s = readAll().scopes[scope]
        if (s?.counters) {
          return {
            reviews: Number(s.counters.reviews) || 0,
            vetoes: Number(s.counters.vetoes) || 0,
            ms: Number(s.counters.ms) || 0,
            demoted: s.counters.demoted === true,
          }
        }
      } catch {}
      return { reviews: 0, vetoes: 0, ms: 0, demoted: false }
    },

    saveCounters(c: Counters): void {
      mutate((s) => {
        s.counters = {
          reviews: Number(c?.reviews) || 0,
          vetoes: Number(c?.vetoes) || 0,
          ms: Number(c?.ms) || 0,
          demoted: c?.demoted === true,
        }
      })
    },

    noteBlock(fingerprint: string, meta: { verb: string; rows: number; reason: string }): number {
      const fp = String(fingerprint || "-")
      let count = 1
      mutate((s) => {
        const prev = s.blocks[fp]
        count = (prev?.count ?? 0) + 1
        s.blocks[fp] = {
          count,
          firstAt: prev?.firstAt ?? nowMs(),
          lastAt: nowMs(),
          verb: String(meta?.verb ?? ""),
          rows: Number(meta?.rows ?? -1),
          reason: String(meta?.reason ?? "").slice(0, 300),
        }
        /* bound the ledger inside one project too */
        const keys = Object.keys(s.blocks)
        if (keys.length > 500) {
          keys
            .sort((a, b) => (s.blocks[a]?.lastAt ?? 0) - (s.blocks[b]?.lastAt ?? 0))
            .slice(0, keys.length - 500)
            .forEach((k) => delete s.blocks[k])
        }
      })
      append({ event: "block", fingerprint: fp, repeat: count, ...meta })
      return count
    },

    blocksFor(fingerprint: string): number {
      try {
        return Number(readAll().scopes[scope]?.blocks?.[String(fingerprint || "-")]?.count) || 0
      } catch {
        return 0
      }
    },

    noteDowngrade(fingerprint: string, justification: string, model: string): void {
      mutate((s) => {
        s.downgrades = (Number(s.downgrades) || 0) + 1
      })
      append({
        event: "downgrade",
        fingerprint: String(fingerprint || "-"),
        model: String(model || "?"),
        justification: String(justification || "").slice(0, 500),
      })
      try {
        log?.warn?.("[guardstate] a deterministic block was DOWNGRADED by a model", {
          fingerprint,
          model,
          justification: String(justification || "").slice(0, 200),
        })
      } catch {}
    },

    /**
     * A per-statement limit alone can be drip-fed: seventeen statements of one row each add
     * up to the same seventeen rows the wide statement was refused for. So the rows a project
     * has actually been allowed to change are added up over a rolling window, and that total
     * is subject to a limit of its own. Same reasoning as the per-statement cap, applied to
     * the sum instead of the term.
     */
    rowsInWindow(windowMs: number): number {
      try {
        const w = Number(windowMs) > 0 ? Number(windowMs) : 3600_000
        const cutoff = nowMs() - w
        const list = readAll().scopes[scope]?.mutations ?? []
        let total = 0
        for (const m of list) if (Number(m?.at) >= cutoff) total += Number(m?.rows) || 0
        return total
      } catch {
        return 0
      }
    },

    noteRows(rows: number): void {
      const r = Number(rows)
      if (!Number.isFinite(r) || r <= 0) return
      mutate((s) => {
        if (!Array.isArray(s.mutations)) s.mutations = []
        s.mutations.push({ at: nowMs(), rows: r })
        if (s.mutations.length > 400) s.mutations = s.mutations.slice(-400)
      })
    },

    totals(): { blocks: number; distinct: number; downgrades: number } {
      try {
        const s = readAll().scopes[scope]
        if (!s) return { blocks: 0, distinct: 0, downgrades: 0 }
        const vals = Object.values(s.blocks ?? {})
        return {
          blocks: vals.reduce((n, b) => n + (Number(b?.count) || 0), 0),
          distinct: vals.length,
          downgrades: Number(s.downgrades) || 0,
        }
      } catch {
        return { blocks: 0, distinct: 0, downgrades: 0 }
      }
    },
  }
}
