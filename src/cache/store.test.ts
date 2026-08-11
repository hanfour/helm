import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  readCache, writeCache, setBrief, getFreshBriefEntry, digestOf, EMPTY_CACHE,
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
  const c = setBrief(EMPTY_CACHE, 's1', { digest: 'd1', generatedAt: 100, gitBranch: null, body: BRIEF })
  writeCache(f, c)
  assert.deepEqual(readCache(f), c)
})

test('setBrief 回傳新物件且不修改原物件', () => {
  const before = EMPTY_CACHE
  const snapshot = structuredClone(before)
  const after = setBrief(before, 's1', { digest: 'd1', generatedAt: 1, gitBranch: null, body: BRIEF })
  assert.deepEqual(before, snapshot)
  assert.equal(after.briefs['s1']?.digest, 'd1')
})

test('getFreshBriefEntry 在 digest 相符時回傳整筆快取（含產生時間）', () => {
  const c = setBrief(EMPTY_CACHE, 's1', { digest: 'd1', generatedAt: 100, gitBranch: null, body: BRIEF })
  assert.deepEqual(getFreshBriefEntry(c, 's1', 'd1')?.body, BRIEF)
  assert.equal(getFreshBriefEntry(c, 's1', 'd1')?.generatedAt, 100)
})

test('getFreshBriefEntry 在 digest 不符時回傳 null（已 stale）', () => {
  const c = setBrief(EMPTY_CACHE, 's1', { digest: 'd1', generatedAt: 1, gitBranch: null, body: BRIEF })
  assert.equal(getFreshBriefEntry(c, 's1', 'd2'), null)
})

test('getFreshBriefEntry 在 digest 為 null 時回傳 null（無法確認新鮮度）', () => {
  const c = setBrief(EMPTY_CACHE, 's1', { digest: 'd1', generatedAt: 1, gitBranch: null, body: BRIEF })
  assert.equal(getFreshBriefEntry(c, 's1', null), null)
})

test('getFreshBriefEntry 對未快取的 session 回傳 null', () => {
  assert.equal(getFreshBriefEntry(EMPTY_CACHE, 'nope', 'd1'), null)
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

test('單一筆壞掉的 brief 只丟那一筆，其餘照常保留', () => {
  // 每一筆簡報都是 57-86 秒的 LLM 花費。全有全無的解析讓一筆手改壞的、
  // 或一次寫到一半的紀錄，賠掉其他二十筆。
  const f = tmpFile(JSON.stringify({
    version: 1,
    briefs: {
      good: { digest: 'd1', generatedAt: 1, gitBranch: null, body: BRIEF },
      bad: { digest: '', generatedAt: 'not a number' },
    },
    prs: {}, projects: {},
  }))
  const c = readCache(f)
  assert.deepEqual(c.briefs['good']?.body, BRIEF)
  assert.equal(c.briefs['bad'], undefined)
  assert.equal(existsSync(f.replace(/\.json$/, '.corrupt.json')), false, '不該整份隔離')
})

test('整份 JSON 壞掉時仍然隔離整份 —— 那時沒有東西救得回來', () => {
  const f = tmpFile('{壞掉')
  assert.deepEqual(readCache(f), EMPTY_CACHE)
  assert.equal(existsSync(f.replace(/\.json$/, '.corrupt.json')), true)
})

test('寫入是原子的 —— 中途失敗不會留下半份檔案', () => {
  // 直接觀察：寫完之後目錄裡不該留有暫存檔。
  const f = tmpFile()
  writeCache(f, setBrief(EMPTY_CACHE, 's1', { digest: 'd1', generatedAt: 1, gitBranch: null, body: BRIEF }))
  const leftovers = readdirSync(dirname(f)).filter((n: string) => n.includes('.tmp'))
  assert.deepEqual(leftovers, [])
  assert.deepEqual(readCache(f).briefs['s1']?.body, BRIEF)
})
