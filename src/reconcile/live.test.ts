import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLiveMarker } from './live.ts'
import { buildHookCommand } from '../hook/snippet.ts'
import { tempDir } from '../temp-dir.ts'

function liveDir(files: Record<string, string>): string {
  const dir = tempDir('helm-live-')
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

test('畸形內容不再回傳 null —— 那會被判成高信心的正常結束', () => {
  // 刻意的行為變更。回 null 等於宣稱「這個 session 沒有留下任何痕跡」，
  // 而檔案就在那裡；lifecycle 據此以高信心說它正常結束，doctor 再刪掉它。
  const dir = liveDir({ 'sess-a.json': '{壞掉' })
  const m = readLiveMarker(dir, 'sess-a')
  assert.notEqual(m, null)
  assert.equal(m?.degraded, true)
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
  const dir = tempDir('helm-live-')
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
  const dir = tempDir('helm-live-')
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

test('內容壞掉的 live 檔仍保有時間戳 —— 時間戳來自 mtime，不是內容', () => {
  // 這是本次修正的關鍵：舊實作把「檔案在但讀不出來」與「檔案不存在」
  // 收在同一個 null，於是 lifecycle 以高信心判定 ended_clean，doctor 接著
  // 刪掉它。而半截的 marker 正是「工具跑到一半被殺」留下的產物 ——
  // 關終端機 SIGHUP 就會這樣 —— 也就是這個檔案存在的唯一理由。
  for (const body of ['', '{"sessionId":"sess-a","ts":0,"toolNa', '{}', 'null']) {
    const dir = liveDir({ 'sess-a.json': body })
    const m = readLiveMarker(dir, 'sess-a')
    assert.notEqual(m, null, `不該當成沒有 marker：${JSON.stringify(body)}`)
    assert.equal(m?.degraded, true)
    assert.ok((m?.ts ?? 0) > 0, '時間戳必須仍然可用，crash 判定靠它')
    assert.equal(m?.toolName, '')
    assert.equal(m?.summary, '')
  }
})

test('讀得好的 marker 不標記為 degraded', () => {
  const dir = liveDir({
    'sess-a.json': JSON.stringify({ sessionId: 'sess-a', ts: 0, toolName: 'Bash', summary: 'x' }),
  })
  assert.equal(readLiveMarker(dir, 'sess-a')?.degraded, false)
})

test('內容的 sessionId 與檔名不符時視為壞掉，不採信內容', () => {
  const dir = liveDir({
    'sess-a.json': JSON.stringify({ sessionId: 'SOMEONE-ELSE', ts: 0, toolName: 'Bash', summary: 'x' }),
  })
  const m = readLiveMarker(dir, 'sess-a')
  assert.equal(m?.sessionId, 'sess-a', '一律以檔名為準')
  assert.equal(m?.degraded, true)
})

test('檔案不存在仍然回 null —— 那才是「沒有 marker」', () => {
  assert.equal(readLiveMarker(liveDir({}), 'nope'), null)
})
