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

/**
 * Whether a verdict is too uncertain to be stated as a fact.
 *
 * `ended_clean` is borrowed by the Codex adapter to mean "helm has stopped
 * guessing" — justified by its effect on the desktop being to draw no dot at
 * all. But the menu bar and `helm sessions` print the word 「已結束」, which is
 * a claim helm has not earned. Every face that renders a label has to ask
 * this; putting it here is what stops the third one from forgetting.
 */
export function isUnearnedClaim(s: SessionState): boolean {
  return s.lifecycleConfidence === 'low' && statusOf(s) === 'ended'
}

/** What to say instead. */
export const UNEARNED_LABEL = '沒有動靜'
