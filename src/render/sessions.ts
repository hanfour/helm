import type { ProjectView } from '../projects/group.ts'
import { UNEARNED_LABEL, isUnearnedClaim, statusOf, type StatusKey } from '../session-status.ts'
import { taskLabelOf } from '../task-status.ts'
import type { SessionState } from '../types.ts'
import { dim, glyph, relativeTime } from './glyphs.ts'
import type { RenderOptions } from './table.ts'
import { padTo } from './width.ts'

const SHORT_ID = 8

/** Three CJK characters each, so the column lines up without padEnd tricks. */
const LABEL: Record<StatusKey, string> = {
  busy: '執行中',
  idle: '等輸入',
  ended: '已結束',
  crashed: '已中斷',
}

/**
 * The session-level view the board used to show for everything. It survives as
 * a drill-down: the user asked for this project by name, so the 20-odd rows
 * underneath it are what they came for rather than noise they have to wade
 * through to find one project.
 */
export function renderSessions(project: ProjectView, opts: RenderOptions): string {
  const head = `${project.pinned ? '📌 ' : ''}${project.name}  ${dim(project.path, opts.color)}`
  if (project.sessions.length === 0) {
    return `${head}\n  這個專案底下沒有 session。\n`
  }
  const rows = project.sessions.map((s) => `  ${renderSession(s, opts)}`)
  return `${head}\n${rows.join('\n')}\n${renderFooter(project, opts)}`
}

function renderSession(s: SessionState, opts: RenderOptions): string {
  const key = statusOf(s)
  const head = [
    glyph(key, s.lifecycleConfidence, opts.color),
    isUnearnedClaim(s) ? UNEARNED_LABEL : LABEL[key],
    padTo(s.sessionId.slice(0, SHORT_ID), SHORT_ID),
    relativeTime(s.updatedAt, opts.nowMs),
  ].join('  ')
  return `${head}${taskSuffix(s)}${liveSuffix(s)}${resumeHint(s, key, opts)}`
}

/** 只有問過的 session 才有這一段。沒問過的不畫空欄位。 */
function taskSuffix(s: SessionState): string {
  const label = taskLabelOf(s.taskStatus)
  return label === null ? '' : `  ${label}`
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

function renderFooter(project: ProjectView, opts: RenderOptions): string {
  return dim(`\n${project.sessionCount} 個 session・helm brief <id> 看某個 session 做到哪\n`, opts.color)
}
