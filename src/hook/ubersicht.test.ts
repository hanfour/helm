import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { adoptWidgetDir, defaultWidgetDir, scannedWidgetDir } from './ubersicht.ts'
import type { PrefsIO } from './defaults.ts'

const PATHS = { home: '/h', helm: '/h/.helm', live: '/h/.helm/live' } as never

/** A fake `defaults` domain that starts empty unless seeded. */
function fakePrefs(seed: Record<string, string> = {}): PrefsIO & { store: Record<string, string> } {
  const store = { ...seed }
  return {
    store,
    readPref: (key) => store[key] ?? null,
    writePref: (key, value) => {
      store[key] = value
    },
  }
}

test('沒設定過時用 Übersicht 自己的預設資料夾', () => {
  const dir = defaultWidgetDir(PATHS)
  assert.equal(dir, join('/h', 'Library', 'Application Support', 'Übersicht', 'widgets'))
})

test('Übersicht 已經有自己的設定時，以它為準', () => {
  // The dead end this exists to prevent: helm writes the widget where it
  // thinks the folder is, Übersicht scans somewhere else, and the desktop
  // stays empty with every check reporting success.
  const prefs = fakePrefs({ widgetDir: '/h/my-widgets' })
  assert.equal(scannedWidgetDir(PATHS, prefs), '/h/my-widgets')
})

test('沒設定時才寫入偏好，已設定就不動使用者的選擇', () => {
  const fresh = fakePrefs()
  assert.equal(adoptWidgetDir('/h/w', fresh), true)
  assert.equal(fresh.store['widgetDir'], '/h/w')

  const chosen = fakePrefs({ widgetDir: '/h/mine' })
  assert.equal(adoptWidgetDir('/h/w', chosen), false)
  assert.equal(chosen.store['widgetDir'], '/h/mine', '使用者選過的資料夾不該被改掉')
})
