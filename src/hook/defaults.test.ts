import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isMissingKey, prefsFor, type PrefsExec } from './defaults.ts'

/**
 * A throwaway domain of our own, so this never touches an app the user runs.
 * It has to be a real one: the bugs being pinned down here live inside macOS's
 * own tooling, and a fake would reproduce whatever I assumed rather than what
 * `defaults` and `plutil` actually do.
 */
const TEST_DOMAIN = `com.helm.test.${process.pid}`

after(() => {
  try {
    execFileSync('defaults', ['delete', TEST_DOMAIN], { stdio: 'ignore' })
  } catch {
    // Nothing was ever written; there is nothing to delete.
  }
  // `defaults delete` empties the domain but leaves the plist behind, and the
  // name carries a pid so it is never reused — 76 of these accumulated in the
  // user's ~/Library/Preferences before anyone noticed.
  rmSync(join(homedir(), 'Library', 'Preferences', `${TEST_DOMAIN}.plist`), { force: true })
})

const write = (key: string, ...args: string[]) =>
  execFileSync('defaults', ['write', TEST_DOMAIN, key, ...args])

const read = (key: string) => prefsFor(TEST_DOMAIN).readPref(key)

test('測試結束後不留下偏好檔 —— 檔名帶 pid，沒人會回收它', () => {
  // Asserted rather than assumed: the previous `after()` called
  // `defaults delete` and looked correct, while leaving the file on disk
  // every single run.
  write('anything', '-string', 'x')
  const plist = join(homedir(), 'Library', 'Preferences', `${TEST_DOMAIN}.plist`)
  assert.equal(existsSync(plist), true, '這一刻它應該存在，after() 才有東西可刪')
})

test('測試環境下讀取真實偏好會爆掉 —— 讀到使用者的設定就會照著改壞它', () => {
  assert.equal(process.env['HELM_NO_REAL_PREFS'], '1', 'test script 應該設好這個變數')
  assert.throws(() => prefsFor('com.ameba.SwiftBar').readPref('PluginDirectory'), /HELM_NO_REAL_PREFS/)
})

test('測試環境下寫入真實偏好會爆掉', () => {
  assert.throws(
    () => prefsFor('com.example.nothing').writePref('someKey', 'someValue'),
    /HELM_NO_REAL_PREFS/,
  )
})

test('寫進去再讀出來是同一個字串 —— 真正的 writePref 之前一行都沒被執行過', () => {
  const prefs = prefsFor(TEST_DOMAIN)
  for (const value of ['/a b/Übersicht/widgets', '2', 'true', '/it’s/a&b/<c>']) {
    prefs.writePref('roundTrip', value)
    assert.deepEqual(prefs.readPref('roundTrip'), { kind: 'set', value })
  }
})

test('`-string` 不能拿掉 —— 少了它 "2" 會被存成整數，型別就變了', () => {
  const prefs = prefsFor(TEST_DOMAIN)
  prefs.writePref('numericLooking', '2')
  assert.deepEqual(prefs.readPref('numericLooking'), { kind: 'set', value: '2' })
})

test('非 ASCII 讀得回原樣 —— defaults read 會把它變成八進位跳脫', () => {
  write('nonAscii', '-string', '/Users/x/Library/Application Support/Übersicht/widgets')
  assert.deepEqual(read('nonAscii'), {
    kind: 'set',
    value: '/Users/x/Library/Application Support/Übersicht/widgets',
  })
})

test('前後空白與換行都逐字保留 —— trim 會靜靜吃掉結尾空白', () => {
  // The comment on this line used to warn about `.trim()` while no test held
  // it: a folder name ending in a space would install to the wrong path, and
  // doctor would report green against an empty desktop.
  for (const value of [' /h/w ', '/h/w\n', 'a\nb', '/h/w\t']) {
    write('spacey', '-string', value)
    assert.deepEqual(read('spacey'), { kind: 'set', value }, JSON.stringify(value))
  }
})

test('XML 會跳脫的字元也讀得回原樣', () => {
  for (const value of ['/a&b', '/a<b>c', '/a"b', "/a'b", '/a&amp;b']) {
    write('xmlish', '-string', value)
    assert.deepEqual(read('xmlish'), { kind: 'set', value }, value)
  }
})

test('空字串等同沒設定 —— 否則 join("", …) 會變成相對路徑', () => {
  write('blank', '-string', '')
  assert.deepEqual(read('blank'), { kind: 'unset' })
})

test('domain 或 key 不存在時是「沒設定」，不是「讀不到」', () => {
  assert.deepEqual(prefsFor('com.helm.test.definitely-not-real').readPref('k'), { kind: 'unset' })
  assert.deepEqual(read('neverWritten'), { kind: 'unset' })
})

test('非字串型別一律拒絕，而且不能被誤認成「沒設定」', () => {
  // `plutil -extract … raw` compresses these: an array prints its element
  // count, a dict prints a key name. Read as a folder, `["a","b"]` became the
  // literal path "2" — a relative path, so helm created ./2/ in whatever
  // directory the user happened to be in, and reported success.
  const cases: [string, string[]][] = [
    ['anInt', ['-int', '42']],
    ['aBool', ['-bool', 'true']],
    ['aFloat', ['-float', '1.5']],
    ['anArray', ['-array', 'a', 'b']],
    ['aDict', ['-dict', 'k', 'v']],
  ]
  for (const [key, args] of cases) {
    write(key, ...args)
    const r = read(key)
    assert.equal(r.kind, 'unreadable', `${key} 應該被拒絕，實際是 ${JSON.stringify(r)}`)
    assert.match((r as { reason: string }).reason, /型別|字串/, JSON.stringify(r))
  }
})

test('讀取失敗回報 unreadable —— 混成「沒設定」就會覆寫使用者的選擇', () => {
  // The distinction is the whole point: `unset` licenses `adoptWidgetDir` to
  // write, and writing over a folder the user chose makes every one of their
  // widgets vanish. A 1.2 MB domain used to hit execFileSync's default
  // maxBuffer, throw ENOBUFS, and be caught as "not set".
  const prefs = prefsFor(TEST_DOMAIN)
  const big = 'x'.repeat(200_000)
  for (let i = 0; i < 8; i++) write(`bulk${i}`, '-string', big)
  write('needle', '-string', '/h/w')
  assert.deepEqual(prefs.readPref('needle'), { kind: 'set', value: '/h/w' }, '大 domain 也要讀得到')
})

test('只有「exit 1 且沒有 errno」才算沒設定，其餘都是讀取失敗', () => {
  // This one predicate decides whether adopt* may overwrite the folder the
  // user chose. Collapsing the two is how a 1.2 MB domain's ENOBUFS turned
  // into "this app was never configured".
  assert.equal(isMissingKey({ status: 1 }), true, 'key 不存在')
  assert.equal(isMissingKey({ status: 1, code: 'ENOBUFS' }), false, 'buffer 爆掉不是沒設定')
  assert.equal(isMissingKey({ status: 1, signal: 'SIGKILL' }), false, '被砍掉不是沒設定')
  assert.equal(isMissingKey({ status: 127 }), false, '找不到指令不是沒設定')
  assert.equal(isMissingKey({ status: null }), false)
  assert.equal(isMissingKey({ code: 'ENOENT' }), false, 'plutil 不在不是沒設定')
})

test('讀取失敗時回 unreadable，絕不回 unset —— unset 等於授權覆寫', () => {
  // The branch that matters most and the one a test cannot reach from
  // outside: there is no way to make the real `defaults` throw ENOBUFS on
  // demand. Injected, so collapsing it into `unset` cannot slip through.
  const failWith = (err: object): PrefsExec => ({
    exportDomain: () => { throw Object.assign(new Error('boom'), err) },
    extract: () => '',
  })
  for (const err of [{ status: 1, code: 'ENOBUFS' }, { status: 127 }, { signal: 'SIGKILL' }]) {
    const r = prefsFor(`${TEST_DOMAIN}.injected`, failWith(err)).readPref('widgetDir')
    assert.equal(r.kind, 'unreadable', JSON.stringify(err))
  }
  const missing = prefsFor(`${TEST_DOMAIN}.injected`, failWith({ status: 1 })).readPref('widgetDir')
  assert.equal(missing.kind, 'unset', 'key 不存在仍然是 unset')
})
