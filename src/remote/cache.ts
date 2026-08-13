import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { WaitingKind } from './waiting.ts'

/** One pull request as the board draws it. */
export interface CachedPr {
  repo: string
  number: number
  title: string
  url: string
  isDraft: boolean
  updatedAt: string
  waiting: WaitingKind
  waitingLabel: string
}

export interface PrCache {
  fetchedAt: number
  prs: CachedPr[]
  /**
   * Why this is not real data, if it is not. Cached alongside the result so a
   * `gh` that is not logged in is asked once a minute rather than every five
   * seconds — and so the board can keep saying what is wrong.
   */
  degraded: string | null
}

/** Spec §10. Long enough that PR state is never on the refresh path. */
export const PR_CACHE_TTL_MS = 60_000

/**
 * Whether the slow path should run again.
 *
 * Being stale is not the same as being unusable: the caller draws whatever is
 * in the cache either way and only uses this to decide whether to kick off a
 * refresh in the background (stale-while-revalidate, spec §10).
 */
export function shouldRefresh(cache: PrCache | null, nowMs: number): boolean {
  if (cache === null) return true
  // `Math.abs` because a clock moved backwards, or a cache written by another
  // machine, would otherwise park the entry in the future and never refresh.
  return Math.abs(nowMs - cache.fetchedAt) >= PR_CACHE_TTL_MS
}

export function readPrCache(file: string): PrCache | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // Absent on first run; corrupt is no worse, since every field is
    // re-derivable from `gh` on the next refresh.
    return null
  }
  if (!isRecord(parsed)) return null

  const { fetchedAt, prs, degraded } = parsed
  if (typeof fetchedAt !== 'number' || !Array.isArray(prs)) return null
  return {
    fetchedAt,
    prs: prs.flatMap(toCachedPr),
    degraded: typeof degraded === 'string' ? degraded : null,
  }
}

/** Returns whether it landed. A silent failure here becomes a `gh` loop. */
export function writePrCache(file: string, cache: PrCache): boolean {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  try {
    // 0600, like the settings backup next door: this file carries private
    // repository names and PR titles, and ~/.helm is world-readable.
    writeFileSync(temp, `${JSON.stringify(cache)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
    return true
  } catch {
    // Losing the cache costs one extra `gh` call. Taking the board down over
    // it would be a far worse trade — but the caller has to know, because the
    // TTL that stops helm asking `gh` every five seconds lives in this file.
    rmSync(temp, { force: true })
    return false
  }
}

function toCachedPr(item: unknown): CachedPr[] {
  if (!isRecord(item)) return []
  const { repo, number, title, url, isDraft, updatedAt, waiting, waitingLabel } = item
  if (typeof repo !== 'string' || typeof number !== 'number') return []
  if (typeof waiting !== 'string' || typeof waitingLabel !== 'string') return []
  return [{
    repo,
    number,
    title: typeof title === 'string' ? title : '',
    url: typeof url === 'string' ? url : '',
    isDraft: isDraft === true,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
    waiting: waiting as WaitingKind,
    waitingLabel,
  }]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
