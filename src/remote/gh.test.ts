import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchMyPrs, prDetail, type GhExec } from './gh.ts'

/** Fails the way the real `gh` does. Exit codes verified 2026-08-12, gh 2.76.2. */
const failing = (over: { code?: string; status?: number; stderr?: string }): GhExec =>
  () => {
    throw Object.assign(new Error('gh failed'), {
      status: over.status ?? 1,
      code: over.code,
      stderr: over.stderr ?? '',
    })
  }

const ok = (payload: unknown): GhExec => () => JSON.stringify(payload)

test('取得跨 repo 的 PR 清單', () => {
  const r = searchMyPrs(ok([{
    number: 4853,
    title: 'feat: 帳務管理',
    url: 'https://github.com/acme/erp/pull/4853',
    isDraft: false,
    updatedAt: '2026-04-14T02:13:36Z',
    repository: { nameWithOwner: 'acme/erp' },
  }]))
  assert.equal(r.kind, 'ok')
  assert.deepEqual(r.kind === 'ok' ? r.prs.map((p) => p.repo) : [], ['acme/erp'])
  assert.equal(r.kind === 'ok' ? r.prs[0]?.number : 0, 4853)
})

test('gh 沒安裝時說怎麼裝，而不是回空清單', () => {
  // 四種降級各自一句帶下一步的話（規格 §10）。空陣列會讓使用者以為
  // 自己沒有任何 PR。
  const r = searchMyPrs(failing({ code: 'ENOENT' }))
  assert.equal(r.kind, 'degraded')
  assert.match(r.kind === 'degraded' ? r.reason : '', /brew install gh|安裝/)
})

test('未登入時說去 gh auth login —— exit 4 是它的專用碼', () => {
  const r = searchMyPrs(failing({ status: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' }))
  assert.equal(r.kind, 'degraded')
  assert.match(r.kind === 'degraded' ? r.reason : '', /gh auth login/)
})

test('憑證失效時跟「沒登入」分開講 —— 要做的事不一樣', () => {
  const r = searchMyPrs(failing({ status: 1, stderr: 'HTTP 401: Bad credentials (https://api.github.com/…)' }))
  assert.equal(r.kind, 'degraded')
  assert.match(r.kind === 'degraded' ? r.reason : '', /憑證|401/)
})

test('rate limit 說什麼時候會恢復', () => {
  const r = searchMyPrs(failing({ status: 1, stderr: 'HTTP 403: API rate limit exceeded for user ID 123.' }))
  assert.equal(r.kind, 'degraded')
  assert.match(r.kind === 'degraded' ? r.reason : '', /額度|rate limit/i)
})

test('認不得的失敗照原樣說出來，不吞掉', () => {
  const r = searchMyPrs(failing({ status: 1, stderr: 'something nobody predicted' }))
  assert.equal(r.kind, 'degraded')
  assert.match(r.kind === 'degraded' ? r.reason : '', /something nobody predicted/)
})

test('輸出不是 JSON 時降級，不讓看板崩掉', () => {
  const r = searchMyPrs(() => 'not json at all')
  assert.equal(r.kind, 'degraded')
})

test('輸出是 JSON 但不是陣列時降級', () => {
  for (const payload of [{}, 'x', 42, null]) {
    assert.equal(searchMyPrs(ok(payload)).kind, 'degraded', JSON.stringify(payload))
  }
})

test('缺欄位的項目略過，不讓整批失敗', () => {
  const r = searchMyPrs(ok([
    { number: 1, repository: { nameWithOwner: 'a/b' }, title: 't', url: 'u', isDraft: false, updatedAt: '2026-01-01T00:00:00Z' },
    { number: 'not a number', repository: { nameWithOwner: 'a/b' } },
    { number: 2 },
  ]))
  assert.equal(r.kind === 'ok' ? r.prs.length : -1, 1)
})

test('取得單一 PR 的審查與 CI 狀態', () => {
  const r = prDetail('acme/erp', 4853, ok({
    reviewDecision: 'APPROVED',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
  }))
  assert.equal(r.kind, 'ok')
  assert.equal(r.kind === 'ok' ? r.detail.reviewDecision : '', 'APPROVED')
  assert.equal(r.kind === 'ok' ? r.detail.checks.length : -1, 1)
})

test('沒有 CI 的 repo 回空陣列，不是 null', () => {
  const r = prDetail('a/b', 1, ok({ reviewDecision: null, statusCheckRollup: null }))
  assert.deepEqual(r.kind === 'ok' ? r.detail.checks : null, [])
})

test('單一 PR 失敗時只影響那一個 —— 其餘照常', () => {
  const r = prDetail('a/b', 1, failing({ status: 1, stderr: 'not found' }))
  assert.equal(r.kind, 'degraded')
})
