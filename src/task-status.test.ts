import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TASK_LABEL, taskLabelOf } from './task-status.ts'

test('三個狀態各有自己的詞', () => {
  assert.equal(taskLabelOf('done'), '任務完成')
  assert.equal(taskLabelOf('in_progress'), '任務進行中')
  assert.equal(taskLabelOf('blocked'), '任務卡住')
})

test('未知時回 null，讓呼叫端什麼都不畫', () => {
  // 舊快取沒有這個欄位、模型回傳非法值、簡報過期，三種都走這裡。
  // 回一個字串會逼呼叫端去猜哪個字串代表「不要畫」。
  assert.equal(taskLabelOf(null), null)
  assert.equal(taskLabelOf(undefined), null)
})

test('任務狀態的詞跟行程狀態的詞不重疊', () => {
  // 同一列會同時出現「已結束」與任務狀態，看得出是兩件事才有意義。
  const lifecycleWords = ['執行中', '等輸入', '已結束', '已中斷', '沒有動靜']
  for (const word of Object.values(TASK_LABEL)) {
    assert.ok(!lifecycleWords.includes(word), `「${word}」跟行程狀態撞詞`)
  }
})
