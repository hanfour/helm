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
/**
 * How long a whole sweep may take before it settles for what it has.
 *
 * Each `gh pr view` gets a 30 s timeout and `--limit 50` allows 51 calls, so
 * the worst case is 25 minutes — five times the lock's stale window. On a bad
 * network that means a new process takes over every five minutes while the
 * previous ones are all still running; measured, six at once. Stopping short
 * of the stale window keeps that impossible.
 */
const SWEEP_BUDGET_MS = 4 * 60_000

export function refreshPrs(
  paths: RefreshPaths,
  exec: GhExec,
  nowMs: number,
  opts: { keepLock?: boolean; clock?: () => number } = {},
): boolean {
  const clock = opts.clock ?? Date.now
  // Measured against the sweep's own start, not the caller's `nowMs` — the
  // latter can be any timestamp the caller chose.
  const startedAt = clock()
  if (!acquireRefreshLock(paths.lockFile, nowMs)) return false

  try {
    const listing = searchMyPrs(exec)
    if (listing.kind === 'degraded') {
      // Cached with the same TTL as real data, so a `gh` that is not logged
      // in gets asked once a minute instead of on every five-second poll.
      writePrCache(paths.cacheFile, { fetchedAt: clock(), prs: [], degraded: listing.reason })
      return true
    }

    const prs: CachedPr[] = []
    let ranOut = false
    for (const pr of listing.prs) {
      if (clock() - startedAt > SWEEP_BUDGET_MS) {
        ranOut = true
        break
      }
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
      prs.push({ ...pr, waiting: waiting.kind, waitingLabel: waiting.label })
    }

    writePrCache(paths.cacheFile, {
      // The moment the answer landed, not the moment the sweep began — a
      // 36-second sweep would otherwise eat more than half the 60-second TTL
      // and `gh` would be asked 2.5× as often as the documentation claims.
      fetchedAt: clock(),
      prs,
      degraded: ranOut
        ? `PR 太多，這次只更新了 ${prs.length}/${listing.prs.length} 個，其餘下次補上。`
        : null,
    })
    return true
  } catch {
    // Whatever went wrong, the lock must come off — a held lock with no
    // holder freezes PR state for five minutes while everything looks fine.
    return true
  } finally {
    if (opts.keepLock !== true) releaseRefreshLock(paths.lockFile, nowMs)
  }
}
