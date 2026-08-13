import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanRollouts, scanRolloutsDetailed } from './scan.ts'
import { tempDir } from '../../temp-dir.ts'

const ID = (n: number) => `019fc64c-6b8a-7882-8c7b-c019bd1848${String(n).padStart(2, '0')}`
const NOW = Date.UTC(2026, 7, 12, 12, 0, 0)

/** Writes a rollout into its YYYY/MM/DD directory and sets its mtime. */
function rollout(root: string, opts: {
  y?: number; mo?: number; d?: number; n: number; ageDays?: number; name?: string
}): string {
  const { y = 2026, mo = 8, d = 3, n, ageDays = 0 } = opts
  const dir = join(root, String(y), String(mo).padStart(2, '0'), String(d).padStart(2, '0'))
  mkdirSync(dir, { recursive: true })
  const name = opts.name
    ?? `rollout-${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T14-25-24-${ID(n)}.jsonl`
  const path = join(dir, name)
  writeFileSync(path, '{"type":"session_meta"}\n')
  const t = (NOW - ageDays * 86_400_000) / 1000
  utimesSync(path, t, t)
  return path
}

const since = (days: number) => NOW - days * 86_400_000

test('掃出 YYYY/MM/DD 三層底下的 rollout', () => {
  const root = tempDir('helm-codex-')
  rollout(root, { n: 1 })
  rollout(root, { mo: 7, d: 20, n: 2 })
  const found = scanRollouts(root, since(14))
  assert.equal(found.length, 2)
  assert.deepEqual(found.map((f) => f.rolloutId).sort(), [ID(1), ID(2)].sort())
})

test('窗口過濾看的是 mtime，不是檔名上的時間', () => {
  // 一個三月前開的 session 可能今天還在寫。照檔名過濾會把它從看板上抹掉，
  // 而那正是最需要看到的那種 session。
  const root = tempDir('helm-codex-')
  rollout(root, { y: 2026, mo: 4, d: 1, n: 1, ageDays: 0 })
  rollout(root, { y: 2026, mo: 8, d: 12, n: 2, ageDays: 40 })
  const found = scanRollouts(root, since(14))
  assert.deepEqual(found.map((f) => f.rolloutId), [ID(1)], '留下的應該是最近有寫入的那個')
})

test('帶著 mtime 與檔名解出的開始時間', () => {
  const root = tempDir('helm-codex-')
  rollout(root, { n: 1, ageDays: 2 })
  const [f] = scanRollouts(root, since(14))
  assert.ok(f)
  assert.equal(Math.round(f.mtimeMs), NOW - 2 * 86_400_000)
  assert.equal(new Date(f.startedAt).getFullYear(), 2026)
  assert.ok(f.path.endsWith('.jsonl'))
})

test('目錄不存在時回空陣列 —— 沒裝 Codex 是正常狀態，不是錯誤', () => {
  assert.deepEqual(scanRollouts(join(tempDir('helm-codex-'), 'nope'), since(14)), [])
})

test('非 rollout 檔與解析失敗的檔名一律略過，不讓整批失敗', () => {
  const root = tempDir('helm-codex-')
  rollout(root, { n: 1 })
  rollout(root, { n: 2, name: 'rollout-not-a-timestamp-nope.jsonl' })
  rollout(root, { n: 3, name: 'history.jsonl' })
  rollout(root, { n: 4, name: '.DS_Store' })
  const found = scanRollouts(root, since(14))
  assert.deepEqual(found.map((f) => f.rolloutId), [ID(1)])
})

test('不讀檔案內容 —— 那是 200ms 契約的前提', () => {
  // rollout 的第一行有 8.6-18.6 KB（塞著整份 base_instructions）。
  // 這一層只 stat，讀取留給有快取擋著的 meta.ts。
  const root = tempDir('helm-codex-')
  const path = rollout(root, { n: 1 })
  writeFileSync(path, 'x'.repeat(50_000))
  const t = NOW / 1000
  utimesSync(path, t, t)
  const found = scanRollouts(root, since(14))
  assert.equal(found.length, 1, '內容壞掉不影響掃描')
})

test('深度不對的檔案不會被漏掉也不會重複', () => {
  // 目錄結構是 Codex 定的，但沒有保證。多一層或少一層時仍要掃得到。
  const root = tempDir('helm-codex-')
  mkdirSync(join(root, '2026', '08'), { recursive: true })
  const shallow = join(root, '2026', '08', `rollout-2026-08-03T14-25-24-${ID(9)}.jsonl`)
  writeFileSync(shallow, '{}')
  utimesSync(shallow, NOW / 1000, NOW / 1000)
  rollout(root, { n: 1 })
  const found = scanRollouts(root, since(14))
  assert.equal(found.length, 2)
  assert.equal(new Set(found.map((f) => f.path)).size, 2, '不得重複')
})

test('目錄存在但讀不到時要回報 —— 那跟「沒裝 Codex」是兩件事', () => {
  // 兩者原本都被同一個 catch 吞掉，於是 ~/.codex chmod 000 produced
  // 半個空看板加上 doctor 回報「皆可讀取」。
  const root = tempDir('helm-codex-')
  const locked = join(root, '2026', '08')
  mkdirSync(locked, { recursive: true })
  chmodSync(locked, 0o000)
  try {
    const r = scanRolloutsDetailed(root, since(14))
    assert.deepEqual(r.files, [])
    assert.deepEqual(r.unreadable, [locked])
  } finally {
    chmodSync(locked, 0o700)
  }
})

test('目錄不存在時安靜 —— 沒裝 Codex 是正常狀態', () => {
  const r = scanRolloutsDetailed(join(tempDir('helm-codex-'), 'nope'), since(14))
  assert.deepEqual(r.files, [])
  assert.deepEqual(r.unreadable, [], '不存在不該被當成錯誤')
})
