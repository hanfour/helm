import type { StatusResult } from '../cli/status.ts'
import type { ProjectView } from '../projects/group.ts'
import type { SessionState } from '../types.ts'
import { dim, glyph, relativeTime, statusOf, type StatusKey } from './glyphs.ts'

export interface RenderOptions {
  color: boolean
  nowMs: number
}

const SHORT_ID = 8

/**
 * All four labels are exactly three CJK characters wide on purpose: a CJK
 * glyph occupies two terminal columns, so padEnd() with ASCII spaces can
 * never align them. Equal length is the only thing that lines the column up.
 */
const LABEL: Record<StatusKey, string> = {
  busy: '執行中',
  idle: '等輸入',
  ended: '已結束',
  crashed: '已中斷',
}

export function renderTable(result: StatusResult, opts: RenderOptions): string {
  const { projects, invalid } = result
  const warning = renderInvalidWarning(invalid, opts)
  if (projects.length === 0) {
    return `沒有找到符合條件的專案。\n（近 14 天內有活動、且是 git repo 的專案才會列出）\n${warning}`
  }
  const body = projects.map((p) => renderProject(p, opts)).join('\n\n')
  return `${body}\n${renderSummary(projects)}\n${warning}`
}

/**
 * Silent data loss is the worst failure mode for a board whose whole promise
 * is "nothing gets forgotten". If a registry file could not be parsed, the
 * user must be told a session is missing rather than shown a short list.
 */
function renderInvalidWarning(invalid: number, opts: RenderOptions): string {
  if (invalid === 0) return ''
  return dim(`\n⚠ 有 ${invalid} 個 session 記錄無法解析，未列於上方。執行 helm doctor 查看原因。\n`, opts.color)
}

function renderProject(p: ProjectView, opts: RenderOptions): string {
  const head = `${p.pinned ? '📌 ' : ''}${p.name}  ${dim(p.path, opts.color)}`
  return [head, ...p.sessions.map((s) => `  ${renderSession(s, opts)}`)].join('\n')
}

function renderSession(s: SessionState, opts: RenderOptions): string {
  const key = statusOf(s)
  const head = [
    glyph(key, s.lifecycleConfidence, opts.color),
    LABEL[key],
    s.sessionId.slice(0, SHORT_ID),
    relativeTime(s.updatedAt, opts.nowMs),
  ].join('  ')
  return `${head}${liveSuffix(s)}${resumeHint(s, key, opts)}`
}

/** The live marker only means anything while the session is actually working. */
function liveSuffix(s: SessionState): string {
  if (s.live === null || s.nativeStatus !== 'busy') return ''
  const summary = s.live.summary === '' ? '' : `: ${s.live.summary}`
  return `  -> ${s.live.toolName}${summary}`
}

function resumeHint(s: SessionState, key: StatusKey, opts: RenderOptions): string {
  if (key !== 'crashed') return ''
  return `  ${dim(`helm open ${s.sessionId.slice(0, SHORT_ID)}`, opts.color)}`
}

function renderSummary(projects: readonly ProjectView[]): string {
  const counts = projects
    .flatMap((p) => p.sessions)
    .reduce<Record<StatusKey, number>>(
      (acc, s) => ({ ...acc, [statusOf(s)]: acc[statusOf(s)] + 1 }),
      { busy: 0, idle: 0, ended: 0, crashed: 0 },
    )
  const parts = (['crashed', 'busy', 'idle', 'ended'] as const)
    .filter((k) => counts[k] > 0)
    .map((k) => `${LABEL[k]} ${counts[k]}`)
  return `\n${projects.length} 個專案・${parts.join('・')}`
}
