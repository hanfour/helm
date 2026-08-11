import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { runBrief } from './brief.ts'
import { captureAsync, scaffoldHome, SCRATCH } from './test-helpers.ts'

after(SCRATCH.cleanup)

const SESSION_ID = 'aaaa1111-0000-1111-2222-333344445555'

const emptyHome = () => scaffoldHome([])

const homeWithProject = () =>
  scaffoldHome([{ project: 'proj', sessions: [{ id: SESSION_ID, content: '把匯出功能修好' }] }])

const FAKE_BRIEF = JSON.stringify({
  goal: '修好匯出功能', done: ['讀完程式'], currentStep: '改 exporter',
  nextStep: '補測試', blockers: [], files: ['src/export.ts'], prs: [],
})

test('沒給目標時印出用法並回傳 2', async () => {
  const { code, err } = await captureAsync(emptyHome(), () => runBrief([]))
  assert.equal(code, 2)
  assert.match(err, /用法/)
})

test('用法訊息說明可以給專案名，不只是 session id', async () => {
  const { err } = await captureAsync(emptyHome(), () => runBrief([]))
  assert.match(err, /專案/)
})

test('只給旗標而沒給目標，仍視為沒給目標', async () => {
  const { code } = await captureAsync(emptyHome(), () => runBrief(['--refresh']))
  assert.equal(code, 2)
})

test('找不到目標時回傳 1 並指引使用者', async () => {
  const { code, err } = await captureAsync(emptyHome(), () => runBrief(['nope']))
  assert.equal(code, 1)
  assert.match(err, /找不到/)
  assert.match(err, /helm status/)
})

test('找不到目標時不會呼叫 LLM —— 那是要花錢的', async () => {
  let called = false
  await captureAsync(emptyHome(), () => runBrief(['nope'], async () => {
    called = true
    return ''
  }))
  assert.equal(called, false)
})

test('給專案名就能產生簡報 —— 使用者不必先猜對 session id', async () => {
  const r = await captureAsync(homeWithProject(), () => runBrief(['proj'], async () => FAKE_BRIEF))
  assert.equal(r.code, 0)
  assert.match(r.out, /修好匯出功能/)
  assert.match(r.out, /補測試/)
  assert.match(r.out, new RegExp(SESSION_ID))
})

test('產生前先告知要花時間，不讓使用者對著不動的畫面猜', async () => {
  const r = await captureAsync(homeWithProject(), () => runBrief(['proj'], async () => FAKE_BRIEF))
  assert.match(r.err, /正在產生/)
})

test('第二次呼叫命中快取，不再花錢呼叫 LLM', async () => {
  const home = homeWithProject()
  let calls = 0
  const run = async () => {
    calls += 1
    return FAKE_BRIEF
  }
  await captureAsync(home, () => runBrief(['proj'], run))
  await captureAsync(home, () => runBrief(['proj'], run))
  assert.equal(calls, 1)
})

test('--refresh 強制重新產生，即使快取是新的', async () => {
  const home = homeWithProject()
  let calls = 0
  const run = async () => {
    calls += 1
    return FAKE_BRIEF
  }
  await captureAsync(home, () => runBrief(['proj'], run))
  await captureAsync(home, () => runBrief(['proj', '--refresh'], run))
  assert.equal(calls, 2)
})

test('LLM 回不出可解析的內容時退回原始提問清單，並以非零結束', async () => {
  const r = await captureAsync(homeWithProject(), () => runBrief(['proj'], async () => '我不知道'))
  assert.equal(r.code, 1)
  assert.match(r.out, /把匯出功能修好/)
})
