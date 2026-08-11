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

/**
 * Ask the OS which of these PIDs are alive and when each started.
 * LC_ALL=C is mandatory: without it macOS renders localized month names
 * (e.g. `四 8月/ 6`) that neither parser can read.
 */
export const queryProcesses: ProcessProbe = (pids) => {
  if (pids.length === 0) return new Map()
  let out = ''
  try {
    out = execFileSync(
      'ps',
      ['-o', 'pid=,lstart=', '-p', pids.join(',')],
      { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } },
    )
  } catch {
    // ps exits non-zero when none of the PIDs exist. That is a valid answer.
    return new Map()
  }
  return out.split('\n').reduce((acc, line) => {
    const m = line.trim().match(/^(\d+)\s+(.+)$/)
    if (m === null) return acc
    const pid = Number(m[1])
    const lstart = (m[2] ?? '').trim()
    return lstart === '' ? acc : new Map(acc).set(pid, lstart)
  }, new Map<number, string>())
}
