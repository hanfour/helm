import { test } from 'node:test'
import assert from 'node:assert/strict'
import { glyph, relativeTime } from './glyphs.ts'

const ESC = String.fromCharCode(27)

test('busy 是實心、idle 是空心', () => {
  assert.equal(glyph('busy', 'high', false), '●')
  assert.equal(glyph('idle', 'high', false), '○')
})

test('低信心的判定在字元後加問號', () => {
  assert.equal(glyph('crashed', 'low', false), '●?')
  assert.equal(glyph('crashed', 'high', false), '●')
})

test('彩色模式輸出 ANSI 序列，無色模式完全不含 ESC', () => {
  assert.ok(glyph('crashed', 'high', true).includes(ESC))
  assert.ok(!glyph('crashed', 'high', false).includes(ESC))
})

test('crashed 與 ended 使用不同顏色', () => {
  assert.notEqual(glyph('crashed', 'high', true), glyph('ended', 'high', true))
})

test('relativeTime 產生中文相對時間', () => {
  const now = Date.UTC(2026, 7, 11, 12, 0, 0)
  assert.equal(relativeTime(now - 30_000, now), '剛剛')
  assert.equal(relativeTime(now - 5 * 60_000, now), '5 分鐘前')
  assert.equal(relativeTime(now - 3 * 3_600_000, now), '3 小時前')
  assert.equal(relativeTime(now - 2 * 86_400_000, now), '2 天前')
})

test('relativeTime 對未來時間回傳「剛剛」而非負數', () => {
  const now = Date.UTC(2026, 7, 11, 12, 0, 0)
  assert.equal(relativeTime(now + 60_000, now), '剛剛')
})
