import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { HelmPaths } from '../paths.ts'

const ENTRY = fileURLToPath(new URL('../cli/main.ts', import.meta.url))

/**
 * Where package managers put `gh`, in the order they should be searched.
 *
 * The board runs under SwiftBar and Übersicht, which launchd starts with
 * `/usr/bin:/bin:/usr/sbin:/sbin` — and `gh` is in none of those. Measured:
 * the entire PR feature had never once succeeded in its real deployment
 * path, and the failure surfaced as「找不到 gh，安裝方式：brew install gh」to a
 * user who had gh installed all along.
 *
 * `pgrep` and `lsof` need no such help; both are in the bare PATH.
 */
const TOOL_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/local/bin',
]

export function buildRefreshEnv(
  base: NodeJS.ProcessEnv,
  fakeHome?: string,
): NodeJS.ProcessEnv {
  const current = (base['PATH'] ?? '/usr/bin:/bin:/usr/sbin:/sbin').split(':').filter((p) => p !== '')
  const missing = TOOL_DIRS.filter((dir) => !current.includes(dir))
  return {
    ...base,
    PATH: [...current, ...missing].join(':'),
    // The child re-derives its own paths, so the sandbox has to be handed
    // across explicitly — without it a test running against a fixture home
    // forks a real `gh` and overwrites the user's real ~/.helm/prs.json.
    ...(fakeHome === undefined ? {} : { HELM_FAKE_HOME: fakeHome }),
  }
}

export function refreshArgs(entry: string = ENTRY): string[] {
  return ['--no-warnings', entry, 'pr-refresh']
}

/**
 * Starts `helm pr-refresh` and forgets about it.
 *
 * `detached` + `unref` + `stdio: 'ignore'` are required together: SwiftBar
 * waits for its plugin's pipes to close, so a child inheriting stdout would
 * hold the menu bar for the whole `gh` sweep.
 *
 * The interpreter is `process.execPath` rather than `node` — under a version
 * manager that resolves to the real binary, which exists in the bare PATH a
 * GUI-launched process gets.
 */
export function spawnPrRefresh(paths: HelmPaths): void {
  // Same guard as `defaults.ts`, and for the same reason. Making the caller
  // inject a no-op was not enough: every call site has to remember, and the
  // ones that forgot forked a real `gh` and overwrote the user's real
  // ~/.helm/prs.json on every `npm test`. The protection belongs down here.
  if (process.env['HELM_NO_REAL_PREFS'] === '1') return

  const child = spawn(process.execPath, refreshArgs(), {
    detached: true,
    stdio: 'ignore',
    env: buildRefreshEnv(process.env, process.env['HELM_FAKE_HOME'] ?? paths.home),
  })
  // `spawn` reports failure asynchronously. Without this listener Node throws
  // on the unhandled 'error' event and takes `helm menu` down with it — the
  // caller's try/catch only ever covered the synchronous path.
  child.on('error', () => {
    // A refresh that could not start is a stale PR row and nothing else.
  })
  child.unref()
}
