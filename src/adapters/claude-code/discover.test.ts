import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePaths } from '../../paths.ts'
import { discoverClaudeCode, type DiscoverDeps } from './discover.ts'

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0)
const DAY = 86_400_000
const OPTS = { windowDays: 14, nowMs: NOW }

/** Keeps the merge logic under test instead of the real filesystem layout. */
const deps = (tree: Record<string, string[]> = {}): DiscoverDeps => ({
  subdirs: (dir) => tree[dir] ?? [],
  canonicalPath: (p) => p,
})

interface TranscriptSpec {
  slug: string
  sessionId: string
  ageMs?: number
}

function scaffold(sessions: object[], transcripts: readonly TranscriptSpec[] = []): string {
  const home = mkdtempSync(join(tmpdir(), 'helm-disc-'))
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  for (const s of sessions) {
    const pid = (s as { pid: number }).pid
    writeFileSync(join(home, '.claude', 'sessions', `${pid}.json`), JSON.stringify(s))
  }
  for (const t of transcripts) {
    const dir = join(home, '.claude', 'projects', t.slug)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${t.sessionId}.jsonl`)
    writeFileSync(path, '{}\n')
    const at = (NOW - (t.ageMs ?? 0)) / 1000
    utimesSync(path, at, at)
  }
  return home
}

const BASE = {
  pid: 111,
  sessionId: 'sess-a',
  cwd: '/Users/testuser/proj',
  startedAt: 1785996974955,
  procStart: 'Thu Aug  6 06:16:12 2026',
  kind: 'interactive',
  name: 'proj-01',
  status: 'busy',
  updatedAt: NOW - 60_000,
}

const SLUG = '-Users-testuser-proj'
const TREE = { '/': ['Users'], '/Users': ['testuser'], '/Users/testuser': ['proj', 'other'] }

test('探索出註冊表中的 session 並帶上 adapterId', () => {
  const home = scaffold([BASE])
  const found = discoverClaudeCode(resolvePaths({ home }), OPTS, deps())
  assert.equal(found.sessions.length, 1)
  assert.equal(found.sessions[0]?.adapterId, 'claude-code')
  assert.equal(found.sessions[0]?.sessionId, 'sess-a')
  assert.equal(found.sessions[0]?.nativeStatus, 'busy')
  assert.equal(found.invalid, 0)
})

test('找得到對應的 transcript 路徑', () => {
  const home = scaffold([BASE], [{ slug: SLUG, sessionId: 'sess-a' }])
  const found = discoverClaudeCode(resolvePaths({ home }), OPTS, deps(TREE))
  assert.ok(found.sessions[0]?.transcriptPath?.endsWith(`${SLUG}/sess-a.jsonl`))
})

test('沒有對應 transcript 時 transcriptPath 為 null', () => {
  const home = scaffold([BASE])
  const found = discoverClaudeCode(resolvePaths({ home }), OPTS, deps())
  assert.equal(found.sessions[0]?.transcriptPath, null)
})

test('探索結果依 updatedAt 由新到舊排序', () => {
  const home = scaffold([
    { ...BASE, pid: 1, sessionId: 'old', updatedAt: NOW - 900_000 },
    { ...BASE, pid: 2, sessionId: 'new', updatedAt: NOW - 100_000 },
  ])
  const found = discoverClaudeCode(resolvePaths({ home }), OPTS, deps())
  assert.deepEqual(found.sessions.map((f) => f.sessionId), ['new', 'old'])
})

test('探索不修改傳入的 paths 物件', () => {
  const home = scaffold([BASE])
  const paths = resolvePaths({ home })
  const snapshot = { ...paths }
  discoverClaudeCode(paths, OPTS, deps())
  assert.deepEqual(paths, snapshot)
})

test('discoverClaudeCode 回傳 invalid 計數而不是丟棄它', () => {
  const home = scaffold([BASE])
  writeFileSync(join(home, '.claude', 'sessions', 'broken.json'), '{壞掉')
  const result = discoverClaudeCode(resolvePaths({ home }), OPTS, deps())
  assert.equal(result.sessions.length, 1)
  assert.equal(result.invalid, 1)
})

// ——— Task 13 缺陷一：註冊表之外的已結束 session ———

test('註冊表為空時，仍從 transcript 探索出已結束的 session', () => {
  const home = scaffold([], [{ slug: SLUG, sessionId: 'ghost', ageMs: 3600_000 }])
  const found = discoverClaudeCode(resolvePaths({ home }), OPTS, deps(TREE))
  assert.equal(found.sessions.length, 1)
  assert.equal(found.sessions[0]?.sessionId, 'ghost')
  assert.equal(found.sessions[0]?.cwd, '/Users/testuser/proj')
})

test('transcript 探索出的 session 沒有存活資訊 —— 不假裝知道', () => {
  const home = scaffold([], [{ slug: SLUG, sessionId: 'ghost' }])
  const s = discoverClaudeCode(resolvePaths({ home }), OPTS, deps(TREE)).sessions[0]
  assert.equal(s?.pid, null)
  assert.equal(s?.procStart, null)
  assert.equal(s?.nativeStatus, null)
  assert.ok(s?.transcriptPath?.endsWith('ghost.jsonl'))
})

test('transcript 的活動時間成為 updatedAt', () => {
  const home = scaffold([], [{ slug: SLUG, sessionId: 'ghost', ageMs: 2 * 3600_000 }])
  const s = discoverClaudeCode(resolvePaths({ home }), OPTS, deps(TREE)).sessions[0]
  assert.ok(Math.abs((s?.updatedAt ?? 0) - (NOW - 2 * 3600_000)) < 2000)
})

test('同一 session 同時有註冊表與 transcript 時只出現一次，且保留註冊表的存活資訊', () => {
  const home = scaffold([BASE], [{ slug: SLUG, sessionId: 'sess-a' }])
  const found = discoverClaudeCode(resolvePaths({ home }), OPTS, deps(TREE))
  assert.equal(found.sessions.length, 1)
  assert.equal(found.sessions[0]?.pid, 111)
  assert.equal(found.sessions[0]?.nativeStatus, 'busy')
  assert.ok(found.sessions[0]?.transcriptPath !== null)
})

test('註冊表與 transcript 的活動時間取較新的那個', () => {
  const home = scaffold(
    [{ ...BASE, updatedAt: NOW - 3600_000 }],
    [{ slug: SLUG, sessionId: 'sess-a', ageMs: 60_000 }],
  )
  const s = discoverClaudeCode(resolvePaths({ home }), OPTS, deps(TREE)).sessions[0]
  assert.ok((s?.updatedAt ?? 0) > NOW - 3600_000)
})

test('超出時間窗口的 transcript 不列入', () => {
  const home = scaffold([], [
    { slug: SLUG, sessionId: 'fresh', ageMs: DAY },
    { slug: SLUG, sessionId: 'ancient', ageMs: 30 * DAY },
  ])
  const found = discoverClaudeCode(resolvePaths({ home }), OPTS, deps(TREE))
  assert.deepEqual(found.sessions.map((s) => s.sessionId), ['fresh'])
})

test('註冊表中的 session 即使 transcript 很舊也不會被窗口濾掉 —— 它還活著', () => {
  const home = scaffold([BASE], [{ slug: SLUG, sessionId: 'sess-a', ageMs: 30 * DAY }])
  const found = discoverClaudeCode(resolvePaths({ home }), OPTS, deps(TREE))
  assert.deepEqual(found.sessions.map((s) => s.sessionId), ['sess-a'])
})

test('slug 反解不出真實路徑時略過該 transcript —— 該目錄已不存在，本來就不會顯示', () => {
  const home = scaffold([], [{ slug: '-private-var-folders-deleted', sessionId: 'gone' }])
  const found = discoverClaudeCode(resolvePaths({ home }), OPTS, deps(TREE))
  assert.deepEqual(found.sessions, [])
})

test('cwd 經過正規化，讓註冊表與 transcript 落在同一個專案', () => {
  const home = scaffold(
    [{ ...BASE, sessionId: 'live', cwd: '/Users/testuser/Proj' }],
    [{ slug: SLUG, sessionId: 'ghost' }],
  )
  const found = discoverClaudeCode(resolvePaths({ home }), OPTS, {
    subdirs: (dir) => TREE[dir as keyof typeof TREE] ?? [],
    canonicalPath: (p) => p.toLowerCase(),
  })
  assert.equal(new Set(found.sessions.map((s) => s.cwd)).size, 1)
})

test('探索結果可安全序列化 —— session 之間不共用物件', () => {
  const home = scaffold([BASE], [{ slug: SLUG, sessionId: 'ghost' }])
  const found = discoverClaudeCode(resolvePaths({ home }), OPTS, deps(TREE))
  assert.equal(found.sessions.length, 2)
  assert.notEqual(found.sessions[0], found.sessions[1])
})
