import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePaths } from '../paths.ts'
import { runChecks, sweepStaleLive, type Check } from './health.ts'
import type { Board } from '../board.ts'
import type { SessionState } from '../types.ts'

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0)
const DAY = 86_400_000

const sess = (over: Partial<SessionState>): SessionState => ({
  adapterId: 'claude-code', sessionId: 's', cwd: '/p', pid: null, procStart: null,
  startedAt: 0, updatedAt: NOW, nativeStatus: null, kind: 'interactive', name: '',
  transcriptPath: null, transcriptMtimeMs: null, lifecycle: 'ended_clean',
  lifecycleConfidence: 'high', live: null, ...over,
})

const board = (
  sessions: SessionState[] = [],
  over: Partial<Board> = {},
): Board => ({
  projects: sessions.length === 0 ? [] : [{
    path: '/p', name: 'p', pinned: false, lastActivityMs: NOW,
    aggregateStatus: null, sessionCount: sessions.length, sessions,
  }],
  invalid: 0,
  prefsHealth: 'ok' as const,
  ...over,
})

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'helm-doctor-'))
  mkdirSync(join(h, '.claude'), { recursive: true })
  writeFileSync(join(h, '.claude', 'settings.json'), '{}')
  return h
}

const find = (checks: readonly Check[], name: string) =>
  checks.find((c) => c.name.includes(name))

test('hook 未安裝時檢查不通過，並告訴使用者怎麼裝', () => {
  const c = find(runChecks(resolvePaths({ home: home() }), board()), 'hook')
  assert.equal(c?.ok, false)
  assert.match(c?.detail ?? '', /helm install/)
})

test('hook 錯誤紀錄非空時檢查不通過並印出內容', () => {
  // hook 是「絕不靜默吞錯」的唯一豁免，而這裡就是它的補償。
  // 沒有這個檢查，那些錯誤就真的只是被吞掉。
  const h = home()
  mkdirSync(join(h, '.helm'), { recursive: true })
  writeFileSync(join(h, '.helm', 'hook-errors.log'), 'sh: 壞掉了\n')
  const c = find(runChecks(resolvePaths({ home: h }), board()), '錯誤')
  assert.equal(c?.ok, false)
  assert.match(c?.detail ?? '', /壞掉了/)
})

test('註冊表有解析失敗時如實回報數量 —— table.ts 承諾過這裡查得到原因', () => {
  const c = find(runChecks(resolvePaths({ home: home() }), board([], { invalid: 3 })), '註冊表')
  assert.equal(c?.ok, false)
  assert.match(c?.detail ?? '', /3/)
})

test('偏好檔毀損時回報，並指出原檔被保留在哪', () => {
  const c = find(runChecks(resolvePaths({ home: home() }), board([], { prefsHealth: 'quarantined' as const })), '偏好')
  assert.equal(c?.ok, false)
  assert.match(c?.detail ?? '', /corrupt/)
})

test('live 目錄不存在時檢查不通過', () => {
  const c = find(runChecks(resolvePaths({ home: home() }), board()), 'live')
  assert.equal(c?.ok, false)
})

test('每一項都帶名稱與說明，沒有空欄位', () => {
  const checks = runChecks(resolvePaths({ home: home() }), board())
  assert.ok(checks.length >= 6)
  assert.ok(checks.every((c) => c.name !== '' && c.detail !== ''))
})

test('清理掉已正常結束的 session 的 live 檔', () => {
  const h = home()
  const live = join(h, '.helm', 'live')
  mkdirSync(live, { recursive: true })
  writeFileSync(join(live, 'done.json'), '{}')
  const removed = sweepStaleLive(
    resolvePaths({ home: h }),
    board([sess({ sessionId: 'done', lifecycle: 'ended_clean' })]),
    NOW,
  )
  assert.deepEqual(removed, ['done.json'])
  assert.equal(existsSync(join(live, 'done.json')), false)
})

test('還在跑的 session 的 live 檔不動', () => {
  const h = home()
  const live = join(h, '.helm', 'live')
  mkdirSync(live, { recursive: true })
  writeFileSync(join(live, 'busy.json'), '{}')
  const removed = sweepStaleLive(
    resolvePaths({ home: h }),
    board([sess({ sessionId: 'busy', lifecycle: 'running' })]),
    NOW,
  )
  assert.deepEqual(removed, [])
})

test('中斷的 session 的 live 檔不動 —— 那正是它中斷的證據', () => {
  const h = home()
  const live = join(h, '.helm', 'live')
  mkdirSync(live, { recursive: true })
  writeFileSync(join(live, 'crashed.json'), '{}')
  const removed = sweepStaleLive(
    resolvePaths({ home: h }),
    board([sess({ sessionId: 'crashed', lifecycle: 'crashed' })]),
    NOW,
  )
  assert.deepEqual(removed, [])
})

test('超過 30 天的孤兒 live 檔即使不認得也清掉', () => {
  const h = home()
  const live = join(h, '.helm', 'live')
  mkdirSync(live, { recursive: true })
  const f = join(live, 'orphan.json')
  writeFileSync(f, '{}')
  const old = (NOW - 31 * DAY) / 1000
  utimesSync(f, old, old)
  assert.deepEqual(sweepStaleLive(resolvePaths({ home: h }), board(), NOW), ['orphan.json'])
})

test('認不得但還很新的 live 檔留著 —— 那可能正是當機的唯一證據', () => {
  // 當機的 session 不在註冊表裡，它的 live 檔就是 §6 真值表最後一列賴以判定的
  // 東西。清得太積極等於湮滅證據，而且湮滅之後沒有任何人會發現。
  const h = home()
  const live = join(h, '.helm', 'live')
  mkdirSync(live, { recursive: true })
  writeFileSync(join(live, 'unknown.json'), '{}')
  assert.deepEqual(sweepStaleLive(resolvePaths({ home: h }), board(), NOW), [])
})

test('live 目錄不存在時清理是 no-op', () => {
  assert.deepEqual(sweepStaleLive(resolvePaths({ home: home() }), board(), NOW), [])
})

test('sweepStaleLive 不修改輸入', () => {
  const input = board([sess({ sessionId: 'done' })])
  const snapshot = structuredClone(input)
  sweepStaleLive(resolvePaths({ home: home() }), input, NOW)
  assert.deepEqual(input, snapshot)
})
