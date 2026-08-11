import { test } from 'node:test'
import assert from 'node:assert/strict'
import { displayWidth, padTo } from './width.ts'

const ESC = String.fromCharCode(27)

test('ASCII 一字一欄', () => {
  assert.equal(displayWidth('helm'), 4)
})

test('中文字佔兩欄', () => {
  assert.equal(displayWidth('等輸入'), 6)
})

test('中英混排相加', () => {
  assert.equal(displayWidth('1 個在跑'), 2 + 6)
})

test('emoji 佔兩欄', () => {
  assert.equal(displayWidth('📌'), 2)
})

test('ANSI 顏色序列不計入寬度', () => {
  assert.equal(displayWidth(`${ESC}[31m●${ESC}[0m`), 1)
})

test('空字串寬度為 0', () => {
  assert.equal(displayWidth(''), 0)
})

test('padTo 依顯示寬度補到指定欄數', () => {
  assert.equal(padTo('ab', 5), 'ab   ')
  assert.equal(displayWidth(padTo('等輸入', 10)), 10)
})

test('padTo 對已達寬度的字串原樣回傳，不截斷', () => {
  assert.equal(padTo('abcdef', 3), 'abcdef')
})

test('padTo 不修改輸入內容，只在尾端補空白', () => {
  assert.ok(padTo('helm', 8).startsWith('helm'))
})
