import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { HelmPaths } from '../paths.ts'
import { addHelmHook, hasHelmHook, removeHelmHook } from './settings.ts'
import { buildHookCommand, HOOK_MARKER, shellQuote } from './snippet.ts'

const SWIFTBAR_APP = '/Applications/SwiftBar.app'
const PLUGIN_NAME = 'helm.5s.sh'

/**
 * Written into every script helm generates, so uninstall can tell its own
 * files apart from anything that happened to be sitting at the same path.
 * `helm` is also the name of the Kubernetes client, and ~/.local/bin is
 * exactly where a user keeps their own binaries.
 */
const SCRIPT_MARKER = `# ${HOOK_MARKER}`

export interface InstallDeps {
  now: () => number
  repoRoot: string
  /** Injected so the SwiftBar branches are testable on any machine. */
  swiftbarInstalled?: boolean
}

export interface InstallReport {
  steps: string[]
  warnings: string[]
  /** False when something helm intended to do did not happen. */
  ok: boolean
}

/**
 * The only place helm touches configuration it does not own. Three rules,
 * in order: back up first, append rather than overwrite, and refuse outright
 * anything we cannot read — because writing our hook into a settings.json we
 * failed to parse would destroy every setting the user has.
 */
export function installHook(paths: HelmPaths, deps: InstallDeps): InstallReport {
  const settings = readSettings(paths.claudeSettings)
  if (settings === UNREADABLE) {
    return {
      steps: [],
      ok: false,
      warnings: [`${paths.claudeSettings} 無法解析或頂層不是物件，已中止安裝。helm 不會覆寫看不懂的設定檔 —— 請先修好它再重跑。`],
    }
  }

  const command = buildHookCommand(paths.helmLive, paths.hookErrorsLog)
  const updated = addHelmHook(settings, command)
  // `addHelmHook` returns its input untouched when the shape is unfamiliar.
  // "Nothing changed" therefore has two causes, and only one of them is a
  // problem: an unfamiliar shape (refuse) versus an identical hook already
  // being installed (fine, and the common case for a repeat install).
  // `hasHelmHook(updated)` alone cannot tell them apart, which is how a
  // re-install meant to fix a moved repo path used to report success while
  // changing nothing at all.
  const unchanged = JSON.stringify(updated) === JSON.stringify(settings)
  if (unchanged && !hasHelmHook(settings)) {
    return {
      steps: [],
      ok: false,
      warnings: [`${paths.claudeSettings} 的 hooks.PreToolUse 不是預期的形狀，已中止安裝，原檔未動。`],
    }
  }

  const steps: string[] = []
  const warnings: string[] = []
  try {
    apply(paths, deps, updated, steps, warnings)
  } catch (err) {
    // The machine may already have been changed by the time we get here.
    // Reporting only the exception would leave the user believing nothing
    // happened — and so not running uninstall — while the hook is live.
    warnings.push(`安裝中途失敗：${err instanceof Error ? err.message : String(err)}`)
    warnings.push('上面列出的步驟已經生效。要收回請執行 helm uninstall，或設 HELM_OFF=1 先停用 hook。')
    return { steps, warnings, ok: false }
  }
  return { steps, warnings, ok: true }
}

/** Everything that mutates the machine, so the caller can report a partial run. */
function apply(
  paths: HelmPaths,
  deps: InstallDeps,
  updated: unknown,
  steps: string[],
  warnings: string[],
): void {
  // Only the state before helm ever touched the file is worth keeping. A
  // second backup would capture settings.json *with* the hook already in it,
  // and a user restoring "the most recent backup" would get helm back —
  // exactly the opposite of what they asked for. The pid guards against two
  // installs in the same millisecond overwriting each other's copy.
  if (existsSync(paths.claudeSettings) && !hasHelmHook(readSettings(paths.claudeSettings))) {
    const stamp = new Date(deps.now()).toISOString().replace(/:/g, '-')
    const backup = join(paths.backupsDir, `settings-${stamp}.${process.pid}.json`)
    mkdirSync(paths.backupsDir, { recursive: true })
    writeFileSync(backup, readFileSync(paths.claudeSettings, 'utf8'), { encoding: 'utf8', mode: 0o600 })
    steps.push(`已備份安裝前的設定到 ${backup}`)
  }

  // The hook must not spawn `mkdir` — measured at 2.5 ms on every single tool
  // call — so the directory has to exist before the first one arrives.
  mkdirSync(paths.helmLive, { recursive: true })
  steps.push(`已建立 ${paths.helmLive}`)

  writeJsonAtomic(paths.claudeSettings, updated)
  steps.push(`已把 hook 加進 ${paths.claudeSettings}（其餘設定未動）`)

  const entry = shellQuote(join(deps.repoRoot, 'src/cli/main.ts'))
  const wrapper = wrapperPath(paths)
  const wrapperOk = writeOurScript(wrapper, `#!/bin/sh\nexec node ${entry} "$@"\n`)
  if (wrapperOk) steps.push(`已安裝 ${wrapper}`)
  else warnings.push(`${wrapper} 已經存在且不是 helm 寫的（Kubernetes 的 helm 也叫這個名字），未覆寫。想用 helm 指令請自行改名或換一個位置。`)

  if (deps.swiftbarInstalled ?? existsSync(SWIFTBAR_APP)) {
    const plugin = join(swiftbarPluginDir(paths), PLUGIN_NAME)
    // Absolute path: SwiftBar runs plugins with a minimal PATH that will not
    // contain ~/.local/bin. Falls back to the entry point directly when the
    // wrapper is somebody else's file.
    const invoke = wrapperOk ? `${shellQuote(wrapper)} menu` : `node ${entry} menu`
    if (writeOurScript(plugin, `#!/bin/sh\nexec ${invoke}\n`)) {
      steps.push(`已安裝 SwiftBar plugin：${plugin}`)
    } else {
      warnings.push(`${plugin} 已經存在且不是 helm 寫的，未覆寫。`)
    }
  } else {
    warnings.push('找不到 SwiftBar，選單列看板尚未啟用。安裝方式：brew install --cask swiftbar，裝好後重跑 helm install。')
  }

  if (!onPath(dirname(wrapper))) {
    warnings.push(`${dirname(wrapper)} 不在 PATH 上，直接打 helm 會找不到。把它加進 shell 設定即可。`)
  }
  warnings.push('hook 要等下一個 Claude Code session 啟動才會生效。')
}

export function uninstallHook(paths: HelmPaths, deps: InstallDeps): InstallReport {
  const steps: string[] = []
  const warnings: string[] = []

  const settings = readSettings(paths.claudeSettings)
  if (settings === UNREADABLE) {
    warnings.push(`${paths.claudeSettings} 無法解析，未改動它。hook 設定可能還留著，請自行檢查。`)
  } else if (hasHelmHook(settings)) {
    writeJsonAtomic(paths.claudeSettings, removeHelmHook(settings))
    steps.push(`已從 ${paths.claudeSettings} 移除 hook`)
  }

  for (const path of [wrapperPath(paths), join(swiftbarPluginDir(paths), PLUGIN_NAME)]) {
    if (!isOurScript(path)) continue
    rmSync(path, { force: true })
    steps.push(`已移除 ${path}`)
  }

  // live/ and cache.json stay. They are the user's own history, and deleting
  // them here would turn "stop collecting" into "throw away what you already
  // collected" — a very different thing to agree to.
  warnings.push(`${paths.helmHome} 底下的 live 檔、快取與備份都保留未動，要清掉請自行刪除。`)
  return { steps, warnings, ok: steps.length > 0 }
}

function wrapperPath(paths: HelmPaths): string {
  return join(paths.home, '.local', 'bin', 'helm')
}

function swiftbarPluginDir(paths: HelmPaths): string {
  return join(paths.home, 'Library', 'Application Support', 'SwiftBar')
}

/** Compares resolved paths, so a stray trailing slash is not a false warning. */
function onPath(dir: string): boolean {
  const target = resolve(dir)
  return (process.env['PATH'] ?? '')
    .split(':')
    .filter((p) => p !== '')
    .some((p) => resolve(p) === target)
}

/** Returns false when something helm did not write already occupies the path. */
function writeOurScript(path: string, body: string): boolean {
  if (existsSync(path) && !isOurScript(path)) return false
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${body}${SCRIPT_MARKER}\n`, 'utf8')
  chmodSync(path, 0o755)
  return true
}

function isOurScript(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(SCRIPT_MARKER)
  } catch {
    // Missing or unreadable: either way it is not a file helm may delete.
    return false
  }
}

/** Distinct from `{}` so the caller can refuse rather than clobber. */
const UNREADABLE = Symbol('unreadable')

function readSettings(file: string): unknown {
  if (!existsSync(file)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // Deliberately NOT degrading to an empty object. Everywhere else in helm a
    // failed read degrades to "nothing there", but here "nothing there" would
    // be written back over the user's entire configuration.
    return UNREADABLE
  }
  // Parsing successfully is not the same as understanding. An array, a string
  // or a number would sail past the catch above and then be replaced wholesale
  // by an object — the exact outcome the comment there rules out.
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed
    : UNREADABLE
}

/**
 * Write to a sibling then rename. `writeFileSync` truncates in place, so a
 * crash mid-write would leave the user with a half-written settings.json and
 * a Claude Code that no longer starts cleanly.
 */
function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}
