import { openSync, closeSync, readFileSync, rmSync, writeSync } from 'node:fs'

/**
 * How long a refresh may hold the lock before it is assumed dead.
 *
 * A `gh` sweep takes a couple of seconds; five minutes is far beyond that.
 * The bound exists because the holder can vanish without releasing — killed,
 * or the machine slept mid-request — and a lock file with no expiry would
 * then freeze PR state for ever while looking perfectly healthy.
 */
const LOCK_STALE_MS = 5 * 60_000

/**
 * Ensures only one refresh runs at a time.
 *
 * Without it the board forks a `gh` sweep on every poll: five-second refresh
 * against a multi-second fetch means a dozen processes racing to do the same
 * work, each one making the machine slower and none of them finishing sooner.
 *
 * `wx` gives the atomicity — the file is created only if it does not already
 * exist, and that check-and-create is one syscall.
 */
export function acquireRefreshLock(file: string, nowMs: number): boolean {
  if (tryCreate(file, nowMs)) return true

  // Someone holds it. The only question left is whether they are still alive.
  const heldAt = readHeldAt(file)
  if (heldAt !== null && Math.abs(nowMs - heldAt) < LOCK_STALE_MS) return false

  // Stale, unreadable, or dated in the future: take it over. Removing first
  // keeps the create atomic, so two processes arriving together still produce
  // exactly one winner.
  rmSync(file, { force: true })
  return tryCreate(file, nowMs)
}

export function releaseRefreshLock(file: string): void {
  rmSync(file, { force: true })
}

function tryCreate(file: string, nowMs: number): boolean {
  let fd: number | null = null
  try {
    fd = openSync(file, 'wx')
    writeSync(fd, String(nowMs))
    return true
  } catch {
    // EEXIST in the normal case; a read-only directory otherwise. Either way
    // this process is not the one that gets to refresh.
    return false
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function readHeldAt(file: string): number | null {
  try {
    const value = Number(readFileSync(file, 'utf8').trim())
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}
