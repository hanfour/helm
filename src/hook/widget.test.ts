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
