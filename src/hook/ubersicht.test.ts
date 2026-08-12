import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { adoptWidgetDir, defaultWidgetDir, resolveWidgetDir } from './ubersicht.ts'
import { fakePrefs, unreadablePrefs } from './test-prefs.ts'

const PATHS = { home: '/h', helm: '/h/.helm', live: '/h/.helm/live' } as never

test('沒設定過時用 Übersicht 自己的預設資料夾', () => {
  assert.equal(
    defaultWidgetDir(PATHS),
    join('/h', 'Library', 'Application Support', 'Übersicht', 'widgets'),
  )
  assert.deepEqual(resolveWidgetDir(PATHS, fakePrefs()), {
    dir: defaultWidgetDir(PATHS), adoptable: true, warning: null,
  })
})

test('Übersicht 已經有自己的設定時，以它為準', () => {
  // The dead end this exists to prevent: helm writes the widget where it
  // thinks the folder is, Übersicht scans somewhere else, and the desktop
  // stays empty with every check reporting success.
  const r = resolveWidgetDir(PATHS, fakePrefs({ widgetDir: '/h/my-widgets' }))
  assert.equal(r.dir, '/h/my-widgets')
  assert.equal(r.adoptable, false, '使用者選過的資料夾不該被改掉')
})

test('讀不到偏好時不寫、不猜', () => {
  const r = resolveWidgetDir(PATHS, unreadablePrefs('ENOBUFS'))
  assert.equal(r.dir, null)
  assert.equal(r.adoptable, false)
  assert.match(r.warning ?? '', /widgetDir/)
})

test('認領時寫的是 Übersicht 自己的鍵', () => {
  const prefs = fakePrefs()
  adoptWidgetDir('/h/w', prefs)
  assert.equal(prefs.store['widgetDir'], '/h/w')
})
