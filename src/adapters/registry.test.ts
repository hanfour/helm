import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectFromAdapters, type Adapter, type AdapterResult } from './registry.ts'
import type { SessionState } from '../types.ts'

const state = (over: Partial<SessionState>): SessionState => ({
  adapterId: 'x', sessionId: 's', cwd: '/p', pid: null, procStart: null,
  startedAt: 0, updatedAt: 0, nativeStatus: null, kind: 'interactive', name: '',
  transcriptPath: null, transcriptMtimeMs: null, lifecycle: 'running',
  lifecycleConfidence: 'high', live: null, ...over,
})

const adapter = (id: string, result: () => AdapterResult): Adapter => ({ id, collect: result })

test('把各 adapter 的 session 合起來', () => {
  const r = collectFromAdapters([
    adapter('claude-code', () => ({ sessions: [state({ adapterId: 'claude-code', sessionId: 'a' })], invalid: 0 })),
    adapter('codex', () => ({ sessions: [state({ adapterId: 'codex', sessionId: 'b' })], invalid: 0 })),
  ])
  assert.deepEqual(r.sessions.map((s) => s.sessionId).sort(), ['a', 'b'])
})

test('invalid 是各 adapter 的總和 —— 不能只報其中一個', () => {
  const r = collectFromAdapters([
    adapter('claude-code', () => ({ sessions: [], invalid: 3 })),
    adapter('codex', () => ({ sessions: [], invalid: 2 })),
  ])
  assert.equal(r.invalid, 5)
})

test('一個 adapter 丟例外時另一個照樣出得來', () => {
  // 這是 P3 install 的教訓：兩個彼此獨立的整合共用一個 try，
  // 於是 SwiftBar 資料夾唯讀就讓 Übersicht 完全沒被安裝。
  const r = collectFromAdapters([
    adapter('claude-code', () => { throw new Error('boom') }),
    adapter('codex', () => ({ sessions: [state({ adapterId: 'codex' })], invalid: 0 })),
  ])
  assert.equal(r.sessions.length, 1)
  assert.equal(r.sessions[0]?.adapterId, 'codex')
})

test('adapter 掛掉時要說出來，不是靜默少一半看板', () => {
  const r = collectFromAdapters([
    adapter('claude-code', () => { throw new Error('registry unreadable') }),
    adapter('codex', () => ({ sessions: [], invalid: 0 })),
  ])
  assert.ok(r.failures.some((f) => f.includes('claude-code')), r.failures.join('|'))
  assert.ok(r.failures.some((f) => f.includes('registry unreadable')), r.failures.join('|'))
})

test('全部都掛掉時回空看板加兩則說明', () => {
  const r = collectFromAdapters([
    adapter('claude-code', () => { throw new Error('a') }),
    adapter('codex', () => { throw new Error('b') }),
  ])
  assert.deepEqual(r.sessions, [])
  assert.equal(r.failures.length, 2)
})

test('都正常時沒有任何說明', () => {
  const r = collectFromAdapters([adapter('codex', () => ({ sessions: [], invalid: 0 }))])
  assert.deepEqual(r.failures, [])
})

test('adapter 內部把例外吞掉時，隔離機制就形同虛設', () => {
  // registry 的整段設計理由是「the loss has to be *said*, not swallowed」，
  // 但 discoverCodex 自己 catch 掉 scan 例外、scanRollouts 更早一層又
  // catch 掉了。reviewer 把三個資料目錄全部 chmod 000，adapterFailures
  // 仍是 []。沒有任何輸入能讓它說出口。
  //
  // 所以 adapter 要能主動回報「我少給了東西」，而不只是靠丟例外。
  const r = collectFromAdapters([
    adapter('codex', () => ({ sessions: [], invalid: 0, failure: '讀不到 ~/.codex/sessions' })),
  ])
  assert.ok(r.failures.some((f) => f.includes('codex')), r.failures.join('|'))
  assert.ok(r.failures.some((f) => f.includes('~/.codex')), r.failures.join('|'))
})

test('回報失敗的 adapter 仍然交出它拿得到的部分', () => {
  const r = collectFromAdapters([
    adapter('codex', () => ({
      sessions: [state({ adapterId: 'codex' })], invalid: 0, failure: '一半讀不到',
    })),
  ])
  assert.equal(r.sessions.length, 1, '部分結果不該被丟掉')
  assert.equal(r.failures.length, 1)
})
