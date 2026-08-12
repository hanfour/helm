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

export interface ProbeResult {
  /** pid → raw `ps` lstart string, for the PIDs the OS answered about. */
  alive: Map<number, string>
  /**
   * PIDs no answer could be obtained for. Emphatically not the same as dead:
   * treating "we could not ask" as "it is gone" is what paints a whole board
   * red at high confidence and sends the user to resume live sessions.
   */
  unreachable: Set<number>
}

export type ProcessProbe = (pids: number[]) => ProbeResult

/** macOS caps PIDs at 99999; measured: 99999 is accepted, 100000 is rejected. */
const MAX_PID = 99_999

function isQueryablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid <= MAX_PID
}

/** Null means the call failed; an empty Map means it ran and found nothing. */
export type PsRunner = (pids: readonly number[]) => Map<number, string> | null

/**
 * Exported so the fallback can be tested directly. It is the entire point of
 * this module and is otherwise only reachable by breaking `ps` itself, which
 * would leave the one behaviour that prevents a board full of false red dots
 * covered by nothing.
 */
/**
 * Above this many PIDs, one `ps` call is cheaper than one per PID.
 *
 * Measured on macOS: `ps -p a,b` scans the entire process table and costs a
 * flat ~42 ms the moment there is more than one PID, while a single-PID query
 * costs ~3.4 ms. The board typically tracks a handful of live sessions, so the
 * batch that looks like the efficient choice was the expensive one — and it
 * was 21% of `helm menu`'s whole 200 ms budget.
 */
const BATCH_THRESHOLD = 12

export function createProbe(run: PsRunner): ProcessProbe {
  return (pids) => {
    // A PID outside what `ps` accepts is one we never asked about, so it lands
    // in `unreachable` rather than being silently dropped — dropping it would
    // read downstream as high-confidence evidence that it is dead.
    const queryable = pids.filter(isQueryablePid)
    const skipped = pids.filter((p) => !isQueryablePid(p))
    if (queryable.length === 0) return { alive: new Map(), unreachable: new Set(skipped) }

    if (queryable.length > BATCH_THRESHOLD) {
      const batched = run(queryable)
      if (batched !== null) return { alive: batched, unreachable: new Set(skipped) }
      // The batch failed as a whole. Asking one at a time means whatever is
      // wrong costs only the PID it belongs to, instead of turning every
      // session on the board red.
    }
    return oneAtATime(run, queryable, skipped)
  }
}

function oneAtATime(
  run: PsRunner,
  queryable: readonly number[],
  skipped: readonly number[],
): ProbeResult {
  const alive = new Map<number, string>()
  const unreachable = new Set<number>(skipped)
  for (const pid of queryable) {
    const one = run([pid])
    if (one === null) unreachable.add(pid)
    else if (one.has(pid)) alive.set(pid, one.get(pid) as string)
  }
  return { alive, unreachable }
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
  // Local accumulator, never escapes: copying the map per output line bought
  // nothing but quadratic work.
  const found = new Map<number, string>()
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/)
    if (m === null) continue
    const lstart = (m[2] ?? '').trim()
    if (lstart !== '') found.set(Number(m[1]), lstart)
  }
  return found
}
