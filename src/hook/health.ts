import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Board } from '../board.ts'
import type { HelmPaths } from '../paths.ts'
import { quarantinePath } from '../projects/prefs.ts'
import { hasHelmHook } from './settings.ts'

const ORPHAN_MAX_AGE_MS = 30 * 86_400_000
const ERROR_TAIL_LINES = 5
const SWIFTBAR_APP = '/Applications/SwiftBar.app'
const PLUGIN_NAME = 'helm.5s.sh'

export interface Check {
  name: string
  ok: boolean
  /** Always says what to do next when `ok` is false. A finding with no next step is noise. */
  detail: string
}

export function runChecks(paths: HelmPaths, board: Board): Check[] {
  return [
    hookInstalled(paths),
    hookErrors(paths),
    hookEnabled(),
    liveDir(paths),
    registryParse(paths, board),
    prefsHealth(paths, board),
    swiftbar(paths),
  ]
}

function hookInstalled(paths: HelmPaths): Check {
  const ok = hasHelmHook(readJson(paths.claudeSettings))
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
  const lines = readLines(paths.hookErrorsLog)
  if (lines.length === 0) return { name: 'hook 錯誤紀錄', ok: true, detail: '沒有錯誤' }
  const tail = lines.slice(-ERROR_TAIL_LINES).map((l) => `    ${l}`).join('\n')
  return {
    name: 'hook 錯誤紀錄',
    ok: false,
    detail: `${lines.length} 行錯誤，最後 ${Math.min(lines.length, ERROR_TAIL_LINES)} 行：\n${tail}`,
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
  const ok = isDir(paths.helmLive)
  return {
    name: 'live 目錄',
    ok,
    detail: ok
      ? paths.helmLive
      : `${paths.helmLive} 不存在，hook 會寫不進去。執行 helm install。`,
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

function swiftbar(paths: HelmPaths): Check {
  if (!existsSync(SWIFTBAR_APP)) {
    return {
      name: 'SwiftBar',
      ok: false,
      detail: '未安裝，選單列看板無法運作。brew install --cask swiftbar，裝好後執行 helm install。',
    }
  }
  const plugin = join(paths.home, 'Library', 'Application Support', 'SwiftBar', PLUGIN_NAME)
  const ok = existsSync(plugin)
  return { name: 'SwiftBar', ok, detail: ok ? plugin : 'plugin 未安裝，執行 helm install。' }
}

/**
 * Spec §4.3. Two rules, and the gap between them is deliberate: a live file
 * whose session helm cannot account for might be the only surviving evidence
 * of a crash (§6's last row), so it is kept until it is old enough to be
 * certainly irrelevant. Sweeping it early would erase that with nobody
 * noticing — the exact failure this whole board exists to prevent.
 */
export function sweepStaleLive(paths: HelmPaths, board: Board, nowMs: number): string[] {
  const ended = new Set(
    board.projects
      .flatMap((p) => p.sessions)
      .filter((s) => s.lifecycle === 'ended_clean')
      .map((s) => s.sessionId),
  )
  return listJson(paths.helmLive).flatMap((name) => {
    const file = join(paths.helmLive, name)
    const sessionId = name.slice(0, -'.json'.length)
    if (!ended.has(sessionId) && ageOf(file, nowMs) <= ORPHAN_MAX_AGE_MS) return []
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

function removeQuietly(file: string): boolean {
  try {
    rmSync(file, { force: true })
    return true
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

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // A missing or corrupt settings.json is itself the finding; returning null
    // lets `hasHelmHook` report "not installed" rather than throwing.
    return null
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
