import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLiveMarker } from './live.ts'

function liveDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'helm-live-'))
  mkdirSync(dir, { recursive: true })
  for (const [n, b] of Object.entries(files)) writeFileSync(join(dir, n), b)
  return dir
}

test('讀出有效的 live marker', () => {
  const dir = liveDir({
    'sess-a.json': JSON.stringify({
      sessionId: 'sess-a', ts: 1786417000000, toolName: 'Bash', summary: 'git status',
    }),
  })
  const m = readLiveMarker(dir, 'sess-a')
  assert.equal(m?.toolName, 'Bash')
  assert.equal(m?.ts, 1786417000000)
})

test('檔案不存在回傳 null', () => {
  assert.equal(readLiveMarker(liveDir({}), 'nope'), null)
})

test('畸形內容回傳 null 而不拋錯', () => {
  const dir = liveDir({ 'sess-a.json': '{壞掉' })
  assert.equal(readLiveMarker(dir, 'sess-a'), null)
})

test('summary 過長時截斷至 200 字元', () => {
  const dir = liveDir({
    'sess-a.json': JSON.stringify({
      sessionId: 'sess-a', ts: 1, toolName: 'Bash', summary: 'x'.repeat(500),
    }),
  })
  assert.equal(readLiveMarker(dir, 'sess-a')?.summary.length, 200)
})

test('session id 含路徑分隔字元時拒絕讀取（防目錄穿越）', () => {
  assert.equal(readLiveMarker(liveDir({}), '../../etc/passwd'), null)
})
