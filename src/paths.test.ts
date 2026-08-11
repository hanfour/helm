import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePaths } from './paths.ts'

test('resolvePaths 由 home 推導出全部預設路徑', () => {
  const p = resolvePaths({ home: '/tmp/fakehome' })
  assert.equal(p.claudeSessions, '/tmp/fakehome/.claude/sessions')
  assert.equal(p.claudeProjects, '/tmp/fakehome/.claude/projects')
  assert.equal(p.helmLive, '/tmp/fakehome/.helm/live')
  assert.equal(p.cacheFile, '/tmp/fakehome/.helm/cache.json')
  assert.equal(p.prefsFile, '/tmp/fakehome/.helm/projects.json')
})

test('resolvePaths 可個別覆寫且不影響其他欄位', () => {
  const p = resolvePaths({ home: '/tmp/fakehome', claudeHome: '/custom/claude' })
  assert.equal(p.claudeSessions, '/custom/claude/sessions')
  assert.equal(p.helmHome, '/tmp/fakehome/.helm')
})

test('resolvePaths 不修改傳入的 overrides 物件', () => {
  const overrides = { home: '/tmp/fakehome' }
  const snapshot = { ...overrides }
  resolvePaths(overrides)
  assert.deepEqual(overrides, snapshot)
})
