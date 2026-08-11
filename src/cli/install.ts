import { fileURLToPath } from 'node:url'
import { installHook, uninstallHook, type InstallReport } from '../hook/install.ts'
import { currentPaths } from './status.ts'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

export function runInstall(_argv: readonly string[]): number {
  return report(installHook(currentPaths(), { now: Date.now, repoRoot: REPO_ROOT }), '安裝')
}

export function runUninstall(_argv: readonly string[]): number {
  return report(uninstallHook(currentPaths(), { now: Date.now, repoRoot: REPO_ROOT }), '解除安裝')
}

/**
 * Steps and warnings are both printed. A step the user cannot see is a change
 * to their machine they did not agree to, and this is the one command that
 * edits a file helm does not own.
 */
function report(result: InstallReport, verb: string): number {
  for (const s of result.steps) process.stdout.write(`✓ ${s}\n`)
  for (const w of result.warnings) process.stderr.write(`⚠ ${w}\n`)
  if (result.steps.length === 0) {
    process.stderr.write(`${verb}沒有做任何事，見上方原因。\n`)
    return 1
  }
  process.stdout.write(
    `${verb}完成。隨時可用 HELM_OFF=1 停用 hook，或 helm uninstall 完全移除。\n`,
  )
  return 0
}
