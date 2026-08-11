import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderTable } from './table.ts'
import type { StatusResult } from '../cli/status.ts'
import type { ProjectView } from '../projects/group.ts'
import type { SessionState } from '../types.ts'

const ESC = String.fromCharCode(27)
const NOW = Date.UTC(2026, 7, 11, 12, 0, 0)

const sess = (over: Partial<SessionState>): SessionState => ({
  adapterId: 'claude-code', sessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
  cwd: '/Users/testuser/proj', pid: 1, procStart: null, startedAt: 0,
  updatedAt: NOW - 5 * 60_000, nativeStatus: 'idle', kind: 'interactive',
  name: 'proj-01', transcriptPath: null, lifecycle: 'running',
  lifecycleConfidence: 'high', live: null, ...over,
})

const proj = (over: Partial<ProjectView>): ProjectView => ({
  path: '/Users/testuser/proj', name: 'proj', pinned: false,
  lastActivityMs: NOW - 5 * 60_000, sessions: [sess({})], ...over,
})

const opts = { color: false, nowMs: NOW }

const res = (projects: ProjectView[], invalid = 0): StatusResult => ({ projects, invalid })

test('空清單顯示提示而非空字串', () => {
  assert.match(renderTable(res([]), opts), /沒有找到/)
})

test('列出專案名稱與相對時間', () => {
  const out = renderTable(res([proj({})]), opts)
  assert.match(out, /proj/)
  assert.match(out, /5 分鐘前/)
})

test('crashed 的 session 標示中斷並附上 resume 提示', () => {
  const out = renderTable(res([proj({ sessions: [sess({ lifecycle: 'crashed' })] })]), opts)
  assert.match(out, /中斷/)
  assert.match(out, /helm open/)
})

test('session id 截短為前 8 碼', () => {
  const out = renderTable(res([proj({})]), opts)
  assert.match(out, /abcdef12/)
  assert.ok(!out.includes('abcdef12-3456-7890-abcd-ef1234567890'))
})

test('busy 時顯示 live marker 的工具與摘要', () => {
  const out = renderTable(res([proj({
    sessions: [sess({
      nativeStatus: 'busy',
      live: { sessionId: 'x', ts: NOW, toolName: 'Bash', summary: 'npm test' },
    })],
  })]), opts)
  assert.match(out, /Bash/)
  assert.match(out, /npm test/)
})

test('idle 時忽略過時的 live marker', () => {
  const out = renderTable(res([proj({
    sessions: [sess({
      nativeStatus: 'idle',
      live: { sessionId: 'x', ts: NOW, toolName: 'Bash', summary: 'npm test' },
    })],
  })]), opts)
  assert.ok(!out.includes('npm test'))
})

test('pinned 的專案顯示釘選記號', () => {
  assert.match(renderTable(res([proj({ pinned: true })]), opts), /📌/)
})

test('底部摘要統計各狀態數量', () => {
  const out = renderTable(res([proj({
    sessions: [
      sess({ sessionId: 'a', lifecycle: 'crashed' }),
      sess({ sessionId: 'b', lifecycle: 'running', nativeStatus: 'busy' }),
    ],
  })]), opts)
  assert.match(out, /中斷 1/)
  assert.match(out, /執行中 1/)
})

test('color: false 時輸出不含任何 ESC', () => {
  const out = renderTable(res([proj({ sessions: [sess({ lifecycle: 'crashed' })] })]), opts)
  assert.ok(!out.includes(ESC))
})

test('color: true 時輸出含 ESC', () => {
  const out = renderTable(res([proj({})]), { color: true, nowMs: NOW })
  assert.ok(out.includes(ESC))
})

test('renderTable 不修改輸入', () => {
  const input = res([proj({})])
  const snapshot = structuredClone(input)
  renderTable(input, opts)
  assert.deepEqual(input, snapshot)
})

test('有解析失敗時在輸出中明講，不靜默隱藏', () => {
  const out = renderTable(res([proj({})], 2), opts)
  assert.match(out, /2 個/)
  assert.match(out, /無法解析|讀不到|helm doctor/)
})

test('沒有解析失敗時不顯示任何警告', () => {
  const out = renderTable(res([proj({})], 0), opts)
  assert.ok(!out.includes('無法解析'))
})

test('全部都解析失敗時，空清單訊息也要說明原因', () => {
  const out = renderTable(res([], 3), opts)
  assert.match(out, /3 個/)
})
