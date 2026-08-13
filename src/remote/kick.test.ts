import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { kickRefreshIfStale } from './kick.ts'
import { writePrCache } from './cache.ts'
import { acquireRefreshLock } from './lock.ts'
import { tempDir } from '../temp-dir.ts'

const NOW = Date.UTC(2026, 7, 12, 12, 0, 0)
const paths = () => {
  const dir = tempDir('helm-kick-')
  return { cacheFile: join(dir, 'prs.json'), lockFile: join(dir, 'refresh.lock') }
}
const fresh = (fetchedAt: number) => ({ fetchedAt, prs: [], degraded: null })

test('沒有快取時會啟動更新', () => {
  let spawned = 0
  kickRefreshIfStale(paths(), NOW, () => { spawned++ })
  assert.equal(spawned, 1)
})

test('快取還新鮮時不啟動', () => {
  const p = paths()
  writePrCache(p.cacheFile, fresh(NOW - 30_000))
  let spawned = 0
  kickRefreshIfStale(p, NOW, () => { spawned++ })
  assert.equal(spawned, 0)
})

test('快取過期時啟動', () => {
  const p = paths()
  writePrCache(p.cacheFile, fresh(NOW - 61_000))
  let spawned = 0
  kickRefreshIfStale(p, NOW, () => { spawned++ })
  assert.equal(spawned, 1)
})

test('已經有人在更新時不再啟動 —— 這是每 5 秒都會走到的路', () => {
  const p = paths()
  acquireRefreshLock(p.lockFile, NOW)
  let spawned = 0
  kickRefreshIfStale(p, NOW, () => { spawned++ })
  assert.equal(spawned, 0)
})

test('spawn 失敗不影響呼叫端 —— 看板照樣要畫出來', () => {
  assert.doesNotThrow(() => kickRefreshIfStale(paths(), NOW, () => {
    throw new Error('spawn failed')
  }))
})

test('回傳快取內容，不論新舊 —— stale-while-revalidate', () => {
  const p = paths()
  writePrCache(p.cacheFile, { fetchedAt: NOW - 300_000, prs: [], degraded: 'gh 尚未登入' })
  const cache = kickRefreshIfStale(p, NOW, () => {})
  assert.equal(cache?.degraded, 'gh 尚未登入', '過期的照樣拿來畫')
})

test('寫不進快取時退避，不是每 5 秒重打一次 gh', () => {
  // 沒有這道退避的話，一個不可寫的 prs.json 會讓看板每次輪詢都 fork
  // 一次完整 sweep。實測每分鐘 12 次。
  const p = paths()
  let spawned = 0
  const spawn = () => { spawned++ }
  // 第一次：沒有快取，該啟動
  kickRefreshIfStale(p, NOW, spawn)
  assert.equal(spawned, 1)
  // refresh 跑了但寫不進去（快取仍然不存在）—— 下一次輪詢不該立刻再來
  kickRefreshIfStale(p, NOW + 5_000, spawn)
  assert.equal(spawned, 1, '5 秒後不該再 spawn')
  kickRefreshIfStale(p, NOW + 61_000, spawn)
  assert.equal(spawned, 2, '過了 TTL 才可以再試')
})
