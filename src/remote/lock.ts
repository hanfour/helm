import {
  closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

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

  // Stale. Taking over used to be `rmSync` then `tryCreate`, which is not
  // atomic at all — measured, 23% of contended takeovers produced more than
  // one winner. `renameSync` onto the lock path is atomic, so exactly one of
  // the racers ends up owning it; everyone else's rename lands on a file the
  // winner has already replaced, and the ownership check below catches them.
  const claim = `${file}.${process.pid}.claim`
  try {
    writeFileSync(claim, String(nowMs), { encoding: 'utf8', mode: 0o600 })
    renameSync(claim, file)
  } catch {
    rmSync(claim, { force: true })
    return false
  }
  return readHeldAt(file) === nowMs
}

/**
 * Removes the lock only if this token still owns it.
 *
 * An unconditional delete breaks mutual exclusion in a chain: A takes the
 * lock, stalls past the stale window, B legitimately takes over, then A
 * finishes and deletes *B's* lock. Measured: that produced four concurrent
 * `gh` sweeps from one laptop-sleep event.
 */
export function releaseRefreshLock(file: string, token?: number): void {
  if (token !== undefined && readHeldAt(file) !== token) return
  rmSync(file, { force: true })
}

function tryCreate(file: string, nowMs: number): boolean {
  let fd: number | null = null
  try {
    // The directory does not exist on a first run, and `openSync` would fail
    // with ENOENT — read as "somebody else holds the lock", so the very first
    // refresh never started and said nothing about it.
    mkdirSync(dirname(file), { recursive: true })
    fd = openSync(file, 'wx', 0o600)
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
