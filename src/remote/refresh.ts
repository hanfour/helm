import { acquireRefreshLock, releaseRefreshLock } from './lock.ts'
import { writePrCache, type CachedPr } from './cache.ts'
import { prDetail, searchMyPrs, type GhExec } from './gh.ts'
import { unknownWaiting, waitingOn } from './waiting.ts'

export interface RefreshPaths {
  cacheFile: string
  lockFile: string
}

/**
 * The entire slow path: ask `gh`, decide who each PR waits on, write the
 * cache. Runs in a detached background process — never on the board's own
 * path, where a multi-second network call has no business being.
 *
 * Returns whether it ran. `false` means somebody else already is.
 */
export function refreshPrs(
  paths: RefreshPaths,
  exec: GhExec,
  nowMs: number,
  opts: { keepLock?: boolean } = {},
): boolean {
  if (!acquireRefreshLock(paths.lockFile, nowMs)) return false

  try {
    const listing = searchMyPrs(exec)
    if (listing.kind === 'degraded') {
      // Cached with the same TTL as real data, so a `gh` that is not logged
      // in gets asked once a minute instead of on every five-second poll.
      writePrCache(paths.cacheFile, { fetchedAt: nowMs, prs: [], degraded: listing.reason })
      return true
    }

    const prs: CachedPr[] = listing.prs.map((pr) => {
      const detail = prDetail(pr.repo, pr.number, exec)
      // One unreachable PR must not delete the others — but it must not be
      // dressed up as a verdict either. Falling back to 「等人審」claimed the
      // ball was with the reviewer when it might be with the user.
      const waiting = detail.kind === 'ok'
        ? waitingOn({
          isDraft: pr.isDraft,
          reviewDecision: detail.detail.reviewDecision,
          checks: detail.detail.checks,
        })
        : unknownWaiting()
      return { ...pr, waiting: waiting.kind, waitingLabel: waiting.label }
    })

    writePrCache(paths.cacheFile, { fetchedAt: nowMs, prs, degraded: null })
    return true
  } catch {
    // Whatever went wrong, the lock must come off — a held lock with no
    // holder freezes PR state for five minutes while everything looks fine.
    return true
  } finally {
    if (opts.keepLock !== true) releaseRefreshLock(paths.lockFile, nowMs)
  }
}
