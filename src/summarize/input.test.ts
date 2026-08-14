import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSummaryInput, renderSummaryPrompt } from './input.ts'
import type { SessionState } from '../types.ts'
import type { TranscriptDigest } from '../adapters/claude-code/transcript.ts'

const session: SessionState = {
  adapterId: 'claude-code', sessionId: 's1', cwd: '/Users/testuser/proj', pid: 1,
  procStart: null, startedAt: 0, updatedAt: 0, nativeStatus: null,
  kind: 'interactive', name: 'proj-01', transcriptPath: '/t/s1.jsonl', transcriptMtimeMs: null,
  lifecycle: 'crashed', lifecycleConfidence: 'high', live: null,
}

const digest: TranscriptDigest = {
  prompts: ['修好登入流程', '繼續跑最終 review'],
  touchedFiles: ['/p/auth.ts'],
  recentTools: [{ ts: 1, name: 'Bash', summary: 'npm test' }],
  lastTs: 1, gitBranch: 'feature/login',
}

const git = { diffStat: ' 1 file changed, 3 insertions(+)', statusShort: ' M auth.ts' }

test('組裝出完整的簡報輸入', () => {
  const input = buildSummaryInput(session, digest, git)
  assert.equal(input.sessionId, 's1')
  assert.equal(input.cwd, '/Users/testuser/proj')
  assert.equal(input.gitBranch, 'feature/login')
  assert.deepEqual(input.prompts, digest.prompts)
  assert.equal(input.gitDiffStat, git.diffStat)
})

test('renderSummaryPrompt 含全部七欄的欄位名稱', () => {
  const p = renderSummaryPrompt(buildSummaryInput(session, digest, git))
  for (const field of
    ['goal', 'done', 'currentStep', 'nextStep', 'blockers', 'files', 'prs']) {
    assert.ok(p.includes(field), `缺少欄位 ${field}`)
  }
})

test('renderSummaryPrompt 含使用者的原話與工具呼叫', () => {
  const p = renderSummaryPrompt(buildSummaryInput(session, digest, git))
  assert.ok(p.includes('繼續跑最終 review'))
  assert.ok(p.includes('npm test'))
  assert.ok(p.includes('feature/login'))
})

test('renderSummaryPrompt 要求只輸出 JSON', () => {
  const p = renderSummaryPrompt(buildSummaryInput(session, digest, git))
  assert.match(p, /JSON/)
})

test('沒有未 commit 變更時仍能組出提示', () => {
  const p = renderSummaryPrompt(
    buildSummaryInput(session, digest, { diffStat: '', statusShort: '' }))
  assert.ok(p.includes('（無）'))
})

test('buildSummaryInput 不修改輸入', () => {
  const d = structuredClone(digest)
  buildSummaryInput(session, digest, git)
  assert.deepEqual(digest, d)
})

test('提示詞要求 taskStatus，並說明三個值各是什麼意思', () => {
  const prompt = renderSummaryPrompt(buildSummaryInput(session, digest, git))
  assert.match(prompt, /taskStatus/)
  for (const value of ['done', 'in_progress', 'blocked']) {
    assert.match(prompt, new RegExp(value), value)
  }
})

test('提示詞允許沒有下一步，否則模型會為了填滿欄位編一個出來', () => {
  // 原本那句是「回來後應該做的下一件事（具體到可以直接動手）」，整份提示詞
  // 的前提都是這個 session 被中斷了。不鬆開的話 taskStatus 永遠不會是 done。
  const prompt = renderSummaryPrompt(buildSummaryInput(session, digest, git))
  assert.match(prompt, /做完了.*留空|留空.*做完了|沒有下一步/)
})
