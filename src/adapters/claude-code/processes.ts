import { execFileSync } from 'node:child_process'

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
}

/** Tolerance for comparing two renderings of the same process start. */
const MATCH_TOLERANCE_MS = 2000

interface Parts {
  month: number
  day: number
  hour: number
  minute: number
  second: number
  year: number
}

/** Both formats share the shape `Ddd Mmm D HH:MM:SS YYYY`, with variable spacing. */
function split(s: string): Parts | null {
  const t = s.trim().split(/\s+/)
  if (t.length !== 5) return null
  const [, mon, day, clock, year] = t
  const month = MONTHS[mon ?? '']
  const hms = (clock ?? '').split(':').map(Number)
  if (month === undefined || hms.length !== 3 || hms.some(Number.isNaN)) return null
  const [hour, minute, second] = hms as [number, number, number]
  const d = Number(day)
  const y = Number(year)
  if (!Number.isInteger(d) || !Number.isInteger(y)) return null
  return { month, day: d, hour, minute, second, year: y }
}

/** ~/.claude/sessions/<pid>.json stores procStart in UTC. */
export function parseProcStart(s: string): number | null {
  const p = split(s)
  return p === null
    ? null
    : Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second)
}

/** `LC_ALL=C ps -o lstart=` reports local time. */
export function parseLstart(s: string): number | null {
  const p = split(s)
  return p === null
    ? null
    : new Date(p.year, p.month, p.day, p.hour, p.minute, p.second).getTime()
}

/**
 * True when the live process started at the same instant the registry
 * recorded. A mismatch means the PID was recycled by an unrelated process,
 * so the original session is gone.
 */
export function procStartMatches(registryProcStart: string, psLstart: string): boolean {
  const a = parseProcStart(registryProcStart)
  const b = parseLstart(psLstart)
  if (a === null || b === null) return false
  return Math.abs(a - b) <= MATCH_TOLERANCE_MS
}

export type ProcessProbe = (pids: number[]) => Map<number, string>

/** macOS caps PIDs at 99999; measured: 99999 is accepted, 100000 is rejected. */
const MAX_PID = 99_999

function isQueryablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid <= MAX_PID
}

/**
 * Ask the OS which of these PIDs are alive and when each started.
 * LC_ALL=C is mandatory: without it macOS renders localized month names
 * (e.g. `四 8月/ 6`) that neither parser can read.
 *
 * Two defences against one bad PID poisoning the whole batch. `ps` rejects
 * the entire invocation over a single bad argument, and reading that as
 * "every session is dead" paints the whole board red — measured 2026-08-11:
 * one PID of 999999 marked all three projects as crashed. A false crash is
 * worse than a missed one, because the user goes and resumes a session that
 * is still running.
 */
/** Null means the call failed; an empty Map means it ran and found nothing. */
export type PsRunner = (pids: readonly number[]) => Map<number, string> | null

/**
 * Exported so the fallback can be tested directly. It is the entire point of
 * this module and is otherwise only reachable by breaking `ps` itself, which
 * would leave the one behaviour that prevents a board full of false red dots
 * covered by nothing.
 */
export function createProbe(run: PsRunner): ProcessProbe {
  return (pids) => {
    const queryable = pids.filter(isQueryablePid)
    if (queryable.length === 0) return new Map()

    const batched = run(queryable)
    if (batched !== null) return batched

    // The batch failed as a whole, so ask one at a time: whatever is wrong
    // then costs only the PID it belongs to. Rare enough that the extra
    // spawns are an acceptable price for not lying about every other session.
    return queryable.reduce((acc, pid) => {
      const lstart = run([pid])?.get(pid)
      return lstart === undefined ? acc : new Map(acc).set(pid, lstart)
    }, new Map<number, string>())
  }
}

export const queryProcesses: ProcessProbe = createProbe(runPs)

/**
 * Null means the invocation itself failed; an empty Map means it ran and found
 * nothing. Measured on macOS, `ps` distinguishes the two even though both exit
 * non-zero: a PID that simply does not exist produces empty stderr, while a
 * rejected argument writes `ps: process id too large: …` to it.
 */
function runPs(pids: readonly number[]): Map<number, string> | null {
  try {
    return parsePsOutput(execFileSync(
      'ps',
      ['-o', 'pid=,lstart=', '-p', pids.join(',')],
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
        // Explicit pipe on stderr: execFileSync forwards the child's stderr to
        // ours by default, which is how `ps: process id too large` ended up in
        // the middle of the user's board.
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ))
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string }
    const stdout = typeof e.stdout === 'string' ? e.stdout : ''
    if (stdout.trim() !== '') return parsePsOutput(stdout)
    const stderr = typeof e.stderr === 'string' ? e.stderr : ''
    // `status` is null when the spawn itself never ran (ps missing, no memory),
    // and that must not be read as "these processes are gone" either.
    return typeof e.status === 'number' && stderr.trim() === '' ? new Map() : null
  }
}

function parsePsOutput(out: string): Map<number, string> {
  return out.split('\n').reduce((acc, line) => {
    const m = line.trim().match(/^(\d+)\s+(.+)$/)
    if (m === null) return acc
    const pid = Number(m[1])
    const lstart = (m[2] ?? '').trim()
    return lstart === '' ? acc : new Map(acc).set(pid, lstart)
  }, new Map<number, string>())
}
