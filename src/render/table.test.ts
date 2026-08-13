import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderTable } from './table.ts'
import { displayWidth } from './width.ts'
import type { Board } from '../board.ts'
import type { ProjectView } from '../projects/group.ts'
import type { SessionState } from '../types.ts'
import { ACTIVITY_WINDOW_DAYS } from '../projects/include.ts'

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

const res = (projects: ProjectView[], invalid = 0): Board => ({ projects, invalid, prefsHealth: 'ok' as const, adapterFailures: [], prs: [], prDegraded: null })

test('空清單顯示提示而非空字串', () => {
  assert.match(renderTable(res([]), opts), /沒有找到/)
})

test('列出專案名稱與相對時間', () => {
  const out = renderTable(res([proj({})]), opts)
  assert.match(out, /proj/)
  assert.match(out, /5 分鐘前/)
})

test('一個專案只佔一行，不論底下有幾個 session', () => {
  const out = renderTable(res([proj({
    sessions: [
      sess({ sessionId: 'a' }), sess({ sessionId: 'b' }), sess({ sessionId: 'c' }),
    ],
  })]), opts)
  const rows = out.split('\n').filter((l) => l.includes('proj'))
  assert.equal(rows.length, 1)
})

test('顯示該專案的 session 總數', () => {
  const out = renderTable(res([proj({ sessionCount: 25 })]), opts)
  assert.match(out, /25 個 session/)
})

test('不再逐一列出 session id —— 那是實作細節，不是使用者介面', () => {
  const out = renderTable(res([proj({})]), opts)
  assert.ok(!out.includes('abcdef12'))
})

test('有中斷的專案標示「中斷未回收」', () => {
  const out = renderTable(res([proj({
    aggregateStatus: 'crashed',
    sessions: [sess({ lifecycle: 'crashed' })],
  })]), opts)
  assert.match(out, /中斷未回收/)
})

test('在跑與等輸入的數量分別標示', () => {
  const out = renderTable(res([proj({
    aggregateStatus: 'busy',
    sessions: [
      sess({ sessionId: 'a', nativeStatus: 'busy' }),
      sess({ sessionId: 'b', nativeStatus: 'busy' }),
      sess({ sessionId: 'c', nativeStatus: 'idle' }),
    ],
  })]), opts)
  assert.match(out, /2 個在跑/)
  assert.match(out, /1 個等輸入/)
})

test('全部 session 都結束的專案不畫圓點', () => {
  const out = renderTable(res([proj({
    aggregateStatus: null,
    sessions: [sess({ lifecycle: 'ended_clean' })],
  })]), opts)
  const row = out.split('\n').find((l) => l.includes('proj')) ?? ''
  assert.ok(!row.includes('●'))
  assert.ok(!row.includes('○'))
})

test('低信心的專案狀態帶問號，不把猜測講成事實', () => {
  const out = renderTable(res([proj({
    aggregateStatus: 'crashed',
    sessions: [sess({ lifecycle: 'crashed', lifecycleConfidence: 'low' })],
  })]), opts)
  assert.match(out, /●\?/)
})

test('高信心的專案狀態不帶問號', () => {
  const out = renderTable(res([proj({
    aggregateStatus: 'crashed',
    sessions: [sess({ lifecycle: 'crashed', lifecycleConfidence: 'high' })],
  })]), opts)
  assert.ok(!out.includes('●?'))
})

test('中文專案名的欄位仍然對齊', () => {
  const out = renderTable(res([
    proj({ name: '報表工具', path: '/a' }),
    proj({ name: 'helm', path: '/b' }),
  ]), opts)
  const rows = out.split('\n').filter((l) => l.includes('分鐘前'))
  assert.equal(rows.length, 2)
  // 對齊要用顯示欄數量，不能用 indexOf —— 那數的是 UTF-16 單位，
  // 「報表工具」是 4 個單位卻佔 8 欄，兩者本來就不會相等。
  const at = rows.map((r) => displayWidth(r.slice(0, r.indexOf('5 分鐘前'))))
  assert.equal(at[0], at[1])
})

test('pinned 的專案顯示釘選記號', () => {
  assert.match(renderTable(res([proj({ pinned: true })]), opts), /📌/)
})

test('底部摘要統計各狀態數量', () => {
  const out = renderTable(res([proj({
    aggregateStatus: 'crashed',
    sessions: [
      sess({ sessionId: 'a', lifecycle: 'crashed' }),
      sess({ sessionId: 'b', lifecycle: 'running', nativeStatus: 'busy' }),
    ],
  })]), opts)
  assert.match(out, /中斷 1/)
  assert.match(out, /執行中 1/)
})

test('提示使用者如何往下鑽 —— 一行一專案後必須指出路', () => {
  const out = renderTable(res([proj({})]), opts)
  assert.match(out, /helm sessions/)
  assert.match(out, /helm open/)
})

test('color: false 時輸出不含任何 ESC', () => {
  const out = renderTable(res([proj({ aggregateStatus: 'crashed' })], 2), opts)
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

test('偏好檔毀損時在輸出中明講，並告知原檔沒有被丟掉', () => {
  // 釘選與隱藏是使用者意圖，不可重建。靜默歸零會讓他以為自己沒設過。
  const out = renderTable({ projects: [proj({})], invalid: 0, prefsHealth: 'quarantined' as const, adapterFailures: [], prs: [], prDegraded: null }, opts)
  assert.match(out, /釘選|隱藏|偏好/)
  assert.match(out, /corrupt/)
})

test('偏好檔正常時不顯示該警告', () => {
  assert.ok(!renderTable(res([proj({})]), opts).includes('.corrupt.json'))
})

test('空清單訊息裡的天數取自常數，不是寫死的 14', () => {
  // 常數改了而文案沒改，使用者會看到一個不再成立的數字，而且沒有任何測試會紅。
  assert.match(renderTable(res([]), opts), new RegExp(`近 ${ACTIVITY_WINDOW_DAYS} 天`))
})

test('摘要不把低信心的中斷講成確定的', () => {
  // 實測 2026-08-13：底部摘要寫「已中斷 2」，而那兩個都是低信心的 Codex
  // 判定 —— 同一支程式的 helm sessions 對它們畫的是 ●?。session-status.ts
  // 寫著「Every face that renders a label has to ask this」，這行摘要是
  // 那個忘記問的面。
  const out = renderTable(res([proj({
    aggregateStatus: 'crashed',
    sessions: [
      sess({ adapterId: 'codex', lifecycle: 'crashed', lifecycleConfidence: 'low' }),
      sess({ adapterId: 'codex', sessionId: 'b', lifecycle: 'crashed', lifecycleConfidence: 'low' }),
    ],
  })]), opts)
  const summary = out.split('\n').find((l) => l.includes('個專案')) ?? ''
  assert.match(summary, /已中斷 2\?/, summary)
})

test('摘要在全高信心時不帶問號 —— 問號要是有意義的', () => {
  const out = renderTable(res([proj({
    aggregateStatus: 'crashed',
    sessions: [sess({ lifecycle: 'crashed', lifecycleConfidence: 'high' })],
  })]), opts)
  const summary = out.split('\n').find((l) => l.includes('個專案')) ?? ''
  assert.match(summary, /已中斷 1(?!\?)/, summary)
})

test('摘要把「沒有動靜」跟「已結束」分開數', () => {
  // isUnearnedClaim 為真的 session 在 helm sessions 裡標的是「沒有動靜」，
  // 因為 Codex 沒有結束訊號、ended_clean 只代表 helm 停止猜測。摘要把它們
  // 混進「已結束」，等於用一個它沒賺到的詞。實測：已結束 142 裡有 5 個是這種。
  const out = renderTable(res([proj({
    aggregateStatus: null,
    sessions: [
      sess({ lifecycle: 'ended_clean', lifecycleConfidence: 'high' }),
      sess({ adapterId: 'codex', sessionId: 'b', lifecycle: 'ended_clean', lifecycleConfidence: 'low' }),
      sess({ adapterId: 'codex', sessionId: 'c', lifecycle: 'ended_clean', lifecycleConfidence: 'low' }),
    ],
  })]), opts)
  const summary = out.split('\n').find((l) => l.includes('個專案')) ?? ''
  assert.match(summary, /已結束 1(?!\d)/, summary)
  assert.match(summary, /沒有動靜 2/, summary)
})

test('在跑與等輸入同樣帶問號 —— Codex 的信心永遠是低的', () => {
  const out = renderTable(res([proj({
    aggregateStatus: 'busy',
    sessions: [sess({ adapterId: 'codex', nativeStatus: 'busy', lifecycleConfidence: 'low' })],
  })]), opts)
  const summary = out.split('\n').find((l) => l.includes('個專案')) ?? ''
  assert.match(summary, /執行中 1\?/, summary)
})

test('摘要裡高低信心混在一起時仍然帶問號', () => {
  // some 改成 every 會存活：只要 bucket 裡有一個是猜的，那個數字就已經
  // 不是純粹的事實了。
  const out = renderTable(res([proj({
    aggregateStatus: 'crashed',
    sessions: [
      sess({ lifecycle: 'crashed', lifecycleConfidence: 'high' }),
      sess({ adapterId: 'codex', sessionId: 'b', lifecycle: 'crashed', lifecycleConfidence: 'low' }),
    ],
  })]), opts)
  const summary = out.split('\n').find((l) => l.includes('個專案')) ?? ''
  assert.match(summary, /已中斷 2\?/, summary)
})

test('「沒有動靜」不再加問號 —— 那個詞本身就是在說不知道', () => {
  const out = renderTable(res([proj({
    aggregateStatus: null,
    sessions: [sess({ adapterId: 'codex', lifecycle: 'ended_clean', lifecycleConfidence: 'low' })],
  })]), opts)
  const summary = out.split('\n').find((l) => l.includes('個專案')) ?? ''
  assert.match(summary, /沒有動靜 1(?!\?)/, summary)
})

test('摘要最糟的排最前 —— 中斷不能被埋在後面', () => {
  const out = renderTable(res([proj({
    aggregateStatus: 'crashed',
    sessions: [
      sess({ nativeStatus: 'busy' }),
      sess({ sessionId: 'b', lifecycle: 'ended_clean' }),
      sess({ sessionId: 'c', lifecycle: 'crashed' }),
    ],
  })]), opts)
  const summary = out.split('\n').find((l) => l.includes('個專案')) ?? ''
  const order = ['已中斷', '執行中', '已結束'].map((w) => summary.indexOf(w))
  assert.deepEqual(order, [...order].toSorted((a, b) => a - b), summary)
  assert.ok(order.every((i) => i >= 0), summary)
})

test('摘要不列出數量為零的狀態', () => {
  // 「已中斷 0」是一句沒有內容的話，而它佔的是最顯眼的位置。
  const out = renderTable(res([proj({
    aggregateStatus: 'busy', sessions: [sess({ nativeStatus: 'busy' })],
  })]), opts)
  const summary = out.split('\n').find((l) => l.includes('個專案')) ?? ''
  assert.doesNotMatch(summary, / 0/, summary)
  assert.match(summary, /執行中 1/, summary)
})
