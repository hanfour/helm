import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupIntoProjects } from './group.ts'
import type { SessionState } from '../types.ts'

const NOW = Date.UTC(2026, 7, 11, 3, 0, 0)

const sess = (over: Partial<SessionState>): SessionState => ({
  adapterId: 'claude-code', sessionId: 's', cwd: '/Users/testuser/a', pid: 1,
  procStart: null, startedAt: 0, updatedAt: NOW - 1000, nativeStatus: 'idle',
  kind: 'interactive', name: '', transcriptPath: null, transcriptMtimeMs: null,
  lifecycle: 'running', lifecycleConfidence: 'high', live: null, ...over,
})

const deps = {
  prefs: { version: 1 as const, projects: {} },
  nowMs: NOW,
  cwdExists: () => true,
  isGitRepo: () => true,
  home: '/Users/testuser',
}

test('同一 cwd 的多個 session 歸為一個專案', () => {
  const out = groupIntoProjects(
    [sess({ sessionId: 'a' }), sess({ sessionId: 'b' })],
    deps,
  )
  assert.equal(out.length, 1)
  assert.equal(out[0]?.sessions.length, 2)
})

test('專案名取 cwd 的最後一段', () => {
  const out = groupIntoProjects([sess({ cwd: '/Users/testuser/acme/example-service' })], deps)
  assert.equal(out[0]?.name, 'data-svc-2.0')
})

test('lastActivityMs 取該專案所有 session 的最大值', () => {
  // 時間一律用 NOW 相對值 —— 裸 epoch 會落在 1970，直接被 14 天窗口濾掉，
  // 斷言根本跑不到。
  // 較新的那個刻意放在陣列的第二個位置：這樣「回傳第一個元素」的錯誤實作
  // 也會被抓到，而不是只抓得到「取最小值」。
  const out = groupIntoProjects(
    [sess({ sessionId: 'older', updatedAt: NOW - 900_000 }),
     sess({ sessionId: 'newer', updatedAt: NOW - 100_000 })],
    deps,
  )
  assert.equal(out[0]?.lastActivityMs, NOW - 100_000)
})

test('專案排序：pinned 優先，其次依 lastActivityMs 由新到舊', () => {
  const out = groupIntoProjects(
    [
      sess({ cwd: '/Users/testuser/fresh', updatedAt: NOW - 100 }),
      sess({ cwd: '/Users/testuser/old', updatedAt: NOW - 9000 }),
      sess({ cwd: '/Users/testuser/pinned', updatedAt: NOW - 50_000 }),
    ],
    {
      ...deps,
      prefs: {
        version: 1,
        projects: { '/Users/testuser/pinned': { pinned: true, hidden: false } },
      },
    },
  )
  assert.deepEqual(out.map((p) => p.name), ['pinned', 'fresh', 'old'])
})

test('被排除的專案不出現在結果中', () => {
  const out = groupIntoProjects(
    [sess({ cwd: '/Users/testuser/ok' }), sess({ cwd: '/private/tmp/noise' })],
    deps,
  )
  assert.deepEqual(out.map((p) => p.name), ['ok'])
})

test('非 git repo 的專案被排除', () => {
  const out = groupIntoProjects([sess({ cwd: '/Users/testuser/nogit' })], {
    ...deps,
    isGitRepo: (p) => p !== '/Users/testuser/nogit',
  })
  assert.deepEqual(out, [])
})

test('專案內的 session 依 updatedAt 由新到舊排序', () => {
  // 輸入刻意給成「舊的在前」，這樣未排序或反向排序的實作都會被抓到。
  const out = groupIntoProjects(
    [sess({ sessionId: 'old', updatedAt: NOW - 900_000 }),
     sess({ sessionId: 'new', updatedAt: NOW - 100_000 })],
    deps,
  )
  assert.deepEqual(out[0]?.sessions.map((s) => s.sessionId), ['new', 'old'])
})

test('專案狀態由其下所有 session 聚合而來', () => {
  const out = groupIntoProjects(
    [sess({ sessionId: 'a', lifecycle: 'ended_clean' }),
     sess({ sessionId: 'b', lifecycle: 'crashed' })],
    deps,
  )
  assert.equal(out[0]?.aggregateStatus, 'crashed')
})

test('全部 session 都結束的專案沒有狀態圓點', () => {
  const out = groupIntoProjects([sess({ lifecycle: 'ended_clean' })], deps)
  assert.equal(out[0]?.aggregateStatus, null)
})

test('sessionCount 是該專案的 session 總數', () => {
  const out = groupIntoProjects(
    [sess({ sessionId: 'a' }), sess({ sessionId: 'b' }), sess({ sessionId: 'c' })],
    deps,
  )
  assert.equal(out[0]?.sessionCount, 3)
})

test('不修改輸入的 session 陣列', () => {
  const input = [sess({ sessionId: 'a' })]
  const snapshot = structuredClone(input)
  groupIntoProjects(input, deps)
  assert.deepEqual(input, snapshot)
})
