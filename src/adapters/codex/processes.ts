import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/**
 * Codex keeps no PID registry, so "is this session still running" has to be
 * answered by looking at the process table and matching working directories
 * (spec §6). `ps` cannot report another process's cwd on macOS, hence `lsof`.
 *
 * Injected so the tests never depend on what happens to be running.
 */
export interface ProcessDeps {
  pgrep: () => number[]
  lsofCwds: (pids: readonly number[]) => string[]
}

export function defaultProcessDeps(): ProcessDeps {
  return { pgrep, lsofCwds }
}

/**
 * The working directories of every running `codex` process.
 *
 * A session whose cwd is in this set is running; everything else is decided
 * by how long ago it was last written to. Both commands live in
 * `/usr/bin:/bin:/usr/sbin:/sbin`, so this works under launchd's bare PATH —
 * which is what SwiftBar and Übersicht hand to the plugin.
 */
export function liveCodexCwds(deps: ProcessDeps = defaultProcessDeps()): Set<string> {
  let pids: number[]
  try {
    pids = deps.pgrep()
  } catch {
    // No `pgrep`, or it failed. Reporting nothing running is the safe
    // direction: sessions then fall back to the age rule rather than being
    // claimed alive on no evidence.
    return new Set()
  }
  // Nothing running is the common case, and this runs every five seconds.
  // Skipping the second spawn matters more than it looks.
  if (pids.length === 0) return new Set()

  try {
    return new Set(deps.lsofCwds(pids).filter((cwd) => isAbsolute(cwd)))
  } catch {
    // `lsof` missing or refused. Same reasoning as above.
    return new Set()
  }
}

function pgrep(): number[] {
  try {
    return execFileSync('pgrep', ['-x', 'codex'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    // `pgrep` exits 1 when nothing matches, which is the normal state.
    return []
  }
}

/**
 * `-Fn` gives one field per line prefixed by its type, which is the only
 * output format that survives a path containing spaces.
 */
function lsofCwds(pids: readonly number[]): string[] {
  const out = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  })
  return out
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1))
}

/**
 * Whether a session's recorded cwd is one of the running ones.
 *
 * `lsof` reports resolved paths — a process in `/tmp/x` comes back as
 * `/private/tmp/x`, and anything under `$TMPDIR` as `/private/var/folders/…`.
 * Codex records the literal path it was started with. Comparing the two as
 * strings never matches, so a running session gets drawn as finished; four of
 * the 192 rollouts on this machine carry exactly that shape of path.
 *
 * Both sides are resolved before comparing, and a path that cannot be
 * resolved (deleted since) falls back to itself rather than throwing.
 */
export function matchesLive(live: ReadonlySet<string>, cwd: string): boolean {
  if (live.has(cwd)) return true
  const resolved = resolve(cwd)
  for (const candidate of live) {
    if (resolve(candidate) === resolved) return true
  }
  return false
}

function resolve(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // Gone since, or never existed. Comparing the literal value is the most
    // this can honestly do.
    return path
  }
}
