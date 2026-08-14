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
  // A degraded marker still carries a trustworthy timestamp (it is the file's
  // mtime), so the comparison itself is sound. What it cannot tell us is which
  // tool was running, and a verdict we cannot explain does not get to call
  // itself high confidence.
  const confidence: Confidence = input.live.degraded ? 'low' : 'high'
  return input.live.ts > input.transcriptMtimeMs
    ? { lifecycle: 'crashed', confidence }
    : { lifecycle: 'ended_clean', confidence }
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
    return {
      ...s,
      lifecycle: verdict.lifecycle,
      lifecycleConfidence: verdict.confidence,
      live,
      // adapter 產不出這個值（它來自簡報快取），所以一律填 null，由
      // attachTaskStatus 在 collectStatus 裡補上。
      taskStatus: null,
    }
  })
}

/**
 * How long a Codex session may sit with no process before helm calls it
 * abandoned.
 *
 * Spec §6. This number is a judgement, not a measurement: it exists so a
 * momentary failure to see the process — `pgrep` losing a race, `lsof`
 * refused — does not flip a live session to crashed. Nobody has measured how
 * long a real Codex session idles, so it gets a name and stays adjustable.
 */
export const CODEX_ABANDON_MS = 30 * 60_000

/**
 * Past this, helm stops claiming the session crashed.
 *
 * Measured 2026-08-12: with only the lower bound, all 12 Codex sessions from
 * the last fortnight on this machine came back `crashed` — the most recent of
 * them six days old. The 30-minute rule describes "it was running a moment
 * ago and now the process is gone"; stretched over six days it is just a
 * guess, and `crashed` is the highest-priority, red-drawn state. Twelve false
 * red dots would bury a real one.
 *
 * Beyond this helm genuinely does not know whether the session crashed or was
 * closed normally. `ended_clean` is used because its effect in the UI is to
 * draw no dot at all — that is, to claim nothing — not because helm believes
 * it ended cleanly. That is what `low` confidence is there to say.
 */
export const CODEX_UNKNOWN_MS = 6 * 3600_000

/**
 * What the session's last recorded event says about how it stopped.
 *
 * `finished` covers Codex's `task_complete` and `turn_aborted`; `midflight`
 * is anything else, i.e. the log stops in the middle of a turn. `unknown` is
 * the honest answer when the tail could not be read.
 */
export type CodexEnding = 'finished' | 'midflight' | 'unknown'

export interface CodexLifecycleInput {
  /** A running `codex` process whose cwd matches this session's. */
  cwdHasProcess: boolean
  /** Newest write to any of the session's rollout files. */
  lastEventMs: number
  nowMs: number
  /** Defaults to `unknown`, which reproduces the pre-2026-08-14 timer rule. */
  endedWith?: CodexEnding
  /**
   * Whether this is a `codex exec` batch run rather than an interactive
   * session. Defaults to false: not knowing must not be read as "batch", or a
   * real crash gets talked down to nothing.
   */
  isExec?: boolean
}

/**
 * Codex's lifecycle rules (spec §6), which differ from Claude Code's in two
 * ways that must not be smoothed over:
 *
 *   - **There is no clean-exit signal.** Codex writes no termination event, so
 *     `ended_clean` here does not mean "it finished cleanly" — it means helm
 *     has stopped guessing, and its effect in the UI is to draw no dot.
 *   - **Confidence is always low.** Everything here is inferred from a process
 *     table and a file mtime, never from the tool saying so. The UI has to
 *     show that difference rather than mixing it in with Claude Code's
 *     registry-backed verdicts.
 */
export function decideCodexLifecycle(input: CodexLifecycleInput): LifecycleVerdict {
  if (input.cwdHasProcess) return { lifecycle: 'running', confidence: 'low' }
  // A session whose log ends on a completed turn did not crash, however long
  // ago that was — no timer needed, and no timer can tell you this.
  //
  // Measured 2026-08-13 across this machine's 88 Codex sessions: 86 end on
  // `task_complete` or `turn_aborted` and 2 stop mid-turn. The two that put
  // 「1 中斷」in the menu bar, sending the user hunting for a crash that had
  // never happened, were finished `codex exec` batch jobs.
  if (input.endedWith === 'finished') return { lifecycle: 'ended_clean', confidence: 'low' }
  // `Math.max(0, …)` because a clock skew or a touched file can put the last
  // event in the future, and a negative age must not read as "long ago".
  const idleMs = Math.max(0, input.nowMs - input.lastEventMs)
  // Still a debounce, but only for the mid-turn case now: two events in a live
  // session are routinely minutes apart, and `pgrep` can lose a race.
  if (idleMs <= CODEX_ABANDON_MS) return { lifecycle: 'running', confidence: 'low' }
  // A `codex exec` run that stopped has no breakpoint to recover: it was
  // launched with its whole prompt as an argument, so getting back to it means
  // re-running the command, not resuming a session. 「中斷」 in spec §11.1 means
  // 「有未回收的斷點」, which overstates this.
  //
  // Measured 2026-08-14: one such run stopped mid-`reasoning` after 6.5
  // minutes and put an orange 「1 中斷?」 in the menu bar. The verdict was
  // factually right and the alarm was still noise — a parent Bash call timing
  // out or being cancelled makes this routine.
  if (input.isExec === true) return { lifecycle: 'ended_clean', confidence: 'low' }
  return idleMs > CODEX_UNKNOWN_MS
    ? { lifecycle: 'ended_clean', confidence: 'low' }
    : { lifecycle: 'crashed', confidence: 'low' }
}
