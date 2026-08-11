import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSession } from './brief.ts'
import type { ProjectView } from '../projects/group.ts'
import type { SessionState } from '../types.ts'

const sess = (id: string): SessionState => ({
  adapterId: 'claude-code', sessionId: id, cwd: '/p', pid: 1, procStart: null,
  startedAt: 0, updatedAt: 0, nativeStatus: null, kind: 'interactive', name: '',
  transcriptPath: null, lifecycle: 'crashed', lifecycleConfidence: 'high', live: null,
})
const proj = (sessions: SessionState[]): ProjectView =>
  ({ path: '/p', name: 'p', pinned: false, lastActivityMs: 0, sessions })

test('用前 8 碼短 id 找得到 session', () => {
  const found = resolveSession([proj([sess('abcdef12-3456-7890')])], 'abcdef12')
  assert.equal(found?.sessionId, 'abcdef12-3456-7890')
})

test('用完整 id 也找得到', () => {
  const found = resolveSession([proj([sess('abcdef12-3456-7890')])], 'abcdef12-3456-7890')
  assert.equal(found?.sessionId, 'abcdef12-3456-7890')
})

test('跨專案搜尋', () => {
  const found = resolveSession(
    [proj([sess('aaa11111')]), proj([sess('bbb22222')])], 'bbb2')
  assert.equal(found?.sessionId, 'bbb22222')
})

test('找不到時回傳 null 而不是丟錯', () => {
  assert.equal(resolveSession([proj([sess('aaa11111')])], 'zzz'), null)
})

test('空清單回傳 null', () => {
  assert.equal(resolveSession([], 'abc'), null)
})

test('前綴同時符合多個時，回傳第一個而非丟錯（行為需明確）', () => {
  // 記錄現況行為：.find() 取第一個。若日後要改成報錯要求使用者給更長的
  // 前綴，這個測試會提醒你那是刻意的行為變更。
  const found = resolveSession([proj([sess('abc11111'), sess('abc22222')])], 'abc')
  assert.equal(found?.sessionId, 'abc11111')
})
