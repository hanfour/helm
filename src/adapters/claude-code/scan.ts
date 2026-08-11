import { readdirSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

export interface TranscriptFile {
  /** The project directory name, still in Claude Code's slugified form. */
  slug: string
  sessionId: string
  path: string
  mtimeMs: number
  birthtimeMs: number
}

const EXT = '.jsonl'

/**
 * Transcripts are the only persistent record that a session ever existed:
 * Claude Code deletes the registry file on clean exit, so the registry alone
 * shows nothing after a reboot (spec §4.1).
 *
 * Two deliberate limits keep this inside the 200 ms budget that `helm menu`
 * polls against every five seconds:
 *
 *   - It never reads file contents, only stats them.
 *   - It never recurses. Session transcripts live at the top level of each
 *     project directory; the nested `<session-id>/` directories hold sidecar
 *     data. Measured 2026-08-11: 499 transcripts at the top level against
 *     2350 nested files, so recursing would sextuple the work for nothing.
 *
 * Measured cost of the full top-level scan on a real machine (499 files,
 * 28 project directories): 6.9 ms.
 */
export function scanTranscripts(
  projectsDir: string,
  sinceMs: number,
  alwaysSlugs: ReadonlySet<string> = new Set(),
): TranscriptFile[] {
  return listDirs(projectsDir).flatMap((slug) => {
    // A pinned project is exempt from the activity window by definition
    // (spec §7). Deciding that here rather than downstream is what keeps the
    // exemption reachable at all — anything dropped by the scan can never be
    // rescued by a later rule.
    const always = alwaysSlugs.has(slug.toLowerCase())
    return listTranscripts(join(projectsDir, slug)).flatMap((name) => {
      const path = join(projectsDir, slug, name)
      const stats = statOf(path)
      if (stats === null || (!always && stats.mtimeMs < sinceMs)) return []
      return [{
        slug,
        sessionId: name.slice(0, -EXT.length),
        path,
        mtimeMs: stats.mtimeMs,
        birthtimeMs: stats.birthtimeMs,
      }]
    })
  })
}

function listDirs(dir: string): string[] {
  return entries(dir).filter((e) => e.isDirectory()).map((e) => e.name)
}

function listTranscripts(dir: string): string[] {
  return entries(dir)
    .filter((e) => e.isFile() && e.name.endsWith(EXT) && e.name.length > EXT.length)
    .map((e) => e.name)
}

function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    // A missing or unreadable ~/.claude/projects just means "no transcripts to
    // report". Throwing would take down the whole board over a directory the
    // user may legitimately not have yet.
    return []
  }
}

function statOf(path: string): { mtimeMs: number; birthtimeMs: number } | null {
  try {
    const s = statSync(path)
    return { mtimeMs: s.mtimeMs, birthtimeMs: s.birthtimeMs }
  } catch {
    // The file can vanish between readdir and stat; that is a normal race with
    // Claude Code, not an error worth surfacing.
    return null
  }
}
