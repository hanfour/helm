import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { refreshPrs } from './refresh.ts'
import { readPrCache } from './cache.ts'
import { acquireRefreshLock } from './lock.ts'
import { tempDir } from '../temp-dir.ts'

const NOW = Date.UTC(2026, 7, 12, 12, 0, 0)
const paths = () => {
  const dir = tempDir('helm-refresh-')
  return { cacheFile: join(dir, 'prs.json'), lockFile: join(dir, 'refresh.lock') }
}

const listing = [{
  number: 4853,
  title: 'feat: 帳務',
  url: 'https://github.com/a/b/pull/4853',
  isDraft: false,
  updatedAt: '2026-04-14T02:13:36Z',
  repository: { nameWithOwner: 'a/b' },
}]

const exec = (over: { detail?: unknown; listFails?: boolean } = {}) => (args: readonly string[]) => {
  if (args[0] === 'search') {
    if (over.listFails) throw Object.assign(new Error('x'), { status: 4, stderr: 'gh auth login' })
    return JSON.stringify(listing)
  }
  return JSON.stringify(over.detail ?? { reviewDecision: 'APPROVED', statusCheckRollup: [] })
}

test('抓下來的狀態寫進快取', () => {
  const p = paths()
  refreshPrs(p, exec(), NOW)
  const cache = readPrCache(p.cacheFile)
  assert.equal(cache?.prs.length, 1)
  assert.equal(cache?.prs[0]?.waitingLabel, '可合併')
  assert.equal(cache?.fetchedAt, NOW)
  assert.equal(cache?.degraded, null)
})

test('清單失敗時把原因寫進快取 —— 下次不用再問一遍', () => {
  const p = paths()
  refreshPrs(p, exec({ listFails: true }), NOW)
  const cache = readPrCache(p.cacheFile)
  assert.match(cache?.degraded ?? '', /gh auth login/)
  assert.deepEqual(cache?.prs, [])
})

test('鎖被別人持有時完全不呼叫 gh', () => {
  // 看板每 5 秒跑一次，而一次 gh 要好幾秒。沒有這道閘，一分鐘內會有
  // 十幾個行程搶著做同一件事。
  const p = paths()
  acquireRefreshLock(p.lockFile, NOW)
  let calls = 0
  const counting = (args: readonly string[]) => {
    calls++
    return exec()(args)
  }
  assert.equal(refreshPrs(p, counting, NOW), false)
  assert.equal(calls, 0, '一次都不該呼叫')
})

test('跑完之後鎖要放開', () => {
  const p = paths()
  refreshPrs(p, exec(), NOW)
  assert.equal(refreshPrs(p, exec(), NOW + 1000), true, '第二次拿得到鎖')
})

test('gh 中途丟例外時鎖也要放開 —— 否則永遠卡住', () => {
  const p = paths()
  refreshPrs(p, () => { throw new Error('boom') }, NOW)
  assert.equal(refreshPrs(p, exec(), NOW + 1000), true)
})

test('單一 PR 的狀態拿不到時要說出來，不是畫成信心十足的「等人審」', () => {
  // helm 根本沒拿到這個 PR 的 review 與 CI 狀態。它可能可合併、可能
  // 等你改、也可能 CI 全紅。畫成「等人審」是主張球在審查者手上，
  // 而球可能在使用者手上。prDetail 已經把原因算出來了，refreshPrs 丟掉了它。
  const p = paths()
  refreshPrs(p, (args) => {
    if (args[0] === 'search') return JSON.stringify(listing)
    throw Object.assign(new Error('x'), { status: 1, stderr: 'HTTP 502: Bad Gateway' })
  }, NOW)
  const cache = readPrCache(p.cacheFile)
  assert.equal(cache?.prs.length, 1, 'PR 本身仍要列出來')
  assert.equal(cache?.prs[0]?.waiting, 'unknown')
  assert.match(cache?.prs[0]?.waitingLabel ?? '', /狀態未知|讀不到/)
})

test('部分 PR 拿不到狀態時，其餘的照常', () => {
  const p = paths()
  const two = [listing[0], { ...listing[0], number: 999 }]
  refreshPrs(p, (args) => {
    if (args[0] === 'search') return JSON.stringify(two)
    if (args.includes('999')) throw Object.assign(new Error('x'), { status: 1, stderr: 'nope' })
    return JSON.stringify({ reviewDecision: 'APPROVED', statusCheckRollup: [] })
  }, NOW)
  const cache = readPrCache(p.cacheFile)
  const byNumber = Object.fromEntries((cache?.prs ?? []).map((pr) => [pr.number, pr.waiting]))
  assert.equal(byNumber[4853], 'mergeable')
  assert.equal(byNumber[999], 'unknown')
})
