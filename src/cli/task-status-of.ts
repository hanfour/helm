import { digestOf as realDigestOf, getFreshBriefEntry, readCache as realReadCache, type CacheShape } from '../cache/store.ts'
import type { SessionState } from '../types.ts'

export interface TaskStatusDeps {
  readCache: (cacheFile: string) => CacheShape
  digestOf: (transcriptPath: string | null) => string | null
}

const DEFAULT_DEPS: TaskStatusDeps = {
  readCache: realReadCache,
  digestOf: realDigestOf,
}

/**
 * 把簡報裡的任務狀態掛到 session 上。
 *
 * 只對快取裡真的有簡報的 session 算 digest。看板上 156 個 session 中有 3 個
 * 有簡報，對全部都算等於多 153 次 stat，而那 153 次的答案一定是「沒有簡報」。
 *
 * 過期的簡報不掛。digest 比對同時處理了規格 §4.3 最後一列：還在跑的 session
 * transcript 一直在變，簡報必然過期，不需要另外判斷。
 */
export function attachTaskStatus(
  sessions: readonly SessionState[],
  cacheFile: string,
  deps: TaskStatusDeps = DEFAULT_DEPS,
): SessionState[] {
  let cache: CacheShape
  try {
    cache = deps.readCache(cacheFile)
  } catch {
    // 快取讀不到只影響這一個維度，看板其餘部分照常。
    return sessions.map((s) => ({ ...s, taskStatus: null }))
  }
  return sessions.map((s) => {
    if (cache.briefs[s.sessionId] === undefined) return { ...s, taskStatus: null }
    const fresh = getFreshBriefEntry(cache, s.sessionId, deps.digestOf(s.transcriptPath))
    return { ...s, taskStatus: fresh?.body.taskStatus ?? null }
  })
}
