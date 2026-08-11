import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

export interface Brief {
  goal: string
  done: string[]
  currentStep: string
  nextStep: string
  blockers: string[]
  files: string[]
  prs: string[]
}

export interface BriefEntry {
  /** `<byteSize>:<mtimeMs>` of the transcript when this brief was made. */
  digest: string
  generatedAt: number
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
})

const CacheSchema = z.object({
  version: z.literal(1),
  briefs: z.record(z.string(), z.object({
    digest: z.string().min(1),
    generatedAt: z.number(),
    body: BriefSchema,
  })).default({}),
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
  if (parsed.success) return parsed.data
  quarantine(cacheFile)
  return EMPTY_CACHE
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

export function writeCache(cacheFile: string, cache: CacheShape): void {
  mkdirSync(dirname(cacheFile), { recursive: true })
  writeFileSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
}

export function setBrief(cache: CacheShape, sessionId: string, entry: BriefEntry): CacheShape {
  return { ...cache, briefs: { ...cache.briefs, [sessionId]: entry } }
}

/** Returns the cached brief only when it still matches the transcript. */
export function getFreshBrief(
  cache: CacheShape,
  sessionId: string,
  digest: string | null,
): Brief | null {
  if (digest === null) return null
  const entry = cache.briefs[sessionId]
  return entry !== undefined && entry.digest === digest ? entry.body : null
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
