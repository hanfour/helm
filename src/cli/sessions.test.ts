import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { runSessions } from './sessions.ts'
import { captureSync, scaffoldHome, SCRATCH } from './test-helpers.ts'

after(SCRATCH.cleanup)

const scaffold = (project: string, ids: readonly string[]): string =>
  scaffoldHome([{ project, sessions: ids.map((id) => ({ id })) }])

const run = (home: string | null, argv: readonly string[]) =>
  captureSync(home ?? scaffoldHome([]), () => runSessions(argv))

test('沒給專案時印出用法並回傳 2', () => {
  const r = run(null, [])
  assert.equal(r.code, 2)
  assert.match(r.err, /用法/)
})

test('只給旗標而沒給專案，仍視為沒給', () => {
  assert.equal(run(null, ['--no-color']).code, 2)
})

test('展開專案底下的 session', () => {
  const home = scaffold('proj', ['aaaa1111-0000-0000-0000-000000000000'])
  const r = run(home, ['proj', '--no-color'])
  assert.equal(r.code, 0)
  assert.match(r.out, /proj/)
  assert.match(r.out, /aaaa1111/)
})

test('列出的是註冊表以外、只靠 transcript 找到的 session', () => {
  // 這個 fixture 完全沒有 ~/.claude/sessions 檔案 —— 重開機後的實況。
  const home = scaffold('proj', [
    'aaaa1111-0000-0000-0000-000000000000',
    'bbbb2222-0000-0000-0000-000000000000',
  ])
  const r = run(home, ['proj', '--no-color'])
  assert.match(r.out, /aaaa1111/)
  assert.match(r.out, /bbbb2222/)
  assert.match(r.out, /2 個 session/)
})

test('用 session id 前綴指定時，展開的是它所屬的專案', () => {
  const home = scaffold('proj', ['aaaa1111-0000-0000-0000-000000000000'])
  const r = run(home, ['aaaa1111', '--no-color'])
  assert.equal(r.code, 0)
  assert.match(r.out, /proj/)
})

test('找不到專案時回傳 1 並說明', () => {
  const home = scaffold('proj', ['aaaa1111-0000-0000-0000-000000000000'])
  const r = run(home, ['nope', '--no-color'])
  assert.equal(r.code, 1)
  assert.match(r.err, /找不到/)
  assert.equal(r.out, '')
})

test('--no-color 時輸出不含 ANSI', () => {
  const home = scaffold('proj', ['aaaa1111-0000-0000-0000-000000000000'])
  assert.ok(!run(home, ['proj', '--no-color']).out.includes(String.fromCharCode(27)))
})
