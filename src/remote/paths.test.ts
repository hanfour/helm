import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prPaths } from './paths.ts'
import { resolvePaths } from '../paths.ts'

test('快取與鎖的檔名是 menu 與 pr-refresh 之間的契約', () => {
  // 兩個行程各自算路徑，名字對不上就等於互斥失效、快取永遠不命中。
  const p = prPaths(resolvePaths({ home: '/h' }))
  assert.equal(p.cacheFile, '/h/.helm/prs.json')
  assert.equal(p.lockFile, '/h/.helm/pr-refresh.lock')
})

test('都在 helm 自己的目錄底下 —— 不散落到別人的地方', () => {
  const p = prPaths(resolvePaths({ home: '/h' }))
  for (const f of [p.cacheFile, p.lockFile]) assert.match(f, /^\/h\/\.helm\//)
})
