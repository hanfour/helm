import { digestOf as realDigestOf, getFreshBriefEntry, readCache as realReadCache, type CacheShape } from '../cache/store.ts'
import { statusOf } from '../session-status.ts'
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
 * 過期的簡報不掛，但 digest 比對擋不住規格 §4.3 最後一列：`helm brief` 允許
 * 對還在跑的 session 產生簡報，一個活著但閒置、transcript 沒有變動的
 * session，digest 會相符，簡報卻只是「上一次的結論，可能已經不準」。digest
 * 擋的是「簡報比 transcript 舊」，擋不掉「session 還活著而簡報恰好還新」，
 * 所以另外用 `statusOf` 擋掉 busy 的 session。
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
    // 規格 §4.3 最後一列：執行中的 session 任何任務狀態都不顯示。
    if (statusOf(s) === 'busy') return { ...s, taskStatus: null }
    const fresh = getFreshBriefEntry(cache, s.sessionId, deps.digestOf(s.transcriptPath))
    return { ...s, taskStatus: fresh?.body.taskStatus ?? null }
  })
}
