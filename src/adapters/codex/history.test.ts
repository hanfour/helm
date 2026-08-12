import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { codexPrompts } from './history.ts'
import { tempDir } from '../../temp-dir.ts'

const SID = '019f40fa-de00-7f01-9f17-23f4771535c1'
const OTHER = '019fc64c-6b8a-7882-8c7b-c019bd18484c'

const line = (session_id: string, ts: number, text: string) =>
  `${JSON.stringify({ session_id, ts, text })}\n`

function history(body: string): string {
  const path = join(tempDir('helm-codex-'), 'history.jsonl')
  writeFileSync(path, body)
  return path
}

test('取出該 session 的 prompt，依時間排序', () => {
  const path = history(
    line(SID, 200, '第二個') + line(OTHER, 150, '別人的') + line(SID, 100, '第一個'),
  )
  assert.deepEqual(codexPrompts(path, SID), ['第一個', '第二個'])
})

test('沒有記錄是正常狀態，不是錯誤', () => {
  // 實測：192 個 rollout 只有 60 個在 history.jsonl 裡有記錄 ——
  // 沒送出過 prompt 的 session 本來就不在那裡。
  assert.deepEqual(codexPrompts(history(line(OTHER, 1, 'x')), SID), [])
})

test('檔案不存在時回空陣列', () => {
  assert.deepEqual(codexPrompts(join(tempDir('helm-codex-'), 'nope.jsonl'), SID), [])
})

test('壞掉的行略過，不讓整批失敗', () => {
  const path = history(
    line(SID, 100, '好的') + 'not json\n' + '{"session_id":123}\n' + '\n' + line(SID, 200, '也好'),
  )
  assert.deepEqual(codexPrompts(path, SID), ['好的', '也好'])
})

test('缺欄位或型別不對的行略過', () => {
  const path = history(
    `${JSON.stringify({ session_id: SID, text: '沒有 ts' })}\n`
    + `${JSON.stringify({ session_id: SID, ts: 1 })}\n`
    + `${JSON.stringify({ session_id: SID, ts: 'x', text: 'ts 不是數字' })}\n`
    + line(SID, 300, '正常的'),
  )
  assert.deepEqual(codexPrompts(path, SID), ['正常的'])
})

test('空字串的 prompt 略過 —— 那不是使用者說的話', () => {
  assert.deepEqual(codexPrompts(history(line(SID, 1, '') + line(SID, 2, '有內容')), SID), ['有內容'])
})

test('有上限，不把整份歷史塞進簡報', () => {
  // history.jsonl 在這台機器上有 552 行。整份餵進 LLM 既慢又會把
  // 最近的脈絡稀釋掉。
  const many = Array.from({ length: 100 }, (_, i) => line(SID, i, `第 ${i} 個`)).join('')
  const got = codexPrompts(history(many), SID, 20)
  assert.equal(got.length, 20)
  assert.equal(got.at(-1), '第 99 個', '要的是最近的那些')
  assert.equal(got[0], '第 80 個')
})
