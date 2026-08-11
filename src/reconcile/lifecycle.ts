import type { Confidence, DiscoveredSession, Lifecycle, LiveMarker, SessionState } from '../types.ts'
import { parseLstart, procStartMatches, type ProbeResult } from '../adapters/claude-code/processes.ts'

export interface LifecycleInput {
  /** Whether ~/.claude/sessions/<pid>.json still exists. */
  registryFileExists: boolean
  pidAlive: boolean
  /** True when no answer about this PID could be obtained at all. */
  pidUnknown: boolean
  /** Raw `LC_ALL=C ps -o lstart=` output for the PID, if alive. */
  psLstart: string | null
  /** Raw procStart from the registry file. */
  procStart: string | null
  live: LiveMarker | null
  transcriptMtimeMs: number | null
}

export interface LifecycleVerdict {
  lifecycle: Lifecycle
  confidence: Confidence
}

/**
 * Spec §6. Three facts drive this, all established by measurement:
 *   1. Claude Code deletes the registry file on clean exit, so a leftover
 *      file with a dead PID is a crash.
 *   2. A live PID whose start time disagrees with the registry is a
 *      recycled PID — the original session is gone.
 *   3. A live marker newer than the transcript means the last tool call
 *      never wrote its result back. That is the shape of a crash.
 *
 * The transcript itself carries no end marker, so it is used only for its
 * timestamp — never parsed for content here.
 */
export function decideLifecycle(input: LifecycleInput): LifecycleVerdict {
  if (input.registryFileExists) return fromRegistry(input)
  return fromAbsence(input)
}

function fromRegistry(input: LifecycleInput): LifecycleVerdict {
  // No answer is not the same as a negative answer. Reporting it as a
  // high-confidence crash would turn one failed `ps` call into a board full of
  // red dots; the `?` suffix exists precisely for what we cannot verify.
  if (input.pidUnknown) return { lifecycle: 'crashed', confidence: 'low' }
  if (!input.pidAlive) return { lifecycle: 'crashed', confidence: 'high' }
  if (input.procStart === null || input.psLstart === null) {
    return { lifecycle: 'crashed', confidence: 'low' }
  }
  if (procStartMatches(input.procStart, input.psLstart)) {
    return { lifecycle: 'running', confidence: 'high' }
  }
  // Distinguish "genuinely a different process" from "we failed to parse".
  // Ask the canonical parser rather than re-deriving its rules: a second
  // format check would drift from `parseLstart` and mislabel confidence in
  // both directions.
  const unparseable = parseLstart(input.psLstart) === null
  return { lifecycle: 'crashed', confidence: unparseable ? 'low' : 'high' }
}

function fromAbsence(input: LifecycleInput): LifecycleVerdict {
  if (input.live === null) return { lifecycle: 'ended_clean', confidence: 'high' }
  if (input.transcriptMtimeMs === null) {
    // A marker with nothing to compare against proves nothing either way.
    return { lifecycle: 'ended_clean', confidence: 'low' }
  }
  return input.live.ts > input.transcriptMtimeMs
    ? { lifecycle: 'crashed', confidence: 'high' }
    : { lifecycle: 'ended_clean', confidence: 'high' }
}

export interface ReconcileDeps {
  /** What the OS said about each PID, including the ones it could not answer. */
  probe: ProbeResult
  readLive: (sessionId: string) => LiveMarker | null
  /** Only consulted when the session did not already carry an mtime. */
  transcriptMtimeMs: (path: string) => number | null
}

function mtimeOf(s: DiscoveredSession, deps: ReconcileDeps): number | null {
  if (s.transcriptMtimeMs !== null) return s.transcriptMtimeMs
  return s.transcriptPath === null ? null : deps.transcriptMtimeMs(s.transcriptPath)
}

export function reconcileSessions(
  sessions: readonly DiscoveredSession[],
  deps: ReconcileDeps,
): SessionState[] {
  return sessions.map((s) => {
    const live = deps.readLive(s.sessionId)
    const psLstart = s.pid === null ? null : (deps.probe.alive.get(s.pid) ?? null)
    const verdict = decideLifecycle({
      // A session discovered from the registry always has a PID; anything
      // without one was found some other way, so treat the registry as absent.
      registryFileExists: s.pid !== null,
      pidAlive: psLstart !== null,
      pidUnknown: s.pid !== null && deps.probe.unreachable.has(s.pid),
      psLstart,
      procStart: s.procStart,
      live,
      // Discovery already stat'ed these files. Re-statting every one of them
      // here doubled the syscalls on a path `helm menu` runs every 5 seconds.
      transcriptMtimeMs: mtimeOf(s, deps),
    })
    return { ...s, lifecycle: verdict.lifecycle, lifecycleConfidence: verdict.confidence, live }
  })
}
