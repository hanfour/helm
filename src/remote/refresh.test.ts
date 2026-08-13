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
  assert.ok((cache?.fetchedAt ?? 0) > 0, 'fetchedAt 記的是資料落地的時刻')
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

test('sweep 有總時限 —— 超過就寫下已經拿到的部分並收工', () => {
  // 每個 gh pr view 的 execFileSync timeout 是 30 秒，--limit 50 表示
  // 最壞 51 × 30s = 25.5 分鐘，遠超過鎖的 5 分鐘過期窗口。網路不穩時
  // 每過 5 分鐘就多一個接管者，前面的都還在跑 —— 實測 6 個並行。
  const p = paths()
  let elapsed = 0
  const many = Array.from({ length: 10 }, (_, i) => ({ ...listing[0], number: 100 + i }))
  refreshPrs(p, (args) => {
    if (args[0] === 'search') return JSON.stringify(many)
    elapsed += 60_000
    return JSON.stringify({ reviewDecision: 'APPROVED', statusCheckRollup: [] })
  }, NOW, { clock: () => NOW + elapsed })

  const cache = readPrCache(p.cacheFile)
  assert.ok((cache?.prs.length ?? 0) > 0, '已經拿到的要留下')
  assert.ok((cache?.prs.length ?? 0) < 10, '超時之後不該繼續打')
  assert.match(cache?.degraded ?? '', /只更新了 \d+\/\d+/, cache?.degraded ?? '')
})

test('沒有超時的話全部都會拿到', () => {
  const p = paths()
  const many = Array.from({ length: 5 }, (_, i) => ({ ...listing[0], number: 200 + i }))
  refreshPrs(p, (args) => (args[0] === 'search' ? JSON.stringify(many) : JSON.stringify({ reviewDecision: 'APPROVED', statusCheckRollup: [] })), NOW)
  assert.equal(readPrCache(p.cacheFile)?.prs.length, 5)
})

test('fetchedAt 記的是寫入當下，不是 sweep 開始的時刻', () => {
  // 用開始時間的話，一趟 36 秒的 sweep 會把 60 秒的 TTL 吃掉超過一半，
  // gh 實際被問的頻率是文件宣稱的 2.5 倍。
  const p = paths()
  let elapsed = 0
  refreshPrs(p, (args) => {
    elapsed += 5_000
    return args[0] === 'search' ? JSON.stringify(listing) : JSON.stringify({ reviewDecision: 'APPROVED', statusCheckRollup: [] })
  }, NOW, { clock: () => NOW + elapsed })
  assert.ok((readPrCache(p.cacheFile)?.fetchedAt ?? 0) > NOW, 'TTL 要從資料落地那一刻算')
})
