import {
  accessSync, constants, existsSync, readFileSync, readdirSync, rmSync, statSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { Board } from '../board.ts'
import type { HelmPaths } from '../paths.ts'
import { quarantinePath } from '../projects/prefs.ts'
import { readLiveMarker } from '../reconcile/live.ts'
import { hasHelmHook, helmHookCommand } from './settings.ts'
import { referencedPaths } from './referenced.ts'
import { appInstalled } from './app-present.ts'
import {
  defaultSwiftBarDeps, PLUGIN_NAME, resolvePluginDir, type SwiftBarDeps,
} from './swiftbar.ts'
import { defaultUbersichtDeps, resolveWidgetDir, type UbersichtDeps } from './ubersicht.ts'
import { WIDGET_NAME } from './widget.ts'

const ORPHAN_MAX_AGE_MS = 30 * 86_400_000
const ERROR_TAIL_LINES = 5
const SWIFTBAR_APP = '/Applications/SwiftBar.app'
const UBERSICHT_APP = '/Applications/Übersicht.app'
const SWIFTBAR_BUNDLE = 'com.ameba.SwiftBar'
const UBERSICHT_BUNDLE = 'tracesOf.Uebersicht'

export interface Check {
  name: string
  ok: boolean
  /** Always says what to do next when `ok` is false. A finding with no next step is noise. */
  detail: string
}

/**
 * Everything about the two GUI apps that a test needs to control.
 *
 * `*Installed` is injected rather than probed because reading /Applications
 * made each check pass or fail according to what happened to be on the machine
 * running the suite — so on a CI box, the menu-bar and desktop assertions
 * quietly asserted nothing.
 */
export interface CheckDeps {
  swiftbar?: SwiftBarDeps
  ubersicht?: UbersichtDeps
  swiftbarInstalled?: boolean
  ubersichtInstalled?: boolean
}

export function runChecks(paths: HelmPaths, board: Board, deps: CheckDeps = {}): Check[] {
  return [
    hookInstalled(paths),
    hookErrors(paths),
    hookEnabled(),
    liveDir(paths),
    dataSources(paths),
    registryParse(paths, board),
    prefsHealth(paths, board),
    runtimePaths(paths, deps),
    swiftbar(
      paths, deps.swiftbar ?? defaultSwiftBarDeps(),
      deps.swiftbarInstalled ?? appInstalled(SWIFTBAR_APP, SWIFTBAR_BUNDLE),
    ),
    ubersicht(
      paths, deps.ubersicht ?? defaultUbersichtDeps(),
      deps.ubersichtInstalled ?? appInstalled(UBERSICHT_APP, UBERSICHT_BUNDLE),
    ),
  ]
}

/**
 * `readRegistry` returns `invalid: 0` when it cannot read the directory at
 * all, so the largest possible failure of the primary data source is invisible
 * to the check named after it. This one asks the filesystem directly.
 */
function dataSources(paths: HelmPaths): Check {
  const unreadable = [paths.claudeSessions, paths.claudeProjects].filter(
    (d) => existsSync(d) && !canRead(d),
  )
  if (unreadable.length > 0) {
    return {
      name: '資料來源',
      ok: false,
      detail: `讀不到 ${unreadable.join('、')}，看板會是空的但不會報錯。檢查權限。`,
    }
  }
  const missing = [paths.claudeSessions, paths.claudeProjects].filter((d) => !existsSync(d))
  return missing.length === 0
    ? { name: '資料來源', ok: true, detail: '皆可讀取' }
    : {
      name: '資料來源',
      ok: true,
      detail: `${missing.join('、')} 尚不存在 —— Claude Code 還沒建立它們，屬正常。`,
    }
}

function hookInstalled(paths: HelmPaths): Check {
  const settings = readJson(paths.claudeSettings)
  // "Cannot read the file" is not "the hook is not installed". Saying the
  // latter sends the user to `helm install`, which refuses to run on an
  // unparseable settings.json — advice that walks in a circle. The hook may
  // well be installed and another tool may have broken the file.
  if (settings === UNREADABLE) {
    return {
      name: 'PreToolUse hook',
      ok: false,
      detail: `${paths.claudeSettings} 無法解析，因此無從得知 hook 是否安裝。先修好那個檔案。`,
    }
  }
  const ok = hasHelmHook(settings)
  return {
    name: 'PreToolUse hook',
    ok,
    detail: ok
      ? '已安裝'
      : '未安裝，因此看不到「此刻正在跑什麼」。執行 helm install 安裝。',
  }
}

/**
 * The hook is the project's single exemption from "never swallow errors"
 * (spec §12) — it runs on the critical path and must stay silent there. This
 * check is the compensation that makes the exemption honest; without it those
 * errors really would just vanish.
 */
function hookErrors(paths: HelmPaths): Check {
  // The log being unwritable is worse than the log having contents: every hook
  // error lands there, so if it cannot be opened the hook writes nothing at
  // all — and this very check would report "no errors" while the board stays
  // permanently empty.
  if (!canWriteTo(paths.hookErrorsLog)) {
    return {
      name: 'hook 錯誤紀錄',
      ok: false,
      detail: `${paths.hookErrorsLog} 寫不進去，hook 會完全停擺而且不會留下任何線索。檢查 ${paths.helmHome} 的權限。`,
    }
  }
  const lines = readLines(paths.hookErrorsLog)
  if (lines.length === 0) return { name: 'hook 錯誤紀錄', ok: true, detail: '沒有錯誤' }
  const tail = lines.slice(-ERROR_TAIL_LINES).map((l) => `    ${l}`).join('\n')
  return {
    name: 'hook 錯誤紀錄',
    ok: false,
    detail: `${paths.hookErrorsLog} 有 ${lines.length} 行錯誤，最後 ${Math.min(lines.length, ERROR_TAIL_LINES)} 行：\n${tail}\n    處理完可直接清掉這個檔案。`,
  }
}

/** The kill switch is a feature, but a silently-disabled hook is a trap. */
function hookEnabled(): Check {
  const off = process.env['HELM_OFF'] === '1'
  return {
    name: 'hook 啟用狀態',
    ok: !off,
    detail: off ? 'HELM_OFF=1，hook 目前完全不採集。取消該環境變數即可恢復。' : '啟用中',
  }
}

function liveDir(paths: HelmPaths): Check {
  if (!isDir(paths.helmLive)) {
    return {
      name: 'live 目錄',
      ok: false,
      detail: `${paths.helmLive} 不存在，hook 會寫不進去。執行 helm install。`,
    }
  }
  // The failure text has always been "the hook cannot write there", so check
  // that rather than mere existence.
  const writable = canWrite(paths.helmLive)
  return {
    name: 'live 目錄',
    ok: writable,
    detail: writable
      ? paths.helmLive
      : `${paths.helmLive} 不可寫，hook 會寫不進去。檢查它的權限。`,
  }
}

function registryParse(paths: HelmPaths, board: Board): Check {
  return {
    name: '註冊表解析',
    ok: board.invalid === 0,
    detail: board.invalid === 0
      ? '全部可解析'
      : `有 ${board.invalid} 個檔案無法解析，位於 ${paths.claudeSessions}。多半是 Claude Code 改了格式，或檔案被截斷。`,
  }
}

function prefsHealth(paths: HelmPaths, board: Board): Check {
  if (board.prefsHealth === 'ok') return { name: '偏好檔', ok: true, detail: '正常' }
  return {
    name: '偏好檔',
    ok: false,
    detail: board.prefsHealth === 'quarantined'
      ? `${paths.prefsFile} 無法解析，原檔已保留為 ${quarantinePath(paths.prefsFile)}。修好後改回檔名即可。`
      : `${paths.prefsFile} 無法解析且搬不開（目錄可能不可寫）。helm 不會寫入它 —— 請自行修好或移走該檔。`,
  }
}

/**
 * Whether the things helm installed can actually run.
 *
 * Every other check verifies that a file helm wrote is present. None of them
 * verified what those files hand off to — the pinned interpreter, the entry
 * point, the wrapper the plugin calls. So a version manager deleting an old
 * Node image, or the user tidying ~/.local/bin, or the repo moving, killed the
 * hook and the menu bar while `helm doctor` reported nine green checks. The
 * `hook 錯誤紀錄` check cannot cover this either: the failure happens before
 * record.mjs is loaded, so nothing is ever written to the log and it reports
 * "no errors" precisely when the hook is dead.
 */
function runtimePaths(paths: HelmPaths, deps: CheckDeps): Check {
  const missing = artefacts(paths, deps).flatMap(({ label, needs }) =>
    needs.filter((p) => !existsSync(p)).map((p) => `${label} 指向的 ${p} 不存在`))

  if (missing.length === 0) {
    return {
      name: '執行路徑',
      ok: true,
      detail: artefacts(paths, deps).length === 0 ? '尚未安裝，沒有需要檢查的路徑。' : '都在',
    }
  }
  return {
    name: '執行路徑',
    ok: false,
    detail: `${missing.join('；')}。`
      + '這通常是 Node 升級刪掉了舊版本，或 repo 搬了位置。重跑 helm install 就會指向新的路徑。',
  }
}

interface Artefact {
  label: string
  /** Paths that must exist for this artefact to run at all. */
  needs: string[]
}

function artefacts(paths: HelmPaths, deps: CheckDeps): Artefact[] {
  const found: Artefact[] = []

  const command = helmHookCommand(readJson(paths.claudeSettings))
  if (command !== null) {
    // Only the first two: the interpreter and the recorder. The remaining two
    // arguments are the live directory and the error log — output locations,
    // each with its own check, and the log is *meant* to be absent.
    found.push({ label: 'PreToolUse hook', needs: referencedPaths(command).slice(0, 2) })
  }

  const wrapper = wrapperPath(paths)
  pushScript(found, 'helm wrapper', wrapper)

  const plugin = resolvePluginDir(paths, deps.swiftbar ?? defaultSwiftBarDeps()).dir
  if (plugin !== null) pushScript(found, 'SwiftBar plugin', join(plugin, PLUGIN_NAME))

  const widgets = resolveWidgetDir(paths, deps.ubersicht ?? defaultUbersichtDeps()).dir
  if (widgets !== null) pushScript(found, '桌面 widget', join(widgets, WIDGET_NAME))

  return found
}

function pushScript(into: Artefact[], label: string, file: string): void {
  let body: string
  try {
    body = readFileSync(file, 'utf8')
  } catch {
    // Not installed, or not ours to read. Whether the file itself should be
    // there is a different check's job; this one is about what it points at.
    return
  }
  into.push({ label, needs: referencedPaths(body) })
}

function wrapperPath(paths: HelmPaths): string {
  return join(paths.home, '.local', 'bin', 'helm')
}

function swiftbar(paths: HelmPaths, deps: SwiftBarDeps, installed: boolean): Check {
  if (!installed) {
    return {
      name: 'SwiftBar',
      ok: false,
      detail: '未安裝，選單列看板無法運作。brew install --cask swiftbar，裝好後執行 helm install。',
    }
  }
  // Checked against the folder SwiftBar actually scans, not the one helm would
  // have picked. Those differing is precisely the failure that looks like
  // success: plugin installed, executable, and the menu bar still empty.
  const scan = resolvePluginDir(paths, deps)
  if (scan.dir === null) {
    return { name: 'SwiftBar', ok: false, detail: scan.warning ?? '設定讀不到。' }
  }
  const plugin = join(scan.dir, PLUGIN_NAME)
  if (!existsSync(plugin)) {
    return {
      name: 'SwiftBar',
      ok: false,
      detail: `SwiftBar 掃描的是 ${scan.dir}，裡面沒有 helm 的 plugin。執行 helm install。`,
    }
  }
  // SwiftBar only runs plugins with the executable bit set, and a plugin that
  // lost it fails silently — the menu bar simply shows nothing.
  const executable = canAccess(plugin, constants.X_OK)
  return {
    name: 'SwiftBar',
    ok: executable,
    detail: executable ? plugin : `${plugin} 沒有執行權限，SwiftBar 不會跑它。chmod +x 或重跑 helm install。`,
  }
}

/**
 * The desktop half. Same failure mode as SwiftBar and checked the same way:
 * against the folder Übersicht actually scans, because a widget written
 * anywhere else leaves every check green and the wallpaper bare.
 */
function ubersicht(paths: HelmPaths, deps: UbersichtDeps, installed: boolean): Check {
  if (!installed) {
    return {
      name: 'Übersicht',
      ok: false,
      detail: '未安裝，桌面看板無法運作。brew install --cask ubersicht，裝好後執行 helm install。',
    }
  }
  const scan = resolveWidgetDir(paths, deps)
  if (scan.dir === null) {
    return { name: 'Übersicht', ok: false, detail: scan.warning ?? '設定讀不到。' }
  }
  const widget = join(scan.dir, WIDGET_NAME)
  if (!existsSync(widget)) {
    return {
      name: 'Übersicht',
      ok: false,
      detail: `Übersicht 掃描的是 ${scan.dir}，裡面沒有 helm 的 widget。執行 helm install。`,
    }
  }
  return { name: 'Übersicht', ok: true, detail: widget }
}

/**
 * Spec §4.3. Two rules, and the gap between them is deliberate: a live file
 * whose session helm cannot account for might be the only surviving evidence
 * of a crash (§6's last row), so it is kept until it is old enough to be
 * certainly irrelevant. Sweeping it early would erase that with nobody
 * noticing — the exact failure this whole board exists to prevent.
 */
export function sweepStaleLive(paths: HelmPaths, board: Board, nowMs: number): string[] {
  // High confidence only. A `low` verdict means helm could not actually tell
  // how the session ended, and deleting on a guess makes the guess permanent.
  const ended = new Set(
    board.projects
      .flatMap((p) => p.sessions)
      .filter((s) => s.lifecycle === 'ended_clean' && s.lifecycleConfidence === 'high')
      .map((s) => s.sessionId),
  )
  return listJson(paths.helmLive).flatMap((name) => {
    const file = join(paths.helmLive, name)
    const sessionId = name.slice(0, -'.json'.length)
    const expired = ageOf(file, nowMs) > ORPHAN_MAX_AGE_MS
    // A marker helm cannot read is never deleted on the strength of a verdict
    // that was reached *because* it could not be read. Only sheer age clears
    // it, which still bounds how many can pile up.
    const readable = readLiveMarker(paths.helmLive, sessionId)?.degraded === false
    if (!expired && !(readable && ended.has(sessionId))) return []
    return removeQuietly(file) ? [name] : []
  })
}

function ageOf(file: string, nowMs: number): number {
  try {
    return nowMs - statSync(file).mtimeMs
  } catch {
    // Vanished between listing and stat. Reporting age 0 means "not expired",
    // so it is skipped this round rather than acted on with stale information.
    return 0
  }
}

/**
 * Reports what actually went away. `rmSync` with `force` never errors, so
 * counting its calls would inflate "swept N files" with entries that were
 * already gone — or with ones it silently failed to touch, like a directory
 * that happens to end in .json.
 */
function removeQuietly(file: string): boolean {
  try {
    rmSync(file, { force: true })
    return !existsSync(file)
  } catch {
    // Cleanup is off the critical path. A file we cannot delete is reported as
    // "not deleted" and retried next time, never escalated to the user.
    return false
  }
}

function listJson(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    // No live directory means nothing to sweep — the normal state before
    // `helm install` has ever run.
    return []
  }
}

const UNREADABLE = Symbol('unreadable')

function canRead(path: string): boolean {
  return canAccess(path, constants.R_OK | constants.X_OK)
}

function canWrite(path: string): boolean {
  return canAccess(path, constants.W_OK)
}

/** A file helm may not have created yet is writable if its directory is. */
function canWriteTo(file: string): boolean {
  return existsSync(file) ? canWrite(file) : canWrite(dirname(file))
}

function canAccess(path: string, mode: number): boolean {
  try {
    accessSync(path, mode)
    return true
  } catch {
    return false
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Missing and unparseable are different findings and must not be merged. */
function readJson(file: string): unknown {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return UNREADABLE
  }
}

function readLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '')
  } catch {
    // No log file is the healthy case.
    return []
  }
}
