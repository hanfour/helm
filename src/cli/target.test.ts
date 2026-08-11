import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chosenSession, resolveOrReport } from './target.ts'
import type { ProjectView } from '../projects/group.ts'
import type { SessionState } from '../types.ts'

const sess = (id: string, updatedAt = 0): SessionState => ({
  adapterId: 'claude-code', sessionId: id, cwd: '/p', pid: null, procStart: null,
  startedAt: 0, updatedAt, nativeStatus: null, kind: 'interactive', name: '',
  transcriptPath: null, transcriptMtimeMs: null, lifecycle: 'ended_clean', lifecycleConfidence: 'high',
  live: null,
})

const proj = (name: string, sessions: SessionState[]): ProjectView => ({
  path: `/Users/u/${name}`, name, pinned: false, lastActivityMs: 0,
  aggregateStatus: null, sessionCount: sessions.length, sessions,
})

/** Collects what the command would have told the user. */
const sink = () => {
  const lines: string[] = []
  return { write: (m: string) => lines.push(m), text: () => lines.join('') }
}

test('專案名命中時回傳該專案，session 為 null', () => {
  const p = proj('helm', [sess('aaa11111')])
  const out = resolveOrReport([p], 'helm', () => {})
  assert.equal(out?.project.name, 'helm')
  assert.equal(out?.session, null)
})

test('session id 命中時同時回傳所屬專案', () => {
  const p = proj('helm', [sess('aaa11111')])
  const out = resolveOrReport([p], 'aaa1', () => {})
  assert.equal(out?.project.name, 'helm')
  assert.equal(out?.session?.sessionId, 'aaa11111')
})

test('歧義時回傳 null 並列出候選，不自動挑一個', () => {
  const s = sink()
  const out = resolveOrReport(
    [proj('data-svc-2.0', []), proj('data-svc-2.0-clone', [])],
    'data-svc',
    s.write,
  )
  assert.equal(out, null)
  assert.match(s.text(), /data-svc-2\.0\b/)
  assert.match(s.text(), /data-svc-2\.0-clone/)
})

test('歧義訊息告訴使用者怎麼解決', () => {
  const s = sink()
  resolveOrReport([proj('a-one', []), proj('a-two', [])], 'a-', s.write)
  assert.match(s.text(), /打長一點/)
})

test('session id 前綴撞號時同樣不自動挑 —— 挑錯就等於弄丟使用者的進度', () => {
  const s = sink()
  const p = proj('helm', [sess('abc11111'), sess('abc22222')])
  assert.equal(resolveOrReport([p], 'abc', s.write), null)
  assert.match(s.text(), /abc11111/)
  assert.match(s.text(), /abc22222/)
})

test('找不到時回傳 null 並指引使用者跑 helm status', () => {
  const s = sink()
  assert.equal(resolveOrReport([proj('helm', [])], 'zzz', s.write), null)
  assert.match(s.text(), /找不到/)
  assert.match(s.text(), /helm status/)
})

test('命中時不寫出任何訊息', () => {
  const s = sink()
  resolveOrReport([proj('helm', [sess('a')])], 'helm', s.write)
  assert.equal(s.text(), '')
})

test('chosenSession：指名 session 時就用那個', () => {
  const target = sess('bbb22222', 500)
  const p = proj('helm', [sess('aaa11111', 900), target])
  const hit = resolveOrReport([p], 'bbb2', () => {})
  assert.equal(chosenSession(hit!)?.sessionId, 'bbb22222')
})

test('chosenSession：指名專案時取最近的那個 session', () => {
  // 分組階段已依 updatedAt 由新到舊排序，取頭即可。
  const p = proj('helm', [sess('newest', 900), sess('older', 100)])
  const hit = resolveOrReport([p], 'helm', () => {})
  assert.equal(chosenSession(hit!)?.sessionId, 'newest')
})

test('chosenSession：專案底下沒有 session 時回傳 null 而不是丟錯', () => {
  const hit = resolveOrReport([proj('helm', [])], 'helm', () => {})
  assert.equal(chosenSession(hit!), null)
})

test('resolveOrReport 不修改輸入', () => {
  const input = [proj('helm', [sess('aaa11111')])]
  const snapshot = structuredClone(input)
  resolveOrReport(input, 'helm', () => {})
  assert.deepEqual(input, snapshot)
})
