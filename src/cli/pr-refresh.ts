import { defaultGhExec } from '../remote/gh.ts'
import { refreshPrs } from '../remote/refresh.ts'
import { prPaths } from '../remote/paths.ts'
import { currentPaths } from './status.ts'

/**
 * The slow path, run as its own process.
 *
 * Exists as a command rather than a function call because the board must not
 * wait for it: `helm menu` forks this detached and returns immediately with
 * whatever the cache already holds.
 */
export function runPrRefresh(_argv: readonly string[]): number {
  const ran = refreshPrs(prPaths(currentPaths()), defaultGhExec(), Date.now())
  // Not running is the normal outcome when another refresh holds the lock —
  // not a failure worth a non-zero exit.
  return ran ? 0 : 0
}
