import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { discoverClaudeCode } from '../adapters/claude-code/discover.ts'
import { queryProcesses, type ProcessProbe } from '../adapters/claude-code/processes.ts'
import type { Board } from '../board.ts'
import { resolvePaths, type HelmPaths } from '../paths.ts'
import { groupIntoProjects } from '../projects/group.ts'
import { ACTIVITY_WINDOW_DAYS } from '../projects/include.ts'
import { readPrefs } from '../projects/prefs.ts'
import { reconcileSessions } from '../reconcile/lifecycle.ts'
import { readLiveMarker } from '../reconcile/live.ts'
import { renderTable } from '../render/table.ts'

/** Fast path: no transcript parsing, no network, no LLM (spec 5.1). */
export function collectStatus(
  paths: HelmPaths,
  nowMs: number,
  probe: ProcessProbe = queryProcesses,
): Board {
  const prefs = readPrefs(paths.prefsFile)
  const { sessions, invalid } = discoverClaudeCode(paths, {
    windowDays: ACTIVITY_WINDOW_DAYS,
    nowMs,
    // Pinned projects are exempt from the window (spec §7), so the scan has to
    // be told about them; filtering them out here would make that exemption
    // unreachable further down.
    alwaysInclude: Object.entries(prefs.projects)
      .filter(([, p]) => p.pinned)
      .map(([path]) => path),
  })
  const alive = probe(sessions.flatMap((d) => (d.pid === null ? [] : [d.pid])))
  const states = reconcileSessions(sessions, {
    alive,
    readLive: (id) => readLiveMarker(paths.helmLive, id),
    transcriptMtimeMs: mtimeMs,
  })
  const projects = groupIntoProjects(states, {
    prefs,
    nowMs,
    cwdExists: existsSync,
    isGitRepo: (p) => existsSync(join(p, '.git')),
    home: paths.home,
  })
  return { projects, invalid }
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
  const result = collectStatus(currentPaths(), now)
  const output = argv.includes('--json')
    ? `${JSON.stringify(result, null, 2)}\n`
    : renderTable(result, { color: useColor(argv), nowMs: now })
  process.stdout.write(output)
  return 0
}

/** HELM_FAKE_HOME lets end-to-end tests drive the real CLI against a fixture. */
export function currentPaths(): HelmPaths {
  const home = process.env['HELM_FAKE_HOME']
  return home === undefined ? resolvePaths() : resolvePaths({ home })
}

export function useColor(argv: readonly string[]): boolean {
  if (argv.includes('--no-color')) return false
  if (process.env['NO_COLOR'] !== undefined) return false
  return process.stdout.isTTY === true
}
