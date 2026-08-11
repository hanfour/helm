import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { discoverClaudeCode } from '../adapters/claude-code/discover.ts'
import { queryProcesses, type ProcessProbe } from '../adapters/claude-code/processes.ts'
import { resolvePaths, type HelmPaths } from '../paths.ts'
import { groupIntoProjects, type ProjectView } from '../projects/group.ts'
import { readPrefs } from '../projects/prefs.ts'
import { reconcileSessions } from '../reconcile/lifecycle.ts'
import { readLiveMarker } from '../reconcile/live.ts'
import { renderTable } from '../render/table.ts'

/** Fast path: no transcript parsing, no network, no LLM (spec 5.1). */
export function collectStatus(
  paths: HelmPaths,
  nowMs: number,
  probe: ProcessProbe = queryProcesses,
): ProjectView[] {
  const discovered = discoverClaudeCode(paths)
  const alive = probe(discovered.flatMap((d) => (d.pid === null ? [] : [d.pid])))
  const states = reconcileSessions(discovered, {
    alive,
    readLive: (id) => readLiveMarker(paths.helmLive, id),
    transcriptMtimeMs: mtimeMs,
  })
  return groupIntoProjects(states, {
    prefs: readPrefs(paths.prefsFile),
    nowMs,
    cwdExists: existsSync,
    isGitRepo: (p) => existsSync(join(p, '.git')),
    home: paths.home,
  })
}

function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    // File may have been deleted or is otherwise inaccessible between
    // discovery and this stat call; treating it as "no timestamp" lets
    // the caller fall back rather than crash the whole status command.
    return null
  }
}

export function runStatus(argv: readonly string[]): number {
  const now = Date.now()
  const projects = collectStatus(currentPaths(), now)
  const output = argv.includes('--json')
    ? `${JSON.stringify(projects, null, 2)}\n`
    : renderTable(projects, { color: useColor(argv), nowMs: now })
  process.stdout.write(output)
  return 0
}

/** HELM_FAKE_HOME lets end-to-end tests drive the real CLI against a fixture. */
export function currentPaths(): HelmPaths {
  const home = process.env['HELM_FAKE_HOME']
  return home === undefined ? resolvePaths() : resolvePaths({ home })
}

function useColor(argv: readonly string[]): boolean {
  if (argv.includes('--no-color')) return false
  if (process.env['NO_COLOR'] !== undefined) return false
  return process.stdout.isTTY === true
}
