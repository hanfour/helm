import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { WIDGET_MARKER, buildWidget } from './widget.ts'

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

test('重新整理頻率是 5 秒，跟選單列一致', () => {
  assert.match(widget(), /refreshFrequency = 5000/)
})

test('helm 失敗時 widget 顯示錯誤，不是顯示空白', () => {
  // The failure this guards against is the one helm keeps repeating: every
  // file in place, nothing on screen, and no way to tell "idle" from "broken".
  const w = widget()
  assert.ok(w.includes('error'), 'render 必須處理 error')
  assert.match(w, /helm 讀不到|helm 失敗|讀不到/)
})

test('輸出不是合法 JSON 時也顯示出來，不整個 widget 崩掉', () => {
  assert.match(widget(), /catch/)
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

/**
 * Runs the widget's own JSX-free logic block and hands back one of its
 * functions, so these assertions exercise the code the desktop actually runs.
 *
 * Asserting on the source text instead is how the first version shipped a
 * title that counted `ended` and `crashed` projects as "running" — the string
 * `aggregateStatus` was present, and that was all a text assertion could see.
 */
function evalFn(widgetSource: string, name: string): (...args: never[]) => unknown {
  const block = /\/\/ --- helm:logic ---[^\n]*\n([\s\S]*?)\/\/ --- \/helm:logic ---/.exec(widgetSource)
  assert.ok(block?.[1], 'widget 裡找不到 helm:logic 區塊')
  return new Function(`${block[1]}\nreturn ${name}`)() as (...args: never[]) => unknown
}

const proj = (aggregateStatus: string | null) => ({ aggregateStatus })

test('標題只數真的在跑的專案 —— ended 與 crashed 都不是「在跑」', () => {
  const titleOf = evalFn(widget(), 'titleOf') as (p: unknown[]) => { word: string }
  assert.match(
    titleOf([proj('busy'), proj('busy'), proj('ended'), proj('ended'), proj('idle'), proj(null)]).word,
    /^2 在跑/,
  )
})

test('有中斷的專案時，中斷優先顯示 —— 那是最需要處理的事', () => {
  const titleOf = evalFn(widget(), 'titleOf') as (p: unknown[]) => { word: string }
  assert.match(titleOf([proj('crashed'), proj('busy'), proj('busy')]).word, /^1 中斷/)
})

test('都沒在跑時說「都閒著」，不留空白', () => {
  const titleOf = evalFn(widget(), 'titleOf') as (p: unknown[]) => { word: string }
  assert.match(titleOf([proj('ended'), proj(null)]).word, /閒/)
  assert.match(titleOf([]).word, /閒/)
})

test('每一種狀態都有自己的顏色，沒有一個落進預設值', () => {
  // `waiting` was in the first version's colour table and is not a status
  // helm produces; `ended` and `crashed` are, and both fell through to the
  // idle grey — a crashed session looked exactly like an idle one.
  const dotOf = evalFn(widget(), 'dotOf') as (s: string | null) => string
  const colours = (['busy', 'idle', 'ended', 'crashed'] as const).map(dotOf)
  assert.equal(new Set(colours).size, 4, `顏色撞在一起：${colours.join(', ')}`)
  assert.ok(dotOf(null), 'aggregateStatus 可以是 null，也要有顏色')
})

test('只有真的在跑的專案才顯示當前動作 —— 停掉的那行是遺言，不是現況', () => {
  // The menu bar has always gated this on nativeStatus (swiftbar.ts). The
  // widget did not, so a project that stopped an hour ago sat there showing
  // `Bash: cd …` as though it were mid-command.
  const activeLive = evalFn(widget(), 'activeLive') as (p: unknown) => unknown
  const live = { toolName: 'Bash', summary: 'npm test' }
  assert.deepEqual(
    activeLive({ aggregateStatus: 'busy', sessions: [{ nativeStatus: 'busy', live }] }),
    live,
  )
  for (const stopped of ['idle', 'ended', 'crashed', null]) {
    assert.equal(
      activeLive({ aggregateStatus: stopped, sessions: [{ nativeStatus: 'busy', live }] }),
      null,
      `狀態 ${stopped} 不該顯示動作`,
    )
  }
})

test('專案在跑但那個 session 已經不在跑時，不拿它的 live 來充數', () => {
  const activeLive = evalFn(widget(), 'activeLive') as (p: unknown) => unknown
  const stale = { toolName: 'Bash', summary: '很久以前' }
  const now = { toolName: 'Read', summary: '現在' }
  assert.equal(
    activeLive({
      aggregateStatus: 'busy',
      sessions: [{ nativeStatus: 'idle', live: stale }, { nativeStatus: 'busy', live: now }],
    }),
    now,
  )
})

test('沒有 sessions 欄位時不炸掉', () => {
  const activeLive = evalFn(widget(), 'activeLive') as (p: unknown) => unknown
  assert.equal(activeLive({ aggregateStatus: 'busy' }), null)
})
