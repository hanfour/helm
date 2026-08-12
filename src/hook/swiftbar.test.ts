import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { resolvePaths } from '../paths.ts'
import { adoptPluginDir, defaultPluginDir, scannedPluginDir, type SwiftBarDeps } from './swiftbar.ts'

const paths = resolvePaths({ home: '/h' })

/** A fake `defaults` domain. */
const fake = (initial: Record<string, string> = {}) => {
  const store = { ...initial }
  const deps: SwiftBarDeps = {
    readPref: (k) => store[k] ?? null,
    writePref: (k, v) => {
      store[k] = v
    },
  }
  return { deps, store }
}

test('預設的 plugin 資料夾在家目錄第一層，不在隱藏的 ~/Library 底下', () => {
  // 這個資料夾使用者可能得在開檔面板裡挑，而 ~/Library 帶著 hidden 旗標 ——
  // 在面板裡根本不存在。
  assert.equal(defaultPluginDir(paths), '/h/SwiftBar')
})

test('SwiftBar 還沒設定時用預設資料夾', () => {
  assert.equal(scannedPluginDir(paths, fake().deps), '/h/SwiftBar')
})

test('SwiftBar 已經有自己的資料夾時就用它的 —— 那是使用者的決定', () => {
  const { deps } = fake({ PluginDirectory: '/h/my-plugins' })
  assert.equal(scannedPluginDir(paths, deps), '/h/my-plugins')
})

test('沒設定過時把 SwiftBar 指向我們的資料夾', () => {
  // 在 SwiftBar 首次啟動前寫入這個鍵，就完全跳過選資料夾的對話框 ——
  // 那是 helm 沒辦法代為完成的手動步驟。
  const { deps, store } = fake()
  assert.equal(adoptPluginDir('/h/SwiftBar', deps), true)
  assert.equal(store['PluginDirectory'], '/h/SwiftBar')
})

test('已經設定過就不覆蓋，helm 改為裝進去', () => {
  const { deps, store } = fake({ PluginDirectory: '/h/my-plugins' })
  assert.equal(adoptPluginDir('/h/SwiftBar', deps), false)
  assert.equal(store['PluginDirectory'], '/h/my-plugins')
})

test('讀不到偏好時當作沒設定，而不是丟錯', () => {
  const deps: SwiftBarDeps = {
    readPref: () => null,
    writePref: () => {},
  }
  assert.equal(scannedPluginDir(paths, deps), join('/h', 'SwiftBar'))
})
