import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { buildRefreshEnv, refreshArgs, spawnPrRefresh } from './spawn.ts'

test('PATH 補上常見的套件管理器路徑 —— gh 不在 launchd 的裸 PATH 裡', () => {
  // 這是整個 P5 在真實部署下從沒成功過的原因：SwiftBar 從登入項啟動，
  // plugin 拿到 /usr/bin:/bin:/usr/sbin:/sbin，而 gh 裝在 /opt/homebrew/bin。
  // 使用者看到的是「找不到 gh，安裝方式：brew install gh」—— 叫他去裝一個
  // 已經裝好的東西。
  const env = buildRefreshEnv({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' })
  assert.match(env['PATH'] ?? '', /\/opt\/homebrew\/bin/)
  assert.match(env['PATH'] ?? '', /\/usr\/local\/bin/)
  assert.match(env['PATH'] ?? '', /^\/usr\/bin:\/bin/, '原本的 PATH 仍在最前面')
})

test('已經在 PATH 裡的不重複加', () => {
  const env = buildRefreshEnv({ PATH: '/opt/homebrew/bin:/usr/bin' })
  const parts = (env['PATH'] ?? '').split(':')
  assert.equal(parts.filter((p) => p === '/opt/homebrew/bin').length, 1)
})

test('完全沒有 PATH 時也給得出一份 —— launchd 的 GUI 行程就是這樣', () => {
  const env = buildRefreshEnv({})
  assert.match(env['PATH'] ?? '', /\/usr\/bin/)
  assert.match(env['PATH'] ?? '', /\/opt\/homebrew\/bin/)
})

test('其餘環境變數原樣帶過去 —— gh 靠 GH_TOKEN 與 HOME', () => {
  const env = buildRefreshEnv({ HOME: '/h', GH_TOKEN: 't', FOO: 'bar' })
  assert.equal(env['HOME'], '/h')
  assert.equal(env['GH_TOKEN'], 't')
  assert.equal(env['FOO'], 'bar')
})

test('子行程收到家目錄，不會回頭用真實的 ~/.helm', () => {
  // spawnPrRefresh 原本的參數叫 _paths —— 完全沒用。於是子行程走
  // currentPaths()，測試會 fork 真的 gh 並覆寫使用者真實的 prs.json。
  // 那是這個專案第四次同型事故。
  const args = refreshArgs('/entry.ts')
  assert.deepEqual(args, ['--no-warnings', '/entry.ts', 'pr-refresh'])
  const env = buildRefreshEnv({ HOME: '/real' }, '/fake/home')
  assert.equal(env['HELM_FAKE_HOME'], '/fake/home')
})

test('沒有指定家目錄時不設 HELM_FAKE_HOME —— 那是正式路徑', () => {
  const env = buildRefreshEnv({ HOME: '/real' })
  assert.equal(env['HELM_FAKE_HOME'], undefined)
})

test('測試環境下完全不 spawn —— 讓呼叫端記得注入是不夠的', () => {
  // 第四次同型事故：collectStatus 讓 spawn 可注入之後，忘記注入的呼叫端
  // 照樣 fork 出真的 gh 並覆寫使用者真實的 prs.json。護欄要在底層。
  //
  // 回傳值而不是數行程：子行程要時間才會出現在 pgrep 裡，用時序判斷會
  // 讓這條測試在拿掉 guard 之後照樣通過（實測就是這樣）。
  assert.equal(process.env['HELM_NO_REAL_PREFS'], '1', 'test script 應該設好它')
  assert.equal(spawnPrRefresh({ home: '/tmp/nope' } as never), false)
})
