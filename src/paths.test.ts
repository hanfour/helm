import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePaths } from './paths.ts'

test('resolvePaths 由 home 推導出全部預設路徑', () => {
  const p = resolvePaths({ home: '/tmp/fakehome' })
  assert.equal(p.home, '/tmp/fakehome')
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

test('P3 新增的三個路徑都掛在正確的家目錄底下', () => {
  const p = resolvePaths({ home: '/h' })
  assert.equal(p.claudeSettings, '/h/.claude/settings.json')
  assert.equal(p.hookErrorsLog, '/h/.helm/hook-errors.log')
  assert.equal(p.backupsDir, '/h/.helm/backups')
})

test('claudeHome override 也會帶著 settings.json 走', () => {
  assert.equal(resolvePaths({ home: '/h', claudeHome: '/c' }).claudeSettings, '/c/settings.json')
})

test('helmHome override 會帶著備份與錯誤紀錄走', () => {
  const p = resolvePaths({ home: '/h', helmHome: '/custom' })
  assert.equal(p.backupsDir, '/custom/backups')
  assert.equal(p.hookErrorsLog, '/custom/hook-errors.log')
  assert.equal(p.claudeSettings, '/h/.claude/settings.json')
})
