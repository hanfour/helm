import type { ToolCall, TranscriptDigest } from '../adapters/claude-code/transcript.ts'
import type { SessionState } from '../types.ts'

export interface GitSnapshot {
  diffStat: string
  statusShort: string
}

export interface SummaryInput {
  sessionId: string
  cwd: string
  gitBranch: string | null
  prompts: string[]
  touchedFiles: string[]
  recentTools: ToolCall[]
  gitDiffStat: string
  gitStatusShort: string
}

export function buildSummaryInput(
  session: SessionState,
  digest: TranscriptDigest,
  git: GitSnapshot,
): SummaryInput {
  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    gitBranch: digest.gitBranch,
    prompts: [...digest.prompts],
    touchedFiles: [...digest.touchedFiles],
    recentTools: [...digest.recentTools],
    gitDiffStat: git.diffStat,
    gitStatusShort: git.statusShort,
  }
}

const FIELDS = `{
  "goal":        "這個 session 想達成什麼（一句話）",
  "done":        ["已經完成的事，每項一句"],
  "currentStep": "中斷當下正在做的那一步",
  "nextStep":    "回來後應該做的下一件事；已經做完就留空字串",
  "blockers":    ["卡住的地方；沒有就空陣列"],
  "files":       ["相關檔案路徑"],
  "prs":         ["相關的 PR 編號或網址；沒有就空陣列"],
  "taskStatus":  "done（這件事已經做完了，沒有下一步）／in_progress（還在做）／blocked（被 blockers 裡的東西擋住）"
}`

/**
 * Deliberately narrow input (spec 8): the last 20 prompts, touched files,
 * uncommitted diff and the last few tool calls — roughly 3-6k tokens
 * instead of a 7679-line transcript.
 */
export function renderSummaryPrompt(input: SummaryInput): string {
  return [
    '你正在為一個中斷的開發 session 寫交接簡報，讓開發者能立刻接續工作。',
    '',
    `工作目錄：${input.cwd}`,
    `分支：${input.gitBranch ?? '（未知）'}`,
    '',
    '## 使用者最近說過的話（由舊到新）',
    orNone(input.prompts.map((p) => `- ${p}`)),
    '',
    '## 這個 session 改過的檔案',
    orNone(input.touchedFiles.map((f) => `- ${f}`)),
    '',
    '## 中斷前最後的工具呼叫',
    orNone(input.recentTools.map((t) => `- ${t.name}: ${t.summary}`)),
    '',
    '## 未 commit 的變更',
    orNone([input.gitDiffStat, input.gitStatusShort].filter((s) => s.trim() !== '')),
    '',
    '## 輸出格式',
    '只輸出一個 JSON 物件，不要有任何其他文字、不要用 markdown 程式碼圍欄。欄位如下：',
    FIELDS,
    '',
    '用繁體中文台灣用語填寫。「下一步」要具體到開發者看完就知道該動哪個檔案；如果這件事已經做完了，nextStep 留空字串並把 taskStatus 填 done，不要為了填滿欄位編一個下一步。',
  ].join('\n')
}

function orNone(lines: readonly string[]): string {
  return lines.length === 0 ? '（無）' : lines.join('\n')
}
