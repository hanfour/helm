import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runPrefs, type PrefAction } from './prefs.ts'
import { collectStatus } from './status.ts'
import { resolvePaths } from '../paths.ts'
import { captureSync, readPrefsOf, scaffoldHome, SCRATCH } from './test-helpers.ts'

after(SCRATCH.cleanup)

const ID = (n: string) => `${n}-0000-1111-2222-333344445555`

const scaffold = (...projects: string[]) =>
  scaffoldHome(projects.map((project, i) => ({
    project,
    sessions: [{ id: ID(`aaaa111${i}`) }],
  })))

const run = (home: string, action: PrefAction, argv: string[]) =>
  captureSync(home, () => runPrefs(action, argv))

const board = (home: string) =>
  collectStatus(resolvePaths({ home }), Date.now(), () => ({
    alive: new Map(), unreachable: new Set<number>(),
  }))

test('pin 之後 projects.json 記下該專案', () => {
  const home = scaffold('proj')
  assert.equal(run(home, 'pin', ['proj']).code, 0)
  assert.equal(readPrefsOf(home).projects[join(home, 'proj')]?.pinned, true)
})

test('pin 之後看板上顯示釘選記號', () => {
  const home = scaffold('proj')
  run(home, 'pin', ['proj'])
  assert.equal(board(home).projects[0]?.pinned, true)
})

test('unpin 取消釘選', () => {
  const home = scaffold('proj')
  run(home, 'pin', ['proj'])
  assert.equal(run(home, 'unpin', ['proj']).code, 0)
  assert.equal(readPrefsOf(home).projects[join(home, 'proj')]?.pinned, false)
})

test('hide 之後該專案不再出現在 helm status', () => {
  const home = scaffold('proj')
  assert.equal(board(home).projects.length, 1)
  run(home, 'hide', ['proj'])
  assert.equal(board(home).projects.length, 0)
})

test('被 hide 的專案仍然 show 得回來 —— 不能把使用者鎖在外面', () => {
  // 被隱藏的專案不在 collectStatus 的結果裡，一般的解析器永遠找不到它。
  // 沒有這條路徑，使用者只能手改 JSON 才救得回自己隱藏掉的東西。
  const home = scaffold('proj')
  run(home, 'hide', ['proj'])
  assert.equal(run(home, 'show', ['proj']).code, 0)
  assert.equal(board(home).projects.length, 1)
})

test('show 一個對不上的名字時列出目前被隱藏的專案', () => {
  const home = scaffold('proj')
  run(home, 'hide', ['proj'])
  const r = run(home, 'show', ['nope'])
  assert.equal(r.code, 1)
  assert.match(r.err, /proj/)
})

test('沒有任何隱藏專案時 show 明講，而不是叫使用者去猜', () => {
  const r = run(scaffold('proj'), 'show', ['whatever'])
  assert.equal(r.code, 1)
  assert.match(r.err, /沒有被隱藏/)
})

test('沒給專案時印用法並回傳 2', () => {
  assert.equal(run(scaffold('proj'), 'pin', []).code, 2)
})

test('只給旗標而沒給專案，仍視為沒給', () => {
  assert.equal(run(scaffold('proj'), 'hide', ['--whatever']).code, 2)
})

test('歧義時列出候選，不自動挑', () => {
  const home = scaffold('proj-one', 'proj-two')
  const r = run(home, 'pin', ['proj'])
  assert.equal(r.code, 1)
  assert.match(r.err, /proj-one/)
  assert.match(r.err, /proj-two/)
  assert.equal(existsSync(join(home, '.helm', 'projects.json')), false,
    '沒挑定就不該寫任何東西，連檔案都不該建')
})

test('找不到專案時回傳 1 且不寫檔', () => {
  const home = scaffold('proj')
  const r = run(home, 'pin', ['nope'])
  assert.equal(r.code, 1)
  assert.match(r.err, /找不到/)
})

test('pin 不會動到同一個檔案裡其他專案的設定', () => {
  const home = scaffold('alpha', 'bravo')
  run(home, 'hide', ['bravo'])
  run(home, 'pin', ['alpha'])
  assert.equal(readPrefsOf(home).projects[join(home, 'bravo')]?.hidden, true)
  assert.equal(readPrefsOf(home).projects[join(home, 'alpha')]?.pinned, true)
})

test('成功時告訴使用者實際動到的是哪個路徑', () => {
  const home = scaffold('proj')
  const r = run(home, 'pin', ['proj'])
  assert.match(r.out, new RegExp(join(home, 'proj')))
})

test('偏好檔毀損時先警告再寫，不讓使用者以為設定一直都在', () => {
  const home = scaffold('proj')
  mkdirSync(join(home, '.helm'), { recursive: true })
  writeFileSync(join(home, '.helm', 'projects.json'), '{壞掉')
  const r = run(home, 'pin', ['proj'])
  assert.equal(r.code, 0)
  assert.match(r.err, /毀損|無法解析/)
  assert.equal(readPrefsOf(home).projects[join(home, 'proj')]?.pinned, true)
})

test('隱藏兩個名字有前綴關係的專案後，短的那個仍 show 得回來', () => {
  // proj 的每一個子字串都同時是 proj2 的子字串，連完整路徑也一樣 ——
  // 「打長一點」在數學上不可能照做。show 是 hide 唯一的回頭路。
  const home = scaffold('proj', 'proj2')
  run(home, 'hide', ['proj'])
  run(home, 'hide', ['proj2'])
  const r = run(home, 'show', ['proj'])
  assert.equal(r.code, 0, r.err)
  assert.equal(readPrefsOf(home).projects[join(home, 'proj')]?.hidden, false)
  assert.equal(readPrefsOf(home).projects[join(home, 'proj2')]?.hidden, true, '不該動到另一個')
})

test('用完整路徑也 show 得回來', () => {
  const home = scaffold('proj', 'proj2')
  run(home, 'hide', ['proj'])
  run(home, 'hide', ['proj2'])
  assert.equal(run(home, 'show', [join(home, 'proj')]).code, 0)
})

test('真正歧義時仍然列候選，不自動挑', () => {
  const home = scaffold('alpha-one', 'alpha-two')
  run(home, 'hide', ['alpha-one'])
  run(home, 'hide', ['alpha-two'])
  const r = run(home, 'show', ['alpha'])
  assert.equal(r.code, 1)
  assert.match(r.err, /alpha-one/)
  assert.match(r.err, /alpha-two/)
})
