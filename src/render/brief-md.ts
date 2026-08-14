import { taskLabelOf } from '../task-status.ts'
import type { Brief } from '../cache/store.ts'

export interface BriefMeta {
  sessionId: string
  cwd: string
  gitBranch: string | null
  generatedAt: number
}

export function renderBriefMarkdown(brief: Brief, meta: BriefMeta): string {
  const task = taskLabelOf(brief.taskStatus)
  return [
    `# 交接簡報 — ${meta.cwd}`,
    '',
    `- Session：\`${meta.sessionId}\``,
    `- 分支：${meta.gitBranch ?? '（未知）'}`,
    `- 產生時間：${new Date(meta.generatedAt).toISOString()}`,
    // 舊簡報沒有這個欄位，那時不多一行空的出來。
    ...(task === null ? [] : [`- 任務狀態：${task}`]),
    '',
    '## 目標',
    orNone([brief.goal]),
    '',
    '## 已完成',
    bullets(brief.done),
    '',
    '## 進行到哪一步',
    orNone([brief.currentStep]),
    '',
    '## 下一步',
    orNone([brief.nextStep]),
    '',
    '## 卡點',
    bullets(brief.blockers),
    '',
    '## 相關檔案',
    bullets(brief.files),
    '',
    '## 相關 PR',
    bullets(brief.prs),
    '',
  ].join('\n')
}

/** Spec 12: a failed brief must still show the user something useful. */
export function renderFallback(prompts: readonly string[]): string {
  if (prompts.length === 0) {
    return '簡報產生失敗，而且沒有可用的原始對話內容可以顯示。\n'
  }
  return [
    '簡報產生失敗，以下是這個 session 最後幾則你說過的話：',
    '',
    ...prompts.slice(-3).map((p) => `- ${p}`),
    '',
    '（可用 `helm brief <id> --refresh` 重試）',
    '',
  ].join('\n')
}

function bullets(items: readonly string[]): string {
  return items.length === 0 ? '（無）' : items.map((i) => `- ${i}`).join('\n')
}

function orNone(items: readonly string[]): string {
  const filled = items.filter((i) => i.trim() !== '')
  return filled.length === 0 ? '（無）' : filled.join('\n')
}
