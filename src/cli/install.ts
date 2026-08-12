import { fileURLToPath } from 'node:url'
import {
  installHook, uninstallHook, type InstallDeps, type InstallReport,
} from '../hook/install.ts'
import { currentPaths, currentPrefs } from './status.ts'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * `overrides` exists for the tests. Without it they reach the real `defaults`
 * database, and one of them did: it wrote a temp path into Übersicht's own
 * settings and then deleted the directory. Nothing in helm should be able to
 * change the user's machine from a test run.
 */
export function runInstall(_argv: readonly string[], overrides: Partial<InstallDeps> = {}): number {
  return report(installHook(currentPaths(), deps(overrides)), '安裝')
}

export function runUninstall(
  _argv: readonly string[],
  overrides: Partial<InstallDeps> = {},
): number {
  return report(uninstallHook(currentPaths(), deps(overrides)), '解除安裝')
}

function deps(overrides: Partial<InstallDeps>): InstallDeps {
  return { now: Date.now, repoRoot: REPO_ROOT, ...currentPrefs(), ...overrides }
}

/**
 * Steps and warnings are both printed. A step the user cannot see is a change
 * to their machine they did not agree to, and this is the one command that
 * edits a file helm does not own.
 */
function report(result: InstallReport, verb: string): number {
  for (const s of result.steps) process.stdout.write(`✓ ${s}\n`)
  for (const w of result.warnings) process.stderr.write(`⚠ ${w}\n`)
  if (!result.ok) {
    process.stderr.write(
      result.steps.length === 0
        ? `${verb}沒有做任何事，見上方原因。\n`
        : `${verb}沒有完成，但上面那些步驟已經生效。\n`,
    )
    return 1
  }
  // The two commands end in opposite states, so they cannot share a closing
  // line: after uninstall, telling the user how to disable the hook and how to
  // uninstall is advice about something that is no longer there.
  process.stdout.write(
    verb === '安裝'
      ? '安裝完成。隨時可用 HELM_OFF=1 停用 hook，或 helm uninstall 完全移除。\n'
      : '解除安裝完成。想再裝回來就跑 helm install。\n',
  )
  return 0
}
