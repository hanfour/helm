import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTarget } from './resolve.ts'
import type { ProjectView } from './group.ts'
import type { SessionState } from '../types.ts'

const sess = (over: Partial<SessionState>): SessionState => ({
  adapterId: 'claude-code', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
  cwd: '/Users/u/proj', pid: null, procStart: null, startedAt: 0, updatedAt: 0,
  nativeStatus: null, kind: 'interactive', name: '', transcriptPath: null,
  lifecycle: 'ended_clean', lifecycleConfidence: 'high', live: null, ...over,
})

/** Distinct per project, so a session-id test can only match what it names. */
const idOf = (name: string) => `${name.replace(/[^a-z0-9]/g, '')}-1111-2222-3333-444444444444`

const proj = (name: string, over: Partial<ProjectView> = {}): ProjectView => ({
  path: `/Users/u/Acme/${name}`,
  name,
  pinned: false,
  lastActivityMs: 0,
  aggregateStatus: null,
  sessionCount: 1,
  sessions: [sess({ cwd: `/Users/u/Acme/${name}`, sessionId: idOf(name) })],
  ...over,
})

const DSP = proj('data-svc-2.0')
const CLONE = proj('data-svc-2.0-clone')
const REPORT = proj('report-tool')
const ALL = [DSP, CLONE, REPORT]

test('完全相符的專案名直接命中', () => {
  const r = resolveTarget(ALL, 'report-tool')
  assert.equal(r.kind, 'project')
  assert.equal(r.kind === 'project' ? r.project.name : '', 'report-tool')
})

test('部分相符也能命中', () => {
  const r = resolveTarget([REPORT], 'report')
  assert.equal(r.kind, 'project')
})

test('大小寫不敏感', () => {
  const r = resolveTarget([REPORT], 'REPORT-STUDIO')
  assert.equal(r.kind, 'project')
})

test('歧義時列出候選，不自動挑一個', () => {
  const r = resolveTarget(ALL, 'data-svc')
  assert.equal(r.kind, 'ambiguous')
  assert.deepEqual(
    r.kind === 'ambiguous' ? r.candidates.toSorted() : [],
    ['data-svc-2.0', 'data-svc-2.0-clone'],
  )
})

test('完全相符優先於部分相符 —— data-svc-2.0 不該被 clone 拖成歧義', () => {
  const r = resolveTarget(ALL, 'data-svc-2.0')
  assert.equal(r.kind, 'project')
  assert.equal(r.kind === 'project' ? r.project.name : '', 'data-svc-2.0')
})

test('同名不同路徑的專案，候選改列完整路徑才分得出來', () => {
  const a = proj('api', { path: '/Users/u/a/api' })
  const b = proj('api', { path: '/Users/u/b/api' })
  const r = resolveTarget([a, b], 'api')
  assert.equal(r.kind, 'ambiguous')
  assert.deepEqual(
    r.kind === 'ambiguous' ? r.candidates.toSorted() : [],
    ['/Users/u/a/api', '/Users/u/b/api'],
  )
})

test('專案名找不到時退而比對 session id 前綴', () => {
  const r = resolveTarget(ALL, 'reportstudio')
  assert.equal(r.kind, 'session')
  assert.equal(r.kind === 'session' ? r.session.sessionId : '', idOf('report-tool'))
})

test('完整的 session id 也能命中', () => {
  const r = resolveTarget(ALL, idOf('report-tool'))
  assert.equal(r.kind, 'session')
})

test('session id 前綴撞到多個時同樣列出候選', () => {
  const p = proj('x', {
    sessions: [sess({ sessionId: 'abc11111' }), sess({ sessionId: 'abc22222' })],
    sessionCount: 2,
  })
  const r = resolveTarget([p], 'abc')
  assert.equal(r.kind, 'ambiguous')
  assert.equal(r.kind === 'ambiguous' ? r.candidates.length : 0, 2)
})

test('專案名優先於 session id —— 專案名才是主要用法', () => {
  const p = proj('abc', { sessions: [sess({ sessionId: 'abcdef00' })] })
  const r = resolveTarget([p], 'abc')
  assert.equal(r.kind, 'project')
})

test('都對不上時回傳 notfound', () => {
  assert.equal(resolveTarget(ALL, 'nope').kind, 'notfound')
})

test('空字串不會亂比中東西', () => {
  assert.equal(resolveTarget(ALL, '').kind, 'notfound')
})

test('只有空白的查詢也視為沒給', () => {
  assert.equal(resolveTarget(ALL, '   ').kind, 'notfound')
})

test('查詢前後的空白會被忽略', () => {
  assert.equal(resolveTarget([REPORT], '  report-tool  ').kind, 'project')
})

test('resolveTarget 不修改輸入', () => {
  const input = [DSP, CLONE]
  const snapshot = structuredClone(input)
  resolveTarget(input, 'data-svc')
  assert.deepEqual(input, snapshot)
})
