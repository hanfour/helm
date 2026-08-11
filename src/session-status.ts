import type { SessionState } from './types.ts'

export type StatusKey = 'busy' | 'idle' | 'ended' | 'crashed'

/** Spec 11.1. A crashed session is crashed regardless of what the registry claimed. */
export function statusOf(s: SessionState): StatusKey {
  if (s.lifecycle === 'crashed') return 'crashed'
  if (s.lifecycle === 'ended_clean') return 'ended'
  return s.nativeStatus === 'busy' ? 'busy' : 'idle'
}

/**
 * Severity order for rolling several sessions up into one project row. A
 * project with anything abandoned must read as abandoned even when a dozen
 * healthy sessions sit beside it — the whole point of the board is that
 * nothing gets forgotten.
 */
const PRIORITY: readonly StatusKey[] = ['crashed', 'busy', 'idle']

/** Null means every session here has ended: no dot at all, not a grey one. */
export function aggregateStatus(sessions: readonly SessionState[]): StatusKey | null {
  const keys = new Set(sessions.map(statusOf))
  return PRIORITY.find((k) => keys.has(k)) ?? null
}
