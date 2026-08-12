import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverCodex, type CodexDeps } from './discover.ts'
import type { RolloutFile } from './scan.ts'
import type { RolloutMeta } from './meta.ts'

const NOW = Date.UTC(2026, 7, 12, 12, 0, 0)
const SID = '019f40fa-de00-7f01-9f17-23f4771535c1'
const OTHER = '019fc64c-6b8a-7882-8c7b-c019bd18484c'

const file = (over: Partial<RolloutFile> & { rolloutId: string }): RolloutFile => ({
  path: `/r/${over.rolloutId}.jsonl`,
  startedAt: NOW - 3600_000,
  mtimeMs: NOW,
  ...over,
})

function deps(over: Partial<CodexDeps> = {}): CodexDeps {
  const metas: Record<string, RolloutMeta> = { r1: { sessionId: SID, cwd: '/p/a' } }
  return {
    scan: () => [file({ rolloutId: 'r1' })],
    meta: (f) => metas[f.rolloutId] ?? null,
    liveCwds: () => new Set<string>(),
    flush: () => {},
    ...over,
  }
}

const run = (d: Partial<CodexDeps> = {}) =>
  discoverCodex({ sessionsDir: '/s', cacheFile: '/c', windowDays: 14, nowMs: NOW }, deps(d))

test('一個 rollout 變成一個 session', () => {
  const { sessions } = run()
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0]?.sessionId, SID)
  assert.equal(sessions[0]?.cwd, '/p/a')
  assert.equal(sessions[0]?.adapterId, 'codex')
})

test('同一個 session 的多個 rollout 合併成一行', () => {
  // 實測：192 個檔案只有 86 個 session，最多的一個橫跨 33 個檔。
  // 照檔案畫的話那個專案會出現 33 行同一個 session。
  const files = [
    file({ rolloutId: 'r1', startedAt: NOW - 7200_000, mtimeMs: NOW - 3600_000 }),
    file({ rolloutId: 'r2', startedAt: NOW - 3600_000, mtimeMs: NOW - 60_000 }),
    file({ rolloutId: 'r3', startedAt: NOW - 1800_000, mtimeMs: NOW }),
  ]
  const { sessions } = run({
    scan: () => files,
    meta: () => ({ sessionId: SID, cwd: '/p/a' }),
  })
  assert.equal(sessions.length, 1, '三個檔案是同一個 session')
  const s = sessions[0]
  assert.equal(s?.startedAt, NOW - 7200_000, '開始時間取最早的')
  assert.equal(s?.updatedAt, NOW, '更新時間取最新的')
  assert.equal(s?.transcriptPath, '/r/r3.jsonl', 'transcript 指向最新的那個檔')
  assert.equal(s?.transcriptMtimeMs, NOW)
})

test('不同 session 各自成行', () => {
  const { sessions } = run({
    scan: () => [file({ rolloutId: 'r1' }), file({ rolloutId: 'r2' })],
    meta: (f) => ({ sessionId: f.rolloutId === 'r1' ? SID : OTHER, cwd: '/p/a' }),
  })
  assert.equal(sessions.length, 2)
})

test('nativeStatus 一律 null —— Codex 沒有 hook，沒有 busy/idle 之分', () => {
  // 偽造一個「執行中」比留白更糟：看板會宣稱它知道一件無從得知的事。
  assert.equal(run().sessions[0]?.nativeStatus, null)
})

test('pid 一律 null —— Codex 沒有 PID 註冊表', () => {
  const s = run().sessions[0]
  assert.equal(s?.pid, null)
  assert.equal(s?.procStart, null)
})

test('讀不出 meta 的檔案計入 invalid，不是靜默消失', () => {
  const { sessions, invalid } = run({
    scan: () => [file({ rolloutId: 'r1' }), file({ rolloutId: 'bad' })],
    meta: (f) => (f.rolloutId === 'bad' ? null : { sessionId: SID, cwd: '/p/a' }),
  })
  assert.equal(sessions.length, 1)
  assert.equal(invalid, 1, '看板要說得出「有一筆讀不到」')
})

test('cwd 有 codex 行程時判為 running', () => {
  const { sessions } = run({ liveCwds: () => new Set(['/p/a']) })
  assert.equal(sessions[0]?.lifecycle, 'running')
  assert.equal(sessions[0]?.lifecycleConfidence, 'low')
})

test('沒有行程且超過 30 分鐘沒動靜時判為 crashed', () => {
  const { sessions } = run({
    scan: () => [file({ rolloutId: 'r1', mtimeMs: NOW - 31 * 60_000 })],
  })
  assert.equal(sessions[0]?.lifecycle, 'crashed')
})

test('live 一律 null —— 那是 hook 的產物，Codex 沒有', () => {
  assert.equal(run().sessions[0]?.live, null)
})

test('掃描完一定 flush 快取，即使沒有任何 session', () => {
  let flushed = 0
  run({ scan: () => [], flush: () => { flushed++ } })
  assert.equal(flushed, 1)
})

test('scan 丟例外時回空結果，不讓整個看板掛掉', () => {
  const { sessions, invalid } = run({
    scan: () => { throw new Error('boom') },
  })
  assert.deepEqual(sessions, [])
  assert.equal(invalid, 0)
})

test('沒有任何 session 時不查行程 —— 省一次 spawn', () => {
  // pgrep 在沒有 codex 在跑時也要 35.7 ms，佔 200ms 契約的 18%。
  // 沒裝 Codex 的人不該付這筆錢。
  let queried = 0
  run({ scan: () => [], liveCwds: () => { queried++; return new Set() } })
  assert.equal(queried, 0)
})

test('全部都是舊 session 時也不查行程', () => {
  // 而且這不只是省成本：一個六天沒動的 session，即使它的 cwd 現在有
  // codex 在跑，那也是別人的行程 —— 把它標成 running 是錯的。
  let queried = 0
  run({
    scan: () => [file({ rolloutId: 'r1', mtimeMs: NOW - 5 * 3600_000 })],
    liveCwds: () => { queried++; return new Set(['/p/a']) },
  })
  assert.equal(queried, 0)
})

test('舊 session 不會因為 cwd 現在有 codex 就被說成 running', () => {
  const { sessions } = run({
    scan: () => [file({ rolloutId: 'r1', mtimeMs: NOW - 5 * 3600_000 })],
    liveCwds: () => new Set(['/p/a']),
  })
  assert.equal(sessions[0]?.lifecycle, 'crashed', '五小時前的活動不會因為現在有行程就變成執行中')
})

test('有最近活動的 session 時才查行程', () => {
  let queried = 0
  const { sessions } = run({
    scan: () => [file({ rolloutId: 'r1', mtimeMs: NOW - 60_000 })],
    liveCwds: () => { queried++; return new Set(['/p/a']) },
  })
  assert.equal(queried, 1)
  assert.equal(sessions[0]?.lifecycle, 'running')
})
