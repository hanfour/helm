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

test('單一 PR 的狀態拿不到時仍然列出它，只是標為未知', () => {
  // 一個 PR 的 detail 失敗不該讓其餘的一起消失。
  const p = paths()
  refreshPrs(p, (args) => {
    if (args[0] === 'search') return JSON.stringify(listing)
    throw Object.assign(new Error('x'), { status: 1, stderr: 'not found' })
  }, NOW)
  const cache = readPrCache(p.cacheFile)
  assert.equal(cache?.prs.length, 1)
  assert.equal(cache?.prs[0]?.waiting, 'review', '問不到就當還沒審，不猜')
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
