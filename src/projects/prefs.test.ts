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
  const p = readPrefs(tmpFile()).prefs
  assert.deepEqual(p, { version: 1, projects: {} })
})

test('讀出既有偏好', () => {
  const f = tmpFile(JSON.stringify({
    version: 1,
    projects: { '/a': { pinned: true, hidden: false } },
  }))
  assert.equal(readPrefs(f).prefs.projects['/a']?.pinned, true)
})

test('畸形內容回傳空結構而不拋錯（偏好毀損不得讓 CLI 掛掉）', () => {
  assert.deepEqual(readPrefs(tmpFile('{壞掉')).prefs, { version: 1, projects: {} })
})

test('writePrefs 寫出的內容可被 readPrefs 讀回', () => {
  const f = tmpFile()
  const p = { version: 1 as const, projects: { '/b': { pinned: false, hidden: true } } }
  writePrefs(f, p)
  assert.deepEqual(readPrefs(f).prefs, p)
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

test('毀損的 prefs 會被隔離保存，而不是靜默歸零', () => {
  // prefs 是使用者意圖，不可重建。靜默回傳空值之後，下一次寫入就把它永久蓋掉。
  const f = tmpFile('{壞掉')
  const out = readPrefs(f)
  assert.deepEqual(out.prefs, { version: 1, projects: {} })
  assert.equal(out.corrupt, true)
  assert.equal(existsSync(f.replace(/\.json$/, '.corrupt.json')), true)
})

test('檔案不存在不算毀損', () => {
  const out = readPrefs(join(mkdtempSync(join(tmpdir(), 'helm-prefs-')), 'nope.json'))
  assert.equal(out.corrupt, false)
})

test('未來版本的 prefs 同樣被保留下來，不當成空檔覆蓋', () => {
  const f = tmpFile(JSON.stringify({ version: 2, projects: { '/p': { pinned: true } } }))
  const out = readPrefs(f)
  assert.equal(out.corrupt, true)
  assert.equal(existsSync(f.replace(/\.json$/, '.corrupt.json')), true)
})
