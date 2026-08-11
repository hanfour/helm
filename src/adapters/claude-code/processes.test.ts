import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { createProbe, parseProcStart, parseLstart, procStartMatches, queryProcesses } from './processes.ts'

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

test('查得到自己的 PID 並帶回 lstart', () => {
  const got = queryProcesses([process.pid])
  assert.equal(got.alive.has(process.pid), true)
  assert.notEqual(parseLstart(got.alive.get(process.pid) ?? ''), null)
})

test('ps 整個掛掉時回報「不知道」，不是「都死了」', () => {
  // 這是 Task 12 修正的漏網之魚：退回逐一查詢仍然全部失敗時，舊實作回傳
  // 空 Map，而空 Map 與「這些 PID 都不存在」無法區分 —— 於是整面看板又
  // 全部變紅，而且是高信心的紅。
  const probe = createProbe(() => null)
  const got = probe([100, 200])
  assert.equal(got.alive.size, 0)
  assert.deepEqual([...got.unreachable].toSorted(), [100, 200])
})

test('超出範圍的 PID 算「不知道」，不算死亡證據', () => {
  // 我們根本沒問過它。沒問過不等於它死了。
  const got = queryProcesses([process.pid, 999999])
  assert.equal(got.alive.has(process.pid), true)
  assert.equal(got.unreachable.has(999999), true)
})

test('正常查得到答案時 unreachable 是空的', () => {
  assert.equal(queryProcesses([process.pid]).unreachable.size, 0)
})

test('一個超出範圍的 PID 不影響同批其他 PID 的查詢結果', () => {
  const got = queryProcesses([process.pid, 999999])
  assert.equal(got.alive.has(process.pid), true, '活著的 PID 必須仍被回報為存活')
  assert.equal(got.alive.has(999999), false)
})

test('全部都是無效 PID 時不拋錯，且一律歸為不知道', () => {
  const got = queryProcesses([999998, 999999])
  assert.equal(got.alive.size, 0)
  assert.equal(got.unreachable.size, 2)
})

test('不合理的 PID 不會送給 ps，但也不當成死亡證據', () => {
  const got = queryProcesses([0, -1, 999999, 1.5])
  assert.equal(got.alive.size, 0)
  assert.equal(got.unreachable.size, 4)
})

test('範圍內但已死的 PID 只影響它自己', () => {
  const got = queryProcesses([process.pid, 3999])
  assert.equal(got.alive.has(process.pid), true)
})

test('空清單不 spawn 任何行程', () => {
  assert.equal(queryProcesses([]).alive.size, 0)
})

test('剛結束的行程被真的 ps 判定為已死 —— 那是明確的答案，不是不知道', () => {
  const dead = spawnSync('/usr/bin/true').pid
  assert.equal(typeof dead, 'number')
  const got = queryProcesses([dead as number])
  assert.equal(got.alive.has(dead as number), false)
  assert.equal(got.unreachable.has(dead as number), false, 'ps 有回答，只是說它不在')
})

test('剛結束的行程不會拖累同批仍活著的 PID', () => {
  const dead = spawnSync('/usr/bin/true').pid
  const got = queryProcesses([process.pid, dead as number])
  assert.equal(got.alive.has(process.pid), true)
  assert.equal(got.alive.has(dead as number), false)
})

test('全部都是合法但已死的 PID 時不觸發逐一重查', () => {
  // 99998/99999 在 ps 接受的範圍內但幾乎不可能存在，走的是「跑成功、都不存在」
  // 那條路 —— stderr 是空的，所以直接回空 Map。
  let calls = 0
  const probe = createProbe((pids) => {
    calls += 1
    assert.deepEqual([...pids], [99998, 99999])
    return new Map()
  })
  assert.equal(probe([99998, 99999]).alive.size, 0)
  assert.equal(calls, 1, '批次成功時不該再逐一查一次')
})

test('批次失敗時退回逐一查詢，活著的 PID 仍被回報', () => {
  const probe = createProbe((pids) =>
    pids.length > 1 ? null : new Map([[pids[0] as number, 'Mon Aug 10 00:00:00 2026']]))
  const got = probe([100, 200, 300])
  assert.deepEqual([...got.alive.keys()], [100, 200, 300])
})

test('逐一查詢時，個別失敗的 PID 只影響它自己', () => {
  const probe = createProbe((pids) => {
    if (pids.length > 1) return null
    return pids[0] === 200 ? null : new Map([[pids[0] as number, 'Mon Aug 10 00:00:00 2026']])
  })
  const got = probe([100, 200, 300])
  assert.deepEqual([...got.alive.keys()], [100, 300])
  assert.deepEqual([...got.unreachable], [200], '單獨失敗的那個是「不知道」')
})



test('createProbe 也會先濾掉不合理的 PID，不讓它們進到 runner', () => {
  const seen: number[] = []
  const probe = createProbe((pids) => {
    seen.push(...pids)
    return new Map()
  })
  probe([0, -1, 1.5, 999999, 42])
  assert.deepEqual(seen, [42])
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
