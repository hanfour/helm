import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readEnding } from './ending.ts'
import { tempDir } from '../../temp-dir.ts'

const dir = tempDir('helm-codex-ending')

const ev = (type: string, payload: Record<string, unknown> = {}) =>
  `${JSON.stringify({ timestamp: '2026-08-13T06:25:24.937Z', type: 'event_msg', payload: { type, ...payload } })}\n`

let n = 0
function rollout(body: string): string {
  const path = join(dir, `rollout-${n++}.jsonl`)
  writeFileSync(path, body)
  return path
}

test('結尾是 task_complete → finished', () => {
  assert.equal(readEnding(rollout(ev('task_started') + ev('task_complete'))), 'finished')
})

test('結尾是 turn_aborted → finished —— 中止也是一種收尾，不是半途斷掉', () => {
  assert.equal(readEnding(rollout(ev('task_started') + ev('turn_aborted'))), 'finished')
})

test('結尾是別的事件 → midflight', () => {
  // 實測這台機器 194 個 rollout 裡只有 2 個是這樣，而它們正是真的停在半途的。
  assert.equal(readEnding(rollout(ev('task_started') + ev('token_count'))), 'midflight')
})

test('只看最後一行 —— 第一輪做完、第二輪半途死掉，那是 midflight', () => {
  // 往回掃幾行會把這個誤判成 finished。實測 194 個檔裡 192 個的完成事件
  // 就是最後一行，所以往回掃買不到什麼，卻會漏掉這種情形。
  const body = ev('task_started') + ev('task_complete') + ev('task_started') + ev('token_count')
  assert.equal(readEnding(rollout(body)), 'midflight')
})

test('檔案不存在 → unknown，不是猜一個', () => {
  assert.equal(readEnding(join(dir, 'does-not-exist.jsonl')), 'unknown')
})

test('空檔案 → unknown', () => {
  assert.equal(readEnding(rollout('')), 'unknown')
})

test('最後一行還沒寫完 → unknown —— rollout 正在被寫入是常態', () => {
  const torn = ev('task_started') + '{"type":"event_msg","payload":{"typ'
  assert.equal(readEnding(rollout(torn)), 'unknown')
})

test('最後一筆事件超過初始緩衝區時仍讀得到', () => {
  // 一次工具輸出就能讓單行超過 8 KB。緩衝區不夠就得長大，否則會把做完的
  // session 判成 midflight —— 又是一次把猜測講成事實。
  const huge = ev('task_complete', { output: 'x'.repeat(40_000) })
  assert.equal(readEnding(rollout(ev('task_started') + huge)), 'finished')
})

test('結尾有空行也不影響', () => {
  assert.equal(readEnding(rollout(ev('task_complete') + '\n\n')), 'finished')
})

test('最後一行是合法 JSON 但沒有 payload.type → midflight', () => {
  const odd = `${JSON.stringify({ timestamp: 'x', type: 'response_item' })}\n`
  assert.equal(readEnding(rollout(ev('task_started') + odd)), 'midflight')
})
