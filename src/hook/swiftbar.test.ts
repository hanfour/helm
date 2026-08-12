import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePaths } from '../paths.ts'
import { adoptPluginDir, defaultPluginDir, resolvePluginDir } from './swiftbar.ts'
import { fakePrefs, unreadablePrefs } from './test-prefs.ts'

const paths = resolvePaths({ home: '/h' })

test('預設的 plugin 資料夾在家目錄第一層，不在隱藏的 ~/Library 底下', () => {
  // 這個資料夾使用者可能得在開檔面板裡挑，而 ~/Library 帶著 hidden 旗標 ——
  // 在面板裡根本不存在。
  assert.equal(defaultPluginDir(paths), '/h/SwiftBar')
})

test('SwiftBar 還沒設定時用預設資料夾，而且可以認領', () => {
  assert.deepEqual(resolvePluginDir(paths, fakePrefs()), {
    dir: '/h/SwiftBar', adoptable: true, warning: null,
  })
})

test('SwiftBar 已經有自己的資料夾時就用它的 —— 那是使用者的決定', () => {
  const r = resolvePluginDir(paths, fakePrefs({ PluginDirectory: '/h/my-plugins' }))
  assert.equal(r.dir, '/h/my-plugins')
  assert.equal(r.adoptable, false)
})

test('讀不到偏好時不寫、不猜 —— 猜錯會蓋掉使用者所有的 plugin', () => {
  // 這條之前斷言的是相反的行為（讀不到就當作沒設定），而那正是
  // 一次暫時性讀取失敗會覆寫掉使用者選擇的原因。
  const r = resolvePluginDir(paths, unreadablePrefs())
  assert.equal(r.dir, null)
  assert.equal(r.adoptable, false)
  assert.match(r.warning ?? '', /PluginDirectory/)
})

test('認領時寫的是 SwiftBar 自己的鍵', () => {
  // 在 SwiftBar 首次啟動前寫入這個鍵，就完全跳過選資料夾的對話框 ——
  // 那是 helm 沒辦法代為完成的手動步驟。
  const prefs = fakePrefs()
  adoptPluginDir('/h/SwiftBar', prefs)
  assert.equal(prefs.store['PluginDirectory'], '/h/SwiftBar')
})
