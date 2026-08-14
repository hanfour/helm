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

/**
 * helm's own work only, with `ps` stubbed out.
 *
 * The 200 ms figure in spec §11.2 is about a real invocation, and a wall-clock
 * assertion cannot honestly stand for it here: `node --test` runs files in
 * parallel, so the same code measured 36 ms alone and 4,216 ms inside the
 * suite on a machine already at load 3.8. A budget that moves with unrelated
 * load is a flake generator, not a guard.
 *
 * So the contract is split across three things that *are* deterministic:
 *   - this budget, which catches algorithmic regressions in helm's own code;
 *   - the import-graph test below, which catches slow-path modules creeping in;
 *   - `processes.test.ts`, which pins the `ps` strategy that dominates the rest.
 * The end-to-end number is measured and recorded in the plan, not asserted.
 */
const OWN_WORK_BUDGET_MS = 60

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

function timeMenu(home: string): number {
  const paths = resolvePaths({ home })
  const started = performance.now()
  const now = Date.now()
  // Stubbed deliberately — see OWN_WORK_BUDGET_MS. Sessions still carry pids
  // so the rest of the pipeline runs exactly as it would in production.
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

test('helm menu 自身的計算成本要留在預算內', () => {
  // SwiftBar 每 5 秒跑一次，所以任何隨 session 數成長的演算法都會現形。
  // 五次取最小。負載只會讓時間變長，所以最小值最接近「helm 自己的成本」，
  // 也是唯一不會因為隔壁測試檔剛好在忙而誤報的統計量。
  const elapsed = Math.min(...Array.from({ length: 5 }, () => timeMenu(withSessions(20))))
  assert.ok(
    elapsed < OWN_WORK_BUDGET_MS,
    `花了 ${elapsed.toFixed(1)}ms，超過 ${OWN_WORK_BUDGET_MS}ms 預算`,
  )
})

test('成本不隨 session 數量爆炸 —— 四倍的量不該是四倍以上的時間', () => {
  // 比值比絕對值穩，但還不夠：整套測試是每個檔案一個行程平行跑的，
  // 大的那次剛好撞上排程就會偽陽性 —— 這條曾經因此在變異測試裡誤判過
  // 一次「已被抓到」。取多次的最小值：負載只會讓時間變長，不會變短。
  const best = (n: number) => Math.min(...Array.from({ length: 5 }, () => timeMenu(withSessions(n))))
  timeMenu(withSessions(20))
  const small = best(20)
  const large = best(80)
  assert.ok(large < small * 8 + 20, `20 個要 ${small.toFixed(1)}ms，80 個要 ${large.toFixed(1)}ms`)
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
  // cache/store.ts 不在清單裡：task-status 設計文件 §6 明白把讀一次 7 KB
  // 的 cache.json 劃進快速路徑的效能預算內，跟這裡量的 200ms 走同一個契約，
  // 不是被漏掉的慢速模組。
  const forbidden = [
    'adapters/claude-code/transcript.ts',
    'summarize/brief.ts',
    'summarize/input.ts',
    'summarize/git.ts',
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
