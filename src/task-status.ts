/**
 * 任務狀態與行程狀態是兩個維度。
 *
 * `session-status.ts` 回答的是「這個行程還活著嗎」，這裡回答的是「我交代
 * 的那件事做完了沒」。一個已結束的 session 可能是做完才關掉，也可能是卡住
 * 就沒再回去，看板對這兩種畫的是同一個灰點。
 */
export type TaskStatus = 'done' | 'in_progress' | 'blocked'

/** 刻意與 session-status.ts 的用詞不重疊：同一列會同時出現兩者。 */
export const TASK_LABEL: Record<TaskStatus, string> = {
  done: '任務完成',
  in_progress: '任務進行中',
  blocked: '任務卡住',
}

/**
 * 未知時回 null，不是空字串。
 *
 * 舊快取沒有這個欄位、模型回傳非法值、簡報過期，三種情況都是未知，而呈現
 * 面對未知的處理是什麼都不畫。回字串會逼每個呼叫端自己判斷哪個字串代表
 * 「不要畫」。
 */
export function taskLabelOf(status: TaskStatus | null | undefined): string | null {
  return status === null || status === undefined ? null : TASK_LABEL[status]
}
