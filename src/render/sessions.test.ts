import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderSessions } from './sessions.ts'
import type { ProjectView } from '../projects/group.ts'
import type { SessionState } from '../types.ts'

const ESC = String.fromCharCode(27)
const NOW = Date.UTC(2026, 7, 11, 12, 0, 0)

const sess = (over: Partial<SessionState>): SessionState => ({
  adapterId: 'claude-code', sessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
  cwd: '/Users/testuser/proj', pid: 1, procStart: null, startedAt: 0,
  updatedAt: NOW - 5 * 60_000, nativeStatus: 'idle', kind: 'interactive',
  name: 'proj-01', transcriptPath: null, transcriptMtimeMs: null, lifecycle: 'running',
  lifecycleConfidence: 'high', live: null, ...over,
})

const proj = (over: Partial<ProjectView>): ProjectView => {
  const sessions = over.sessions ?? [sess({})]
  return {
    path: '/Users/testuser/proj', name: 'proj', pinned: false,
    lastActivityMs: NOW - 5 * 60_000, aggregateStatus: 'idle',
    sessionCount: sessions.length, ...over, sessions,
  }
}

const opts = { color: false, nowMs: NOW }

test('標頭顯示專案名與路徑', () => {
  const out = renderSessions(proj({}), opts)
  assert.match(out, /proj/)
  assert.match(out, /\/Users\/testuser\/proj/)
})

test('逐一列出 session 的短 id 與相對時間', () => {
  const out = renderSessions(proj({}), opts)
  assert.match(out, /abcdef12/)
  assert.ok(!out.includes('abcdef12-3456-7890-abcd-ef1234567890'))
  assert.match(out, /5 分鐘前/)
})

test('每個 session 各佔一行', () => {
  const out = renderSessions(proj({
    sessions: [
      sess({ sessionId: 'aaaaaaaa-1' }), sess({ sessionId: 'bbbbbbbb-2' }),
      sess({ sessionId: 'cccccccc-3' }),
    ],
  }), opts)
  assert.equal(out.split('\n').filter((l) => l.includes('分鐘前')).length, 3)
})

test('crashed 的 session 標示中斷並附上 resume 提示', () => {
  const out = renderSessions(proj({ sessions: [sess({ lifecycle: 'crashed' })] }), opts)
  assert.match(out, /已中斷/)
  assert.match(out, /helm open abcdef12/)
})

test('busy 時顯示 live marker 的工具與摘要', () => {
  const out = renderSessions(proj({
    sessions: [sess({
      nativeStatus: 'busy',
      live: { sessionId: 'x', ts: NOW, toolName: 'Bash', summary: 'npm test', degraded: false },
    })],
  }), opts)
  assert.match(out, /Bash/)
  assert.match(out, /npm test/)
})

test('idle 時忽略過時的 live marker', () => {
  const out = renderSessions(proj({
    sessions: [sess({
      nativeStatus: 'idle',
      live: { sessionId: 'x', ts: NOW, toolName: 'Bash', summary: 'npm test', degraded: false },
    })],
  }), opts)
  assert.ok(!out.includes('npm test'))
})

test('低信心的判定帶問號', () => {
  const out = renderSessions(proj({
    sessions: [sess({ lifecycle: 'crashed', lifecycleConfidence: 'low' })],
  }), opts)
  assert.match(out, /●\?/)
})

test('pinned 的專案顯示釘選記號', () => {
  assert.match(renderSessions(proj({ pinned: true }), opts), /📌/)
})

test('底部提示如何看單一 session 的交接簡報', () => {
  assert.match(renderSessions(proj({}), opts), /helm brief/)
})

test('沒有 session 的專案顯示明確訊息而非空白', () => {
  const out = renderSessions(proj({ sessions: [], sessionCount: 0 }), opts)
  assert.match(out, /沒有 session/)
})

test('color: false 時輸出不含任何 ESC', () => {
  const out = renderSessions(proj({ sessions: [sess({ lifecycle: 'crashed' })] }), opts)
  assert.ok(!out.includes(ESC))
})

test('color: true 時輸出含 ESC', () => {
  assert.ok(renderSessions(proj({}), { color: true, nowMs: NOW }).includes(ESC))
})

test('renderSessions 不修改輸入', () => {
  const input = proj({})
  const snapshot = structuredClone(input)
  renderSessions(input, opts)
  assert.deepEqual(input, snapshot)
})

test('低信心的「已結束」在這裡也不能講得像確定的', () => {
  const out = renderSessions(proj({
    sessions: [sess({ lifecycle: 'ended_clean', lifecycleConfidence: 'low' })],
  }), opts)
  assert.doesNotMatch(out, /已結束/, out)
  assert.match(out, /沒有動靜/)
})
