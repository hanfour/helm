import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePaths } from '../paths.ts'
import { installHook, uninstallHook } from './install.ts'
import { hasHelmHook } from './settings.ts'

const DEPS = { now: () => 1786000000000, repoRoot: '/repo' }

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
  assert.match(readFileSync(wrapper, 'utf8'), /exec node "\/repo\/src\/cli\/main\.ts" "\$@"/)
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
  const plugin = join(h, 'Library', 'Application Support', 'SwiftBar', 'helm.5s.sh')
  assert.match(readFileSync(plugin, 'utf8'), /helm" menu/)
  assert.ok((statSync(plugin).mode & 0o111) !== 0)
})

test('SwiftBar plugin 走 wrapper 的絕對路徑 —— 它的 PATH 很精簡', () => {
  const h = home({})
  installHook(resolvePaths({ home: h }), { ...DEPS, swiftbarInstalled: true })
  const plugin = join(h, 'Library', 'Application Support', 'SwiftBar', 'helm.5s.sh')
  assert.ok(readFileSync(plugin, 'utf8').includes(join(h, '.local', 'bin', 'helm')))
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
  assert.equal(
    existsSync(join(h, 'Library', 'Application Support', 'SwiftBar', 'helm.5s.sh')),
    false,
  )
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

test('重複安裝只留一份 hook，且只備份實際存在過的檔案', () => {
  const h = home({ theme: 'dark' })
  const paths = resolvePaths({ home: h })
  installHook(paths, DEPS)
  installHook(paths, { ...DEPS, now: () => 1786000001000 })
  const settings = readSettings(h) as { hooks: { PreToolUse: unknown[] } }
  assert.equal(settings.hooks.PreToolUse.length, 1)
  assert.equal(readdirSync(join(h, '.helm', 'backups')).length, 2)
})

test('安裝是原子的 —— 不留半份 settings.json 也不留暫存檔', () => {
  const h = home({ theme: 'dark' })
  installHook(resolvePaths({ home: h }), DEPS)
  const leftovers = readdirSync(join(h, '.claude')).filter((n) => n.includes('.tmp'))
  assert.deepEqual(leftovers, [])
})
