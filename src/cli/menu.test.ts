import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runMenu } from './menu.ts'
import { collectStatus } from './status.ts'
import { resolvePaths } from '../paths.ts'
import { renderSwiftBar } from '../render/swiftbar.ts'
import { captureSync, scaffoldHome, SCRATCH } from './test-helpers.ts'

after(SCRATCH.cleanup)

const CONTRACT_MS = 200

const id = (i: number) => `${String(i).padStart(8, '0')}-0000-1111-2222-333344445555`

const withSessions = (n: number) =>
  scaffoldHome([{ project: 'proj', sessions: Array.from({ length: n }, (_, i) => ({ id: id(i) })) }])

/** Times the whole fast path, with `ps` stubbed so the clock measures helm. */
function timeMenu(home: string): number {
  const paths = resolvePaths({ home })
  const started = performance.now()
  const now = Date.now()
  renderSwiftBar(
    collectStatus(paths, now, () => ({ alive: new Map(), unreachable: new Set<number>() })),
    { nowMs: now, helmBin: '/x' },
  )
  return performance.now() - started
}

test('輸出 SwiftBar 格式：標題、分隔線、專案、可點的動作', () => {
  const r = captureSync(withSessions(1), () => runMenu([]))
  assert.equal(r.code, 0)
  const lines = r.out.split('\n')
  assert.match(lines[0] ?? '', /⚓/)
  assert.equal(lines[1], '---')
  assert.match(r.out, /^proj/m)
  assert.match(r.out, /param1=open/)
})

test('沒有專案時仍輸出合法的選單', () => {
  const r = captureSync(scaffoldHome([]), () => runMenu([]))
  assert.equal(r.code, 0)
  assert.ok(r.out.includes('\n---\n'))
})

test('helm menu 在 fixture 環境下必須在 200ms 內完成', () => {
  // SwiftBar 每 5 秒跑一次。超過契約不是「有點慢」，是使用者的選單列會卡。
  const elapsed = timeMenu(withSessions(20))
  assert.ok(elapsed < CONTRACT_MS, `花了 ${elapsed.toFixed(1)}ms，超過 ${CONTRACT_MS}ms 契約`)
})

test('helm menu 絕不讀 transcript 內容 —— 那是慢速路徑', () => {
  // 塞一份大到讀了必定超時的 transcript：只要有人偷讀就會被抓到。
  const home = withSessions(1)
  const slug = join(home, 'proj').replace(/[^a-zA-Z0-9]/g, '-')
  const line = `${JSON.stringify({
    type: 'user', message: { role: 'user', content: 'x'.repeat(900) },
  })}\n`
  writeFileSync(join(home, '.claude', 'projects', slug, `${id(0)}.jsonl`), line.repeat(20_000))
  const elapsed = timeMenu(home)
  assert.ok(elapsed < CONTRACT_MS, `花了 ${elapsed.toFixed(1)}ms —— 有人讀了 transcript 內容`)
})

test('helm menu 不產生簡報也不寫快取 —— 那些都是慢速路徑的產物', () => {
  const home = withSessions(2)
  captureSync(home, () => runMenu([]))
  assert.equal(existsSync(join(home, '.helm', 'briefs')), false, '產生了簡報代表偷跑了慢速路徑')
  assert.equal(existsSync(join(home, '.helm', 'cache.json')), false, '寫了快取代表呼叫過 LLM')
})
