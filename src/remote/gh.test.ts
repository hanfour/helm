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

test('StatusContext 型別的 CI 也讀得懂 —— 它的欄位是 state 不是 status/conclusion', () => {
  // Buildkite、CircleCI、Jenkins、Prow、CLA bot、Vercel 用的是 commit status
  // API 而不是 Checks API。實測 kubernetes/kubernetes#141331 的 13 個 check
  // 全部是 StatusContext，其中有 FAILURE 與 PENDING —— 而 helm 判定「等人審」。
  // 紅燈被當成綠燈。
  const r = prDetail('a/b', 1, ok({
    reviewDecision: 'APPROVED',
    statusCheckRollup: [
      { __typename: 'StatusContext', context: 'buildkite/rails', state: 'FAILURE' },
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
  }))
  assert.equal(r.kind, 'ok')
  const checks = r.kind === 'ok' ? r.detail.checks : []
  assert.equal(checks.length, 2)
  assert.equal(checks[0]?.conclusion, 'FAILURE', 'state 要被讀成 conclusion')
  assert.equal(checks[0]?.status, 'COMPLETED')
})

test('StatusContext 的 PENDING 是「還在跑」，不是「完成且無結論」', () => {
  const r = prDetail('a/b', 1, ok({
    reviewDecision: 'APPROVED',
    statusCheckRollup: [{ __typename: 'StatusContext', context: 'ci', state: 'PENDING' }],
  }))
  const check = r.kind === 'ok' ? r.detail.checks[0] : null
  assert.notEqual(check?.status, 'COMPLETED', 'PENDING 不該被當成已完成')
})

test('送給 gh 的指令列是對的 —— 抓誰的、幾筆、哪些欄位', () => {
  // 這三樣之前完全沒有測試看過：ok() 把 args 丟掉了。改成別人的 PR、
  // 只抓 5 筆、或少要一個欄位，三個檔案的測試都會照樣綠。
  let seen: readonly string[] = []
  searchMyPrs((args) => {
    seen = args
    return '[]'
  })
  assert.ok(seen.includes('--author') && seen.includes('@me'), seen.join(' '))
  assert.ok(seen.includes('--state') && seen.includes('open'), seen.join(' '))
  const json = seen[seen.indexOf('--json') + 1] ?? ''
  for (const field of ['number', 'repository', 'isDraft', 'url']) {
    assert.ok(json.includes(field), `${field} 沒有被要求：${json}`)
  }
})

test('prDetail 要的兩個欄位一個都不能少', () => {
  let seen: readonly string[] = []
  prDetail('a/b', 42, (args) => {
    seen = args
    return '{}'
  })
  assert.ok(seen.includes('--repo') && seen.includes('a/b'), seen.join(' '))
  assert.ok(seen.includes('42'), seen.join(' '))
  const json = seen[seen.indexOf('--json') + 1] ?? ''
  assert.ok(json.includes('reviewDecision'), json)
  assert.ok(json.includes('statusCheckRollup'), json)
})

test('降級訊息走的是專屬分支，不是 fallback 原樣回吐', () => {
  // 原本三條測試的 fixture 把關鍵字寫進 stderr，而 fallback 本來就會原樣
  // 回傳它 —— 所以那三條驗的是 fallback，不是它們宣稱的那個分支。
  // 這裡的 stderr 刻意不含任何關鍵字。
  const cases: [{ status?: number; code?: string; stderr?: string }, RegExp][] = [
    [{ status: 4, stderr: 'zzz' }, /gh auth login/],
    [{ status: 1, stderr: 'HTTP 401: zzz' }, /憑證/],
    [{ status: 1, stderr: 'HTTP 403: API rate limit exceeded zzz' }, /額度/],
    [{ code: 'ETIMEDOUT', stderr: '' }, /逾時/],
    [{ code: 'ENOENT' }, /brew install gh/],
  ]
  for (const [err, expected] of cases) {
    const r = searchMyPrs(failing(err))
    const reason = r.kind === 'degraded' ? r.reason : ''
    assert.match(reason, expected, JSON.stringify(err))
    assert.doesNotMatch(reason, /^gh 失敗了：/, `不該走 fallback：${reason}`)
  }
})

test('斷網有自己的一句話，不是把整串 API URL 印到選單列上', () => {
  // 筆電斷網是最常見的失敗，而它原本是唯一沒有專屬句子的一個 ——
  // 使用者會在選單列看到 `gh 失敗了：Get "https://api.github.com/search/issues?…`
  const r = searchMyPrs(failing({
    status: 1,
    stderr: 'Get "https://api.github.com/search/issues?q=x": dial tcp: lookup api.github.com: no such host',
  }))
  const reason = r.kind === 'degraded' ? r.reason : ''
  assert.match(reason, /網路|連線/)
  assert.doesNotMatch(reason, /https:\/\//, '不該把 URL 印出來')
})
