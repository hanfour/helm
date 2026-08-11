import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
  assert.equal(out.health, 'quarantined')
  assert.equal(existsSync(f.replace(/\.json$/, '.corrupt.json')), true)
})

test('隔離失敗時回報 unreadable —— 絕不能與「已保存」混為一談', () => {
  // 目錄不可寫時 rename 失敗，但就地截斷不需要目錄權限。舊實作把兩者
  // 都回報成 corrupt，呼叫端據此告訴使用者「原檔已保留」，接著就把它
  // 蓋掉了 —— 一個宣稱不可重建的檔案，靜默且不可回復地消失。
  const dir = mkdtempSync(join(tmpdir(), 'helm-prefs-'))
  const f = join(dir, 'projects.json')
  writeFileSync(f, '{壞掉')
  chmodSync(dir, 0o555)
  try {
    const out = readPrefs(f)
    assert.equal(out.health, 'unreadable')
    assert.equal(existsSync(f.replace(/\.json$/, '.corrupt.json')), false)
    assert.equal(readFileSync(f, 'utf8'), '{壞掉', '原檔必須原封不動')
  } finally {
    chmodSync(dir, 0o755)
  }
})

test('writePrefs 是原子的 —— 不留暫存檔', () => {
  const f = tmpFile()
  writePrefs(f, setProjectPref({ version: 1, projects: {} }, '/a', { pinned: true }))
  assert.deepEqual(readdirSync(dirname(f)).filter((n) => n.includes('.tmp')), [])
  assert.equal(readPrefs(f).prefs.projects['/a']?.pinned, true)
})

test('並行寫入不會產生半份 JSON', () => {
  // 實測 8 個並行 helm hide 會寫出無法解析的檔案，下一次 helm status
  // 把它隔離，全部設定一次失去。
  const f = tmpFile()
  const bodies = Array.from({ length: 12 }, (_, i) =>
    setProjectPref({ version: 1, projects: {} }, `/p${i}`, { hidden: true }))
  for (const b of bodies) writePrefs(f, b)
  assert.equal(readPrefs(f).health, 'ok')
})

test('檔案不存在不算毀損', () => {
  const out = readPrefs(join(mkdtempSync(join(tmpdir(), 'helm-prefs-')), 'nope.json'))
  assert.equal(out.health, 'ok')
})

test('未來版本的 prefs 同樣被保留下來，不當成空檔覆蓋', () => {
  const f = tmpFile(JSON.stringify({ version: 2, projects: { '/p': { pinned: true } } }))
  const out = readPrefs(f)
  assert.equal(out.health, 'quarantined')
  assert.equal(existsSync(f.replace(/\.json$/, '.corrupt.json')), true)
})
