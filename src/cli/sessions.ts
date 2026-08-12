import { renderSessions } from '../render/sessions.ts'
import { firstPositional } from './argv.ts'
import { collectStatus, currentPaths, useColor } from './status.ts'
import { resolveOrReport } from './target.ts'

const USAGE = '用法：helm sessions <專案或 session-id>\n'

/**
 * The drill-down from the project board. `helm status` deliberately shows one
 * row per project, so this is how the user gets at the sessions underneath a
 * project they actually care about.
 */
export function runSessions(argv: readonly string[]): number {
  const query = firstPositional(argv)
  if (query === undefined) {
    process.stderr.write(USAGE)
    return 2
  }

  const now = Date.now()
  const { projects } = collectStatus(currentPaths(), now)
  const hit = resolveOrReport(projects, query, (m) => process.stderr.write(m))
  if (hit === null) return 1

  process.stdout.write(renderSessions(hit.project, { color: useColor(argv), nowMs: now }))
  return 0
}
