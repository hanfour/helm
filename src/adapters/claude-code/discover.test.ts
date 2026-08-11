import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePaths } from '../../paths.ts'
import { discoverClaudeCode } from './discover.ts'

function scaffold(sessions: object[], transcripts: string[] = []): string {
  const home = mkdtempSync(join(tmpdir(), 'helm-disc-'))
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  for (const s of sessions) {
    const pid = (s as { pid: number }).pid
    writeFileSync(join(home, '.claude', 'sessions', `${pid}.json`), JSON.stringify(s))
  }
  for (const t of transcripts) {
    const dir = join(home, '.claude', 'projects', t.split('/')[0] ?? '')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, t.split('/')[1] ?? ''), '{}\n')
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
  updatedAt: 1786416587966,
}

test('探索出註冊表中的 session 並帶上 adapterId', () => {
  const home = scaffold([BASE])
  const found = discoverClaudeCode(resolvePaths({ home }), () => new Map())
  assert.equal(found.length, 1)
  assert.equal(found[0]?.adapterId, 'claude-code')
  assert.equal(found[0]?.sessionId, 'sess-a')
  assert.equal(found[0]?.nativeStatus, 'busy')
})

test('找得到對應的 transcript 路徑', () => {
  const slug = '-Users-testuser-proj'
  const home = scaffold([BASE], [`${slug}/sess-a.jsonl`])
  const found = discoverClaudeCode(resolvePaths({ home }), () => new Map())
  assert.ok(found[0]?.transcriptPath?.endsWith(`${slug}/sess-a.jsonl`))
})

test('沒有對應 transcript 時 transcriptPath 為 null', () => {
  const home = scaffold([BASE])
  const found = discoverClaudeCode(resolvePaths({ home }), () => new Map())
  assert.equal(found[0]?.transcriptPath, null)
})

test('探索結果依 updatedAt 由新到舊排序', () => {
  const home = scaffold([
    { ...BASE, pid: 1, sessionId: 'old', updatedAt: 1000 },
    { ...BASE, pid: 2, sessionId: 'new', updatedAt: 9000 },
  ])
  const found = discoverClaudeCode(resolvePaths({ home }), () => new Map())
  assert.deepEqual(found.map((f) => f.sessionId), ['new', 'old'])
})

test('探索不修改傳入的 paths 物件', () => {
  const home = scaffold([BASE])
  const paths = resolvePaths({ home })
  const snapshot = { ...paths }
  discoverClaudeCode(paths, () => new Map())
  assert.deepEqual(paths, snapshot)
})
