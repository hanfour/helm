import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { TASK_STATUSES, type TaskStatus } from '../task-status.ts'

export interface Brief {
  goal: string
  done: string[]
  currentStep: string
  nextStep: string
  blockers: string[]
  files: string[]
  prs: string[]
  /**
   * 選用：舊快取沒有這個欄位，模型回傳非法值時也會是 undefined。
   * 兩種情況都代表未知，呈現面一律不顯示。
   */
  taskStatus?: TaskStatus | undefined
}

export interface BriefEntry {
  /** `<byteSize>:<mtimeMs>` of the transcript when this brief was made. */
  digest: string
  generatedAt: number
  /**
   * Stored alongside the brief so a cache hit needs nothing but this entry.
   * Without it the caller has to parse the whole transcript just to recover
   * one string for the header — on the path that exists to avoid exactly that.
   */
  gitBranch: string | null
  body: Brief
}

export interface CacheShape {
  version: 1
  briefs: Record<string, BriefEntry>
  prs: Record<string, unknown>
  projects: Record<string, { name: string; gitRemote: string | null }>
}

export const EMPTY_CACHE: CacheShape = { version: 1, briefs: {}, prs: {}, projects: {} }

const BriefSchema = z.object({
  goal: z.string().default(''),
  done: z.array(z.string()).default([]),
  currentStep: z.string().default(''),
  nextStep: z.string().default(''),
  blockers: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  prs: z.array(z.string()).default([]),
  taskStatus: z.enum(TASK_STATUSES).optional().catch(undefined),
})

const BriefEntrySchema = z.object({
  digest: z.string().min(1),
  generatedAt: z.number(),
  // Defaulted rather than required: caches written before this field existed
  // are still perfectly good briefs and must not be thrown away.
  gitBranch: z.string().nullable().default(null),
  body: BriefSchema,
})

const CacheSchema = z.object({
  version: z.literal(1),
  // Each entry is validated separately below. A record-wide schema would fail
  // the whole file over one bad value, and every value here cost 57-86 s of
  // LLM time — this is the most expensive data helm holds and it had the most
  // brittle parse.
  briefs: z.record(z.string(), z.unknown()).default({}),
  prs: z.record(z.string(), z.unknown()).default({}),
  projects: z.record(z.string(), z.object({
    name: z.string().default(''),
    gitRemote: z.string().nullable().default(null),
  })).default({}),
})

/**
 * Everything here is derived and rebuildable. A corrupt cache must never
 * stop the CLI — it is moved aside for inspection and treated as empty.
 */
export function readCache(cacheFile: string): CacheShape {
  let raw: string
  try {
    raw = readFileSync(cacheFile, 'utf8')
  } catch {
    // Degrade, don't throw: no cache file simply means nothing has been
    // cached yet, which is the normal state on first run.
    return EMPTY_CACHE
  }
  const parsed = CacheSchema.safeParse(safeJson(raw))
  if (!parsed.success) {
    // The file as a whole is unusable — truncated, wrong version, not an
    // object. Nothing here can be salvaged per entry, so preserve it for
    // inspection and start over.
    quarantine(cacheFile)
    return EMPTY_CACHE
  }
  return { ...parsed.data, briefs: parseBriefs(parsed.data.briefs) }
}

/** Drops only the entries that fail; a bad neighbour costs nothing. */
function parseBriefs(raw: Record<string, unknown>): Record<string, BriefEntry> {
  return Object.fromEntries(
    Object.entries(raw).flatMap(([id, value]) => {
      const entry = BriefEntrySchema.safeParse(value)
      return entry.success ? [[id, entry.data] as const] : []
    }),
  )
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    // Degrade to null so the caller can quarantine and rebuild. The cache is
    // pure derived data — a truncated write (crash mid-save) must cost the
    // user a regenerated brief, never a CLI that refuses to start.
    return null
  }
}

function quarantine(cacheFile: string): void {
  try {
    renameSync(cacheFile, cacheFile.replace(/\.json$/, '.corrupt.json'))
  } catch {
    // Nothing more we can do; the caller still gets a usable empty cache.
  }
}

/**
 * Write to a sibling then rename. `writeFileSync` truncates in place, so a
 * crash mid-write leaves a half-written file — which the reader would then
 * quarantine, taking every cached brief with it. Rename is atomic within a
 * filesystem, so a reader sees either the old file or the new one.
 */
export function writeCache(cacheFile: string, cache: CacheShape): void {
  mkdirSync(dirname(cacheFile), { recursive: true })
  const temp = `${cacheFile}.${process.pid}.tmp`
  // 0600, like every other file helm puts in ~/.helm: this one holds briefs —
  // goals, blockers and absolute paths into whatever the user was working on —
  // and ~/.helm is world-readable. It was the oldest of these caches and the
  // only one the 0644 sweep missed.
  writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, cacheFile)
}

export function setBrief(cache: CacheShape, sessionId: string, entry: BriefEntry): CacheShape {
  return { ...cache, briefs: { ...cache.briefs, [sessionId]: entry } }
}

/**
 * Returns the whole cached entry, not just the brief, so callers can report
 * when it was actually generated. Showing the current time on a cache hit
 * would tell the user a two-day-old brief was written seconds ago.
 */
export function getFreshBriefEntry(
  cache: CacheShape,
  sessionId: string,
  digest: string | null,
): BriefEntry | null {
  if (digest === null) return null
  const entry = cache.briefs[sessionId]
  return entry !== undefined && entry.digest === digest ? entry : null
}

/** Size plus mtime is enough: an append always changes size, an edit changes mtime. */
export function digestOf(transcriptPath: string | null): string | null {
  if (transcriptPath === null) return null
  try {
    const s = statSync(transcriptPath)
    return `${s.size}:${s.mtimeMs}`
  } catch {
    // Degrade to null, which getFreshBrief treats as "cannot confirm
    // freshness" and therefore never serves a cached brief. Failing closed
    // costs one regeneration; failing open would show a stale brief.
    return null
  }
}
