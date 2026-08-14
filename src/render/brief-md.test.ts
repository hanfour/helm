import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderBriefMarkdown, renderFallback } from './brief-md.ts'
import type { Brief } from '../cache/store.ts'

const BRIEF: Brief = {
  goal: '修好登入流程',
  done: ['寫了 token 測試', '修好 refresh 邏輯'],
  currentStep: '實作 token 驗證',
  nextStep: '跑 npm test 確認綠燈',
  blockers: ['等後端提供 JWKS 端點'],
  files: ['/p/auth.ts'],
  prs: ['#123'],
}

const META = {
  sessionId: 'abcdef12-3456', cwd: '/Users/testuser/proj',
  gitBranch: 'feature/login', generatedAt: Date.UTC(2026, 7, 11, 3, 0, 0),
}

test('七欄全部出現在輸出中', () => {
  const md = renderBriefMarkdown(BRIEF, META)
  for (const t of ['目標', '已完成', '進行到哪一步', '下一步', '卡點', '相關檔案', '相關 PR']) {
    assert.ok(md.includes(t), `缺少 ${t}`)
  }
})

test('內容值有被填進去', () => {
  const md = renderBriefMarkdown(BRIEF, META)
  assert.ok(md.includes('修好登入流程'))
  assert.ok(md.includes('跑 npm test 確認綠燈'))
  assert.ok(md.includes('等後端提供 JWKS 端點'))
  assert.ok(md.includes('feature/login'))
})

test('空的陣列欄位顯示「（無）」而非空白', () => {
  const md = renderBriefMarkdown({ ...BRIEF, blockers: [], prs: [] }, META)
  assert.ok(md.includes('（無）'))
})

test('降級輸出列出原始 prompt 並說明簡報產生失敗', () => {
  const md = renderFallback(['目前狀況？', '繼續跑最終 review'])
  assert.match(md, /簡報產生失敗/)
  assert.ok(md.includes('繼續跑最終 review'))
})

test('降級輸出在沒有 prompt 時仍給出可讀訊息', () => {
  assert.match(renderFallback([]), /沒有可用的/)
})

test('簡報標題區說出任務狀態', () => {
  const out = renderBriefMarkdown({ ...BRIEF, taskStatus: 'blocked' }, META)
  assert.match(out, /任務卡住/)
})

test('舊簡報沒有 taskStatus 時標題區不多一行空的', () => {
  const out = renderBriefMarkdown({ ...BRIEF, taskStatus: undefined }, META)
  assert.doesNotMatch(out, /任務狀態/)
})
