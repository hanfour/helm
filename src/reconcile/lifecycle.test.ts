import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideCodexLifecycle, decideLifecycle, reconcileSessions } from './lifecycle.ts'
import type { LiveMarker, DiscoveredSession } from '../types.ts'

const PROC_START = 'Thu Aug  6 06:16:12 2026'
/** Same instant rendered the way `LC_ALL=C ps` would, in the test runner's zone. */
const PS_MATCHING = fmtLocal(new Date(Date.UTC(2026, 7, 6, 6, 16, 12)))
const PS_OTHER = fmtLocal(new Date(Date.UTC(2026, 7, 6, 9, 30, 0)))

const marker = (ts: number): LiveMarker =>
  ({ sessionId: 's', ts, toolName: 'Bash', summary: 'git status', degraded: false })

const DAY = Date.UTC(2026, 7, 12, 12, 0, 0)

test('註冊表在、但根本問不到 PID 的狀態 → 低信心，不當成死亡證據', () => {
  // ps 整個掛掉時，每一個 session 都會走到這裡。若判成高信心 crashed，
  // 一次失敗的系統呼叫就會讓整面看板變紅，而使用者會去 resume 還活著的 session。
  const r = decideLifecycle({
    registryFileExists: true, pidAlive: false, pidUnknown: true, psLstart: null,
    procStart: PROC_START, live: null, transcriptMtimeMs: null,
  })
  assert.deepEqual(r, { lifecycle: 'crashed', confidence: 'low' })
})

test('註冊表在、PID 活著、procStart 相符 → running', () => {
  const r = decideLifecycle({
    registryFileExists: true, pidAlive: true, pidUnknown: false, psLstart: PS_MATCHING,
    procStart: PROC_START, live: null, transcriptMtimeMs: null,
  })
  assert.deepEqual(r, { lifecycle: 'running', confidence: 'high' })
})

test('註冊表在、PID 死了 → crashed（來不及刪檔）', () => {
  const r = decideLifecycle({
    registryFileExists: true, pidAlive: false, pidUnknown: false, psLstart: null,
    procStart: PROC_START, live: null, transcriptMtimeMs: null,
  })
  assert.deepEqual(r, { lifecycle: 'crashed', confidence: 'high' })
})

test('註冊表在、PID 活著、但 procStart 不符 → crashed（PID 被重用）', () => {
  const r = decideLifecycle({
    registryFileExists: true, pidAlive: true, pidUnknown: false, psLstart: PS_OTHER,
    procStart: PROC_START, live: null, transcriptMtimeMs: null,
  })
  assert.deepEqual(r, { lifecycle: 'crashed', confidence: 'high' })
})

test('註冊表不在、live 檔晚於 transcript 末筆 → crashed（當機於工具執行中）', () => {
  const r = decideLifecycle({
    registryFileExists: false, pidAlive: false, pidUnknown: false, psLstart: null, procStart: null,
    live: marker(5000), transcriptMtimeMs: 4000,
  })
  assert.deepEqual(r, { lifecycle: 'crashed', confidence: 'high' })
})

test('註冊表不在、live 檔早於 transcript 末筆 → ended_clean', () => {
  const r = decideLifecycle({
    registryFileExists: false, pidAlive: false, pidUnknown: false, psLstart: null, procStart: null,
    live: marker(3000), transcriptMtimeMs: 4000,
  })
  assert.deepEqual(r, { lifecycle: 'ended_clean', confidence: 'high' })
})

test('註冊表不在、無 live 檔 → ended_clean', () => {
  const r = decideLifecycle({
    registryFileExists: false, pidAlive: false, pidUnknown: false, psLstart: null, procStart: null,
    live: null, transcriptMtimeMs: 4000,
  })
  assert.deepEqual(r, { lifecycle: 'ended_clean', confidence: 'high' })
})

test('註冊表不在、有 live 檔但沒有 transcript → ended_clean 且信心降為 low', () => {
  const r = decideLifecycle({
    registryFileExists: false, pidAlive: false, pidUnknown: false, psLstart: null, procStart: null,
    live: marker(5000), transcriptMtimeMs: null,
  })
  assert.deepEqual(r, { lifecycle: 'ended_clean', confidence: 'low' })
})

test('註冊表在、PID 活著、但 procStart 無法解析 → crashed 且信心降為 low', () => {
  const r = decideLifecycle({
    registryFileExists: true, pidAlive: true, pidUnknown: false, psLstart: '無法解析',
    procStart: PROC_START, live: null, transcriptMtimeMs: null,
  })
  assert.deepEqual(r, { lifecycle: 'crashed', confidence: 'low' })
})

function fmtLocal(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n: number) => String(n).padStart(2, '0')
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`
}

const session = (over: Partial<DiscoveredSession> = {}): DiscoveredSession => ({
  adapterId: 'claude-code', sessionId: 's1', cwd: '/p', pid: 111,
  procStart: PROC_START, startedAt: 1, updatedAt: 2, nativeStatus: 'idle',
  kind: 'interactive', name: 'n', transcriptPath: '/t/s1.jsonl',
  transcriptMtimeMs: null, ...over,
})

test('reconcileSessions 為每個 session 附上 lifecycle 與 live', () => {
  const out = reconcileSessions([session()], {
    probe: { alive: new Map([[111, PS_MATCHING]]), unreachable: new Set<number>() },
    readLive: () => null,
    transcriptMtimeMs: () => 4000,
  })
  assert.equal(out.length, 1)
  assert.equal(out[0]?.lifecycle, 'running')
  assert.equal(out[0]?.live, null)
})

test('reconcileSessions 不修改輸入陣列或其元素', () => {
  const input = [session()]
  const snapshot = structuredClone(input)
  reconcileSessions(input, {
    probe: { alive: new Map(), unreachable: new Set<number>() }, readLive: () => null, transcriptMtimeMs: () => null,
  })
  assert.deepEqual(input, snapshot)
})

test('PID 為 null（例如非 Claude Code adapter）時視為註冊表不存在', () => {
  const out = reconcileSessions([session({ pid: null, procStart: null })], {
    probe: { alive: new Map(), unreachable: new Set<number>() }, readLive: () => null, transcriptMtimeMs: () => 4000,
  })
  assert.equal(out[0]?.lifecycle, 'ended_clean')
})

test('psLstart 格式有效但時刻不同 → crashed/high（真的 PID 重用，非解析失敗）', () => {
  // macOS ps -o lstart= can output hour without zero-padding in some locales.
  // This format is valid and parseable, but the timestamp differs from procStart.
  // Must return high confidence (genuine PID reuse), not low (parse failure).
  const psUnpadded = 'Thu Aug  6  6:16:12 2026' // hour not zero-padded
  const r = decideLifecycle({
    registryFileExists: true, pidAlive: true, pidUnknown: false, psLstart: psUnpadded,
    procStart: PROC_START, live: null, transcriptMtimeMs: null,
  })
  assert.deepEqual(r, { lifecycle: 'crashed', confidence: 'high' })
})

test('壞掉的 live marker 晚於 transcript → 仍判 crashed，但信心降為 low', () => {
  // 時間戳來自檔案 mtime，所以內容壞掉不影響「晚於 transcript」這個判斷；
  // 但我們不知道它當時卡在哪個工具，所以不該宣稱高信心。
  const r = decideLifecycle({
    registryFileExists: false, pidAlive: false, pidUnknown: false, psLstart: null,
    procStart: null, live: { ...marker(5000), degraded: true }, transcriptMtimeMs: 4000,
  })
  assert.deepEqual(r, { lifecycle: 'crashed', confidence: 'low' })
})

test('壞掉的 live marker 早於 transcript → ended_clean 但信心降為 low', () => {
  const r = decideLifecycle({
    registryFileExists: false, pidAlive: false, pidUnknown: false, psLstart: null,
    procStart: null, live: { ...marker(3000), degraded: true }, transcriptMtimeMs: 4000,
  })
  assert.deepEqual(r, { lifecycle: 'ended_clean', confidence: 'low' })
})

test('Codex：cwd 有 codex 行程在跑就是 running', () => {
  // Codex 沒有 PID 註冊表，存活只能靠行程表比對 cwd（規格 §6）。
  const v = decideCodexLifecycle({ cwdHasProcess: true, lastEventMs: 0, nowMs: DAY })
  assert.equal(v.lifecycle, 'running')
})

test('Codex：沒有行程但最後事件在 30 分鐘內，仍算 running', () => {
  // 防的是 ps 短暫抓不到就誤判成當機。
  const v = decideCodexLifecycle({ cwdHasProcess: false, lastEventMs: DAY - 29 * 60_000, nowMs: DAY })
  assert.equal(v.lifecycle, 'running')
})

test('Codex：沒有行程且超過 30 分鐘沒動靜 → crashed', () => {
  const v = decideCodexLifecycle({ cwdHasProcess: false, lastEventMs: DAY - 31 * 60_000, nowMs: DAY })
  assert.equal(v.lifecycle, 'crashed')
})

test('Codex：30 分鐘的兩側都要對', () => {
  const at = (mins: number) =>
    decideCodexLifecycle({ cwdHasProcess: false, lastEventMs: DAY - mins * 60_000, nowMs: DAY }).lifecycle
  assert.equal(at(30), 'running', '剛好 30 分鐘還不算')
  assert.equal(at(30.1), 'crashed')
})

test('Codex：超過 6 小時就不再宣稱中斷', () => {
  // 實測 2026-08-12：只有 30 分鐘下界的話，這台機器近 14 天的 12 個 Codex
  // session 全部被判成 crashed —— 最近的一個是 6 天前。那條規則描述的是
  // 「剛剛還在跑、現在行程不見了」，套到六天前關掉的 session 就是誤報，
  // 而 crashed 是優先序最高、畫成紅色的狀態。
  const at = (hours: number) =>
    decideCodexLifecycle({ cwdHasProcess: false, lastEventMs: DAY - hours * 3600_000, nowMs: DAY }).lifecycle
  assert.equal(at(1), 'crashed')
  assert.equal(at(6), 'crashed', '剛好 6 小時還算')
  assert.equal(at(6.1), 'ended_clean')
  assert.equal(at(24 * 7), 'ended_clean')
})

test('Codex：行程還在時，多久沒動都是 running', () => {
  const v = decideCodexLifecycle({ cwdHasProcess: true, lastEventMs: DAY - 30 * 86_400_000, nowMs: DAY })
  assert.equal(v.lifecycle, 'running')
})

test('Codex 的信心一律是 low —— UI 必須把它跟 Claude Code 的判定區分開', () => {
  for (const cwdHasProcess of [true, false]) {
    for (const mins of [0, 31, 60 * 24]) {
      const v = decideCodexLifecycle({ cwdHasProcess, lastEventMs: DAY - mins * 60_000, nowMs: DAY })
      assert.equal(v.confidence, 'low', `${cwdHasProcess} / ${mins} 分鐘`)
    }
  }
})

test('Codex：未來的時間戳不會被算成「超過 30 分鐘」', () => {
  // 時鐘偏移或檔案被 touch 過都可能造成 lastEventMs > now。
  const v = decideCodexLifecycle({ cwdHasProcess: false, lastEventMs: DAY + 60_000, nowMs: DAY })
  assert.equal(v.lifecycle, 'running')
})

test('Codex：結尾是完成事件時不叫它中斷 —— rollout 自己寫著它做完了', () => {
  // 實測 2026-08-13，這台機器 88 個 Codex session 裡 86 個的最後一筆事件是
  // task_complete 或 turn_aborted，只有 2 個真的停在半途。而使用者看到紅色
  // 「1 中斷」去找卻找不到誰的那兩個，都是跑完的 codex exec 批次工作。
  const v = decideCodexLifecycle({
    cwdHasProcess: false, lastEventMs: DAY - 90 * 60_000, nowMs: DAY, endedWith: 'finished',
  })
  assert.equal(v.lifecycle, 'ended_clean')
})

test('Codex：結尾在半途才是中斷', () => {
  const v = decideCodexLifecycle({
    cwdHasProcess: false, lastEventMs: DAY - 90 * 60_000, nowMs: DAY, endedWith: 'midflight',
  })
  assert.equal(v.lifecycle, 'crashed')
})

test('Codex：讀不到結尾時退回計時器，不假裝知道', () => {
  const v = decideCodexLifecycle({
    cwdHasProcess: false, lastEventMs: DAY - 90 * 60_000, nowMs: DAY, endedWith: 'unknown',
  })
  assert.equal(v.lifecycle, 'crashed', '沒有訊號時維持原本的保守判定')
})

test('Codex：有行程就是在跑，結尾寫什麼都不影響', () => {
  for (const endedWith of ['finished', 'midflight', 'unknown'] as const) {
    const v = decideCodexLifecycle({ cwdHasProcess: true, lastEventMs: 0, nowMs: DAY, endedWith })
    assert.equal(v.lifecycle, 'running', endedWith)
  }
})

test('Codex：30 分鐘的防抖動對半途結尾仍然有效', () => {
  // 兩筆事件之間本來就會有空檔。剛停 10 分鐘不該立刻叫中斷。
  const v = decideCodexLifecycle({
    cwdHasProcess: false, lastEventMs: DAY - 10 * 60_000, nowMs: DAY, endedWith: 'midflight',
  })
  assert.equal(v.lifecycle, 'running')
})

test('Codex：完成的結尾不必等 30 分鐘 —— 它已經做完了', () => {
  const v = decideCodexLifecycle({
    cwdHasProcess: false, lastEventMs: DAY - 5 * 60_000, nowMs: DAY, endedWith: 'finished',
  })
  assert.equal(v.lifecycle, 'ended_clean')
})

test('Codex 的信心一律低 —— 全部是從行程表與檔案推論出來的', () => {
  for (const endedWith of ['finished', 'midflight', 'unknown'] as const) {
    const v = decideCodexLifecycle({
      cwdHasProcess: false, lastEventMs: DAY - 90 * 60_000, nowMs: DAY, endedWith,
    })
    assert.equal(v.confidence, 'low', endedWith)
  }
})
