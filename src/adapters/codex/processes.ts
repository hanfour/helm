import { execFileSync } from 'node:child_process'
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
