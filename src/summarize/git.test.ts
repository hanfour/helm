import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGitSnapshot } from './git.ts'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'helm-git-'))
  const run = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  run('init', '-q')
  run('config', 'user.email', 't@example.com')
  run('config', 'user.name', 'T')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  run('add', '.')
  run('commit', '-q', '-m', 'init')
  return dir
}

test('乾淨的 repo 回傳空的 diff 與 status', () => {
  const s = readGitSnapshot(repo())
  assert.equal(s.diffStat.trim(), '')
  assert.equal(s.statusShort.trim(), '')
})

test('有未 commit 變更時回傳 diff stat 與 status', () => {
  const dir = repo()
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
  const s = readGitSnapshot(dir)
  assert.match(s.diffStat, /a\.txt/)
  assert.match(s.statusShort, /a\.txt/)
})

test('非 git 目錄回傳空值而不拋錯', () => {
  const s = readGitSnapshot(mkdtempSync(join(tmpdir(), 'helm-nogit-')))
  assert.deepEqual(s, { diffStat: '', statusShort: '' })
})

test('目錄不存在回傳空值而不拋錯', () => {
  assert.deepEqual(readGitSnapshot('/nonexistent/xyz'), { diffStat: '', statusShort: '' })
})
