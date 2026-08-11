import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { briefMarkdownFor } from './brief-source.ts'
import { resolvePaths } from '../paths.ts'
import { digestOf, EMPTY_CACHE, readCache, setBrief, writeCache } from '../cache/store.ts'
import type { SessionState } from '../types.ts'

const SCRATCH = fileURLToPath(
  new URL(`../../.test-scratch/${process.pid}-briefsrc/`, import.meta.url),
)
mkdirSync(SCRATCH, { recursive: true })
after(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0)

const sess = (over: Partial<SessionState>): SessionState => ({
  adapterId: 'claude-code', sessionId: 'aaaa1111-0000-1111-2222-333344445555',
  cwd: '/nonexistent', pid: null, procStart: null, startedAt: 0, updatedAt: 0,
  nativeStatus: null, kind: 'interactive', name: '', transcriptPath: null, transcriptMtimeMs: null,
  lifecycle: 'ended_clean', lifecycleConfidence: 'high', live: null, ...over,
})

function transcript(lines: readonly string[]): string {
  const dir = mkdtempSync(join(SCRATCH, 'tx-'))
  const path = join(dir, 'sess.jsonl')
  writeFileSync(path, lines.map((l) => `${l}\n`).join(''))
  return path
}

const paths = () => resolvePaths({ home: mkdtempSync(join(SCRATCH, 'home-')) })

const req = (over: Partial<Parameters<typeof briefMarkdownFor>[3]> = {}) => ({
  refresh: false, notify: () => {}, now: () => NOW, ...over,
})

test('沒有 transcript 時不呼叫 LLM —— 空提示問了也只會得到空答案，還要付一分鐘', async () => {
  let called = false
  const out = await briefMarkdownFor(sess({}), paths(), async () => {
    called = true
    return '{}'
  }, req())
  assert.equal(called, false)
  assert.equal(out.ok, false)
})

test('沒有 transcript 時明講原因，不謊稱「產生失敗」', async () => {
  const out = await briefMarkdownFor(sess({}), paths(), async () => '{}', req())
  assert.match(out.markdown, /沒有|找不到/)
  assert.ok(!out.markdown.includes('產生失敗'), '什麼都沒發生，不該說失敗')
})

test('transcript 存在但空無一物時同樣不呼叫 LLM', async () => {
  let called = false
  const out = await briefMarkdownFor(
    sess({ transcriptPath: transcript([]) }),
    paths(),
    async () => {
      called = true
      return '{}'
    },
    req(),
  )
  assert.equal(called, false)
  assert.equal(out.ok, false)
})

test('有內容時照常呼叫 LLM 並渲染簡報', async () => {
  const path = transcript([
    JSON.stringify({ type: 'user', message: { role: 'user', content: '把匯出修好' } }),
  ])
  const out = await briefMarkdownFor(
    sess({ transcriptPath: path }),
    paths(),
    async () => JSON.stringify({
      goal: '修好匯出', done: [], currentStep: '', nextStep: '補測試',
      blockers: [], files: [], prs: [],
    }),
    req(),
  )
  assert.equal(out.ok, true)
  assert.match(out.markdown, /修好匯出/)
})

test('產生前告知使用者要花時間', async () => {
  const path = transcript([
    JSON.stringify({ type: 'user', message: { role: 'user', content: '做一件事' } }),
  ])
  const notices: string[] = []
  await briefMarkdownFor(sess({ transcriptPath: path }), paths(), async () => '{}', req({
    notify: (m: string) => notices.push(m),
  }))
  assert.match(notices.join(''), /正在產生/)
})

test('沒東西可做時不發出花費前告知 —— 那會嚇到使用者卻什麼也沒花', async () => {
  const notices: string[] = []
  await briefMarkdownFor(sess({}), paths(), async () => '{}', req({
    notify: (m: string) => notices.push(m),
  }))
  assert.equal(notices.join(''), '')
})

test('快取命中時不讀 transcript —— 分支取自快取，不是檔案', async () => {
  // 直接觀察行為而非計時：快取與 transcript 記的分支刻意不同，若實作偷讀
  // transcript，渲染出來的就會是 transcript 那個。
  const path = transcript([
    JSON.stringify({ type: 'user', gitBranch: 'transcript-branch',
                     message: { role: 'user', content: '做一件事' } }),
  ])
  const session = sess({ transcriptPath: path })
  const p = paths()
  mkdirSync(join(p.helmHome), { recursive: true })
  writeCache(p.cacheFile, setBrief(EMPTY_CACHE, session.sessionId, {
    digest: digestOf(path) as string,
    generatedAt: NOW,
    gitBranch: 'cached-branch',
    body: { goal: '快取的目標', done: [], currentStep: '', nextStep: '', blockers: [], files: [], prs: [] },
  }))

  let called = false
  const out = await briefMarkdownFor(session, p, async () => {
    called = true
    return '{}'
  }, req())
  assert.equal(called, false, '快取命中不該呼叫 LLM')
  assert.match(out.markdown, /cached-branch/)
  assert.ok(!out.markdown.includes('transcript-branch'))
})

test('快取命中時顯示的是當初產生的時間，不是現在', async () => {
  const path = transcript([
    JSON.stringify({ type: 'user', message: { role: 'user', content: '做一件事' } }),
  ])
  const session = sess({ transcriptPath: path })
  const p = paths()
  mkdirSync(join(p.helmHome), { recursive: true })
  const generatedAt = Date.UTC(2026, 0, 1, 0, 0, 0)
  writeCache(p.cacheFile, setBrief(EMPTY_CACHE, session.sessionId, {
    digest: digestOf(path) as string, generatedAt, gitBranch: null,
    body: { goal: 'x', done: [], currentStep: '', nextStep: '', blockers: [], files: [], prs: [] },
  }))
  const out = await briefMarkdownFor(session, p, async () => '{}', req())
  assert.match(out.markdown, /2026-01-01/)
})

test('產生成功後把分支一併存進快取', async () => {
  const path = transcript([
    JSON.stringify({ type: 'user', gitBranch: 'feat/x',
                     message: { role: 'user', content: '做一件事' } }),
  ])
  const session = sess({ transcriptPath: path })
  const p = paths()
  await briefMarkdownFor(session, p, async () => JSON.stringify({
    goal: 'g', done: [], currentStep: '', nextStep: '', blockers: [], files: [], prs: [],
  }), req())
  const entry = readCache(p.cacheFile).briefs[session.sessionId]
  assert.equal(entry?.gitBranch, 'feat/x')
})
