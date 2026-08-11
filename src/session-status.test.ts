import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateStatus, statusOf } from './session-status.ts'
import type { SessionState } from './types.ts'

const s = (over: Partial<SessionState>): SessionState => ({
  adapterId: 'claude-code', sessionId: 'x', cwd: '/p', pid: 1, procStart: null,
  startedAt: 0, updatedAt: 0, nativeStatus: null, kind: 'interactive', name: '',
  transcriptPath: null, transcriptMtimeMs: null, lifecycle: 'running', lifecycleConfidence: 'high',
  live: null, ...over,
})

test('running + busy → busy', () => {
  assert.equal(statusOf(s({ lifecycle: 'running', nativeStatus: 'busy' })), 'busy')
})

test('running + idle → idle', () => {
  assert.equal(statusOf(s({ lifecycle: 'running', nativeStatus: 'idle' })), 'idle')
})

test('running 但沒有 nativeStatus → idle（保守假設在等輸入）', () => {
  assert.equal(statusOf(s({ lifecycle: 'running', nativeStatus: null })), 'idle')
})

test('crashed → crashed，不受 nativeStatus 影響', () => {
  assert.equal(statusOf(s({ lifecycle: 'crashed', nativeStatus: 'busy' })), 'crashed')
})

test('ended_clean → ended', () => {
  assert.equal(statusOf(s({ lifecycle: 'ended_clean' })), 'ended')
})

test('聚合優先序：crashed 蓋過 busy', () => {
  assert.equal(
    aggregateStatus([
      s({ lifecycle: 'running', nativeStatus: 'busy' }),
      s({ lifecycle: 'crashed' }),
      s({ lifecycle: 'ended_clean' }),
    ]),
    'crashed',
  )
})

test('聚合優先序：busy 蓋過 idle', () => {
  assert.equal(
    aggregateStatus([
      s({ lifecycle: 'running', nativeStatus: 'idle' }),
      s({ lifecycle: 'running', nativeStatus: 'busy' }),
    ]),
    'busy',
  )
})

test('聚合優先序：idle 蓋過 ended', () => {
  assert.equal(
    aggregateStatus([
      s({ lifecycle: 'ended_clean' }),
      s({ lifecycle: 'running', nativeStatus: 'idle' }),
    ]),
    'idle',
  )
})

test('全部結束時聚合為 null —— 不畫圓點，減少視覺噪音', () => {
  assert.equal(aggregateStatus([s({ lifecycle: 'ended_clean' })]), null)
})

test('沒有 session 時聚合為 null', () => {
  assert.equal(aggregateStatus([]), null)
})

test('aggregateStatus 不修改輸入', () => {
  const input = [s({ lifecycle: 'crashed' }), s({ lifecycle: 'ended_clean' })]
  const snapshot = structuredClone(input)
  aggregateStatus(input)
  assert.deepEqual(input, snapshot)
})
