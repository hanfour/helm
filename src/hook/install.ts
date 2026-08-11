import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HelmPaths } from '../paths.ts'
import { addHelmHook, hasHelmHook, removeHelmHook } from './settings.ts'
import { buildHookCommand } from './snippet.ts'

const SWIFTBAR_APP = '/Applications/SwiftBar.app'
const PLUGIN_NAME = 'helm.5s.sh'

export interface InstallDeps {
  now: () => number
  repoRoot: string
  /** Injected so the SwiftBar branches are testable on any machine. */
  swiftbarInstalled?: boolean
}

export interface InstallReport {
  steps: string[]
  warnings: string[]
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
      warnings: [`${paths.claudeSettings} 無法解析，已中止安裝。helm 不會覆寫看不懂的設定檔 —— 請先修好它再重跑。`],
    }
  }

  const command = buildHookCommand(paths.helmLive, paths.hookErrorsLog)
  const updated = addHelmHook(settings, command)
  if (!hasHelmHook(updated)) {
    return {
      steps: [],
      warnings: [`${paths.claudeSettings} 的 hooks 欄位不是預期的形狀，已中止安裝，原檔未動。`],
    }
  }

  const steps: string[] = []
  const warnings: string[] = []

  if (existsSync(paths.claudeSettings)) {
    const stamp = new Date(deps.now()).toISOString().replace(/:/g, '-')
    const backup = join(paths.backupsDir, `settings-${stamp}.json`)
    mkdirSync(paths.backupsDir, { recursive: true })
    writeFileSync(backup, readFileSync(paths.claudeSettings, 'utf8'), 'utf8')
    steps.push(`已備份設定到 ${backup}`)
  }

  // The hook must not spawn `mkdir` — measured at 2.5 ms on every single tool
  // call — so the directory has to exist before the first one arrives.
  mkdirSync(paths.helmLive, { recursive: true })
  steps.push(`已建立 ${paths.helmLive}`)

  writeJsonAtomic(paths.claudeSettings, updated)
  steps.push(`已把 hook 加進 ${paths.claudeSettings}（其餘設定未動）`)

  const wrapper = wrapperPath(paths)
  writeExecutable(wrapper, `#!/bin/sh\nexec node "${join(deps.repoRoot, 'src/cli/main.ts')}" "$@"\n`)
  steps.push(`已安裝 ${wrapper}`)

  if (deps.swiftbarInstalled ?? existsSync(SWIFTBAR_APP)) {
    const plugin = join(swiftbarPluginDir(paths), PLUGIN_NAME)
    // Absolute path: SwiftBar runs plugins with a minimal PATH that will not
    // contain ~/.local/bin.
    writeExecutable(plugin, `#!/bin/sh\nexec "${wrapper}" menu\n`)
    steps.push(`已安裝 SwiftBar plugin：${plugin}`)
  } else {
    warnings.push('找不到 SwiftBar，選單列看板尚未啟用。安裝方式：brew install --cask swiftbar，裝好後重跑 helm install。')
  }

  if (!onPath(dirname(wrapper))) {
    warnings.push(`${dirname(wrapper)} 不在 PATH 上，直接打 helm 會找不到。把它加進 shell 設定即可。`)
  }
  warnings.push('hook 要等下一個 Claude Code session 啟動才會生效。')

  return { steps, warnings }
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
    if (!existsSync(path)) continue
    rmSync(path, { force: true })
    steps.push(`已移除 ${path}`)
  }

  // live/ and cache.json stay. They are the user's own history, and deleting
  // them here would turn "stop collecting" into "throw away what you already
  // collected" — a very different thing to agree to.
  warnings.push(`${paths.helmHome} 底下的 live 檔、快取與備份都保留未動，要清掉請自行刪除。`)
  return { steps, warnings }
}

function wrapperPath(paths: HelmPaths): string {
  return join(paths.home, '.local', 'bin', 'helm')
}

function swiftbarPluginDir(paths: HelmPaths): string {
  return join(paths.home, 'Library', 'Application Support', 'SwiftBar')
}

function onPath(dir: string): boolean {
  return (process.env['PATH'] ?? '').split(':').includes(dir)
}

function writeExecutable(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body, 'utf8')
  chmodSync(path, 0o755)
}

/** Distinct from `{}` so the caller can refuse rather than clobber. */
const UNREADABLE = Symbol('unreadable')

function readSettings(file: string): unknown {
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // Deliberately NOT degrading to an empty object. Everywhere else in helm a
    // failed read degrades to "nothing there", but here "nothing there" would
    // be written back over the user's entire configuration.
    return UNREADABLE
  }
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
