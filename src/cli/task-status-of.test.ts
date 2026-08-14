import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachTaskStatus } from './task-status-of.ts'
import { EMPTY_CACHE, type BriefEntry, type CacheShape } from '../cache/store.ts'
import type { SessionState } from '../types.ts'

const sess = (over: Partial<SessionState> & { sessionId: string }): SessionState => ({
  adapterId: 'claude-code', cwd: '/p/a', pid: null, procStart: null, startedAt: 0,
  updatedAt: 0, nativeStatus: null, kind: 'interactive', name: '',
  transcriptPath: `/t/${over.sessionId}.jsonl`, transcriptMtimeMs: null,
  lifecycle: 'ended_clean', lifecycleConfidence: 'high', live: null,
  taskStatus: null, ...over,
})

const entry = (over: Partial<BriefEntry> = {}): BriefEntry => ({
  digest: '10:20', generatedAt: 0, gitBranch: null,
  body: {
    goal: '', done: [], currentStep: '', nextStep: '', blockers: [], files: [], prs: [],
    taskStatus: 'done',
  },
  ...over,
})

const cacheWith = (briefs: Record<string, BriefEntry>): CacheShape =>
  ({ ...EMPTY_CACHE, briefs })

const deps = (cache: CacheShape, digest: string | null = '10:20') => ({
  readCache: () => cache,
  digestOf: () => digest,
})

test('digest 相符時掛上簡報裡的任務狀態', () => {
  const out = attachTaskStatus([sess({ sessionId: 'a' })], '/c', deps(cacheWith({ a: entry() })))
  assert.equal(out[0]?.taskStatus, 'done')
})

test('digest 不符時不掛，顯示過期的「任務完成」比不顯示更糟', () => {
  const out = attachTaskStatus([sess({ sessionId: 'a' })], '/c', deps(cacheWith({ a: entry() }), '99:99'))
  assert.equal(out[0]?.taskStatus, null)
})

test('沒有簡報的 session 不去 stat 它的 transcript', () => {
  // 看板上 156 個 session 有 3 個有簡報。對全部都算 digest 等於多 153 次
  // stat，而那 153 次的答案一定是「沒有簡報」。
  let stats = 0
  attachTaskStatus([sess({ sessionId: 'a' }), sess({ sessionId: 'b' })], '/c', {
    readCache: () => cacheWith({ a: entry() }),
    digestOf: () => {
      stats++
      return '10:20'
    },
  })
  assert.equal(stats, 1, '只有有簡報的那個需要算 digest')
})

test('簡報沒有 taskStatus 欄位時掛 null', () => {
  const old = entry()
  const out = attachTaskStatus([sess({ sessionId: 'a' })], '/c', deps(cacheWith({
    a: { ...old, body: { ...old.body, taskStatus: undefined } },
  })))
  assert.equal(out[0]?.taskStatus, null)
})

test('快取讀不到時整批回 null，不讓看板其餘部分受影響', () => {
  const out = attachTaskStatus([sess({ sessionId: 'a' })], '/c', {
    readCache: () => {
      throw new Error('boom')
    },
    digestOf: () => '10:20',
  })
  assert.equal(out.length, 1)
  assert.equal(out[0]?.taskStatus, null)
})

test('不修改輸入', () => {
  const input = [sess({ sessionId: 'a' })]
  const snapshot = structuredClone(input)
  attachTaskStatus(input, '/c', deps(cacheWith({ a: entry() })))
  assert.deepEqual(input, snapshot)
})
