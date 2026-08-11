import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseProcStart, parseLstart, procStartMatches } from './processes.ts'

test('parseProcStart 將註冊表字串當作 UTC 解析', () => {
  const ms = parseProcStart('Thu Aug  6 06:16:12 2026')
  assert.equal(ms, Date.UTC(2026, 7, 6, 6, 16, 12))
})

test('parseProcStart 容忍月份與日之間的雙空格', () => {
  assert.equal(
    parseProcStart('Thu Aug  6 06:16:12 2026'),
    parseProcStart('Thu Aug 6 06:16:12 2026'),
  )
})

test('parseLstart 將 ps 輸出當作本地時間解析', () => {
  const ms = parseLstart('Thu Aug 6 14:16:12 2026')
  assert.equal(ms, new Date(2026, 7, 6, 14, 16, 12).getTime())
})

test('procStartMatches 對同一行程的兩種表示法回傳 true', () => {
  // 實測樣本：台北時區（UTC+8）下，兩者指向同一時刻
  assert.equal(
    procStartMatches('Thu Aug  6 06:16:12 2026', 'Thu Aug 6 14:16:12 2026'),
    new Date(2026, 7, 6, 14, 16, 12).getTime() === Date.UTC(2026, 7, 6, 6, 16, 12),
  )
})

test('procStartMatches 容忍 2 秒以內的誤差', () => {
  const utc = 'Thu Aug  6 06:16:12 2026'
  const localMs = Date.UTC(2026, 7, 6, 6, 16, 13)
  const local = fmtLocal(new Date(localMs))
  assert.equal(procStartMatches(utc, local), true)
})

test('procStartMatches 對相差一小時的行程回傳 false（PID 已被重用）', () => {
  const utc = 'Thu Aug  6 06:16:12 2026'
  const local = fmtLocal(new Date(Date.UTC(2026, 7, 6, 7, 16, 12)))
  assert.equal(procStartMatches(utc, local), false)
})

test('無法解析的輸入回傳 null 並使比對為 false', () => {
  assert.equal(parseProcStart('不是日期'), null)
  assert.equal(parseLstart(''), null)
  assert.equal(procStartMatches('壞掉', 'Thu Aug 6 14:16:12 2026'), false)
})

/** 產生 `LC_ALL=C ps -o lstart=` 格式的本地時間字串。 */
function fmtLocal(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n: number) => String(n).padStart(2, '0')
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`
}
