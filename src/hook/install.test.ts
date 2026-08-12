import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePaths } from '../paths.ts'
import { installHook, uninstallHook } from './install.ts'
import { hasHelmHook } from './settings.ts'

/** A fake `defaults` domain, so no test ever touches the real SwiftBar. */
const fakeSwiftBar = (initial: Record<string, string> = {}) => {
  const store = { ...initial }
  return {
    store,
    deps: {
      readPref: (k: string) => store[k] ?? null,
      writePref: (k: string, v: string) => {
        store[k] = v
      },
    },
  }
}

// Stateless by default: a shared mutable store would let the first test that
// installs leak its PluginDirectory into every test after it.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

const NO_PREFS = { readPref: () => null, writePref: () => {} }

const DEPS = {
  now: () => 1786000000000,
  repoRoot: '/repo',
  // Both, always. Leaving either out sends that path to the real `defaults`
  // database, which is how a test once overwrote the working SwiftBar plugin
  // in ~/SwiftBar with one pointing at its own fixture.
  swiftbar: NO_PREFS,
  ubersicht: NO_PREFS,
}

function home(settings?: object): string {
  const h = mkdtempSync(join(tmpdir(), 'helm-install-'))
  mkdirSync(join(h, '.claude'), { recursive: true })
  if (settings !== undefined) {
    writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify(settings, null, 2))
  }
  return h
}

const readSettings = (h: string): unknown =>
  JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'))

test('安裝會寫入 hook 設定', () => {
  const h = home({ theme: 'dark' })
  installHook(resolvePaths({ home: h }), DEPS)
  assert.equal(hasHelmHook(readSettings(h)), true)
})

test('安裝前先備份，備份內容是安裝前的原始檔', () => {
  const h = home({ theme: 'dark' })
  installHook(resolvePaths({ home: h }), DEPS)
  const backups = readdirSync(join(h, '.helm', 'backups'))
  assert.equal(backups.length, 1)
  assert.deepEqual(
    JSON.parse(readFileSync(join(h, '.helm', 'backups', backups[0] as string), 'utf8')),
    { theme: 'dark' },
  )
})

test('安裝會預先建立 live 目錄 —— hook 不建目錄，多一次 spawn 太貴', () => {
  const h = home({})
  installHook(resolvePaths({ home: h }), DEPS)
  assert.ok(statSync(join(h, '.helm', 'live')).isDirectory())
})

test('安裝會寫出可執行的 helm wrapper', () => {
  const h = home({})
  installHook(resolvePaths({ home: h }), DEPS)
  const wrapper = join(h, '.local', 'bin', 'helm')
  assert.match(readFileSync(wrapper, 'utf8'), /exec "\$NODE" '\/repo\/src\/cli\/main\.ts' "\$@"/)
  assert.ok((statSync(wrapper).mode & 0o111) !== 0, 'wrapper 必須可執行')
})

test('settings.json 不存在時視為空設定，仍能安裝', () => {
  const h = home()
  installHook(resolvePaths({ home: h }), DEPS)
  assert.equal(hasHelmHook(readSettings(h)), true)
})

test('settings.json 壞掉時拒絕安裝，不硬蓋掉使用者的檔案', () => {
  // 解析失敗時退成空物件再寫回去，會一口氣毀掉使用者的每一項設定。
  // 拒絕是唯一安全的答案。
  const h = home()
  writeFileSync(join(h, '.claude', 'settings.json'), '{壞掉')
  const report = installHook(resolvePaths({ home: h }), DEPS)
  assert.ok(report.warnings.some((w) => w.includes('無法解析')))
  assert.equal(report.steps.length, 0)
  assert.equal(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'), '{壞掉')
})

test('hooks 是看不懂的形狀時同樣拒絕，並明講原因', () => {
  const h = home({ hooks: 'not an object' })
  const report = installHook(resolvePaths({ home: h }), DEPS)
  assert.ok(report.warnings.some((w) => w.includes('hooks')))
  assert.deepEqual(readSettings(h), { hooks: 'not an object' })
})

test('SwiftBar 未安裝時給出提示但不擋安裝', () => {
  const h = home({})
  const report = installHook(resolvePaths({ home: h }), { ...DEPS, swiftbarInstalled: false })
  assert.ok(report.warnings.some((w) => w.includes('SwiftBar')))
  assert.equal(hasHelmHook(readSettings(h)), true)
})

test('SwiftBar 有裝時一併安裝可執行的 plugin', () => {
  const h = home({})
  installHook(resolvePaths({ home: h }), { ...DEPS, swiftbarInstalled: true })
  const plugin = join(h, 'SwiftBar', 'helm.5s.sh')
  assert.match(readFileSync(plugin, 'utf8'), /helm' menu/)
  assert.ok((statSync(plugin).mode & 0o111) !== 0)
})

test('SwiftBar plugin 走 wrapper 的絕對路徑 —— 它的 PATH 很精簡', () => {
  const h = home({})
  installHook(resolvePaths({ home: h }), { ...DEPS, swiftbarInstalled: true })
  const plugin = join(h, 'SwiftBar', 'helm.5s.sh')
  assert.ok(readFileSync(plugin, 'utf8').includes(join(h, '.local', 'bin', 'helm')))
})

test('沒設定過時把 SwiftBar 指向我們的資料夾 —— 跳過那個只能手動點的對話框', () => {
  const h = home({})
  const sb = fakeSwiftBar()
  const report = installHook(resolvePaths({ home: h }), {
    ...DEPS, swiftbarInstalled: true, swiftbar: sb.deps,
  })
  assert.equal(sb.store['PluginDirectory'], join(h, 'SwiftBar'))
  assert.ok(report.steps.some((s) => s.includes('plugin 資料夾')))
})

test('SwiftBar 已經指向別的資料夾時，plugin 就裝進去那裡', () => {
  // 那是使用者自己選的，helm 沒有立場把它改掉；裝錯地方則是靜默失效。
  const h = home({})
  const sb = fakeSwiftBar({ PluginDirectory: join(h, 'my-plugins') })
  installHook(resolvePaths({ home: h }), {
    ...DEPS, swiftbarInstalled: true, swiftbar: sb.deps,
  })
  assert.ok(existsSync(join(h, 'my-plugins', 'helm.5s.sh')))
  assert.equal(sb.store['PluginDirectory'], join(h, 'my-plugins'), '不該被覆寫')
})

test('解除安裝把 settings.json 還原成安裝前的樣子', () => {
  const original = { theme: 'dark', permissions: { allow: ['Bash(npm test)'] } }
  const h = home(original)
  const paths = resolvePaths({ home: h })
  installHook(paths, DEPS)
  uninstallHook(paths, DEPS)
  assert.deepEqual(readSettings(h), original)
})

test('解除安裝不動別人的 hook', () => {
  const original = {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other.js' }] }] },
  }
  const h = home(original)
  const paths = resolvePaths({ home: h })
  installHook(paths, DEPS)
  uninstallHook(paths, DEPS)
  assert.deepEqual(readSettings(h), original)
})

test('解除安裝會移除 wrapper 與 SwiftBar plugin', () => {
  const h = home({})
  const paths = resolvePaths({ home: h })
  installHook(paths, { ...DEPS, swiftbarInstalled: true })
  uninstallHook(paths, DEPS)
  assert.equal(existsSync(join(h, '.local', 'bin', 'helm')), false)
  assert.equal(existsSync(join(h, 'SwiftBar', 'helm.5s.sh')), false)
})

test('解除安裝保留 live 檔與快取 —— 那是使用者的資料，不是我們的殘骸', () => {
  const h = home({})
  const paths = resolvePaths({ home: h })
  installHook(paths, DEPS)
  writeFileSync(join(h, '.helm', 'live', 'x.json'), '{}')
  uninstallHook(paths, DEPS)
  assert.equal(existsSync(join(h, '.helm', 'live', 'x.json')), true)
})

test('沒裝過就解除安裝不丟錯，也不動 settings.json', () => {
  const h = home({ theme: 'dark' })
  uninstallHook(resolvePaths({ home: h }), DEPS)
  assert.deepEqual(readSettings(h), { theme: 'dark' })
})

test('重複安裝只留一份 hook，備份也只留安裝前那一份', () => {
  // 第二份備份會是「已經含 helm hook」的檔案。使用者照直覺還原最新的備份
  // 會讓 helm 又回來 —— 那正好是他想擺脫的東西。
  const h = home({ theme: 'dark' })
  const paths = resolvePaths({ home: h })
  installHook(paths, DEPS)
  installHook(paths, { ...DEPS, now: () => 1786000001000 })
  const settings = readSettings(h) as { hooks: { PreToolUse: unknown[] } }
  assert.equal(settings.hooks.PreToolUse.length, 1)
  const backups = readdirSync(join(h, '.helm', 'backups'))
  assert.equal(backups.length, 1)
  const body = readFileSync(join(h, '.helm', 'backups', backups[0] as string), 'utf8')
  assert.ok(!body.includes('HELM_LIVE_MARKER'), '備份必須是安裝前的乾淨狀態')
})

test('備份檔權限為 0600 —— settings.json 可能含 env 裡的 token', () => {
  const h = home({ env: { SOME_TOKEN: 'secret' } })
  installHook(resolvePaths({ home: h }), DEPS)
  const backups = readdirSync(join(h, '.helm', 'backups'))
  const mode = statSync(join(h, '.helm', 'backups', backups[0] as string)).mode & 0o777
  assert.equal(mode, 0o600)
})

test('安裝是原子的 —— 不留半份 settings.json 也不留暫存檔', () => {
  const h = home({ theme: 'dark' })
  installHook(resolvePaths({ home: h }), DEPS)
  const leftovers = readdirSync(join(h, '.claude')).filter((n) => n.includes('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('既有的同名 helm（例如 Kubernetes 的）不會被覆寫', () => {
  // ~/.local/bin 正是使用者放自己二進位檔的地方，而 Kubernetes 的 helm 同名。
  // 覆寫它、又在 uninstall 時刪掉，會讓使用者永久失去一個我們沒寫的檔案。
  const h = home({})
  const wrapper = join(h, '.local', 'bin', 'helm')
  mkdirSync(dirname(wrapper), { recursive: true })
  writeFileSync(wrapper, '#!/bin/sh\necho "Kubernetes Helm v3.16.2"\n')
  const report = installHook(resolvePaths({ home: h }), DEPS)
  assert.match(readFileSync(wrapper, 'utf8'), /Kubernetes Helm/)
  assert.ok(report.warnings.some((w) => w.includes(wrapper)))
})

test('別人的 helm 存在時仍完成 hook 安裝，不是整個放棄', () => {
  const h = home({})
  const wrapper = join(h, '.local', 'bin', 'helm')
  mkdirSync(dirname(wrapper), { recursive: true })
  writeFileSync(wrapper, '#!/bin/sh\necho other\n')
  installHook(resolvePaths({ home: h }), DEPS)
  assert.equal(hasHelmHook(readSettings(h)), true)
})

test('別人的 helm 存在時，SwiftBar plugin 改為直接呼叫 node，不依賴 wrapper', () => {
  const h = home({})
  const wrapper = join(h, '.local', 'bin', 'helm')
  mkdirSync(dirname(wrapper), { recursive: true })
  writeFileSync(wrapper, '#!/bin/sh\necho other\n')
  installHook(resolvePaths({ home: h }), { ...DEPS, swiftbarInstalled: true })
  const plugin = readFileSync(join(h, 'SwiftBar', 'helm.5s.sh'), 'utf8')
  assert.ok(!plugin.includes(wrapper), '不該指向別人的 helm')
  assert.match(plugin, /main\.ts' menu/)
})

test('uninstall 只刪自己寫的 wrapper', () => {
  const h = home({})
  const wrapper = join(h, '.local', 'bin', 'helm')
  mkdirSync(dirname(wrapper), { recursive: true })
  writeFileSync(wrapper, '#!/bin/sh\necho "Kubernetes Helm v3.16.2"\n')
  const paths = resolvePaths({ home: h })
  installHook(paths, DEPS)
  uninstallHook(paths, DEPS)
  assert.equal(existsSync(wrapper), true, '不是我們寫的就不該刪')
  assert.match(readFileSync(wrapper, 'utf8'), /Kubernetes Helm/)
})

test('uninstall 刪得掉自己寫的 wrapper', () => {
  const h = home({})
  const paths = resolvePaths({ home: h })
  installHook(paths, DEPS)
  const wrapper = join(h, '.local', 'bin', 'helm')
  assert.equal(existsSync(wrapper), true)
  uninstallHook(paths, DEPS)
  assert.equal(existsSync(wrapper), false)
})

test('uninstall 不刪別人的 SwiftBar plugin', () => {
  const h = home({})
  const plugin = join(h, 'SwiftBar', 'helm.5s.sh')
  mkdirSync(dirname(plugin), { recursive: true })
  writeFileSync(plugin, '#!/bin/sh\necho someone elses\n')
  uninstallHook(resolvePaths({ home: h }), DEPS)
  assert.match(readFileSync(plugin, 'utf8'), /someone elses/)
})

test('頂層不是物件的 settings.json 被拒絕，不是被取代', () => {
  // readSettings 花了整段註解說明「絕不退化成空物件再寫回去」，但 JSON.parse
  // 成功而值是陣列/字串/數字時，asRecord 就回 {} 然後照寫。
  for (const body of ['[{"important":"user data"}]', '"just a string"', 'null', '42']) {
    const h = home()
    writeFileSync(join(h, '.claude', 'settings.json'), body)
    const report = installHook(resolvePaths({ home: h }), DEPS)
    assert.equal(report.ok, false, `不該接受：${body}`)
    assert.equal(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'), body)
  }
})

test('中途失敗時仍回報已經做了哪些事', () => {
  // settings.json 已經被改、hook 已經生效之後才丟例外，使用者只看到一行
  // EACCES 就合理判斷「安裝失敗」而不去 uninstall —— 但機器已經被改了。
  const h = home({ theme: 'dark' })
  writeFileSync(join(h, '.local'), 'not a directory')
  const report = installHook(resolvePaths({ home: h }), DEPS)
  assert.equal(report.ok, false)
  assert.ok(report.steps.some((s) => s.includes('已把 hook 加進')), '已完成的步驟必須說出來')
  assert.ok(report.warnings.some((w) => w.includes('helm uninstall')), '要告訴使用者怎麼收回')
  assert.equal(hasHelmHook(readSettings(h)), true)
})

test('已有舊的 helm 條目但 hooks 形狀看不懂時，不謊報成功', () => {
  // repo 搬家後重跑 install「修路徑」，實際上只是把原檔重寫一遍。
  const h = home({
    hooks: {
      PreToolUse: 'not an array',
    },
  })
  const report = installHook(resolvePaths({ home: h }), DEPS)
  assert.equal(report.ok, false)
  assert.ok(report.warnings.some((w) => w.includes('hooks')))
})

test('保留 settings.json 原有的檔案權限', () => {
  // 0600 的檔案裡可能有 env 段的 token，安裝後變 0644 是安全退化。
  const h = home({ env: { SOME_TOKEN: 'secret' } })
  chmodSync(join(h, '.claude', 'settings.json'), 0o600)
  installHook(resolvePaths({ home: h }), DEPS)
  assert.equal(statSync(join(h, '.claude', 'settings.json')).mode & 0o777, 0o600)
})

test('settings.json 是 symlink 時寫進去的是真身，連結本身留著', () => {
  // 用 dotfiles 管理設定是常見做法。把 symlink 換成普通檔會讓 dotfiles
  // 從此永久斷開，而且不會有任何人告訴使用者。
  const h = home()
  const real = join(h, 'dotfiles-settings.json')
  writeFileSync(real, JSON.stringify({ theme: 'dark' }, null, 2))
  symlinkSync(real, join(h, '.claude', 'settings.json'))
  installHook(resolvePaths({ home: h }), DEPS)
  assert.equal(lstatSync(join(h, '.claude', 'settings.json')).isSymbolicLink(), true)
  assert.ok(readFileSync(real, 'utf8').includes('HELM_LIVE_MARKER'), '真身必須被更新')
})

test('保留原本的縮排 —— 不讓一次安裝在 dotfiles 產生整檔 diff', () => {
  const h = home()
  writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark' }, null, 4))
  const paths = resolvePaths({ home: h })
  installHook(paths, DEPS)
  uninstallHook(paths, DEPS)
  assert.equal(
    readFileSync(join(h, '.claude', 'settings.json'), 'utf8'),
    `${JSON.stringify({ theme: 'dark' }, null, 4)}\n`,
  )
})

test('uninstall 前也會備份 —— 那才是真正在刪東西的那一邊', () => {
  const h = home({ theme: 'dark' })
  const paths = resolvePaths({ home: h })
  installHook(paths, DEPS)
  uninstallHook(paths, DEPS)
  const backups = readdirSync(join(h, '.helm', 'backups'))
  assert.equal(backups.length, 2, '安裝前一份、解除安裝前一份')
  assert.ok(backups.some((n) => n.includes('uninstall')))
})

test('wrapper 用絕對路徑的 node，不依賴 PATH', () => {
  // SwiftBar 等由 Finder／登入項目啟動的 app 拿到的是 launchd 的精簡 PATH，
  // 而所有 Node 版本管理器的 shim 都在家目錄底下 —— 重開機後就找不到。
  const h = home({})
  installHook(resolvePaths({ home: h }), { ...DEPS, nodeBin: '/abs/node' })
  const body = readFileSync(join(h, '.local', 'bin', 'helm'), 'utf8')
  assert.match(body, /NODE='\/abs\/node'/)
  assert.match(body, /exec "\$NODE"/)
})

test('絕對路徑不存在時退回 PATH —— 版本管理器升級會刪掉舊的 image', () => {
  const h = home({})
  installHook(resolvePaths({ home: h }), { ...DEPS, nodeBin: '/abs/node' })
  assert.match(readFileSync(join(h, '.local', 'bin', 'helm'), 'utf8'), /\[ -x "\$NODE" \] \|\| NODE=node/)
})

test('在精簡 PATH 下 wrapper 仍然跑得起來', () => {
  const h = home({})
  installHook(resolvePaths({ home: h }), { ...DEPS, nodeBin: process.execPath, repoRoot: REPO_ROOT })
  const out = execFileSync(join(h, '.local', 'bin', 'helm'), ['help'], {
    encoding: 'utf8',
    env: { HOME: h, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  })
  assert.match(out, /helm —/)
})

const fakeUbersicht = (initial: Record<string, string> = {}) => {
  const store = { ...initial }
  return {
    store,
    deps: {
      readPref: (k: string) => store[k] ?? null,
      writePref: (k: string, v: string) => {
        store[k] = v
      },
    },
  }
}

const UB = (extra: object = {}) => ({ ...DEPS, ubersichtInstalled: true, ...extra })

test('裝了 Übersicht 就寫出桌面 widget', () => {
  const h = home({})
  const ub = fakeUbersicht()
  const report = installHook(resolvePaths({ home: h }), UB({ ubersicht: ub.deps }))
  const widget = join(h, 'Library', 'Application Support', 'Übersicht', 'widgets', 'helm.jsx')
  assert.equal(existsSync(widget), true, report.warnings.join('\n'))
  assert.match(readFileSync(widget, 'utf8'), /export const command = /)
})

test('widget 走 wrapper 的絕對路徑 —— Übersicht 的 PATH 一樣很精簡', () => {
  const h = home({})
  const ub = fakeUbersicht()
  installHook(resolvePaths({ home: h }), UB({ ubersicht: ub.deps }))
  const widget = readFileSync(
    join(h, 'Library', 'Application Support', 'Übersicht', 'widgets', 'helm.jsx'), 'utf8',
  )
  assert.ok(widget.includes(join(h, '.local', 'bin', 'helm')))
})

test('Übersicht 已經指定過 widget 資料夾時，裝進它掃描的那一個', () => {
  const h = home({})
  const mine = join(h, 'my-widgets')
  const ub = fakeUbersicht({ widgetDir: mine })
  installHook(resolvePaths({ home: h }), UB({ ubersicht: ub.deps }))
  assert.equal(existsSync(join(mine, 'helm.jsx')), true)
  assert.equal(ub.store['widgetDir'], mine, '使用者選過的資料夾不該被改掉')
})

test('沒裝 Übersicht 時給出安裝指引，而不是默默跳過', () => {
  const h = home({})
  const report = installHook(resolvePaths({ home: h }), { ...DEPS, ubersichtInstalled: false })
  assert.ok(
    report.warnings.some((w) => w.includes('Übersicht') && w.includes('brew')),
    report.warnings.join('\n'),
  )
})

test('別人的 helm 佔住 wrapper 時，widget 改為直接呼叫 node', () => {
  const h = home({})
  const wrapper = join(h, '.local', 'bin', 'helm')
  mkdirSync(dirname(wrapper), { recursive: true })
  writeFileSync(wrapper, '#!/bin/sh\necho "Kubernetes Helm v3.16.2"\n')
  const ub = fakeUbersicht()
  installHook(resolvePaths({ home: h }), UB({ ubersicht: ub.deps }))
  const widget = readFileSync(
    join(h, 'Library', 'Application Support', 'Übersicht', 'widgets', 'helm.jsx'), 'utf8',
  )
  assert.ok(!widget.includes(wrapper), '不該指向別人的 helm')
  assert.ok(widget.includes('/repo/src/cli/main.ts'))
})

test('uninstall 刪得掉自己寫的 widget，但不碰別人的', () => {
  const h = home({})
  const ub = fakeUbersicht()
  const paths = resolvePaths({ home: h })
  const dir = join(h, 'Library', 'Application Support', 'Übersicht', 'widgets')
  installHook(paths, UB({ ubersicht: ub.deps }))
  assert.equal(existsSync(join(dir, 'helm.jsx')), true)

  const theirs = join(dir, 'weather.jsx')
  writeFileSync(theirs, 'export const command = "date"\n')
  uninstallHook(paths, UB({ ubersicht: ub.deps }))
  assert.equal(existsSync(join(dir, 'helm.jsx')), false)
  assert.equal(existsSync(theirs), true, '別人的 widget 不該被刪')
})

test('widget 已存在且不是 helm 寫的就不覆寫', () => {
  const h = home({})
  const dir = join(h, 'Library', 'Application Support', 'Übersicht', 'widgets')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'helm.jsx'), 'export const command = "my own thing"\n')
  const ub = fakeUbersicht()
  const report = installHook(resolvePaths({ home: h }), UB({ ubersicht: ub.deps }))
  assert.match(readFileSync(join(dir, 'helm.jsx'), 'utf8'), /my own thing/)
  assert.ok(report.warnings.some((w) => w.includes('helm.jsx')), report.warnings.join('\n'))
})
