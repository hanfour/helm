import type { ProjectView } from '../projects/group.ts'
import { resolveTarget } from '../projects/resolve.ts'
import type { SessionState } from '../types.ts'

export interface TargetHit {
  project: ProjectView
  /** Set only when the user named one specific session, not a whole project. */
  session: SessionState | null
}

export type Writer = (message: string) => void

/**
 * Shared by every command that takes a target, so `helm brief`, `helm sessions`
 * and `helm open` cannot drift into three different answers to "which session
 * did you mean". Returns null after telling the user why.
 */
export function resolveOrReport(
  projects: readonly ProjectView[],
  query: string,
  write: Writer,
): TargetHit | null {
  const result = resolveTarget(projects, query)
  switch (result.kind) {
    case 'project':
      return { project: result.project, session: null }
    case 'session': {
      const owner = projects.find((p) => p.sessions.includes(result.session))
      // Every session reaching here came out of `projects`, so the owner is
      // always found; the guard exists so a future caller passing a detached
      // session gets a clear message instead of a crash.
      if (owner === undefined) {
        write(`session ${result.session.sessionId} 不屬於任何列出的專案。\n`)
        return null
      }
      return { project: owner, session: result.session }
    }
    case 'ambiguous':
      write(ambiguousMessage(query, result.candidates))
      return null
    case 'notfound':
      write(`找不到符合 "${query}" 的專案或 session。先跑 helm status 看看有哪些。\n`)
      return null
  }
}

/**
 * Guessing here would cost the user the one thing helm promises to protect —
 * their place in a piece of work — so the ambiguity is handed back with enough
 * information to answer it in one more keystroke.
 */
function ambiguousMessage(query: string, candidates: readonly string[]): string {
  const list = candidates.toSorted().map((c) => `  ${c}`).join('\n')
  return `"${query}" 同時符合多個目標：\n${list}\n打長一點就能分辨。\n`
}

/**
 * A project target means "the thing I was last doing here". Sessions arrive
 * sorted newest-first from grouping, so the head is that thing.
 */
export function chosenSession(hit: TargetHit): SessionState | null {
  return hit.session ?? hit.project.sessions[0] ?? null
}
