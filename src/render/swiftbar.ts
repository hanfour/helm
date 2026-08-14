import type { Board } from '../board.ts'
import type { ProjectView } from '../projects/group.ts'
import { ACTIVITY_WINDOW_DAYS } from '../projects/include.ts'
import { isUnearnedClaim, statusOf, UNEARNED_LABEL, type StatusKey } from '../session-status.ts'
import { taskLabelOf } from '../task-status.ts'
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
  return `${[
    renderTitle(board.projects),
    '---',
    ...renderBody(board, opts),
    '---',
    '重新整理 | refresh=true',
    `helm doctor | bash="${opts.helmBin}" param1=doctor terminal=true`,
  ].join('\n')}\n`
}

/**
 * Counts sessions, not projects — the same unit the desktop widget uses.
 *
 * The two surfaces must agree: they used to differ, so one project with three
 * running sessions gave 「⚓ 3 在跑」in the menu bar and 「1 在跑」on the desktop
 * at the same moment, and the screen carries only the number.
 *
 * That was unified on projects, which was the wrong side. Measured
 * 2026-08-13: two terminals running, both with cwd `super-dsp-2.0`, and the
 * menu bar said 「1 在跑」— indistinguishable from a single terminal. Several
 * terminals in one repository is the ordinary way to work, and rolling them
 * up made the most common case the one the title could not express. What the
 * user counts is terminals, and one terminal is one session.
 */
function renderTitle(projects: readonly ProjectView[]): string {
  const sessions = projects.flatMap((p) => p.sessions)
  for (const key of ['crashed', 'busy', 'idle'] as const) {
    const matched = sessions.filter((s) => statusOf(s) === key)
    if (matched.length === 0) continue
    const { word } = TITLE[key]
    const color = titleColor(key, matched)
    // Same `?` the dot carries one level down, for the same reason: the
    // roll-up must not launder a guess into a fact. Codex verdicts are always
    // low confidence (`decideCodexLifecycle`), so without this the title
    // states as certain the one thing helm inferred rather than read.
    return `⚓ ${matched.length} ${word}${isGuess(matched) ? '?' : ''}`
      + (color === '' ? '' : ` | color=${color}`)
  }
  return '⚓'
}

function isGuess(sessions: readonly SessionState[]): boolean {
  return sessions.some((s) => s.lifecycleConfidence === 'low')
}

/**
 * Red is reserved for a crash helm actually verified.
 *
 * Reported 2026-08-13: the menu bar went red with 「1 中斷」, the user went
 * looking and found nothing — it was a Codex session idle for 44 minutes,
 * which `decideCodexLifecycle` calls crashed on a 30-minute timer and always
 * at low confidence. `lifecycle.ts` already says twelve false red dots would
 * bury a real one; this is that, in the one place the whole screen shows.
 *
 * One verified crash still earns red even when guesses sit beside it.
 */
function titleColor(key: Exclude<StatusKey, 'ended'>, matched: readonly SessionState[]): string {
  if (key !== 'crashed') return TITLE[key].color
  return matched.some((s) => s.lifecycleConfidence !== 'low') ? 'red' : 'orange'
}

function renderBody(board: Board, opts: MenuOptions): string[] {
  // Warnings belong on the empty board too — arguably more so. Corrupt prefs
  // disable pinning, pinned projects lose their exemption from the activity
  // window, and the board empties out; "no matching projects" would then be
  // the only thing the user is told about a machine where something broke.
  const warnings = renderWarnings(board, opts)
  // The empty-board branch used to return early past `renderPrs`, so a user
  // back from holiday saw nothing at all in the menu bar while the desktop
  // widget showed their pull requests and a 「gh 尚未登入」notice. Same board,
  // two answers — which is worse than either being incomplete.
  const rows = board.projects.length === 0
    ? [`沒有符合條件的專案（近 ${ACTIVITY_WINDOW_DAYS} 天內有活動且是 git repo）`]
    : board.projects.flatMap((p) => renderProject(p, opts))
  return [...rows, ...renderPrs(board, opts), ...warnings]
}

/** Degradation must be visible here too, not only in the terminal view. */
/**
 * A section of its own, not a line under each project.
 *
 * Mapping `owner/repo` back to a local path would mean reading every
 * project's git remote, and anything that failed to match would simply
 * vanish — measured here, the only open pull request belongs to a repository
 * that is not on the board at all. The question this answers is "what is
 * waiting on me", which was never a per-project question anyway.
 */
function renderPrs(board: Board, opts: MenuOptions): string[] {
  // Kept out of the early return below: two of the three messages `refresh.ts`
  // writes here — `listing.truncated` and the sweep's own「只更新了 N/M 個」—
  // mean "this list is partial", not "there is no list", and they arrive
  // *alongside* the pull requests they are counting. Returning early on them
  // printed「只更新了 12/50 個」and then drew none of the twelve.
  const warning = board.prDegraded === null
    ? []
    : [`⚠ ${clean(board.prDegraded)} | color=orange`]
  if (board.prs.length === 0) return warning.length === 0 ? [] : ['---', ...warning]
  return [
    '---',
    'PR',
    ...board.prs.map((pr) =>
      `--${clean(`${pr.repo}#${pr.number}`)}  ${clean(pr.waitingLabel)}  ${label(pr.title)}`
      // Quoted like every other value that lands in SwiftBar's parameter
      // region: `clean()` strips `|` and control characters but keeps spaces,
      // and everything after `|` is split on whitespace into key=value pairs.
      + ` | href=${param(pr.url)}`),
    // After the list, not before: it is a footnote about the list's
    // completeness, and top-level so it is visible without opening the submenu.
    ...warning,
  ]
}

function renderWarnings(board: Board, opts: MenuOptions): string[] {
  const rows: string[] = []
  if (board.invalid > 0) {
    rows.push(`⚠ 有 ${board.invalid} 個 session 記錄無法解析 | color=orange`)
  }
  for (const failure of board.adapterFailures) {
    rows.push(`⚠ ${clean(failure)} | color=orange`)
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
  // Same split as the title: a project the user is actively working in must
  // not go red because one Codex session in it passed a 30-minute timer.
  const color = p.aggregateStatus === 'crashed'
    ? ` | color=${titleColor('crashed', p.sessions.filter((s) => statusOf(s) === 'crashed'))}`
    : ''
  const name = label(p.name)
  return [
    `${p.pinned ? '📌 ' : ''}${name}  ${relativeTime(p.lastActivityMs, opts.nowMs)}${color}`,
    ...p.sessions.flatMap((s) => renderSession(s, opts)),
    `--隱藏此專案 | bash="${opts.helmBin}" param1=hide param2=-- param3=${param(p.name)} terminal=false refresh=true`,
  ]
}

function renderSession(s: SessionState, opts: MenuOptions): string[] {
  const key = statusOf(s)
  // Session ids are not validated as UUIDs anywhere upstream (`registry.ts`
  // accepts any non-empty string, and transcript filenames are just names), so
  // they are cleaned like every other untrusted value — `live.ts` says as much
  // about the very same field.
  const short = clean(s.sessionId).slice(0, SHORT_ID)
  const mark = `${SHAPE[key]}${s.lifecycleConfidence === 'low' ? '?' : ''}`
  const label = isUnearnedClaim(s) ? UNEARNED_LABEL : LABEL[key]
  return [
    `--${mark} ${label}  ${short}  ${relativeTime(s.updatedAt, opts.nowMs)}${taskSuffix(s)}${liveSuffix(s)}`,
    `----開終端機接續 | bash="${opts.helmBin}" param1=open param2=-- param3=${param(short)} terminal=false refresh=true`,
    // Generating a brief takes the measured 57-86 s, so it opens a terminal
    // where the user can watch it rather than appearing to hang the menu.
    `----看交接簡報 | bash="${opts.helmBin}" param1=brief param2=-- param3=${param(short)} terminal=true`,
  ]
}

/** 與 helm sessions 同一個詞、同一個「沒有就不畫」的規則。 */
function taskSuffix(s: SessionState): string {
  const label = taskLabelOf(s.taskStatus)
  return label === null ? '' : `  ${clean(label)}`
}

/** The one thing no file on disk can tell us — what the session is doing right now. */
function liveSuffix(s: SessionState): string {
  if (s.live === null || s.nativeStatus !== 'busy') return ''
  const summary = s.live.summary === '' ? '' : `: ${clean(s.live.summary)}`
  return `  → ${clean(s.live.toolName)}${summary}`
}

/**
 * Everything user-controlled passes through here. `|` separates a SwiftBar
 * line from its parameters, and any control character can end the line or
 * repaint it: a lone CR forges an entire extra menu row, and U+2028 is a line
 * separator that survives `JSON.parse` intact.
 *
 * The values are not exotic. A summary is whatever command the user ran
 * (`ps aux | grep node`), and a project name is a directory name, which APFS
 * happily lets contain a carriage return.
 */
function clean(text: string): string {
  return [...text.split('|').join('')]
    .map((ch) => (isControl(ch) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

function isControl(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0
  return cp < 0x20 || cp === 0x7f || cp === 0x2028 || cp === 0x2029
}

/**
 * A leading `--` is SwiftBar's nesting syntax, so a project literally named
 * `--evil` would be read as a submenu item of whatever came before it. The
 * name is also unusable as a `helm hide` argument, since argv parsing treats
 * it as a flag — so it is displayed with the dashes escaped rather than
 * silently misplaced.
 */
function label(name: string): string {
  const cleaned = clean(name)
  if (cleaned === '') return '（無法顯示的名稱）'
  return cleaned.startsWith('--') ? `\u2011\u2011${cleaned.slice(2)}` : cleaned
}

/**
 * Parameter values are quoted because everything after the first `|` is parsed
 * as `key=value` pairs split on whitespace: an unquoted project name with a
 * space truncates the argument, and one containing `param1=` overrides the
 * subcommand outright.
 */
function param(value: string): string {
  return `"${clean(value).split('"').join('')}"`
}
