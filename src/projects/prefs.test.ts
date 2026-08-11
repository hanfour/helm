import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPrefs, writePrefs, setProjectPref } from './prefs.ts'

const tmpFile = (body?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-prefs-'))
  const f = join(dir, 'projects.json')
  if (body !== undefined) writeFileSync(f, body)
  return f
}

test('檔案不存在時回傳空的偏好結構', () => {
  const p = readPrefs(tmpFile())
  assert.deepEqual(p, { version: 1, projects: {} })
})

test('讀出既有偏好', () => {
  const f = tmpFile(JSON.stringify({
    version: 1,
    projects: { '/a': { pinned: true, hidden: false } },
  }))
  assert.equal(readPrefs(f).projects['/a']?.pinned, true)
})

test('畸形內容回傳空結構而不拋錯（偏好毀損不得讓 CLI 掛掉）', () => {
  assert.deepEqual(readPrefs(tmpFile('{壞掉')), { version: 1, projects: {} })
})

test('writePrefs 寫出的內容可被 readPrefs 讀回', () => {
  const f = tmpFile()
  const p = { version: 1 as const, projects: { '/b': { pinned: false, hidden: true } } }
  writePrefs(f, p)
  assert.deepEqual(readPrefs(f), p)
})

test('writePrefs 會建立缺少的父目錄', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-prefs-'))
  const f = join(dir, 'nested', 'deep', 'projects.json')
  writePrefs(f, { version: 1, projects: {} })
  assert.equal(existsSync(f), true)
})

test('setProjectPref 回傳新物件且不修改原物件', () => {
  const before = { version: 1 as const, projects: { '/a': { pinned: false, hidden: false } } }
  const snapshot = structuredClone(before)
  const after = setProjectPref(before, '/a', { pinned: true })
  assert.deepEqual(before, snapshot)
  assert.equal(after.projects['/a']?.pinned, true)
  assert.equal(after.projects['/a']?.hidden, false)
  assert.notEqual(after, before)
})

test('setProjectPref 可為尚未存在的專案建立條目', () => {
  const after = setProjectPref({ version: 1, projects: {} }, '/new', { hidden: true })
  assert.deepEqual(after.projects['/new'], { pinned: false, hidden: true })
})
