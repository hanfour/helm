import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInstall, runUninstall } from './install.ts'
import { captureSync, scaffoldHome, SCRATCH } from './test-helpers.ts'

after(SCRATCH.cleanup)

const settingsOf = (home: string): unknown =>
  JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))

test('安裝成功回 0 並逐項印出做了什麼', () => {
  const r = captureSync(scaffoldHome([]), () => runInstall([]))
  assert.equal(r.code, 0)
  assert.match(r.out, /已把 hook 加進/)
  assert.match(r.out, /已建立/)
})

test('settings.json 壞掉時回 1，且不動使用者的檔案', () => {
  const home = scaffoldHome([])
  writeFileSync(join(home, '.claude', 'settings.json'), '{壞掉')
  const r = captureSync(home, () => runInstall([]))
  assert.equal(r.code, 1)
  assert.match(r.err, /無法解析/)
  assert.equal(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'), '{壞掉')
})

test('解除安裝後 settings.json 與安裝前逐字相同', () => {
  const home = scaffoldHome([])
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(ls)'] } }, null, 2),
  )
  const before = settingsOf(home)
  captureSync(home, () => runInstall([]))
  captureSync(home, () => runUninstall([]))
  assert.deepEqual(settingsOf(home), before)
})

test('輸出告訴使用者怎麼收回 —— 30 秒內要能完全脫身', () => {
  const r = captureSync(scaffoldHome([]), () => runInstall([]))
  assert.match(r.out, /HELM_OFF=1/)
  assert.match(r.out, /helm uninstall/)
})

test('提醒 hook 要下一個 session 才生效，不讓使用者以為壞掉了', () => {
  const r = captureSync(scaffoldHome([]), () => runInstall([]))
  assert.match(r.err, /下一個 Claude Code session/)
})

test('解除安裝明講 live 檔與快取沒有被刪掉', () => {
  const home = scaffoldHome([])
  captureSync(home, () => runInstall([]))
  const r = captureSync(home, () => runUninstall([]))
  assert.equal(r.code, 0)
  assert.match(r.err, /保留未動/)
})

test('沒裝過就解除安裝回 1 並說明沒事可做', () => {
  const r = captureSync(scaffoldHome([]), () => runUninstall([]))
  assert.equal(r.code, 1)
  assert.match(r.err, /沒有做任何事/)
})
