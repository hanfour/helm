import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { prefsFor } from './defaults.ts'

/**
 * A throwaway domain of our own, so this never touches an app the user runs.
 * It has to be a real one: the bug being pinned down here lives inside macOS's
 * own `defaults` output, and a fake would reproduce whatever I assumed rather
 * than what the tool actually does.
 */
const TEST_DOMAIN = `com.helm.test.${process.pid}`

after(() => {
  try {
    execFileSync('defaults', ['delete', TEST_DOMAIN], { stdio: 'ignore' })
  } catch {
    // Nothing was ever written; there is nothing to clean up.
  }
})

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

test('非 ASCII 的值讀得回原樣 —— defaults read 會把它變成八進位跳脫', () => {
  // `defaults read <domain> <key>` printed the Übersicht widget folder as
  //   /Users/…/Application Support/\334bersicht/widgets
  // and helm then looked for a directory by that literal name, found nothing,
  // and reported the widget as missing right after installing it.
  const dir = '/Users/x/Library/Application Support/Übersicht/widgets'
  execFileSync('defaults', ['write', TEST_DOMAIN, 'widgetDir', '-string', dir])
  assert.equal(prefsFor(TEST_DOMAIN).readPref('widgetDir'), dir)
})

test('值裡有換行也讀得回原樣', () => {
  // A path cannot contain a newline, but the reader must not be the thing that
  // decides that — `plutil -extract raw` appends one and it has to come off
  // without eating a legitimate character.
  const weird = 'a\nb'
  execFileSync('defaults', ['write', TEST_DOMAIN, 'weird', '-string', weird])
  assert.equal(prefsFor(TEST_DOMAIN).readPref('weird'), weird)
})
