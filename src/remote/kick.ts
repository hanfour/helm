import { readPrCache, shouldRefresh, type PrCache } from './cache.ts'
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

  // Probe the lock here rather than inside the child: spawning a process only
  // to have it exit immediately costs ~40 ms on a path that runs every five
  // seconds. Released straight away — the child takes its own.
  if (acquireRefreshLock(paths.lockFile, nowMs)) {
    releaseRefreshLock(paths.lockFile)
    try {
      spawn()
    } catch {
      // A refresh that could not be started is a stale PR row, nothing more.
      // The board still has everything else to draw.
    }
  }
  return cache
}
