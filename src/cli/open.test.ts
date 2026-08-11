import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runOpen } from './open.ts'
import { captureAsync, scaffoldHome, SCRATCH, type SessionSpec } from './test-helpers.ts'
import type { LaunchDeps } from '../launch/run.ts'
import { parseLstart, queryProcesses } from '../adapters/claude-code/processes.ts'

after(SCRATCH.cleanup)

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The registry stores procStart in UTC while `ps` reports local time, and
 * lifecycle only says "running" when the two agree. A hardcoded timestamp
 * would make every fixture session look crashed, so the real start time of a
 * real live process is read back and re-rendered the way the registry writes it.
 */
function registryProcStart(pid: number): string {
  const ms = parseLstart(queryProcesses([pid]).alive.get(pid) ?? '')
  assert.notEqual(ms, null, `無法取得 PID ${pid} 的啟動時間`)
  const d = new Date(ms as number)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ` +
         `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()}`
}

const live = (id: string, pid: number, status: 'busy' | 'idle'): SessionSpec =>
  ({ id, pid, status, procStart: registryProcStart(pid) })

const scaffold = (project: string, sessions: readonly SessionSpec[]) =>
  scaffoldHome([{ project, sessions }])

interface Captured {
  code: number
  out: string
  err: string
  scripts: string[]
}

/** Runs the command with a fake terminal launcher and a fake LLM. */
async function run(
  home: string,
  argv: readonly string[],
  over: { launch?: () => LaunchDeps; brief?: string; onRun?: () => void } = {},
): Promise<Captured> {
  const scripts: string[] = []
  const captured = await captureAsync(home, () => runOpen(argv, {
    run: async () => {
      over.onRun?.()
      return over.brief ?? JSON.stringify({
        goal: '修好匯出', done: [], currentStep: '', nextStep: '補測試',
        blockers: [], files: [], prs: [],
      })
    },
    launch: over.launch ?? (() => ({
      term: 'terminal',
      runOsascript: (s: string) => void scripts.push(s),
    })),
  }))
  return { ...captured, scripts }
}

const A = 'aaaa1111-0000-1111-2222-333344445555'
const B = 'bbbb2222-0000-1111-2222-333344445555'

test('沒給目標時印出用法並回傳 2', async () => {
  const r = await run(scaffold('proj', [{ id: A }]), [])
  assert.equal(r.code, 2)
  assert.match(r.err, /用法/)
})

test('找不到目標時回傳 1 且不開終端機', async () => {
  const r = await run(scaffold('proj', [{ id: A }]), ['nope'])
  assert.equal(r.code, 1)
  assert.match(r.err, /找不到/)
  assert.deepEqual(r.scripts, [])
})

test('給專案名就能接續，並送出 osascript', async () => {
  const r = await run(scaffold('proj', [{ id: A }]), ['proj'])
  assert.equal(r.code, 0)
  assert.equal(r.scripts.length, 1)
  assert.match(r.scripts[0] ?? '', /claude --resume/)
  assert.ok((r.scripts[0] ?? '').includes(A))
})

test('簡報寫成檔案，第一則訊息只叫它去讀，不把全文貼進 prompt', async () => {
  const home = scaffold('proj', [{ id: A }])
  const r = await run(home, ['proj'])
  const briefPath = join(home, '.helm', 'briefs', `${A}.md`)
  assert.match(readFileSync(briefPath, 'utf8'), /補測試/)
  const script = r.scripts[0] ?? ''
  assert.ok(script.includes(`讀 ${briefPath} 後接續`))
  assert.ok(!script.includes('補測試'), '簡報內容不該出現在開場訊息裡')
})

test('--no-brief 時不產生簡報也不呼叫 LLM，但仍開終端機', async () => {
  let called = false
  const r = await run(scaffold('proj', [{ id: A }]), ['proj', '--no-brief'], {
    onRun: () => {
      called = true
    },
  })
  assert.equal(r.code, 0)
  assert.equal(called, false, '沒有要簡報就不該花錢')
  assert.equal(r.scripts.length, 1)
})

test('--no-brief 時開場訊息不得指向任何簡報檔', async () => {
  // 沒寫簡報卻叫 session 去讀那個路徑：檔案不存在時是一句無意義的指令，
  // 檔案存在時更糟 —— 那是上一次 helm open 留下的舊簡報，Claude 會照著
  // 一份過期的計畫接續，而且沒有任何跡象顯示它過期了。
  const r = await run(scaffold('proj', [{ id: A }]), ['proj', '--no-brief'])
  assert.equal(r.code, 0)
  const script = r.scripts[0] ?? ''
  assert.ok(!script.includes('.md'), `開場訊息不該提到簡報檔：${script}`)
  assert.ok(script.includes('claude --resume'))
})

test('--no-brief 時即使磁碟上有舊簡報也不指向它', async () => {
  const home = scaffold('proj', [{ id: A }])
  await run(home, ['proj'])
  const stale = readFileSync(join(home, '.helm', 'briefs', `${A}.md`), 'utf8')
  assert.match(stale, /補測試/, '前置條件：第一次呼叫確實留下了簡報')
  const r = await run(home, ['proj', '--no-brief'])
  assert.ok(!(r.scripts[0] ?? '').includes('.md'))
})

test('--no-brief 時輸出不宣稱簡報已產生', async () => {
  const r = await run(scaffold('proj', [{ id: A }]), ['proj', '--no-brief'])
  assert.ok(!r.out.includes('簡報'), `不該提簡報：${r.out}`)
})

test('專案底下有多個還在跑的 session 時列出來讓使用者選，不自動挑', async () => {
  const home = scaffold('proj', [live(A, process.pid, 'busy'), live(B, process.ppid, 'idle')])
  const r = await run(home, ['proj'])
  assert.equal(r.code, 1)
  assert.deepEqual(r.scripts, [], '不確定要開哪一個時，什麼都不該開')
  assert.match(r.err, /aaaa1111/)
  assert.match(r.err, /bbbb2222/)
})

test('只有一個在跑時直接開它，不打擾使用者', async () => {
  const home = scaffold('proj', [live(A, process.pid, 'busy'), { id: B }])
  const r = await run(home, ['proj'])
  assert.equal(r.code, 0)
  assert.ok((r.scripts[0] ?? '').includes(A))
})

test('都沒在跑時接續最近的那個 —— 重開機後的主要用法', async () => {
  const r = await run(scaffold('proj', [{ id: A }, { id: B }]), ['proj'])
  assert.equal(r.code, 0)
  assert.equal(r.scripts.length, 1)
})

test('指名 session id 時就開那一個，不套用專案層級的規則', async () => {
  const home = scaffold('proj', [live(A, process.pid, 'busy'), live(B, process.ppid, 'idle')])
  const r = await run(home, ['bbbb2222'])
  assert.equal(r.code, 0)
  assert.ok((r.scripts[0] ?? '').includes(B))
})

test('開終端機失敗時回傳 1，並告訴使用者簡報在哪', async () => {
  const r = await run(scaffold('proj', [{ id: A }]), ['proj'], {
    launch: () => ({
      term: 'terminal',
      runOsascript: () => {
        throw new Error('osascript 掛了')
      },
    }),
  })
  assert.equal(r.code, 1)
  assert.match(r.err, /開啟終端機失敗/)
  assert.match(r.err, /osascript 掛了/)
  assert.match(r.err, new RegExp(`${A}\\.md`))
})

test('LLM 回不出東西時仍然接續，簡報退回原始提問清單', async () => {
  const home = scaffold('proj', [{ id: A }])
  const r = await run(home, ['proj'], { brief: '我不知道' })
  assert.equal(r.code, 0)
  assert.match(readFileSync(join(home, '.helm', 'briefs', `${A}.md`), 'utf8'), /做一件事/)
})
