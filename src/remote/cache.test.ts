import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readPrCache, shouldRefresh, writePrCache, type PrCache } from './cache.ts'
import { tempDir } from '../temp-dir.ts'

const NOW = Date.UTC(2026, 7, 12, 12, 0, 0)
const file = () => join(tempDir('helm-pr-'), 'prs.json')

const cache = (over: Partial<PrCache> = {}): PrCache => ({
  fetchedAt: NOW,
  prs: [{
    repo: 'a/b', number: 1, title: 't', url: 'u', isDraft: false,
    updatedAt: '2026-08-01T00:00:00Z', waiting: 'review', waitingLabel: '等人審',
  }],
  degraded: null,
  ...over,
})

test('寫得出去也讀得回來', () => {
  const f = file()
  writePrCache(f, cache())
  assert.deepEqual(readPrCache(f), cache())
})

test('寫入是原子的 —— 不留暫存檔', () => {
  const f = file()
  writePrCache(f, cache())
  const dir = f.slice(0, f.lastIndexOf('/'))
  assert.deepEqual(
    readFileSync(f, 'utf8').trim().at(-1),
    '}',
    '完整的 JSON',
  )
  assert.equal(existsSync(`${f}.${process.pid}.tmp`), false)
  assert.ok(dir.length > 0)
})

test('沒有快取檔時回 null —— 那是第一次跑，不是錯誤', () => {
  assert.equal(readPrCache(file()), null)
})

test('快取檔壞掉時回 null，不讓看板崩掉', () => {
  for (const junk of ['not json', 'null', '[]', '42', '{"prs":"nope"}', '{}']) {
    const f = file()
    writeFileSync(f, junk)
    assert.equal(readPrCache(f), null, junk)
  }
})

test('60 秒內不重新抓', () => {
  assert.equal(shouldRefresh(cache({ fetchedAt: NOW - 59_000 }), NOW), false)
})

test('超過 60 秒就該重新抓，但舊資料照樣拿得到', () => {
  // stale-while-revalidate：過期不代表沒東西可畫。
  const stale = cache({ fetchedAt: NOW - 61_000 })
  assert.equal(shouldRefresh(stale, NOW), true)
  assert.equal(stale.prs.length, 1, '舊的照樣在')
})

test('沒有快取時當然要抓', () => {
  assert.equal(shouldRefresh(null, NOW), true)
})

test('未來的時間戳不會讓它永遠不更新', () => {
  // 時鐘往回調過，或快取是另一台機器寫的。
  assert.equal(shouldRefresh(cache({ fetchedAt: NOW + 3600_000 }), NOW), true)
})

test('降級狀態也存進快取 —— 否則每 5 秒重試一次沒登入的 gh', () => {
  const f = file()
  const degraded = cache({ prs: [], degraded: 'gh 尚未登入…' })
  writePrCache(f, degraded)
  assert.equal(readPrCache(f)?.degraded, 'gh 尚未登入…')
  assert.equal(shouldRefresh(readPrCache(f), NOW), false, '降級也要遵守 TTL')
})

test('快取檔是 0600 —— 裡面有私有 repo 名稱與 PR 標題', () => {
  // install.ts 就在隔壁刻意用 0600，註解記的正是那次 token 以 0644 寫出的事故。
  const f = file()
  writePrCache(f, cache())
  assert.equal(statSync(f).mode & 0o777, 0o600)
})

test('父目錄不存在時會建出來 —— 第一次跑時 ~/.helm 還沒有', () => {
  const f = join(tempDir('helm-pr-'), 'nested', 'deep', 'prs.json')
  writePrCache(f, cache())
  assert.deepEqual(readPrCache(f), cache())
})

test('只壞一個欄位的快取也要拒絕 —— 否則會丟 TypeError 炸穿整個看板', () => {
  // `{"fetchedAt":1,"prs":"nope"}` 會讓 prs.flatMap 在 try 之外爆炸。
  for (const junk of ['{"fetchedAt":"x","prs":[]}', '{"fetchedAt":1,"prs":"nope"}', '{"prs":[]}']) {
    const f = file()
    writeFileSync(f, junk)
    assert.doesNotThrow(() => readPrCache(f), junk)
    assert.equal(readPrCache(f), null, junk)
  }
})
