import { readdirSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { parseRolloutName } from './rollout-name.ts'

export interface RolloutFile {
  /** The file's own id, not the session's. See `rollout-name.ts`. */
  rolloutId: string
  path: string
  startedAt: number
  mtimeMs: number
}

/**
 * Every rollout under `~/.codex/sessions` that has been written to recently.
 *
 * Two limits keep this inside the 200 ms budget that `helm menu` polls
 * against every five seconds:
 *
 *   - It never reads file contents, only stats them. A rollout's first line
 *     alone is 8.6–18.6 KB, because it carries Codex's entire base
 *     instructions; reading 34 of them costs 25.7 ms. That work belongs in
 *     `meta.ts`, where a cache absorbs it.
 *   - It filters on mtime, not on the timestamp in the filename. A session
 *     opened three months ago may still be receiving writes today, and that
 *     is exactly the session most worth showing.
 *
 * The directory layout is Codex's (`YYYY/MM/DD/`), but nothing guarantees it,
 * so this walks whatever depth it finds rather than assuming three levels.
 */
export function scanRollouts(sessionsDir: string, sinceMs: number): RolloutFile[] {
  return scanRolloutsDetailed(sessionsDir, sinceMs).files
}

export interface ScanResult {
  files: RolloutFile[]
  /** Directories that exist but could not be read. Reported, not swallowed. */
  unreadable: string[]
}

export function scanRolloutsDetailed(sessionsDir: string, sinceMs: number): ScanResult {
  const unreadable: string[] = []
  const files = walk(sessionsDir, unreadable).flatMap((path) => {
    const parsed = parseRolloutName(baseName(path))
    if (parsed === null) return []
    const mtimeMs = mtimeOf(path)
    if (mtimeMs === null || mtimeMs < sinceMs) return []
    return [{ rolloutId: parsed.rolloutId, path, startedAt: parsed.startedAt, mtimeMs }]
  })
  return { files, unreadable }
}

function walk(dir: string, unreadable: string[]): string[] {
  return entries(dir, unreadable).flatMap((e) => {
    const path = join(dir, e.name)
    return e.isDirectory() ? walk(path, unreadable) : [path]
  })
}

/**
 * Missing and unreadable are not the same thing.
 *
 * Not having Codex installed is an ordinary state and must stay silent. A
 * directory that exists but cannot be read is a chunk of the board going
 * missing, and the user has to hear about it — swallowing both identically
 * is how `~/.codex` chmod 000 produced a half-empty board and a doctor
 * reporting 「皆可讀取」.
 */
function entries(dir: string, unreadable: string[]): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') unreadable.push(dir)
    return []
  }
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    // The file can vanish between readdir and stat; that is a normal race
    // with Codex writing, not something to surface.
    return null
  }
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
