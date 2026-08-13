import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { WIDGET_MARKER, buildWidget } from './widget.ts'
import { renderSwiftBar } from '../render/swiftbar.ts'

const HELM = '/Users/x/.local/bin/helm'
const widget = (argv: readonly string[] = [HELM, 'status', '--json']) => buildWidget(argv)

test('產出的 widget 帶著識別字，安裝器才認得出是自己寫的', () => {
  assert.ok(widget().includes(WIDGET_MARKER))
})

test('command 指向 helm 的絕對路徑並要求 JSON', () => {
  assert.deepEqual(shellArgv(extractCommand(widget())), [HELM, 'status', '--json'])
})

test('wrapper 被別人佔走時可以直接呼叫 node 加進入點', () => {
  // Same fallback the SwiftBar plugin has. Anything less would leave the
  // desktop silently empty on a machine that already has a `helm` in
  // ~/.local/bin — the Kubernetes one, which is not rare.
  const w = widget(['/abs/node', '/repo/src/cli/main.ts', 'status', '--json'])
  assert.ok(w.includes('/abs/node'))
  assert.ok(w.includes('/repo/src/cli/main.ts'))
})

test('helm 路徑含空白或引號時，產出的仍是合法 JS 且 shell 拆得對', () => {
  // A home directory with a space is ordinary; one with a quote is legal.
  // The path is embedded twice over — a JS string literal inside a shell
  // command — and getting either layer wrong yields a widget that either
  // fails to parse or runs the wrong program.
  for (const p of ['/Users/a b/helm', "/Users/it's/helm", '/Users/a"b/helm']) {
    const argv = [p, 'status', '--json']
    assert.deepEqual(shellArgv(extractCommand(buildWidget(argv))), argv, `路徑：${p}`)
  }
})

/** Hands the command to a real shell and reports the arguments it made of it. */
function shellArgv(command: string): string[] {
  const out = execFileSync('/bin/sh', ['-c', `printf '%s\n' ${command}`], { encoding: 'utf8' })
  return out.split('\n').slice(0, -1)
}

/** Pulls the shell command back out of the generated module. */
function extractCommand(widgetSource: string): string {
  const m = /export const command = (".*")\n/.exec(widgetSource)
  assert.ok(m?.[1], `找不到 command：\n${widgetSource.slice(0, 300)}`)
  return JSON.parse(m[1]) as string
}

test('重新整理頻率留有逾時餘裕 —— Übersicht 拿它當 HTTP timeout', () => {
  // `.timeout(refreshFrequency)` in Übersicht's client. helm status --json
  // measures p50 407ms and p90 2.4s on a busy machine, so a 5s value turns
  // the desktop into an intermittent timeout error.
  const m = /refreshFrequency = (\d+)/.exec(widget())
  assert.ok(m?.[1], widget().slice(0, 200))
  assert.ok(Number(m[1]) >= 10000, `${m[1]}ms 對 p90 2.4 秒來說太緊`)
})

/**
 * Runs the widget's own JSX-free logic block and hands back one of its
 * functions, so these assertions exercise the code the desktop actually runs.
 *
 * `localStorage` is stubbed before the block runs, not inside it: the block
 * ends with a module-level `let pos = clampPos(loadPos(), …)`, so without a
 * stub every call here would depend on `loadPos`'s catch swallowing a
 * ReferenceError — which made twelve unrelated assertions fail the moment
 * that catch was mutated.
 */
function evalFn(widgetSource: string, name: string, store: Record<string, string> = {}) {
  const block = /\/\/ --- helm:logic ---[^\n]*\n([\s\S]*?)\/\/ --- \/helm:logic ---/.exec(widgetSource)
  assert.ok(block?.[1], 'widget 裡找不到 helm:logic 區塊')
  const localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v
    },
  }
  return new Function('localStorage', 'window', `${block[1]}\nreturn ${name}`)(
    localStorage, { innerWidth: 1440, innerHeight: 900 },
  ) as (...args: never[]) => never
}

const NOW = 1_786_500_000_000
const viewOf = () => evalFn(widget(), 'viewOf') as unknown as
  (o: unknown, e: unknown, n: number) => Record<string, never>
const view = (board: unknown, nowMs = NOW) => viewOf()(JSON.stringify(board), null, nowMs) as never

/** 一個貼合 aggregateStatus 的 session，讓沒有指定 sessions 的案例仍是真實形狀。 */
const SESSION_FOR: Record<string, Record<string, unknown>> = {
  busy: { nativeStatus: 'busy', lifecycle: 'running' },
  crashed: { nativeStatus: 'idle', lifecycle: 'crashed' },
  idle: { nativeStatus: 'idle', lifecycle: 'running' },
  null: { nativeStatus: 'idle', lifecycle: 'ended_clean' },
}

const proj = (over: Record<string, unknown> = {}) => {
  const agg = 'aggregateStatus' in over ? over['aggregateStatus'] : 'idle'
  return {
    path: `/p/${String(over['name'] ?? 'a')}`,
    name: 'a',
    aggregateStatus: agg,
    lastActivityMs: NOW,
    // groupIntoProjects 是從 session 的 cwd 長出專案的，所以「有專案但沒有
    // session」在真實資料裡不存在。fixture 用空陣列會讓數 session 的斷言
    // 全部落在一個機器上到不了的狀態。
    sessions: [SESSION_FOR[String(agg)] ?? SESSION_FOR['idle']],
    ...over,
  }
}
const board = (over: Record<string, unknown> = {}) =>
  ({ projects: [], invalid: 0, prefsHealth: 'ok', adapterFailures: [], prs: [], prDegraded: null, ...over })

test('helm 失敗時畫出錯誤，不是畫一片空白', () => {
  // `if (error)` → `if (false)` used to survive the whole suite: the old test
  // asserted that the source text contained the word "error", which the
  // destructured parameter `{ output, error }` already satisfied.
  const v = viewOf()('', new Error('boom'), NOW) as unknown as { errorText: string }
  assert.match(v.errorText, /讀不到資料/)
  assert.match(v.errorText, /boom/)
})

test('輸出不是合法 JSON 時畫出前 120 字，不整個崩掉', () => {
  const v = viewOf()('not json ' + 'x'.repeat(500), null, NOW) as unknown as { errorText: string }
  assert.match(v.errorText, /讀不懂/)
  assert.ok(v.errorText.length < 200, v.errorText)
})

test('完全沒有輸出時說「沒有輸出」，不是留白', () => {
  for (const empty of ['', null, undefined]) {
    const v = viewOf()(empty, null, NOW) as unknown as { errorText: string }
    assert.match(v.errorText, /沒有輸出/, String(empty))
  }
})

test('輸出是合法 JSON 但沒有專案清單時也說出來', () => {
  for (const odd of ['null', '42', '[]', '{"projects":"nope"}']) {
    const v = viewOf()(odd, null, NOW) as unknown as { errorText: string }
    assert.match(v.errorText ?? '', /專案清單/, odd)
  }
})

test('標題數的是 session —— 一個專案裡兩個在跑就是 2', () => {
  // 實測 2026-08-13：使用者兩個 terminal 在跑、cwd 同一個，兩個介面都寫
  // 「1 在跑」。專案是從 session 的 cwd 長出來的，不是使用者開的東西。
  const busy = { nativeStatus: 'busy', lifecycle: 'running' }
  const word = (view(board({
    projects: [proj({ aggregateStatus: 'busy', sessions: [busy, busy] })],
  })) as unknown as { title: { word: string } }).title.word
  assert.match(word, /^2 在跑/, word)
})

test('桌面與選單列對同一份資料給同一個數字', () => {
  // 這兩支檔案各有一份計數邏輯，而畫面上只有數字 —— 單位一旦分岔，
  // 使用者無從得知兩邊在數不同的東西。舊註解防的就是這件事，但它靠的是
  // 兩處註解互相提醒；這條測試讓分岔直接變紅。
  const mk = (nativeStatus: string, lifecycle: string) => ({
    adapterId: 'claude-code', sessionId: 'x', cwd: '/p/a', pid: null, procStart: null,
    startedAt: NOW, updatedAt: NOW, nativeStatus, kind: 'interactive', name: '',
    transcriptPath: null, transcriptMtimeMs: null, lifecycle,
    lifecycleConfidence: 'high', live: null,
  })
  const cases: Record<string, unknown>[][] = [
    [{ aggregateStatus: 'busy', sessions: [mk('busy', 'running'), mk('busy', 'running')] }],
    [{ aggregateStatus: 'crashed', sessions: [mk('idle', 'crashed'), mk('idle', 'crashed')] }],
    [{ aggregateStatus: 'idle', sessions: [mk('idle', 'running'), mk('idle', 'running')] }],
    [
      { aggregateStatus: 'busy', sessions: [mk('busy', 'running'), mk('idle', 'running')] },
      { aggregateStatus: 'busy', sessions: [mk('busy', 'running')] },
    ],
    [{ aggregateStatus: null, sessions: [mk('idle', 'ended_clean')] }],
  ]
  for (const projects of cases) {
    const full = projects.map((p) => proj(p))
    const desktop = (view(board({ projects: full })) as unknown as { title: { word: string } }).title.word
    const menu = renderSwiftBar(
      { projects: full, invalid: 0, prefsHealth: 'ok', adapterFailures: [], prs: [], prDegraded: null } as never,
      { nowMs: NOW, helmBin: HELM },
    ).split('\n')[0] ?? ''
    // 選單列的標題是「⚓ N 詞 | color=…」，桌面的 word 是「N 詞」。
    const menuWord = menu.replace(/^⚓ ?/, '').split(' |')[0] ?? ''
    assert.equal(menuWord === '' ? '都閒著' : menuWord, desktop,
      `兩邊不一致：選單列 ${JSON.stringify(menu)}、桌面 ${JSON.stringify(desktop)}`)
  }
})

test('標題只數真的在跑的，而且中斷優先', () => {
  assert.match(
    (view(board({ projects: [proj({ aggregateStatus: 'busy' }), proj({ aggregateStatus: 'busy' }),
      proj({ aggregateStatus: null }), proj()] })) as unknown as { title: { word: string } }).title.word,
    /^2 在跑/,
  )
  assert.match(
    (view(board({ projects: [proj({ aggregateStatus: 'crashed' }), proj({ aggregateStatus: 'busy' })] })) as
      unknown as { title: { word: string } }).title.word,
    /^1 中斷/,
  )
  assert.match(
    (view(board({ projects: [proj({ aggregateStatus: null })] })) as
      unknown as { title: { word: string } }).title.word,
    /閒/,
  )
})

test('每一種狀態畫成它自己的顏色 —— 對調要抓得到', () => {
  // The old assertion only required the four colours to differ from each
  // other, so swapping busy and crashed — a running project drawn red, an
  // abandoned one green — passed.
  const dotOf = evalFn(widget(), 'dotOf') as unknown as (s: string | null) => string | null
  assert.equal(dotOf('busy'), '#4ade80')
  assert.equal(dotOf('crashed'), '#f87171')
  assert.match(dotOf('idle') ?? '', /^rgba/)
  assert.equal(dotOf(null), null, 'aggregateStatus 為 null 代表全部結束：不畫點')
  assert.equal(dotOf('ended'), null, "aggregateStatus 永遠不會是 'ended'")
})

test('只有那個 session 自己在跑才顯示動作 —— 跟選單列同一條規則', () => {
  const live = { toolName: 'Bash', summary: 'npm test' }
  const running = { nativeStatus: 'busy', live }
  const stopped = { nativeStatus: 'idle', live: { toolName: 'Bash', summary: '很久以前' } }

  const one = (sessions: unknown[], aggregateStatus: string | null = 'busy') =>
    (view(board({ projects: [proj({ sessions, aggregateStatus })] })) as
      unknown as { rows: { live: string | null }[] }).rows[0]?.live

  assert.equal(one([running]), 'Bash: npm test')
  assert.equal(one([stopped]), null, '停掉的 session 那行是遺言，不是現況')
  assert.equal(one([stopped, running]), 'Bash: npm test', '不拿停掉的那個充數')
  assert.equal(
    one([running], 'crashed'),
    'Bash: npm test',
    '同一專案裡有東西中斷時，正在跑的那道指令更該看得到',
  )
  // 選單列在 summary 為空時顯示「→ Read」，所以桌面也顯示工具名。
  // 這裡要擋的是 `Bash: undefined`，不是整行不畫。
  assert.equal(one([{ nativeStatus: 'busy', live: { toolName: 'Bash' } }]), 'Bash')
  assert.equal(one([{ nativeStatus: 'busy', live: { toolName: '', summary: '' } }]), null)
  assert.equal(one([]), null)
})

test('相對時間用 Math.floor，跟選單列的 relativeTime 完全一致', () => {
  const ago = evalFn(widget(), 'ago') as unknown as (ms: number, now: number) => string
  assert.equal(ago(NOW - 59_600, NOW), '剛剛', 'Math.round 會在這裡說「1 分鐘前」')
  assert.equal(ago(NOW - 60_000, NOW), '1 分鐘前')
  assert.equal(ago(NOW - 3_599_000, NOW), '59 分鐘前')
  assert.equal(ago(NOW - 3_600_000, NOW), '1 小時前')
  assert.equal(ago(NOW - 86_399_000, NOW), '23 小時前')
  assert.equal(ago(NOW - 86_400_000, NOW), '1 天前')
  assert.equal(ago(NOW + 60_000, NOW), '剛剛', '時鐘偏移不該畫出負數')
})

test('看板自己回報的降級也要畫出來 —— 選單列一直都有畫', () => {
  const v = view(board({ projects: [proj()], invalid: 3, prefsHealth: 'quarantined', adapterFailures: [], prs: [], prDegraded: null })) as
    unknown as { notes: string[] }
  assert.ok(v.notes.some((n) => n.includes('3')), v.notes.join('|'))
  assert.ok(v.notes.some((n) => n.includes('釘選')), v.notes.join('|'))
  assert.ok(v.notes.some((n) => n.includes('doctor')), '要說下一步')
  assert.deepEqual((view(board({ projects: [proj()] })) as unknown as { notes: string[] }).notes, [])
})

test('空看板說的是過濾條件，不是「沒有 session」', () => {
  // Sessions are usually still there — filtered out by the activity window, by
  // not being a git repo, or by `helm hide`. 「沒有找到 session」sends the
  // user looking for missing sessions instead of at the filters.
  const v = view(board()) as unknown as { empty: string; rows: unknown[] }
  assert.match(v.empty, /14 天/)
  assert.match(v.empty, /git repo/)
  assert.deepEqual(v.rows, [])
})

test('位置被夾在畫面內，而且夾在確定的位置', () => {
  // The old assertion only required the result to be inside the viewport, so
  // shrinking the margin to 1px — a 300px card with one pixel to grab —
  // passed.
  const clampPos = evalFn(widget(), 'clampPos') as unknown as (
    p: { top: number; left: number }, w: number, h: number,
  ) => { top: number; left: number }
  assert.deepEqual(clampPos({ top: -80, left: -200 }, 1000, 800), { top: 0, left: 0 })
  assert.deepEqual(clampPos({ top: 5000, left: 9000 }, 1000, 800), { top: 760, left: 960 })
  assert.deepEqual(clampPos({ top: 100, left: 200 }, 1000, 800), { top: 100, left: 200 })
  assert.deepEqual(clampPos({ top: 10, left: 10 }, 20, 20), { top: 0, left: 0 }, '視窗比邊界還小時不得為負')
})

test('模組載入時 pos 就已經夾好 —— 這是唯一會在畫面外救回卡片的時機', () => {
  // Asserting on clampPos and loadPos separately left the wiring between them
  // unguarded: `let pos = loadPos()` (no clamp) passed every one of those.
  const block = /\/\/ --- helm:logic ---[^\n]*\n([\s\S]*?)\/\/ --- \/helm:logic ---/
    .exec(widget())?.[1]
  assert.ok(block)
  const stored = { 'helm.widget.pos': JSON.stringify({ top: 1400, left: 3200 }) }
  const pos = new Function('localStorage', 'window', `${block}\nreturn pos`)(
    { getItem: (k: string) => stored[k as keyof typeof stored] ?? null, setItem: () => {} },
    { innerWidth: 1440, innerHeight: 900 },
  ) as { top: number; left: number }
  assert.ok(pos.top < 900, `top=${pos.top} 在 900 高的畫面外`)
  assert.ok(pos.left < 1440, `left=${pos.left} 在 1440 寬的畫面外`)
})

test('存過的位置在載入時就夾一次 —— 換小螢幕之後不能就此消失', () => {
  // clampPos only ran while dragging, so a card parked at the corner of an
  // external display landed off-screen on the laptop panel: unreachable by
  // mouse, and the position lives in localStorage where uninstall cannot
  // clear it.
  const stored = { 'helm.widget.pos': JSON.stringify({ top: 1400, left: 3200 }) }
  const loadPos = evalFn(widget(), 'loadPos', stored) as unknown as () => unknown
  assert.deepEqual(loadPos(), { top: 1400, left: 3200 }, 'loadPos 本身照實回報')
  const clampPos = evalFn(widget(), 'clampPos', stored) as unknown as (
    p: unknown, w: number, h: number,
  ) => { top: number; left: number }
  const onLaptop = clampPos({ top: 1400, left: 3200 }, 1440, 900)
  assert.ok(onLaptop.top < 900 && onLaptop.left < 1440, JSON.stringify(onLaptop))
})

test('存的位置壞掉時回預設值，而不是讓整個 widget 消失', () => {
  for (const junk of ['not json', 'null', '[]', '{}', '{"top":"20","left":20}', '{"top":null}']) {
    const loadPos = evalFn(widget(), 'loadPos', { 'helm.widget.pos': junk }) as unknown as () => unknown
    assert.deepEqual(loadPos(), { top: 20, left: 20 }, junk)
  }
})

test('localStorage 寫不進去時不影響拖曳本身', () => {
  // Safari-style private mode throws on setItem. Losing the saved position is
  // acceptable; losing the widget is not.
  const savePos = evalFn(widget(), 'savePos') as unknown as (p: unknown) => void
  assert.doesNotThrow(() => savePos({ top: 1, left: 2 }))
})

test('拖曳只認左鍵，而且放開之後不留下監聽器', () => {
  const startDrag = evalFn(widget(), 'startDrag') as unknown as (e: unknown) => void
  const listeners: Record<string, number> = { mousemove: 0, mouseup: 0 }
  const handlers: Record<string, (e: unknown) => void> = {}
  const doc = {
    addEventListener: (k: string, fn: (e: unknown) => void) => {
      listeners[k] = (listeners[k] ?? 0) + 1
      handlers[k] = fn
    },
    removeEventListener: (k: string) => {
      listeners[k] = (listeners[k] ?? 0) - 1
    },
  }
  const g = globalThis as { document?: unknown }
  const had = 'document' in g
  const previous = g.document
  g.document = doc
  try {
    const node = { style: {} as Record<string, string> }
    startDrag({ button: 2, currentTarget: node, clientX: 0, clientY: 0, preventDefault: () => {} })
    assert.equal(listeners['mousemove'], 0, '右鍵不該啟動拖曳')

    startDrag({ button: 0, currentTarget: node, clientX: 10, clientY: 10, preventDefault: () => {} })
    assert.equal(listeners['mousemove'], 1)
    handlers['mousemove']?.({ clientX: 40, clientY: 30 })
    assert.equal(node.style['left'], '50px', '起點 20 + 位移 30')
    assert.equal(node.style['top'], '40px')
    handlers['mouseup']?.({})
    assert.equal(listeners['mousemove'], 0, '放開之後要解除')
    assert.equal(listeners['mouseup'], 0)
  } finally {
    if (had) g.document = previous
    else delete g.document
  }
})

test('釘選的專案帶著 📌 —— 選單列一直有畫', () => {
  const rows = (view(board({ projects: [proj({ pinned: true }), proj({ name: 'b', pinned: false })] })) as
    unknown as { rows: { pin: string }[] }).rows
  assert.equal(rows[0]?.pin, '📌')
  assert.equal(rows[1]?.pin, '')
})

test('低信心的狀態要標出來，不能把猜測畫成確定', () => {
  // The menu bar draws `●? 已中斷` when lifecycleConfidence is low. The widget
  // drew a solid red dot either way — a guess presented as a fact.
  const low = { nativeStatus: 'idle', lifecycle: 'crashed', lifecycleConfidence: 'low' }
  const high = { nativeStatus: 'idle', lifecycle: 'crashed', lifecycleConfidence: 'high' }
  const uncertainOf = (sessions: unknown[]) =>
    (view(board({ projects: [proj({ aggregateStatus: 'crashed', sessions })] })) as
      unknown as { rows: { uncertain: boolean }[] }).rows[0]?.uncertain
  assert.equal(uncertainOf([low]), true)
  assert.equal(uncertainOf([high]), false)
})

test('live 只有工具名沒有摘要時仍顯示工具名 —— 選單列顯示 → Read', () => {
  // The widget required `live.summary` to be truthy, so a marker written
  // mid-flight, or a tool with nothing to summarise, showed nothing at all.
  const rows = (view(board({
    projects: [proj({
      aggregateStatus: 'busy',
      sessions: [{ nativeStatus: 'busy', live: { toolName: 'Read', summary: '' } }],
    })],
  })) as unknown as { rows: { live: string | null }[] }).rows
  assert.equal(rows[0]?.live, 'Read')
})

test('PR 進 view 的自己一區，每筆說出在等誰', () => {
  const prs = [
    { repo: 'a/b', number: 142, waitingLabel: '等人審', title: 'feat: x', url: 'u' },
    { repo: 'a/c', number: 7, waitingLabel: '等你改', title: 'fix: y', url: 'u2' },
  ]
  const v = view(board({ projects: [proj()], prs })) as unknown as
    { prs: { text: string }[] }
  assert.equal(v.prs.length, 2)
  assert.match(v.prs[0]?.text ?? '', /a\/b#142/)
  assert.match(v.prs[0]?.text ?? '', /等人審/)
})

test('PR 讀不到時進 notes，跟選單列說同一句話', () => {
  const v = view(board({ projects: [proj()], prs: [], prDegraded: 'gh 尚未登入，執行 gh auth login。' })) as
    unknown as { notes: string[]; prs: unknown[] }
  assert.ok(v.notes.some((n) => n.includes('gh auth login')), v.notes.join('|'))
  assert.deepEqual(v.prs, [])
})

test('沒有 PR 也沒有錯誤時那一區是空的', () => {
  const v = view(board({ projects: [proj()] })) as unknown as { prs: unknown[] }
  assert.deepEqual(v.prs, [])
})

test('Codex 的低信心 running 也要跟高信心的分開畫（規格 §6）', () => {
  // isUncertain 原本只涵蓋 crashed 與 ended_clean，把 running 排除掉了 ——
  // 而 running 正是 Codex 最常見的狀態。於是桌面把「有行程在跑，低信心」
  // 畫得跟 Claude Code 那個有註冊表撐著的判定一模一樣。
  const low = { nativeStatus: null, lifecycle: 'running', lifecycleConfidence: 'low' }
  const high = { nativeStatus: 'idle', lifecycle: 'running', lifecycleConfidence: 'high' }
  const uncertainOf = (sessions: unknown[], aggregateStatus = 'idle') =>
    (view(board({ projects: [proj({ sessions, aggregateStatus })] })) as
      unknown as { rows: { uncertain: boolean }[] }).rows[0]?.uncertain
  assert.equal(uncertainOf([low]), true, '低信心就要標出來，不論是哪一種 lifecycle')
  assert.equal(uncertainOf([high]), false)
})

test('全部結束的低信心專案不會變成看不見的點', () => {
  // aggregateStatus 為 null 時 dot 是 null，JSX 畫的是 transparent ——
  // 於是 >6 小時那段的 ◍ 等於看不見。低信心的標記不該依賴顏色。
  const rows = (view(board({
    projects: [proj({
      aggregateStatus: null,
      sessions: [{ nativeStatus: null, lifecycle: 'ended_clean', lifecycleConfidence: 'low' }],
    })],
  })) as unknown as { rows: { uncertain: boolean; dot: string | null }[] }).rows
  assert.equal(rows[0]?.uncertain, true)
  assert.equal(rows[0]?.dot, null, '不畫點是對的')
})
