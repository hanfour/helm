import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMenu } from './menu.ts'
import { collectStatus } from './status.ts'
import { resolvePaths } from '../paths.ts'
import { renderSwiftBar } from '../render/swiftbar.ts'
import { captureSync, scaffoldHome, SCRATCH } from './test-helpers.ts'

after(SCRATCH.cleanup)

const CONTRACT_MS = 200

const id = (i: number) => `${String(i).padStart(8, '0')}-0000-1111-2222-333344445555`

/**
 * Half the sessions carry a registry entry, because a session without a `pid`
 * never reaches `ps` at all. The original fixture had none, so the 200 ms
 * assertion was measuring a code path that skipped the single most expensive
 * thing the fast path does — it passed at 0.8 ms, a 250x margin that no
 * regression could ever close.
 */
const withSessions = (n: number) =>
  scaffoldHome([{
    project: 'proj',
    sessions: Array.from({ length: n }, (_, i) => (
      i % 2 === 0 ? { id: id(i), pid: 90_000 + i } : { id: id(i) }
    )),
  }])

/** Times the whole fast path, `ps` and all. */
function timeMenu(home: string): number {
  const paths = resolvePaths({ home })
  const started = performance.now()
  const now = Date.now()
  renderSwiftBar(collectStatus(paths, now), { nowMs: now, helmBin: '/x' })
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

test('helm menu 的 import 圖裡沒有任何慢速路徑模組', () => {
  // 計時證明不了這件事：一份 19MB 的 transcript 讀完加逐行解析只要 22-25ms，
  // 離 200ms 差一個數量級 —— 舊測試對「把 readFileSync 塞進 scan.ts」這種
  // 變異照樣通過（reviewer 實際做過這個變異，五個測試全綠）。
  //
  // 具名管道也不行：listTranscripts 用 isFile() 過濾，FIFO 根本進不到那裡。
  //
  // 真正對得上這條 invariant 的是 import 圖本身。慢速路徑的模組只要被
  // menu 這一側碰到，這裡就會紅。
  const forbidden = [
    'adapters/claude-code/transcript.ts',
    'summarize/brief.ts',
    'summarize/input.ts',
    'summarize/git.ts',
    'cache/store.ts',
    'launch/run.ts',
  ]
  const reachable = importGraphOf(fileURLToPath(new URL('./menu.ts', import.meta.url)))
  for (const slow of forbidden) {
    assert.ok(
      ![...reachable].some((f) => f.endsWith(slow)),
      `helm menu 碰到了慢速路徑模組 ${slow}`,
    )
  }
})

/** Follows relative imports from an entry point and returns every file reached. */
function importGraphOf(entry: string): Set<string> {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const m of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      queue.push(resolve(dirname(file), m[1] as string))
    }
  }
  return seen
}

test('helm menu 不產生簡報也不寫快取 —— 那些都是慢速路徑的產物', () => {
  const home = withSessions(2)
  captureSync(home, () => runMenu([]))
  assert.equal(existsSync(join(home, '.helm', 'briefs')), false, '產生了簡報代表偷跑了慢速路徑')
  assert.equal(existsSync(join(home, '.helm', 'cache.json')), false, '寫了快取代表呼叫過 LLM')
})
