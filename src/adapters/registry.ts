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
export interface AdapterResult {
  sessions: SessionState[]
  invalid: number
  /**
   * Set when the adapter knows it is handing back less than it should.
   *
   * Throwing is not enough on its own: an adapter that catches its own I/O
   * errors — which both of helm's do, deliberately, so one unreadable
   * directory cannot take the board down — never reaches the `catch` below.
   * Measured: with all three data directories chmod 000, `failures` was
   * still empty. Nothing could make it speak.
   */
  failure?: string
}

export interface Adapter {
  id: string
  collect: () => AdapterResult
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
      // Partial results still count — the adapter kept what it could reach.
      if (result.failure !== undefined) failures.push(`${adapter.id}：${result.failure}`)
    } catch (err) {
      failures.push(
        `${adapter.id} 這個來源讀不到：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return { sessions, invalid, failures }
}
