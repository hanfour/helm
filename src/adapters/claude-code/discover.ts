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
 * Fast path rules still hold: never read a transcript's contents, never spawn
 * a subprocess. `helm menu` calls this every five seconds (spec §5.1).
 *
 * Liveness deliberately does NOT belong here. Reconciliation needs one `ps`
 * result for the whole session set, so `collectStatus` makes that single call
 * and passes it down.
 */
export function discoverClaudeCode(
  paths: HelmPaths,
  opts: DiscoverOptions,
  deps: DiscoverDeps = defaultDeps(),
): DiscoverResult {
  const { entries, invalid } = readRegistry(paths.claudeSessions)
  const since = opts.nowMs - opts.windowDays * DAY_MS
  const transcripts = scanTranscripts(paths.claudeProjects, since)
  const bySessionId = new Map(transcripts.map((t) => [t.sessionId, t]))

  const live = entries.map((e) =>
    fromRegistry(e, bySessionId.get(e.sessionId), paths.claudeProjects, deps))
  const known = new Set(entries.map((e) => e.sessionId))
  const historical = transcripts
    .filter((t) => !known.has(t.sessionId))
    .flatMap((t) => fromTranscript(t, deps))

  return {
    sessions: [...live, ...historical].toSorted((a, b) => b.updatedAt - a.updatedAt),
    invalid,
  }
}

function fromRegistry(
  e: RegistryEntry,
  transcript: TranscriptFile | undefined,
  projectsDir: string,
  deps: DiscoverDeps,
): DiscoveredSession {
  return {
    adapterId: ADAPTER_ID,
    sessionId: e.sessionId,
    cwd: deps.canonicalPath(e.cwd),
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
    // The scan covers only the activity window, so a long-lived session whose
    // transcript predates it still needs the direct lookup.
    transcriptPath: transcript?.path ?? findTranscript(projectsDir, e.cwd, e.sessionId),
  }
}

/**
 * A transcript with no registry entry is a session that has already exited.
 * Every field the registry would have supplied is null rather than guessed:
 * lifecycle reconciliation reads `pid === null` as "no registry file", which
 * is precisely the evidence we have.
 */
function fromTranscript(t: TranscriptFile, deps: DiscoverDeps): DiscoveredSession[] {
  const cwd = resolveSlug(t.slug, { subdirs: deps.subdirs })
  // An unresolvable slug means no such directory exists any more (temp dirs,
  // deleted checkouts). Such a project is dropped by `shouldInclude`'s
  // cwdExists rule anyway, so skipping here loses nothing a user would see.
  if (cwd === null) return []
  return [{
    adapterId: ADAPTER_ID,
    sessionId: t.sessionId,
    cwd: deps.canonicalPath(cwd),
    pid: null,
    procStart: null,
    startedAt: t.birthtimeMs,
    updatedAt: t.mtimeMs,
    nativeStatus: null,
    kind: 'interactive',
    name: '',
    transcriptPath: t.path,
  }]
}

export { slugifyCwd }

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
