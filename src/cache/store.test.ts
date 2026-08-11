import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readCache, writeCache, setBrief, getFreshBrief, digestOf, EMPTY_CACHE,
} from './store.ts'
import type { Brief } from './store.ts'

const tmpFile = (body?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-cache-'))
  const f = join(dir, 'cache.json')
  if (body !== undefined) writeFileSync(f, body)
  return f
}

const BRIEF: Brief = {
  goal: '修好登入', done: ['寫測試'], currentStep: '實作中',
  nextStep: '跑測試', blockers: [], files: ['/p/a.ts'], prs: [],
}

test('檔案不存在時回傳空快取', () => {
  assert.deepEqual(readCache(tmpFile()), EMPTY_CACHE)
})

test('毀損的快取回傳空結構，並把原檔搬到 .corrupt.json', () => {
  const f = tmpFile('{壞掉')
  assert.deepEqual(readCache(f), EMPTY_CACHE)
  assert.equal(existsSync(f.replace(/\.json$/, '.corrupt.json')), true)
})

test('writeCache 寫出的內容可被 readCache 讀回', () => {
  const f = tmpFile()
  const c = setBrief(EMPTY_CACHE, 's1', { digest: 'd1', generatedAt: 100, body: BRIEF })
  writeCache(f, c)
  assert.deepEqual(readCache(f), c)
})

test('setBrief 回傳新物件且不修改原物件', () => {
  const before = EMPTY_CACHE
  const snapshot = structuredClone(before)
  const after = setBrief(before, 's1', { digest: 'd1', generatedAt: 1, body: BRIEF })
  assert.deepEqual(before, snapshot)
  assert.equal(after.briefs['s1']?.digest, 'd1')
})

test('getFreshBrief 在 digest 相符時回傳簡報', () => {
  const c = setBrief(EMPTY_CACHE, 's1', { digest: 'd1', generatedAt: 1, body: BRIEF })
  assert.deepEqual(getFreshBrief(c, 's1', 'd1'), BRIEF)
})

test('getFreshBrief 在 digest 不符時回傳 null（已 stale）', () => {
  const c = setBrief(EMPTY_CACHE, 's1', { digest: 'd1', generatedAt: 1, body: BRIEF })
  assert.equal(getFreshBrief(c, 's1', 'd2'), null)
})

test('getFreshBrief 在 digest 為 null 時回傳 null（無法確認新鮮度）', () => {
  const c = setBrief(EMPTY_CACHE, 's1', { digest: 'd1', generatedAt: 1, body: BRIEF })
  assert.equal(getFreshBrief(c, 's1', null), null)
})

test('getFreshBrief 對未快取的 session 回傳 null', () => {
  assert.equal(getFreshBrief(EMPTY_CACHE, 'nope', 'd1'), null)
})

test('digestOf 對同一個未變動的檔案產生相同值', () => {
  const f = tmpFile('內容')
  assert.equal(digestOf(f), digestOf(f))
})

test('digestOf 在檔案變動後產生不同值', async () => {
  const f = tmpFile('a')
  const before = digestOf(f)
  await new Promise((r) => setTimeout(r, 10))
  writeFileSync(f, 'a much longer content than before')
  assert.notEqual(digestOf(f), before)
})

test('digestOf 對 null 或不存在的路徑回傳 null', () => {
  assert.equal(digestOf(null), null)
  assert.equal(digestOf('/nonexistent/x'), null)
})
