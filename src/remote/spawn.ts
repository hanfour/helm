import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { HelmPaths } from '../paths.ts'

const ENTRY = fileURLToPath(new URL('../cli/main.ts', import.meta.url))

/**
 * Starts `helm pr-refresh` and forgets about it.
 *
 * `detached` plus `unref` plus `stdio: 'ignore'` are all required together:
 * SwiftBar waits for its plugin's pipes to close, so a child that inherits
 * stdout would hold the menu bar for the entire `gh` sweep — the exact
 * blocking this whole design exists to avoid.
 *
 * The interpreter is `process.execPath`, not `node`: this is spawned from a
 * process SwiftBar started under launchd's bare PATH, where a version
 * manager's shim does not exist.
 */
export function spawnPrRefresh(_paths: HelmPaths): void {
  const child = spawn(process.execPath, ['--no-warnings', ENTRY, 'pr-refresh'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}
