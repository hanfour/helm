import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runDoctor } from './doctor.ts'
import { runInstall } from './install.ts'
import { captureSync, scaffoldHome, SCRATCH } from './test-helpers.ts'

after(SCRATCH.cleanup)

test('沒安裝過時回 1 並指出缺什麼', () => {
  const r = captureSync(scaffoldHome([]), () => runDoctor([]))
  assert.equal(r.code, 1)
  assert.match(r.out, /helm install/)
})

test('每一項都帶勾或叉，沒有含糊的行', () => {
  const r = captureSync(scaffoldHome([]), () => runDoctor([]))
  const rows = r.out.split('\n').filter((l) => l.includes('：'))
  assert.ok(rows.length >= 6)
  assert.ok(rows.every((l) => l.startsWith('✓') || l.startsWith('✗')))
})

test('裝好之後 hook 與 live 目錄兩項轉為通過', () => {
  const home = scaffoldHome([])
  captureSync(home, () => runInstall([]))
  const out = captureSync(home, () => runDoctor([])).out
  assert.match(out, /✓ PreToolUse hook/)
  assert.match(out, /✓ live 目錄/)
})

test('hook 錯誤紀錄有內容時把它印出來 —— 那是靜默豁免的唯一補償', () => {
  const home = scaffoldHome([])
  mkdirSync(join(home, '.helm'), { recursive: true })
  writeFileSync(join(home, '.helm', 'hook-errors.log'), 'sh: 有夠慘\n')
  const r = captureSync(home, () => runDoctor([]))
  assert.equal(r.code, 1)
  assert.match(r.out, /有夠慘/)
})

test('偏好檔毀損時回報，並說明原檔沒被丟掉', () => {
  const home = scaffoldHome([])
  mkdirSync(join(home, '.helm'), { recursive: true })
  writeFileSync(join(home, '.helm', 'projects.json'), '{壞掉')
  const r = captureSync(home, () => runDoctor([]))
  assert.match(r.out, /✗ 偏好檔/)
  assert.match(r.out, /corrupt/)
})

test('順手清掉已結束 session 的 live 檔，並回報清了幾個', () => {
  const home = scaffoldHome([{ project: 'proj', sessions: [{ id: 'aaaa1111-0000-1111-2222-333344445555' }] }])
  captureSync(home, () => runInstall([]))
  const id = 'aaaa1111-0000-1111-2222-333344445555'
  const stale = join(home, '.helm', 'live', `${id}.json`)
  writeFileSync(stale, JSON.stringify({ sessionId: id, ts: 0, toolName: 'Bash', summary: 'x' }))
  // 必須比 transcript 舊。marker 比 transcript 新代表「最後一個工具呼叫沒能
  // 寫回結果」，那是當機的形狀（規格 §6），當機的證據不該被清掉。
  const old = (Date.now() - 3600_000) / 1000
  utimesSync(stale, old, old)
  const r = captureSync(home, () => runDoctor([]))
  assert.match(r.out, /順手清掉 1 個/)
  assert.equal(existsSync(stale), false)
})

test('doctor 不會把認不得的新 live 檔清掉', () => {
  const home = scaffoldHome([])
  captureSync(home, () => runInstall([]))
  const evidence = join(home, '.helm', 'live', 'ffff9999-0000-1111-2222-333344445555.json')
  writeFileSync(evidence, '{}')
  captureSync(home, () => runDoctor([]))
  assert.equal(existsSync(evidence), true, '那可能是唯一一份當機證據')
})

test('看板不可信時不清理 —— 刪掉的可能正是那個壞掉的檔案所描述的 session', () => {
  const home = scaffoldHome([{ project: 'proj', sessions: [{ id: 'aaaa1111-0000-1111-2222-333344445555' }] }])
  captureSync(home, () => runInstall([]))
  writeFileSync(join(home, '.claude', 'sessions', 'broken.json'), '{壞掉')
  const id = 'aaaa1111-0000-1111-2222-333344445555'
  const stale = join(home, '.helm', 'live', `${id}.json`)
  writeFileSync(stale, JSON.stringify({ sessionId: id, ts: 0, toolName: 'Bash', summary: 'x' }))
  const old = (Date.now() - 3600_000) / 1000
  utimesSync(stale, old, old)
  const r = captureSync(home, () => runDoctor([]))
  assert.match(r.out, /✗ 註冊表解析/)
  assert.ok(!r.out.includes('順手清掉'), '看板不可信時不該動任何 live 檔')
  assert.equal(existsSync(stale), true)
  assert.match(r.out, /先處理上面的問題/)
})
