import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTranscriptDigest, DEFAULT_LIMITS } from './transcript.ts'

function jsonl(records: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'helm-tr-'))
  const f = join(dir, 's.jsonl')
  writeFileSync(f, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return f
}

const userText = (text: string, ts: string) => ({
  type: 'user', timestamp: ts, cwd: '/p', gitBranch: 'main',
  message: { content: [{ type: 'text', text }] },
})

const userStringContent = (text: string, ts: string) => ({
  type: 'user', timestamp: ts, message: { content: text },
})

const toolUse = (name: string, input: object, ts: string) => ({
  type: 'assistant', timestamp: ts,
  message: { content: [{ type: 'tool_use', name, input }] },
})

test('抽出純文字 user prompt', () => {
  const f = jsonl([
    userText('修好登入流程', '2026-08-11T01:00:00.000Z'),
    userText('繼續跑最終 review', '2026-08-11T02:00:00.000Z'),
  ])
  assert.deepEqual(readTranscriptDigest(f).prompts, ['修好登入流程', '繼續跑最終 review'])
})

test('message.content 為字串時也能抽出', () => {
  const f = jsonl([userStringContent('目前狀況？', '2026-08-11T01:00:00.000Z')])
  assert.deepEqual(readTranscriptDigest(f).prompts, ['目前狀況？'])
})

test('排除 tool_result 內容，不當成使用者說的話', () => {
  const f = jsonl([{
    type: 'user', timestamp: '2026-08-11T01:00:00.000Z',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '一堆輸出' }] },
  }])
  assert.deepEqual(readTranscriptDigest(f).prompts, [])
})

test('排除 isMeta 標記的注入內容 —— 即使它不以尖括號開頭', () => {
  // 實測：圖片 caption 與 skill 重載訊息都不以 < 開頭，只靠前綴會漏 35%
  const f = jsonl([
    { ...userText('[Image: original 1080x2400, displayed at 900x2000.]', '2026-08-11T01:00:00.000Z'), isMeta: true },
    { ...userText('(Re-invocation of /superpowers:brainstorming)', '2026-08-11T01:30:00.000Z'), isMeta: true },
    userText('實機測試', '2026-08-11T02:00:00.000Z'),
  ])
  assert.deepEqual(readTranscriptDigest(f).prompts, ['實機測試'])
})

test('尖括號規則作為補強，涵蓋沒有 isMeta 標記的舊格式', () => {
  const f = jsonl([
    userText('<task-notification><task-id>abc</task-id></task-notification>', '2026-08-11T01:00:00.000Z'),
    userText('真的使用者訊息', '2026-08-11T02:00:00.000Z'),
  ])
  assert.deepEqual(readTranscriptDigest(f).prompts, ['真的使用者訊息'])
})

test('isMeta 為 false 的內容照常保留', () => {
  const f = jsonl([
    { ...userText('這是我打的字', '2026-08-11T01:00:00.000Z'), isMeta: false },
  ])
  assert.deepEqual(readTranscriptDigest(f).prompts, ['這是我打的字'])
})

test('只保留最後 N 則 prompt', () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    userText(`p${i}`, `2026-08-11T01:00:${String(i).padStart(2, '0')}.000Z`))
  const d = readTranscriptDigest(jsonl(many), { prompts: 5, files: 50, tools: 3 })
  assert.deepEqual(d.prompts, ['p25', 'p26', 'p27', 'p28', 'p29'])
})

test('從 Edit/Write 的 tool_use 抽出碰過的檔案並去重', () => {
  const f = jsonl([
    toolUse('Edit', { file_path: '/p/a.ts' }, '2026-08-11T01:00:00.000Z'),
    toolUse('Write', { file_path: '/p/b.ts' }, '2026-08-11T01:01:00.000Z'),
    toolUse('Edit', { file_path: '/p/a.ts' }, '2026-08-11T01:02:00.000Z'),
    toolUse('Read', { file_path: '/p/c.ts' }, '2026-08-11T01:03:00.000Z'),
  ])
  assert.deepEqual(readTranscriptDigest(f).touchedFiles, ['/p/a.ts', '/p/b.ts'])
})

test('最後 N 筆工具呼叫，Bash 保留完整指令', () => {
  const f = jsonl([
    toolUse('Read', { file_path: '/x' }, '2026-08-11T01:00:00.000Z'),
    toolUse('Bash', { command: 'npm test -- --watch=false' }, '2026-08-11T01:01:00.000Z'),
  ])
  const d = readTranscriptDigest(f, { prompts: 20, files: 50, tools: 2 })
  assert.equal(d.recentTools.length, 2)
  assert.equal(d.recentTools[1]?.name, 'Bash')
  assert.equal(d.recentTools[1]?.summary, 'npm test -- --watch=false')
})

test('非 Bash 工具的 summary 取檔案路徑或縮短的輸入', () => {
  const f = jsonl([toolUse('Edit', { file_path: '/p/long/path.ts' }, '2026-08-11T01:00:00.000Z')])
  assert.equal(readTranscriptDigest(f).recentTools[0]?.summary, '/p/long/path.ts')
})

test('lastTs 取最後一筆有時間戳的記錄', () => {
  const f = jsonl([
    userText('a', '2026-08-11T01:00:00.000Z'),
    { type: 'ai-title', aiTitle: 'Clone codebase' },
    userText('b', '2026-08-11T03:00:00.000Z'),
  ])
  assert.equal(readTranscriptDigest(f).lastTs, Date.parse('2026-08-11T03:00:00.000Z'))
})

test('gitBranch 取最後一筆有記錄的值', () => {
  const f = jsonl([
    { ...userText('a', '2026-08-11T01:00:00.000Z'), gitBranch: 'old' },
    { ...userText('b', '2026-08-11T02:00:00.000Z'), gitBranch: 'feature/x' },
  ])
  assert.equal(readTranscriptDigest(f).gitBranch, 'feature/x')
})

test('畸形行被跳過，不影響其餘解析', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-tr-'))
  const f = join(dir, 's.jsonl')
  writeFileSync(f, `{壞掉\n${JSON.stringify(userText('好的', '2026-08-11T01:00:00.000Z'))}\n`)
  assert.deepEqual(readTranscriptDigest(f).prompts, ['好的'])
})

test('檔案不存在時回傳空 digest 而不拋錯', () => {
  const d = readTranscriptDigest('/nonexistent/x.jsonl')
  assert.deepEqual(d, {
    prompts: [], touchedFiles: [], recentTools: [], lastTs: null, gitBranch: null,
  })
})

test('DEFAULT_LIMITS 對應規格 §8 的 20 / 50 / 3', () => {
  assert.deepEqual(DEFAULT_LIMITS, { prompts: 20, files: 50, tools: 3 })
})
