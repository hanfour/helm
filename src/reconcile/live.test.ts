import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLiveMarker } from './live.ts'
import { buildHookCommand } from '../hook/snippet.ts'

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
  assert.equal(m?.summary, 'git status')
  // 刻意的行為變更：ts 改由檔案 mtime 決定，內容裡的值一律忽略。
  // hook 只准 spawn 一次，而 POSIX sh 沒有取 epoch 的 builtin —— 寫時間戳
  // 就得呼叫 date，那是第二次 spawn。mtime 指的是同一個瞬間，精度還更好。
  assert.notEqual(m?.ts, 1786417000000)
  assert.ok(Math.abs((m?.ts ?? 0) - Date.now()) < 5000)
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

test('ts 取檔案 mtime，而不是檔案內容裡的 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-live-'))
  const before = Date.now()
  writeFileSync(join(dir, 'sess-1.json'),
    '{"sessionId":"sess-1","ts":0,"toolName":"Bash","summary":"npm test"}\n')
  const marker = readLiveMarker(dir, 'sess-1')
  assert.ok((marker?.ts ?? 0) >= before - 2000)
  assert.ok((marker?.ts ?? 0) <= Date.now() + 2000)
})

test('hook 實際寫出的內容能被 readLiveMarker 直接吃下', () => {
  // 這是本 task 最重要的一個測試：shell 那端與 TypeScript 這端的契約，
  // 只有它守著。兩邊分開改的時候，只有它會出聲。
  const dir = mkdtempSync(join(tmpdir(), 'helm-live-'))
  const id = 'aaaa1111-0000-1111-2222-333344445555'
  execFileSync('sh', ['-c', buildHookCommand(dir, join(dir, 'errors.log'))], {
    input: JSON.stringify({
      session_id: id, tool_name: 'Bash', tool_input: { command: 'npm test' },
    }),
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  const marker = readLiveMarker(dir, id)
  assert.equal(marker?.sessionId, id)
  assert.equal(marker?.toolName, 'Bash')
  assert.equal(marker?.summary, 'npm test')
  assert.ok((marker?.ts ?? 0) > 0, 'ts 必須來自檔案 mtime')
})
