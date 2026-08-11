import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanTranscripts } from './scan.ts'

const NOW = Date.now()
const DAY = 86_400_000

interface FileSpec {
  slug: string
  name: string
  ageDays?: number
  nested?: boolean
}

function scaffold(files: readonly FileSpec[]): string {
  const root = mkdtempSync(join(tmpdir(), 'helm-scan-'))
  for (const f of files) {
    const dir = f.nested === true ? join(root, f.slug, 'sidecar') : join(root, f.slug)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, f.name)
    writeFileSync(path, '{}\n')
    const at = (NOW - (f.ageDays ?? 0) * DAY) / 1000
    utimesSync(path, at, at)
  }
  return root
}

test('掃出頂層的 transcript，帶上 slug、sessionId 與 mtime', () => {
  const root = scaffold([{ slug: '-Users-u-proj', name: 'sess-a.jsonl' }])
  const found = scanTranscripts(root, 0)
  assert.equal(found.length, 1)
  assert.equal(found[0]?.slug, '-Users-u-proj')
  assert.equal(found[0]?.sessionId, 'sess-a')
  assert.ok(found[0]?.path.endsWith('-Users-u-proj/sess-a.jsonl'))
  assert.ok(Math.abs((found[0]?.mtimeMs ?? 0) - NOW) < 5000)
})

test('不遞迴進巢狀目錄 —— 那裡放的是 sidecar，不是 session transcript', () => {
  const root = scaffold([
    { slug: '-Users-u-proj', name: 'real.jsonl' },
    { slug: '-Users-u-proj', name: 'sidecar.jsonl', nested: true },
  ])
  assert.deepEqual(scanTranscripts(root, 0).map((f) => f.sessionId), ['real'])
})

test('濾掉活動時間早於 sinceMs 的 transcript', () => {
  const root = scaffold([
    { slug: '-Users-u-proj', name: 'fresh.jsonl', ageDays: 1 },
    { slug: '-Users-u-proj', name: 'stale.jsonl', ageDays: 30 },
  ])
  const found = scanTranscripts(root, NOW - 14 * DAY)
  assert.deepEqual(found.map((f) => f.sessionId), ['fresh'])
})

test('剛好落在邊界上的 transcript 算在窗口內', () => {
  const root = scaffold([{ slug: '-Users-u-proj', name: 'edge.jsonl', ageDays: 14 }])
  // utimes 只有秒級精度，容忍 1 秒誤差。
  assert.equal(scanTranscripts(root, NOW - 14 * DAY - 1000).length, 1)
})

test('忽略非 .jsonl 的檔案', () => {
  const root = scaffold([
    { slug: '-Users-u-proj', name: 'sess.jsonl' },
    { slug: '-Users-u-proj', name: 'notes.md' },
  ])
  assert.deepEqual(scanTranscripts(root, 0).map((f) => f.sessionId), ['sess'])
})

test('projects 目錄不存在時回傳空陣列而不是丟例外', () => {
  assert.deepEqual(scanTranscripts(join(tmpdir(), 'helm-scan-does-not-exist'), 0), [])
})

test('多個 slug 目錄都會掃到', () => {
  const root = scaffold([
    { slug: '-Users-u-a', name: 'sa.jsonl' },
    { slug: '-Users-u-b', name: 'sb.jsonl' },
  ])
  assert.deepEqual(
    scanTranscripts(root, 0).map((f) => f.sessionId).toSorted(),
    ['sa', 'sb'],
  )
})

test('回傳 birthtimeMs 供沒有註冊表紀錄的 session 當作起始時間', () => {
  const root = scaffold([{ slug: '-Users-u-proj', name: 'sess.jsonl' }])
  assert.ok((scanTranscripts(root, 0)[0]?.birthtimeMs ?? 0) > 0)
})
