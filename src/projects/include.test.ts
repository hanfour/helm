import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldInclude, ACTIVITY_WINDOW_DAYS } from './include.ts'

const NOW = Date.UTC(2026, 7, 11, 3, 0, 0)
const DAY = 86_400_000

const base = {
  path: '/Users/testuser/proj',
  cwdExists: true,
  isGitRepo: true,
  lastActivityMs: NOW - DAY,
  nowMs: NOW,
  prefs: undefined,
}

test('活躍的 git 專案會被納入', () => {
  assert.equal(shouldInclude(base), true)
})

test('cwd 不存在則排除', () => {
  assert.equal(shouldInclude({ ...base, cwdExists: false }), false)
})

test('非 git repo 則排除', () => {
  assert.equal(shouldInclude({ ...base, isGitRepo: false }), false)
})

test(`超過 ${ACTIVITY_WINDOW_DAYS} 天沒活動則排除`, () => {
  const stale = NOW - (ACTIVITY_WINDOW_DAYS + 1) * DAY
  assert.equal(shouldInclude({ ...base, lastActivityMs: stale }), false)
})

test('剛好在窗口邊界內仍納入', () => {
  const edge = NOW - (ACTIVITY_WINDOW_DAYS * DAY) + 1000
  assert.equal(shouldInclude({ ...base, lastActivityMs: edge }), true)
})

test('hidden 的專案一律排除，即使活躍', () => {
  assert.equal(
    shouldInclude({ ...base, prefs: { pinned: false, hidden: true } }),
    false,
  )
})

test('pinned 的專案不受活動窗口限制', () => {
  const ancient = NOW - 400 * DAY
  assert.equal(
    shouldInclude({ ...base, lastActivityMs: ancient, prefs: { pinned: true, hidden: false } }),
    true,
  )
})

test('pinned 但 cwd 已不存在仍排除（路徑已失效）', () => {
  assert.equal(
    shouldInclude({ ...base, cwdExists: false, prefs: { pinned: true, hidden: false } }),
    false,
  )
})

test('hidden 優先於 pinned', () => {
  assert.equal(
    shouldInclude({ ...base, prefs: { pinned: true, hidden: true } }),
    false,
  )
})

for (const p of ['/private/tmp/x', '/var/folders/fs/abc/T/y', '/Users/testuser/Downloads/z']) {
  test(`排除路徑前綴：${p}`, () => {
    assert.equal(shouldInclude({ ...base, path: p, home: '/Users/testuser' }), false)
  })
}

test('排除前綴以路徑邊界比對，不誤傷同名開頭的目錄', () => {
  // /Users/testuser/Downloads 要排除，但 /Users/testuser/Downloads-archive 不該被排除
  assert.equal(
    shouldInclude({ ...base, path: '/Users/testuser/Downloads-archive/p', home: '/Users/testuser' }),
    true,
  )
})

test('沒有傳 home 時，home 相對的排除規則不生效（但絕對路徑規則仍生效）', () => {
  assert.equal(shouldInclude({ ...base, path: '/Users/testuser/Downloads/z' }), true)
  assert.equal(shouldInclude({ ...base, path: '/private/tmp/x' }), false)
})
