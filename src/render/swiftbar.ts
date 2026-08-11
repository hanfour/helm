import type { Board } from '../board.ts'
import type { ProjectView } from '../projects/group.ts'
import { statusOf, type StatusKey } from '../session-status.ts'
import type { SessionState } from '../types.ts'
import { relativeTime } from './glyphs.ts'

const SHORT_ID = 8

export interface MenuOptions {
  nowMs: number
  /** Absolute path: SwiftBar runs plugins with a minimal PATH. */
  helmBin: string
}

const SHAPE: Record<StatusKey, string> = {
  busy: '●', idle: '○', ended: '●', crashed: '●',
}

const LABEL: Record<StatusKey, string> = {
  busy: '執行中', idle: '等輸入', ended: '已結束', crashed: '已中斷',
}

const TITLE: Record<Exclude<StatusKey, 'ended'>, { word: string; color: string }> = {
  crashed: { word: '中斷', color: 'red' },
  busy: { word: '在跑', color: 'green' },
  idle: { word: '等輸入', color: '' },
}

/**
 * SwiftBar reads the first line as the menu bar title, then `---`, then the
 * dropdown. `--` prefixes nest one level, and everything after the first `|`
 * on a line is parsed as parameters.
 *
 * Spec §11.1: the title shows whatever most needs attention, and is red
 * whenever anything is crashed.
 */
export function renderSwiftBar(board: Board, opts: MenuOptions): string {
  const sessions = board.projects.flatMap((p) => p.sessions)
  return `${[
    renderTitle(sessions),
    '---',
    ...renderBody(board, opts),
    '---',
    '重新整理 | refresh=true',
    `helm doctor | bash="${opts.helmBin}" param1=doctor terminal=true`,
  ].join('\n')}\n`
}

function renderTitle(sessions: readonly SessionState[]): string {
  const keys = sessions.map(statusOf)
  for (const key of ['crashed', 'busy', 'idle'] as const) {
    const n = keys.filter((k) => k === key).length
    if (n === 0) continue
    const { word, color } = TITLE[key]
    return `⚓ ${n} ${word}${color === '' ? '' : ` | color=${color}`}`
  }
  return '⚓'
}

function renderBody(board: Board, opts: MenuOptions): string[] {
  if (board.projects.length === 0) {
    return ['沒有符合條件的專案（近 14 天內有活動且是 git repo）']
  }
  return [
    ...board.projects.flatMap((p) => renderProject(p, opts)),
    ...renderWarnings(board, opts),
  ]
}

/** Degradation must be visible here too, not only in the terminal view. */
function renderWarnings(board: Board, opts: MenuOptions): string[] {
  const rows: string[] = []
  if (board.invalid > 0) {
    rows.push(`⚠ 有 ${board.invalid} 個 session 記錄無法解析 | color=orange`)
  }
  if (board.prefsHealth !== 'ok') {
    rows.push('⚠ 偏好檔無法解析，釘選與隱藏沒有生效 | color=orange')
  }
  if (rows.length > 0) {
    rows.push(`--看原因 | bash="${opts.helmBin}" param1=doctor terminal=true`)
  }
  return rows
}

function renderProject(p: ProjectView, opts: MenuOptions): string[] {
  const color = p.aggregateStatus === 'crashed' ? ' | color=red' : ''
  const name = clean(p.name)
  return [
    `${p.pinned ? '📌 ' : ''}${name}  ${relativeTime(p.lastActivityMs, opts.nowMs)}${color}`,
    ...p.sessions.flatMap((s) => renderSession(s, opts)),
    `--隱藏此專案 | bash="${opts.helmBin}" param1=hide param2=${name} terminal=false refresh=true`,
  ]
}

function renderSession(s: SessionState, opts: MenuOptions): string[] {
  const key = statusOf(s)
  const short = s.sessionId.slice(0, SHORT_ID)
  const mark = `${SHAPE[key]}${s.lifecycleConfidence === 'low' ? '?' : ''}`
  return [
    `--${mark} ${LABEL[key]}  ${short}  ${relativeTime(s.updatedAt, opts.nowMs)}${liveSuffix(s)}`,
    `----開終端機接續 | bash="${opts.helmBin}" param1=open param2=${short} terminal=false refresh=true`,
    // Generating a brief takes the measured 57-86 s, so it opens a terminal
    // where the user can watch it rather than appearing to hang the menu.
    `----看交接簡報 | bash="${opts.helmBin}" param1=brief param2=${short} terminal=true`,
  ]
}

/** The one thing no file on disk can tell us — what the session is doing right now. */
function liveSuffix(s: SessionState): string {
  if (s.live === null || s.nativeStatus !== 'busy') return ''
  const summary = s.live.summary === '' ? '' : `: ${clean(s.live.summary)}`
  return `  → ${clean(s.live.toolName)}${summary}`
}

/**
 * `|` separates a SwiftBar line from its parameters and a newline ends the
 * line outright. Both reach here from the live marker, whose summary is
 * whatever command the user happened to run — `ps aux | grep node` would
 * otherwise silently break the row it appears in.
 */
function clean(text: string): string {
  return text.split('|').join('').split('\n').join(' ').trim()
}
