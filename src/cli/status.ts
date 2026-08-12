import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { discoverClaudeCode } from '../adapters/claude-code/discover.ts'
import { defaultCodexDeps, discoverCodex } from '../adapters/codex/discover.ts'
import { collectFromAdapters } from '../adapters/registry.ts'
import { queryProcesses, type ProcessProbe } from '../adapters/claude-code/processes.ts'
import type { Board } from '../board.ts'
import { resolvePaths, type HelmPaths } from '../paths.ts'
import { groupIntoProjects } from '../projects/group.ts'
import { ACTIVITY_WINDOW_DAYS } from '../projects/include.ts'
import { readPrefs } from '../projects/prefs.ts'
import { reconcileSessions } from '../reconcile/lifecycle.ts'
import { readLiveMarker } from '../reconcile/live.ts'
import { renderTable } from '../render/table.ts'
import type { PrefsIO } from '../hook/defaults.ts'
import { defaultSwiftBarDeps } from '../hook/swiftbar.ts'
import { defaultUbersichtDeps } from '../hook/ubersicht.ts'

/** Fast path: no transcript parsing, no network, no LLM (spec 5.1). */
export function collectStatus(
  paths: HelmPaths,
  nowMs: number,
  probe: ProcessProbe = queryProcesses,
): Board {
  const { prefs, health: prefsHealth } = readPrefs(paths.prefsFile)
  // Pinned projects are exempt from the window (spec §7), so each scan has to
  // be told about them; filtering them out afterwards would make that
  // exemption unreachable.
  const alwaysInclude = Object.entries(prefs.projects)
    .filter(([, p]) => p.pinned)
    .map(([path]) => path)

  const { sessions: states, invalid, failures } = collectFromAdapters([
    {
      id: 'claude-code',
      collect: () => {
        const found = discoverClaudeCode(paths, { windowDays: ACTIVITY_WINDOW_DAYS, nowMs, alwaysInclude })
        const probed = probe(found.sessions.flatMap((d) => (d.pid === null ? [] : [d.pid])))
        return {
          sessions: reconcileSessions(found.sessions, {
            probe: probed,
            readLive: (id) => readLiveMarker(paths.helmLive, id),
            transcriptMtimeMs: mtimeMs,
          }),
          invalid: found.invalid,
        }
      },
    },
    {
      id: 'codex',
      collect: () => discoverCodex({
        sessionsDir: join(paths.home, '.codex', 'sessions'),
        cacheFile: join(paths.helmHome, 'codex-meta.json'),
        windowDays: ACTIVITY_WINDOW_DAYS,
        nowMs,
        alwaysInclude,
      }, defaultCodexDeps(join(paths.helmHome, 'codex-meta.json'))),
    },
  ])

  const projects = groupIntoProjects(states, {
    prefs,
    nowMs,
    cwdExists: existsSync,
    isGitRepo: (p) => existsSync(join(p, '.git')),
    home: paths.home,
  })
  return { projects, invalid, prefsHealth, adapterFailures: failures }
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

/**
 * The two GUI apps' preference domains — sandboxed whenever the home
 * directory is.
 *
 * A fake home looks like isolation but the `defaults` database is shared with
 * the whole machine, so an end-to-end run against a fixture used to read the
 * real SwiftBar folder and install into it. That is the shape of both
 * pollution incidents this project has already had.
 */
export function currentPrefs(): { swiftbar: PrefsIO; ubersicht: PrefsIO } {
  if (process.env['HELM_FAKE_HOME'] === undefined) {
    return { swiftbar: defaultSwiftBarDeps(), ubersicht: defaultUbersichtDeps() }
  }
  const sandboxed: PrefsIO = {
    readPref: () => ({ kind: 'unset' }), writePref: () => {}, clearPref: () => {},
  }
  return { swiftbar: sandboxed, ubersicht: sandboxed }
}

export function useColor(argv: readonly string[]): boolean {
  if (argv.includes('--no-color')) return false
  if (process.env['NO_COLOR'] !== undefined) return false
  return process.stdout.isTTY === true
}
