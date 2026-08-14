import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBriefJson, generateBrief } from './brief.ts'
import type { SummaryInput } from './input.ts'

const INPUT: SummaryInput = {
  sessionId: 's1', cwd: '/p', gitBranch: 'main',
  prompts: ['修好登入'], touchedFiles: [], recentTools: [],
  gitDiffStat: '', gitStatusShort: '',
}

const VALID = JSON.stringify({
  goal: '修好登入流程', done: ['寫了測試'], currentStep: '實作 token 驗證',
  nextStep: '跑 npm test', blockers: [], files: ['/p/auth.ts'], prs: [],
})

test('解析合法的 JSON 簡報', () => {
  const b = parseBriefJson(VALID)
  assert.equal(b?.goal, '修好登入流程')
  assert.deepEqual(b?.done, ['寫了測試'])
})

test('容忍 LLM 包上的 markdown 程式碼圍欄', () => {
  const fenced = '```json\n' + VALID + '\n```'
  assert.equal(parseBriefJson(fenced)?.goal, '修好登入流程')
})

test('容忍 JSON 前後的閒聊文字', () => {
  assert.equal(parseBriefJson(`好的，這是簡報：\n${VALID}\n希望有幫助。`)?.goal, '修好登入流程')
})

test('缺少的欄位以空值補齊而非整份拒絕', () => {
  const b = parseBriefJson(JSON.stringify({ goal: '只有目標' }))
  assert.equal(b?.goal, '只有目標')
  assert.deepEqual(b?.done, [])
  assert.equal(b?.nextStep, '')
})

test('完全不是 JSON 時回傳 null', () => {
  assert.equal(parseBriefJson('抱歉我無法完成這個請求'), null)
})

test('模型自我修正時取最後一個能 parse 的 fenced block，而非被丟棄的草稿', () => {
  const draft = JSON.stringify({
    goal: '錯誤的草稿目標', done: [], currentStep: '', nextStep: '',
    blockers: [], files: [], prs: [],
  })
  const raw = [
    '```json', draft, '```',
    '不對，重新來一次，正確答案是：',
    '```json', VALID, '```',
  ].join('\n')
  assert.equal(parseBriefJson(raw)?.goal, '修好登入流程')
})

test('generateBrief 把 prompt 交給 runner 並解析結果', async () => {
  let seen = ''
  const b = await generateBrief(INPUT, async (p) => { seen = p; return VALID })
  assert.ok(seen.includes('修好登入'))
  assert.equal(b?.goal, '修好登入流程')
})

test('runner 拋錯時回傳 null 而不向上拋', async () => {
  const b = await generateBrief(INPUT, async () => { throw new Error('claude 掛了') })
  assert.equal(b, null)
})

test('runner 回傳無法解析的內容時回傳 null', async () => {
  assert.equal(await generateBrief(INPUT, async () => '???'), null)
})

test('三個合法的 taskStatus 都解析得出來', () => {
  for (const value of ['done', 'in_progress', 'blocked'] as const) {
    const raw = JSON.stringify({ goal: 'g', taskStatus: value })
    const brief = parseBriefJson(raw)
    assert.ok(brief !== null, `brief should not be null for ${value}`)
    assert.equal(brief?.goal, 'g', `goal should survive parsing for ${value}`)
    assert.equal(brief?.taskStatus, value, value)
  }
})

test('taskStatus 是模型自己編的值時視為未知，不猜一個', () => {
  // 「完成了」「finished」這種回答不能硬塞進三個值之一。猜錯的方向是
  // 把沒做完的說成做完了。整份解析必須成功，只有 taskStatus 欄位失效。
  const raw = JSON.stringify({ goal: 'g', taskStatus: '完成了' })
  const brief = parseBriefJson(raw)
  assert.ok(brief !== null, 'entire brief should parse successfully')
  assert.equal(brief?.goal, 'g', 'goal should survive invalid taskStatus')
  assert.equal(brief?.taskStatus, undefined, 'invalid taskStatus should be undefined')
})

test('taskStatus 型別錯誤時視為未知，其餘欄位照常解析', () => {
  // 數字或其他型別的 taskStatus 應該被 catch 為 undefined，而不是整份解析失敗
  const raw = JSON.stringify({ goal: 'g', taskStatus: 42 })
  const brief = parseBriefJson(raw)
  assert.ok(brief !== null, 'entire brief should parse successfully with type mismatch')
  assert.equal(brief?.goal, 'g', 'goal should survive taskStatus type error')
  assert.equal(brief?.taskStatus, undefined, 'taskStatus type mismatch should be undefined')
})

test('舊快取沒有 taskStatus 欄位時其餘欄位照常解析', () => {
  const raw = JSON.stringify({ goal: 'g', nextStep: 'n' })
  const brief = parseBriefJson(raw)
  assert.ok(brief !== null, 'entire brief should parse when taskStatus is missing')
  assert.equal(brief?.goal, 'g', 'goal should be present')
  assert.equal(brief?.taskStatus, undefined, 'missing taskStatus should be undefined')
})
