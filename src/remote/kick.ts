import { readFileSync, writeFileSync } from 'node:fs'
import { PR_CACHE_TTL_MS, readPrCache, shouldRefresh, type PrCache } from './cache.ts'
import { acquireRefreshLock, releaseRefreshLock } from './lock.ts'
import type { RefreshPaths } from './refresh.ts'

/**
 * Reads the cache and, if it is stale, starts a refresh in the background.
 *
 * Never waits. The board runs every five seconds against a `gh` sweep that
 * takes seconds; the whole point of the cache is that the two never meet.
 * Whatever is on disk gets drawn — stale data with a timestamp beats a blank
 * space, and beats a frozen menu bar by a very long way.
 */
export function kickRefreshIfStale(
  paths: RefreshPaths,
  nowMs: number,
  spawn: () => void,
): PrCache | null {
  const cache = readPrCache(paths.cacheFile)
  if (!shouldRefresh(cache, nowMs)) return cache
  // The refresh cannot record its own attempt if the cache is unwritable, so
  // the throttle would never engage: measured at 12 `gh` sweeps a minute
  // against a 30/minute search quota, which locks the user out of `gh`
  // everywhere else. A separate marker survives that.
  if (!shouldAttempt(paths.lockFile, nowMs)) return cache

  // Probe the lock here rather than inside the child: spawning a process only
  // to have it exit immediately costs ~40 ms on a path that runs every five
  // seconds. Released straight away — the child takes its own.
  if (acquireRefreshLock(paths.lockFile, nowMs)) {
    markAttempt(paths.lockFile, nowMs)
    releaseRefreshLock(paths.lockFile, nowMs)
    try {
      spawn()
    } catch {
      // A refresh that could not be started is a stale PR row, nothing more.
      // The board still has everything else to draw.
    }
  }
  return cache
}

/**
 * Remembers when a refresh was last started, independently of whether it
 * managed to write anything.
 *
 * Lives next to the lock rather than in the cache precisely because the case
 * it guards is "the cache could not be written".
 */
function attemptFile(lockFile: string): string {
  return `${lockFile}.attempt`
}

function shouldAttempt(lockFile: string, nowMs: number): boolean {
  try {
    const last = Number(readFileSync(attemptFile(lockFile), 'utf8').trim())
    if (!Number.isFinite(last)) return true
    return Math.abs(nowMs - last) >= PR_CACHE_TTL_MS
  } catch {
    // Never attempted, or the marker is gone. Either way, go ahead.
    return true
  }
}

function markAttempt(lockFile: string, nowMs: number): void {
  try {
    writeFileSync(attemptFile(lockFile), String(nowMs), { encoding: 'utf8', mode: 0o600 })
  } catch {
    // Cannot record the attempt either. The lock still bounds concurrency;
    // this only costs the backoff.
  }
}
