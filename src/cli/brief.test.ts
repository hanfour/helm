import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBrief } from './brief.ts'

/**
 * Captures what the command writes and restores the stream afterwards, so one
 * failing assertion cannot leave the rest of the suite writing into a buffer.
 */
async function capture(
  fn: () => Promise<number>,
): Promise<{ code: number; err: string; out: string }> {
  const realErr = process.stderr.write.bind(process.stderr)
  const realOut = process.stdout.write.bind(process.stdout)
  const errs: string[] = []
  const outs: string[] = []
  process.stderr.write = ((c: string) => (errs.push(String(c)), true)) as typeof process.stderr.write
  process.stdout.write = ((c: string) => (outs.push(String(c)), true)) as typeof process.stdout.write
  try {
    return { code: await fn(), err: errs.join(''), out: outs.join('') }
  } finally {
    process.stderr.write = realErr
    process.stdout.write = realOut
  }
}

/** An empty home means no projects at all, which is what these paths need. */
function emptyHome(): string {
  return mkdtempSync(join(tmpdir(), 'helm-brief-'))
}

async function withFakeHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env['HELM_FAKE_HOME']
  process.env['HELM_FAKE_HOME'] = home
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env['HELM_FAKE_HOME']
    else process.env['HELM_FAKE_HOME'] = previous
  }
}

test('沒給目標時印出用法並回傳 2', async () => {
  const { code, err } = await capture(() => runBrief([]))
  assert.equal(code, 2)
  assert.match(err, /用法/)
})

test('用法訊息說明可以給專案名，不只是 session id', async () => {
  const { err } = await capture(() => runBrief([]))
  assert.match(err, /專案/)
})

test('只給旗標而沒給目標，仍視為沒給目標', async () => {
  const { code } = await capture(() => runBrief(['--refresh']))
  assert.equal(code, 2)
})

test('找不到目標時回傳 1 並指引使用者', async () => {
  const home = emptyHome()
  const { code, err } = await withFakeHome(home, () => capture(() => runBrief(['nope'])))
  assert.equal(code, 1)
  assert.match(err, /找不到/)
  assert.match(err, /helm status/)
})

test('找不到目標時不會呼叫 LLM —— 那是要花錢的', async () => {
  const home = emptyHome()
  let called = false
  await withFakeHome(home, () => capture(() => runBrief(['nope'], async () => {
    called = true
    return ''
  })))
  assert.equal(called, false)
})

/**
 * Fixtures for the happy path cannot live in the OS temp dir: include.ts
 * excludes /tmp and /var/folders as noise, so the project would never be
 * listed. Namespaced by pid so concurrent test processes cannot delete each
 * other's fixtures.
 */
const SCRATCH_ROOT = fileURLToPath(
  new URL(`../../.test-scratch/${process.pid}-brief/`, import.meta.url),
)
mkdirSync(SCRATCH_ROOT, { recursive: true })
after(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true })
})

const SESSION_ID = 'aaaa1111-0000-0000-0000-000000000000'

/** A home holding one git project with one transcript-only session. */
function homeWithProject(): string {
  const home = mkdtempSync(join(SCRATCH_ROOT, 'home-'))
  const cwd = join(home, 'proj')
  mkdirSync(join(cwd, '.git'), { recursive: true })
  const dir = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${SESSION_ID}.jsonl`),
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: '把匯出功能修好' } })}\n`,
  )
  return home
}

const FAKE_BRIEF = JSON.stringify({
  goal: '修好匯出功能', done: ['讀完程式'], currentStep: '改 exporter',
  nextStep: '補測試', blockers: [], files: ['src/export.ts'], prs: [],
})

test('給專案名就能產生簡報 —— 使用者不必先猜對 session id', async () => {
  const home = homeWithProject()
  const r = await withFakeHome(home, () =>
    capture(() => runBrief(['proj'], async () => FAKE_BRIEF)))
  assert.equal(r.code, 0)
  assert.match(r.out, /修好匯出功能/)
  assert.match(r.out, /補測試/)
  assert.match(r.out, new RegExp(SESSION_ID))
})

test('產生前先告知要花時間，不讓使用者對著不動的畫面猜', async () => {
  const home = homeWithProject()
  const r = await withFakeHome(home, () =>
    capture(() => runBrief(['proj'], async () => FAKE_BRIEF)))
  assert.match(r.err, /正在產生/)
})

test('第二次呼叫命中快取，不再花錢呼叫 LLM', async () => {
  const home = homeWithProject()
  let calls = 0
  const run = async () => {
    calls += 1
    return FAKE_BRIEF
  }
  await withFakeHome(home, () => capture(() => runBrief(['proj'], run)))
  await withFakeHome(home, () => capture(() => runBrief(['proj'], run)))
  assert.equal(calls, 1)
})

test('--refresh 強制重新產生，即使快取是新的', async () => {
  const home = homeWithProject()
  let calls = 0
  const run = async () => {
    calls += 1
    return FAKE_BRIEF
  }
  await withFakeHome(home, () => capture(() => runBrief(['proj'], run)))
  await withFakeHome(home, () => capture(() => runBrief(['proj', '--refresh'], run)))
  assert.equal(calls, 2)
})

test('LLM 回不出可解析的內容時退回原始提問清單，並以非零結束', async () => {
  const home = homeWithProject()
  const r = await withFakeHome(home, () =>
    capture(() => runBrief(['proj'], async () => '我不知道')))
  assert.equal(r.code, 1)
  assert.match(r.out, /把匯出功能修好/)
})
