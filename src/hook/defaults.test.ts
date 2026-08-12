import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prefsFor } from './defaults.ts'

test('測試環境下寫入真實偏好會直接爆掉，而不是默默改掉使用者的設定', () => {
  // This already happened once: a CLI test with no injected fake wrote a
  // /var/folders path into the real Übersicht domain, pointing the app at a
  // directory that the test then deleted. Nothing failed, nothing was
  // printed, and the damage was only found by reading `defaults` by hand.
  assert.equal(process.env['HELM_NO_REAL_PREFS'], '1', 'test script 應該設好這個變數')
  assert.throws(
    () => prefsFor('com.example.nothing').writePref('someKey', 'someValue'),
    /HELM_NO_REAL_PREFS/,
  )
})

test('讀取不受影響 —— 讀不會改壞任何東西', () => {
  assert.equal(prefsFor('com.example.definitely-not-a-real-domain').readPref('k'), null)
})
