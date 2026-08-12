import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRolloutName } from './rollout-name.ts'

const ID = '019fc64c-6b8a-7882-8c7b-c019bd18484c'

test('從檔名解出這個檔案自己的 id 與開始時間', () => {
  // 不是 session id —— 全部 192 個 rollout 裡有 106 個的 session_meta 帶著
  // 不同的 id，因為一個 session 會續接／fork 出多個 rollout 檔（這台機器上
  // 最多的一個有 33 個）。照檔名分組會把那個 session 畫成 33 行。
  const r = parseRolloutName(`rollout-2026-08-03T14-25-24-${ID}.jsonl`)
  assert.equal(r?.rolloutId, ID)
  assert.equal(new Date(r?.startedAt ?? 0).getFullYear(), 2026)
})

test('檔名的時間是本地時間，不是 UTC', () => {
  // 實測那一筆：檔名寫 T14-25-24，而 session_meta 的 payload.timestamp 是
  // 2026-08-03T06:25:24.937Z —— 差 8 小時，也就是這台機器的時區。
  // 當成 UTC 解析的話整個看板的排序會錯一整個時區。
  const r = parseRolloutName(`rollout-2026-08-03T14-25-24-${ID}.jsonl`)
  const local = new Date(2026, 7, 3, 14, 25, 24)
  assert.equal(r?.startedAt, local.getTime())
})

test('毫秒不在檔名裡，所以只到秒', () => {
  const r = parseRolloutName(`rollout-2026-08-03T14-25-24-${ID}.jsonl`)
  assert.equal((r?.startedAt ?? 0) % 1000, 0)
})

test('不是 rollout 檔的一律回 null', () => {
  for (const name of [
    'history.jsonl',
    `rollout-2026-08-03T14-25-24-${ID}.json`,
    `${ID}.jsonl`,
    'rollout-.jsonl',
    '',
    `rollout-2026-08-03T14-25-24-${ID}.jsonl.bak`,
  ]) {
    assert.equal(parseRolloutName(name), null, JSON.stringify(name))
  }
})

test('時間戳壞掉時回 null，不回一個 NaN 的時間', () => {
  // 一個 NaN 的 startedAt 會一路流進排序與相對時間，畫出「NaN 天前」。
  for (const stamp of ['2026-13-03T14-25-24', '2026-08-32T14-25-24', 'not-a-date', '2026-08-03T99-99-99']) {
    assert.equal(parseRolloutName(`rollout-${stamp}-${ID}.jsonl`), null, stamp)
  }
})

test('uuid 少一段或多一段時回 null', () => {
  for (const id of ['019fc64c-6b8a-7882-8c7b', `${ID}-extra`, 'not-a-uuid-at-all', '']) {
    assert.equal(parseRolloutName(`rollout-2026-08-03T14-25-24-${id}.jsonl`), null, id)
  }
})

test('帶著目錄的路徑不被接受 —— 這裡只認檔名', () => {
  assert.equal(parseRolloutName(`2026/08/03/rollout-2026-08-03T14-25-24-${ID}.jsonl`), null)
})
