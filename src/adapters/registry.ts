import type { SessionState } from '../types.ts'

/**
 * One agent CLI's contribution to the board.
 *
 * Adapters return reconciled `SessionState`, not raw discoveries: what
 * "running" means differs per CLI — Claude Code cross-checks a PID registry
 * against `ps`, Codex has neither and infers from a process table and an
 * mtime — and pretending one reconcile pass fits both would put CLI-specific
 * branching into the core, which spec §5.1 rules out.
 */
export interface Adapter {
  id: string
  collect: () => { sessions: SessionState[]; invalid: number }
}

export interface CollectResult {
  sessions: SessionState[]
  invalid: number
  /** One line per adapter that threw, for the board to show. */
  failures: string[]
}

/**
 * Runs every adapter, isolating each one.
 *
 * The isolation is the point. These are independent data sources, and P3's
 * installer taught this the hard way: two unrelated integrations sharing one
 * try block meant a read-only SwiftBar folder left the Übersicht widget
 * uninstalled. An unreadable ~/.codex must not cost the user their Claude
 * Code board, and vice versa — but the loss has to be *said*, not swallowed.
 */
export function collectFromAdapters(adapters: readonly Adapter[]): CollectResult {
  const sessions: SessionState[] = []
  const failures: string[] = []
  let invalid = 0

  for (const adapter of adapters) {
    try {
      const result = adapter.collect()
      sessions.push(...result.sessions)
      invalid += result.invalid
    } catch (err) {
      failures.push(
        `${adapter.id} 這個來源讀不到：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return { sessions, invalid, failures }
}
