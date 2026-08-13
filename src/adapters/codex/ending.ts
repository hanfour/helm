import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import type { CodexEnding } from '../../reconcile/lifecycle.ts'

/**
 * Event types that mean the turn ended rather than was cut off.
 *
 * `turn_aborted` is here with `task_complete` on purpose: the user pressing
 * Esc is a session that stopped on purpose, not one with an unrecovered
 * breakpoint. Both answer the only question the lifecycle asks — was this log
 * still mid-turn when it stopped?
 */
const FINISHED = new Set(['task_complete', 'turn_aborted'])

/** Enough for almost every event; grown rather than guessed when it is not. */
const TAIL_BYTES = 8192
const MAX_TAIL_BYTES = 512 * 1024

/**
 * How a rollout's log ends, from its last complete line.
 *
 * Spec §6 used to record that Codex writes no termination event, so lifecycle
 * fell back to a timer: no process plus thirty minutes of silence meant
 * 「已中斷」. Measured 2026-08-13 across this machine's 194 rollouts, that
 * premise is wrong — 192 of them end on `task_complete` or `turn_aborted`,
 * and only 2 stop mid-turn. The timer was calling finished work abandoned.
 *
 * **Only the last line is consulted.** Scanning back a few lines would let a
 * session that completed one turn and then died during the next report itself
 * as finished, and it buys nothing: the completion event is the final line in
 * 192 of the 194 files here, and absent entirely in the other two.
 */
export function readEnding(path: string): CodexEnding {
  const line = lastLine(path)
  if (line === null) return 'unknown'

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    // A rollout being appended to right now has a torn last line. Claiming
    // either verdict from a fragment would be inventing one.
    return 'unknown'
  }
  if (!isRecord(parsed)) return 'unknown'

  const payload = parsed['payload']
  const type = isRecord(payload) ? payload['type'] : undefined
  return typeof type === 'string' && FINISHED.has(type) ? 'finished' : 'midflight'
}

/**
 * The last complete line, read from the end of the file.
 *
 * The window has to contain a newline before the final line for that line to
 * be known-complete, so it doubles until one appears. A single event carrying
 * a large tool output runs past 8 KB often enough that a fixed window would
 * report those sessions as mid-turn — a guess dressed as a fact, in the one
 * direction that puts a red dot on the board.
 */
function lastLine(path: string): string | null {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const size = fstatSync(fd).size
    if (size === 0) return null
    for (let want = TAIL_BYTES; ; want *= 2) {
      const len = Math.min(want, size)
      const buf = Buffer.allocUnsafe(len)
      readSync(fd, buf, 0, len, size - len)
      const text = buf.toString('utf8')
      const lines = text.split('\n').filter((l) => l.trim() !== '')
      const last = lines.at(-1)
      if (last === undefined) return null
      // Reading the whole file, or seeing a newline ahead of the final line,
      // both prove that line was not truncated by the window itself.
      if (len === size || lines.length > 1) return last
      if (len >= MAX_TAIL_BYTES) return null
    }
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
