import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { HelmPaths } from '../../paths.ts'
import type { DiscoveredSession, RegistryEntry } from '../../types.ts'
import { readRegistry } from './registry.ts'
import { scanTranscripts, type TranscriptFile } from './scan.ts'
import { createSubdirReader, resolveSlug, slugifyCwd } from './slug.ts'

export const ADAPTER_ID = 'claude-code'

const DAY_MS = 86_400_000

export interface DiscoverResult {
  sessions: DiscoveredSession[]
  /** Registry files that existed but could not be parsed. Surfaced to the user. */
  invalid: number
}

export interface DiscoverOptions {
  windowDays: number
  nowMs: number
  /**
   * Cwds to scan regardless of how old their transcripts are. The adapter is
   * told *which* paths, never *why* — user preferences stay out of here.
   */
  alwaysInclude: readonly string[]
}

export interface DiscoverDeps {
  /** Names of the subdirectories of `dir`, used to reverse Claude Code's slugs. */
  subdirs: (dir: string) => readonly string[]
  /** Collapses casing and symlink differences so two sources agree on one path. */
  canonicalPath: (path: string) => string
}

/**
 * Two sources, joined on session id, because neither alone is sufficient:
 *
 *   - Transcripts are the persistent fact. Claude Code deletes the registry
 *     file on clean exit (spec §4.1), so after a normal reboot the registry is
 *     empty and a registry-only board shows nothing at all — exactly half of
 *     what the user asked for ("resume after a reboot *or* a crash").
 *   - The registry is the live fact. Only it knows the PID, the process start
 *     time, and whether the session is busy or waiting for input.
 *
 * Fast path rules still hold here: never read a transcript's contents, never
 * spawn a subprocess. `helm menu` calls this every five seconds (spec §5.1).
 *
 * Liveness deliberately does NOT belong here — but note that `collectStatus`,
 * one layer up, *does* spawn `ps`, and that spawn is the most expensive thing
 * on the whole fast path (measured: 13 ms of `helm menu`'s ~130 ms). The rule
 * above is about this module, not about the path as a whole.
 */
export function discoverClaudeCode(
  paths: HelmPaths,
  opts: DiscoverOptions,
  deps: DiscoverDeps = defaultDeps(),
): DiscoverResult {
  const { entries, invalid } = readRegistry(paths.claudeSessions)
  // The window is a scan bound *and* a display rule, and the two must agree on
  // the exemptions or the disagreement is invisible: an earlier version bounded
  // the scan by the window alone, so a pinned project with no recent transcript
  // was dropped here and `shouldInclude`'s pinned exemption never ran. The
  // caller therefore has to name the paths that outlive the window.
  // Dropping the bound entirely also works but costs the 200 ms budget:
  // measured 78 ms windowed against 230 ms unbounded on 500 transcripts.
  const since = opts.nowMs - opts.windowDays * DAY_MS
  const always = new Set(opts.alwaysInclude.map((p) => slugifyCwd(p).toLowerCase()))
  const transcripts = scanTranscripts(paths.claudeProjects, since, always)
  const bySessionId = new Map(transcripts.map((t) => [t.sessionId, t]))
  // Both of these are per-directory answers being asked per-file. Measured on
  // 500 transcripts across 24 project directories: resolving every slug
  // separately cost 111 ms against 17 ms for the distinct ones, and realpath
  // another 20 ms for cwds that are overwhelmingly the same handful of paths.
  const resolved = memoize((slug: string) => resolveSlug(slug, { subdirs: deps.subdirs }))
  const canonical = memoize(deps.canonicalPath)

  const live = entries.map((e) =>
    fromRegistry(e, bySessionId.get(e.sessionId), paths.claudeProjects, canonical))
  const known = new Set(entries.map((e) => e.sessionId))
  const historical = transcripts
    .filter((t) => !known.has(t.sessionId))
    .flatMap((t) => fromTranscript(t, resolved, canonical))

  return {
    sessions: [...live, ...historical].toSorted((a, b) => b.updatedAt - a.updatedAt),
    invalid,
  }
}

function fromRegistry(
  e: RegistryEntry,
  transcript: TranscriptFile | undefined,
  projectsDir: string,
  canonical: (path: string) => string,
): DiscoveredSession {
  return {
    adapterId: ADAPTER_ID,
    sessionId: e.sessionId,
    cwd: canonical(e.cwd),
    pid: e.pid,
    procStart: e.procStart,
    startedAt: e.startedAt,
    // The registry file is only rewritten on status changes, while the
    // transcript grows with every turn. Whichever moved last is the truth
    // about when the user last did something here.
    updatedAt: Math.max(e.updatedAt, transcript?.mtimeMs ?? 0),
    nativeStatus: e.status,
    kind: e.kind,
    name: e.name,
    // The direct lookup is the fallback for a transcript the scan could not
    // see at all — an unreadable project directory, or a race with Claude Code
    // creating the file between the scan and now.
    transcriptPath: transcript?.path ?? findTranscript(projectsDir, e.cwd, e.sessionId),
    transcriptMtimeMs: transcript?.mtimeMs ?? null,
  }
}

/**
 * A transcript with no registry entry is a session that has already exited.
 * Every field the registry would have supplied is null rather than guessed:
 * lifecycle reconciliation reads `pid === null` as "no registry file", which
 * is precisely the evidence we have.
 */
function fromTranscript(
  t: TranscriptFile,
  resolved: (slug: string) => string | null,
  canonical: (path: string) => string,
): DiscoveredSession[] {
  const cwd = resolved(t.slug)
  // An unresolvable slug means no such directory exists any more (temp dirs,
  // deleted checkouts). Such a project is dropped by `shouldInclude`'s
  // cwdExists rule anyway, so skipping here loses nothing a user would see.
  if (cwd === null) return []
  return [{
    adapterId: ADAPTER_ID,
    sessionId: t.sessionId,
    cwd: canonical(cwd),
    pid: null,
    procStart: null,
    startedAt: t.birthtimeMs,
    updatedAt: t.mtimeMs,
    nativeStatus: null,
    kind: 'interactive',
    name: '',
    transcriptPath: t.path,
    transcriptMtimeMs: t.mtimeMs,
  }]
}

export { slugifyCwd }

/** One CLI invocation's worth of answers; a stale entry is never reachable. */
function memoize<T>(fn: (key: string) => T): (key: string) => T {
  const cache = new Map<string, T>()
  return (key) => {
    const hit = cache.get(key)
    if (hit !== undefined || cache.has(key)) return hit as T
    const value = fn(key)
    cache.set(key, value)
    return value
  }
}

function findTranscript(projectsDir: string, cwd: string, sessionId: string): string | null {
  const candidate = join(projectsDir, slugifyCwd(cwd), `${sessionId}.jsonl`)
  return existsSync(candidate) ? candidate : null
}

function defaultDeps(): DiscoverDeps {
  return { subdirs: createSubdirReader(), canonicalPath: canonicalPath }
}

/**
 * macOS filesystems are case-insensitive but case-preserving, and `/var` is a
 * symlink to `/private/var`. Without this, `~/Acme/TokenSvc` from the registry
 * and `~/Acme/tokensvc` from the transcript slug would render as two separate
 * projects — which is the bug this whole task exists to avoid.
 */
function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    // A path that no longer exists cannot be canonicalized, and that is fine:
    // it is returned unchanged and excluded downstream by the cwdExists rule.
    return path
  }
}
