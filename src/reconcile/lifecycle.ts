import type { Confidence, DiscoveredSession, Lifecycle, LiveMarker, SessionState } from '../types.ts'
import { procStartMatches } from '../adapters/claude-code/processes.ts'

export interface LifecycleInput {
  /** Whether ~/.claude/sessions/<pid>.json still exists. */
  registryFileExists: boolean
  pidAlive: boolean
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
  if (!input.pidAlive) return { lifecycle: 'crashed', confidence: 'high' }
  if (input.procStart === null || input.psLstart === null) {
    return { lifecycle: 'crashed', confidence: 'low' }
  }
  if (procStartMatches(input.procStart, input.psLstart)) {
    return { lifecycle: 'running', confidence: 'high' }
  }
  // Distinguish "genuinely a different process" from "we failed to parse".
  const unparseable = !/^\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/
    .test(input.psLstart.trim().replace(/\s+/g, ' '))
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
  /** pid → raw `ps` lstart string. Absent key means the PID is dead. */
  alive: Map<number, string>
  readLive: (sessionId: string) => LiveMarker | null
  transcriptMtimeMs: (path: string) => number | null
}

export function reconcileSessions(
  sessions: readonly DiscoveredSession[],
  deps: ReconcileDeps,
): SessionState[] {
  return sessions.map((s) => {
    const live = deps.readLive(s.sessionId)
    const psLstart = s.pid === null ? null : (deps.alive.get(s.pid) ?? null)
    const verdict = decideLifecycle({
      // A session discovered from the registry always has a PID; anything
      // without one was found some other way, so treat the registry as absent.
      registryFileExists: s.pid !== null,
      pidAlive: psLstart !== null,
      psLstart,
      procStart: s.procStart,
      live,
      transcriptMtimeMs:
        s.transcriptPath === null ? null : deps.transcriptMtimeMs(s.transcriptPath),
    })
    return { ...s, lifecycle: verdict.lifecycle, lifecycleConfidence: verdict.confidence, live }
  })
}
