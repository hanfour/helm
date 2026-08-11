import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSubdirReader, resolveSlug, slugifyCwd } from './slug.ts'

/** A fake filesystem: absolute dir → its subdirectory names. */
const fs = (tree: Record<string, string[]>) => ({
  subdirs: (dir: string): readonly string[] => tree[dir] ?? [],
})

test('slugifyCwd 逐字元取代非英數字元，不合併連續字元', () => {
  assert.equal(slugifyCwd('/Users/u/proj'), '-Users-u-proj')
  assert.equal(slugifyCwd('/Users/u/.pmk/review'), '-Users-u--pmk-review')
  assert.equal(slugifyCwd('/Users/u/data-svc-2.0'), '-Users-u-data-svc-2-0')
})

test('slugifyCwd 把中文字視為非英數字元，一字一個 dash', () => {
  assert.equal(slugifyCwd('/Users/u/季評分Q1'), '-Users-u----Q1')
})

const TREE = {
  '/': ['Users', 'private'],
  '/Users': ['u'],
  '/Users/u': ['proj', 'data-svc-2.0', 'data-svc-2.0-clone', '.pmk', '季評分Q1-reports'],
  '/Users/u/.pmk': ['review-workspace'],
}

test('反解出單純的路徑', () => {
  assert.equal(resolveSlug('-Users-u-proj', fs(TREE)), '/Users/u/proj')
})

test('反解出含點號的目錄名（dash 可能來自 . 也可能來自 -）', () => {
  assert.equal(resolveSlug('-Users-u-data-svc-2-0', fs(TREE)), '/Users/u/data-svc-2.0')
})

test('較長的比對優先，不會把 data-svc-2.0-clone 誤判成 data-svc-2.0', () => {
  assert.equal(
    resolveSlug('-Users-u-data-svc-2-0-clone', fs(TREE)),
    '/Users/u/data-svc-2.0-clone',
  )
})

test('反解出連續非英數字元造成的連續 dash', () => {
  assert.equal(resolveSlug('-Users-u--pmk-review-workspace', fs(TREE)), '/Users/u/.pmk/review-workspace')
})

test('反解出含中文的目錄名', () => {
  assert.equal(resolveSlug('-Users-u----Q1-reports', fs(TREE)), '/Users/u/季評分Q1-reports')
})

test('大小寫不敏感 —— macOS 記錄的 cwd 大小寫未必等於磁碟上的', () => {
  assert.equal(resolveSlug('-Users-U-Proj', fs(TREE)), '/Users/u/proj')
})

test('磁碟上不存在的路徑回傳 null，而不是硬拼一個出來', () => {
  assert.equal(resolveSlug('-private-var-folders-xx-tmpdir', fs(TREE)), null)
})

test('走進死路時會回溯，改試較短的比對', () => {
  // a-b 這個目錄能吃掉前兩段但底下沒有 c；正解是 a/b-c。
  const tree = { '/': ['a', 'a-b'], '/a': ['b-c'], '/a-b': ['zzz'] }
  assert.equal(resolveSlug('-a-b-c', fs(tree)), '/a/b-c')
})

test('也接受目錄名原字面比對 —— 舊版 Claude Code 的 slug 會保留點號', () => {
  const tree = { '/': ['Users'], '/Users': ['u'], '/Users/u': ['.claude'], '/Users/u/.claude': ['usage-data'] }
  assert.equal(resolveSlug('-Users-u-.claude-usage-data', fs(tree)), '/Users/u/.claude/usage-data')
})

test('空字串與不以 dash 開頭的輸入回傳 null', () => {
  assert.equal(resolveSlug('', fs(TREE)), null)
  assert.equal(resolveSlug('Users-u-proj', fs(TREE)), null)
})

test('目錄讀不到時回傳 null 而不是丟例外', () => {
  const throwing = {
    subdirs: (): readonly string[] => {
      throw new Error('EACCES')
    },
  }
  assert.throws(() => throwing.subdirs())
  assert.equal(resolveSlug('-Users-u-proj', fs({})), null)
})

test('病態的目錄結構不會無限展開 —— 有步數上限', () => {
  // 每一層都有 a、a-a、a-a-a 三種可能吃法，指數級分支。
  const deep = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`/${Array(i + 1).fill('a').join('/')}`, ['a', 'a-a', 'a-a-a']]),
  )
  const tree = { '/': ['a', 'a-a', 'a-a-a'], ...deep }
  const started = performance.now()
  resolveSlug(`-${Array(30).fill('a').join('-')}-nope`, fs(tree))
  assert.ok(performance.now() - started < 1000, '解析必須在有限步數內放棄')
})

test('createSubdirReader 只回傳子目錄，忽略檔案', () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-slug-'))
  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'file.txt'), '')
  assert.deepEqual(createSubdirReader()(root).toSorted(), ['sub'])
})

test('createSubdirReader 把指向目錄的 symlink 也算進來（macOS 的 /var 就是）', () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-slug-'))
  mkdirSync(join(root, 'real'))
  symlinkSync(join(root, 'real'), join(root, 'link'))
  assert.deepEqual(createSubdirReader()(root).toSorted(), ['link', 'real'])
})

test('createSubdirReader 讀不到目錄時回傳空陣列而不是丟例外', () => {
  assert.deepEqual(createSubdirReader()(join(tmpdir(), 'helm-slug-nope')), [])
})

test('createSubdirReader 對同一個目錄只讀一次', () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-slug-'))
  mkdirSync(join(root, 'a'))
  const read = createSubdirReader()
  const first = read(root)
  mkdirSync(join(root, 'b'))
  // 快取只活一次 CLI 呼叫，所以讀到舊值是刻意的，也讓解析多個 slug 時
  // 不必重覆掃同一個 home 目錄。
  assert.deepEqual(read(root), first)
})

test('resolveSlug 走真實檔案系統也能反解', () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-slug-'))
  mkdirSync(join(root, 'data-svc-2.0'), { recursive: true })
  const slug = slugifyCwd(join(root, 'data-svc-2.0'))
  assert.equal(resolveSlug(slug, { subdirs: createSubdirReader() }), join(root, 'data-svc-2.0'))
})

test('resolveSlug 不修改傳入的目錄清單', () => {
  const names = ['proj', 'data-svc-2.0']
  const snapshot = [...names]
  resolveSlug('-Users-u-proj', { subdirs: (d) => (d === '/Users/u' ? names : TREE[d as keyof typeof TREE] ?? []) })
  assert.deepEqual(names, snapshot)
})
