import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unknownWaiting, waitingOn, type PrStatus } from './waiting.ts'

const pr = (over: Partial<PrStatus> = {}): PrStatus => ({
  isDraft: false,
  reviewDecision: 'REVIEW_REQUIRED',
  checks: [],
  ...over,
})

const check = (conclusion: string | null, status = 'COMPLETED') => ({ status, conclusion })

test('要求修改時是「等你改」', () => {
  assert.equal(waitingOn(pr({ reviewDecision: 'CHANGES_REQUESTED' })).kind, 'changes')
})

test('還沒有人審時是「等人審」', () => {
  assert.equal(waitingOn(pr({ reviewDecision: 'REVIEW_REQUIRED' })).kind, 'review')
  assert.equal(waitingOn(pr({ reviewDecision: null })).kind, 'review')
})

test('通過審查且沒有 CI 時是「可合併」', () => {
  // 沒有設 CI 的 repo，statusCheckRollup 是空陣列。把它當成「等 CI」
  // 會讓那些 PR 永遠卡在一個不存在的東西上。
  assert.equal(waitingOn(pr({ reviewDecision: 'APPROVED', checks: [] })).kind, 'mergeable')
})

test('通過審查且 CI 全過時是「可合併」', () => {
  const checks = [check('SUCCESS'), check('SKIPPED'), check('NEUTRAL')]
  assert.equal(waitingOn(pr({ reviewDecision: 'APPROVED', checks })).kind, 'mergeable')
})

test('CI 失敗時是「等 CI」，蓋過審查狀態', () => {
  // 審過了但 CI 紅的，該做的事是修 CI，不是等合併。
  const checks = [check('SUCCESS'), check('FAILURE')]
  assert.equal(waitingOn(pr({ reviewDecision: 'APPROVED', checks })).kind, 'ci')
})

test('CI 還在跑時是「等 CI」', () => {
  for (const s of ['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING']) {
    assert.equal(waitingOn(pr({ reviewDecision: 'APPROVED', checks: [check(null, s)] })).kind, 'ci', s)
  }
})

test('SKIPPED 與 NEUTRAL 不算失敗', () => {
  // GitHub Actions 的條件式 job 大量產生 SKIPPED。把它當失敗的話
  // 幾乎每個 PR 都會顯示成「等 CI」。
  const checks = [check('SKIPPED'), check('NEUTRAL'), check('SUCCESS')]
  assert.equal(waitingOn(pr({ reviewDecision: 'APPROVED', checks })).kind, 'mergeable')
})

test('CANCELLED 與 TIMED_OUT 算失敗 —— 那是需要人去看的狀態', () => {
  for (const c of ['CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']) {
    assert.equal(waitingOn(pr({ reviewDecision: 'APPROVED', checks: [check(c)] })).kind, 'ci', c)
  }
})

test('CI 失敗蓋過「等你改」—— 兩件事都要做時先講會擋住合併的那個', () => {
  const checks = [check('FAILURE')]
  assert.equal(waitingOn(pr({ reviewDecision: 'CHANGES_REQUESTED', checks })).kind, 'ci')
})

test('草稿蓋過一切 —— 它不在等任何人', () => {
  const checks = [check('FAILURE')]
  for (const d of ['CHANGES_REQUESTED', 'APPROVED', null] as const) {
    assert.equal(waitingOn(pr({ isDraft: true, reviewDecision: d, checks })).kind, 'draft', String(d))
  }
})

test('每一種狀態對到它自己的那句話 —— 對調要抓得到', () => {
  // 原本只有 assert.ok(label.length > 0)：五個 label 全改成 'x' 照樣過，
  // 「等你改」與「等人審」對調也照樣過。使用者會看到「等人審」，
  // 而實際上是 reviewer 要他改。
  assert.equal(waitingOn(pr({ isDraft: true })).label, '草稿')
  assert.equal(waitingOn(pr({ reviewDecision: 'CHANGES_REQUESTED' })).label, '等你改')
  assert.equal(waitingOn(pr({ reviewDecision: 'REVIEW_REQUIRED' })).label, '等人審')
  assert.equal(waitingOn(pr({ reviewDecision: 'APPROVED', checks: [check('FAILURE')] })).label, '等 CI')
  assert.equal(waitingOn(pr({ reviewDecision: 'APPROVED' })).label, '可合併')
})

test('已完成但沒有結論的 check 不算失敗', () => {
  // 原本那條看似在測 null conclusion，但它同時把 status 設成 IN_PROGRESS，
  // 先被上一行擋掉了 —— 又一次 fixture 讓測試走不到它要驗的那一行。
  const checks = [check(null, 'COMPLETED')]
  assert.equal(waitingOn(pr({ reviewDecision: 'APPROVED', checks })).kind, 'mergeable')
})

test('BAD_CONCLUSIONS 的每一個值都要被當成失敗', () => {
  for (const c of ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']) {
    assert.equal(waitingOn(pr({ reviewDecision: 'APPROVED', checks: [check(c)] })).kind, 'ci', c)
  }
})

test('狀態讀不到時是 unknown，不是任何一種判定', () => {
  assert.equal(unknownWaiting().kind, 'unknown')
  assert.match(unknownWaiting().label, /讀不到/)
})
