/**
 * A Codex rollout filename:
 *
 *   rollout-2026-08-03T14-25-24-019fc64c-6b8a-7882-8c7b-c019bd18484c.jsonl
 *           └────── started ─────┘ └────── this file's own id ────────┘
 *
 * That uuid is **not** the session id, however much it looks like one.
 * Measured across all 192 rollouts on this machine: 106 of them carry a
 * different id in their own `session_meta`, because one Codex session spans
 * several rollout files as it continues and forks — the largest here has 33.
 * Grouping by filename would draw that session as 33 separate rows.
 *
 * So this is the cache key and the sort key, nothing more. The session id
 * lives in the first line; see `meta.ts`.
 */
export interface RolloutName {
  /** Identifies the file, not the session. */
  rolloutId: string
  startedAt: number
}

const PATTERN =
  /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/

export function parseRolloutName(name: string): RolloutName | null {
  const m = PATTERN.exec(name)
  if (m === null) return null
  const [, y, mo, d, h, mi, s, rolloutId] = m

  // Local time, not UTC. Measured 2026-08-12: a file named `T14-25-24` has
  // `2026-08-03T06:25:24.937Z` in its own session_meta — eight hours apart,
  // this machine's offset. Reading it as UTC would skew every timestamp on the
  // board by a whole timezone.
  const started = new Date(
    Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s),
  )

  // `new Date(2026, 12, …)` rolls over into the next year rather than failing,
  // so the only way to reject an impossible *date* is to ask what came back.
  //
  // The time-of-day is deliberately not checked. On the spring-forward day
  // 02:30 does not exist locally and rolls to 03:30 — rejecting that dropped
  // the rollout from the scan entirely, uncounted and unmentioned. Being an
  // hour off is not in the same league as a session vanishing from the board,
  // and `startedAt` is only ever used for ordering.
  if (
    Number.isNaN(started.getTime())
    || started.getFullYear() !== Number(y)
    || started.getMonth() !== Number(mo) - 1
    || started.getDate() !== Number(d)
  ) {
    return null
  }

  return { rolloutId: rolloutId as string, startedAt: started.getTime() }
}
