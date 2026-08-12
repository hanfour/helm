import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { runStatus } from './status.ts'
import { captureSync, scaffoldHome, SCRATCH } from './test-helpers.ts'

after(SCRATCH.cleanup)

const ID = 'aaaa1111-0000-1111-2222-333344445555'

const home = () => scaffoldHome([{ project: 'proj', sessions: [{ id: ID }] }])

test('helm status 印出看板並回傳 0', () => {
  const r = captureSync(home(), () => runStatus(['--no-color']))
  assert.equal(r.code, 0)
  assert.match(r.out, /proj/)
  assert.match(r.out, /1 個 session/)
})

test('--json 輸出可解析，且帶著看板的完整結構', () => {
  const r = captureSync(home(), () => runStatus(['--json']))
  assert.equal(r.code, 0)
  const board = JSON.parse(r.out) as {
    projects: { name: string; sessions: unknown[] }[]
    invalid: number
    prefsHealth: string
  }
  assert.equal(board.projects[0]?.name, 'proj')
  assert.equal(board.projects[0]?.sessions.length, 1)
  assert.equal(board.invalid, 0)
  assert.equal(board.prefsHealth, 'ok')
})

test('--json 的輸出裡沒有 ANSI —— 它是給其他工具吃的', () => {
  const r = captureSync(home(), () => runStatus(['--json']))
  assert.ok(!r.out.includes(String.fromCharCode(27)))
})

test('--no-color 時不含 ANSI', () => {
  const r = captureSync(home(), () => runStatus(['--no-color']))
  assert.ok(!r.out.includes(String.fromCharCode(27)))
})

test('沒有專案時印出提示而不是空白', () => {
  const r = captureSync(scaffoldHome([]), () => runStatus(['--no-color']))
  assert.equal(r.code, 0)
  assert.match(r.out, /沒有找到/)
})

test('NO_COLOR 環境變數也會關掉顏色', () => {
  const previous = process.env['NO_COLOR']
  process.env['NO_COLOR'] = '1'
  try {
    const r = captureSync(home(), () => runStatus([]))
    assert.ok(!r.out.includes(String.fromCharCode(27)))
  } finally {
    if (previous === undefined) delete process.env['NO_COLOR']
    else process.env['NO_COLOR'] = previous
  }
})
