import type { Board } from '../board.ts'
import type { ProjectView } from '../projects/group.ts'
import { ACTIVITY_WINDOW_DAYS } from '../projects/include.ts'
import { UNEARNED_LABEL, isUnearnedClaim, statusOf, type StatusKey } from '../session-status.ts'
import type { Confidence, SessionState } from '../types.ts'
import { dim, markOf, paint, relativeTime } from './glyphs.ts'
import { displayWidth, padTo } from './width.ts'

export interface RenderOptions {
  color: boolean
  nowMs: number
}

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

/** Project-row wording, which describes sessions rather than naming a state. */
const NOTE: Record<StatusKey, string> = {
  crashed: '中斷未回收',
  busy: '在跑',
  idle: '等輸入',
  ended: '已結束',
}

/** Worst first: an abandoned session is the one thing the user must not miss. */
const NOTE_ORDER: readonly StatusKey[] = ['crashed', 'busy', 'idle']

/** Two columns so a low-confidence mark (`●?`) does not shift the row. */
const MARK_COLUMNS = 2
const GAP = '  '

/**
 * One row per project (spec revision, Task 13). A session-level board was
 * measured at 158 rows against 12 real projects on this machine — handing the
 * user that list just recreates the `claude --resume` problem it exists to
 * solve. `helm sessions <project>` drills down when they actually want it.
 */
export function renderTable(board: Board, opts: RenderOptions): string {
  const { projects, invalid } = board
  const warning = renderInvalidWarning(invalid, opts) + renderPrefsWarning(board, opts)
  if (projects.length === 0) {
    return `沒有找到符合條件的專案。\n（近 ${ACTIVITY_WINDOW_DAYS} 天內有活動、且是 git repo 的專案才會列出）\n${warning}`
  }
  const rows = projects.map((p) => cellsOf(p, opts))
  const widths = columnWidths(rows)
  const body = projects
    .map((p, i) => renderRow(p, rows[i] as Cells, widths, opts))
    .join('\n')
  return `${body}\n${renderSummary(projects)}\n${renderHint(opts)}${warning}`
}

interface Cells {
  mark: string
  name: string
  time: string
  note: string
  count: string
}

function cellsOf(p: ProjectView, opts: RenderOptions): Cells {
  return {
    mark: p.aggregateStatus === null
      ? ''
      : markOf(p.aggregateStatus, confidenceOf(p, p.aggregateStatus)),
    name: `${p.pinned ? '📌 ' : ''}${p.name}`,
    time: relativeTime(p.lastActivityMs, opts.nowMs),
    note: noteOf(p),
    count: `${p.sessionCount} 個 session`,
  }
}

function columnWidths(rows: readonly Cells[]): { name: number; time: number; note: number } {
  const widest = (pick: (c: Cells) => string) =>
    Math.max(...rows.map((r) => displayWidth(pick(r))))
  return {
    name: widest((c) => c.name),
    time: widest((c) => c.time),
    note: widest((c) => c.note),
  }
}

function renderRow(
  p: ProjectView,
  cells: Cells,
  widths: { name: number; time: number; note: number },
  opts: RenderOptions,
): string {
  const mark = padTo(cells.mark, MARK_COLUMNS)
  const painted = p.aggregateStatus === null
    ? mark
    : paint(p.aggregateStatus, mark, opts.color)
  return [
    `${painted}${GAP}${padTo(cells.name, widths.name)}`,
    padTo(cells.time, widths.time),
    padTo(cells.note, widths.note),
    dim(cells.count, opts.color),
  ].join(GAP).trimEnd()
}

/**
 * A project's dot inherits the doubt of whichever session produced it. Hiding
 * that would present a guess as a fact — the same failure the `?` suffix was
 * introduced to prevent at the session level.
 */
function confidenceOf(p: ProjectView, key: StatusKey): Confidence {
  const deciding = p.sessions.filter((s) => statusOf(s) === key)
  return deciding.some((s) => s.lifecycleConfidence === 'low') ? 'low' : 'high'
}

/** Ended sessions are omitted: the session count already covers them. */
function noteOf(p: ProjectView): string {
  const counts = p.sessions.reduce<Record<string, number>>(
    (acc, s) => ({ ...acc, [statusOf(s)]: (acc[statusOf(s)] ?? 0) + 1 }),
    {},
  )
  return NOTE_ORDER
    .filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => `${counts[k]} 個${NOTE[k]}`)
    .join('・')
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

/**
 * Pins and hidden flags are user intent and cannot be rebuilt from anything.
 * Resetting them without a word would leave the user believing they had never
 * set them — so say it, and say where the original went.
 */
function renderPrefsWarning(board: Board, opts: RenderOptions): string {
  if (board.prefsHealth === 'ok') return ''
  const where = board.prefsHealth === 'quarantined'
    ? '原檔已保留為同目錄下的 projects.corrupt.json，修好後改回檔名即可。（helm doctor 會告訴你完整路徑）'
    : '原檔還在原地但搬不開（目錄可能不可寫），helm 不會寫入它 —— 請自行處理。'
  return dim(`\n⚠ 偏好檔無法解析，這次的釘選與隱藏設定沒有生效。\n  ${where}\n`, opts.color)
}

/**
 * Buckets by the label a session would actually be given, not by its raw
 * status key — and marks a bucket that contains a guess.
 *
 * Measured 2026-08-13: this line read 「已中斷 2・…・已結束 142」while both
 * crashes were low-confidence Codex verdicts and five of the 142 were
 * `isUnearnedClaim`, which `helm sessions` prints as 「沒有動靜」. Every other
 * face carries a `?` or the unearned label; this one stated all of it flat.
 * `session-status.ts` says every face that renders a label has to ask — this
 * is the face that forgot.
 */
function renderSummary(projects: readonly ProjectView[]): string {
  const sessions = projects.flatMap((p) => p.sessions)
  const parts = SUMMARY_ORDER.flatMap((label) => {
    const inBucket = sessions.filter((s) => summaryLabel(s) === label)
    if (inBucket.length === 0) return []
    // 「沒有動靜」already says helm does not know, so a `?` on top of it would
    // be saying the same thing twice.
    const guess = label !== UNEARNED_LABEL
      && inBucket.some((s) => s.lifecycleConfidence === 'low')
    return [`${label} ${inBucket.length}${guess ? '?' : ''}`]
  })
  return `\n${projects.length} 個專案・${parts.join('・')}`
}

/** Worst first, with the admission last — it is the least actionable. */
const SUMMARY_ORDER: readonly string[] = [
  LABEL.crashed, LABEL.busy, LABEL.idle, LABEL.ended, UNEARNED_LABEL,
]

function summaryLabel(s: SessionState): string {
  return isUnearnedClaim(s) ? UNEARNED_LABEL : LABEL[statusOf(s)]
}

/** The board is now one row per project, so the way down has to be signposted. */
function renderHint(opts: RenderOptions): string {
  return dim('helm sessions <專案> 看該專案的 session・helm open <專案> 接續\n', opts.color)
}
