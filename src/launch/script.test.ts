import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  appleScriptQuote, buildLaunchScript, buildResumeCommand, detectTerminal, shellQuote,
} from './script.ts'

/** Round-trips a quoted string through a real shell and returns what it saw. */
function throughShell(quoted: string): string {
  return execFileSync('/bin/sh', ['-c', `printf '%s' ${quoted}`], { encoding: 'utf8' })
}

/** How many arguments a real shell splits the quoted string into. */
function argCount(quoted: string): number {
  return Number(execFileSync(
    '/bin/sh',
    ['-c', `set -- ${quoted}; echo $#`],
    { encoding: 'utf8' },
  ).trim())
}

/** Compiles without running. Throws when the AppleScript is malformed. */
function compiles(script: string): boolean {
  execFileSync('osacompile', ['-o', '/dev/null', '-e', script], { stdio: 'pipe' })
  return true
}

test('shellQuote 用單引號包住一般路徑', () => {
  assert.equal(shellQuote('/Users/testuser/proj'), "'/Users/testuser/proj'")
})

test('shellQuote 正確處理含空格的路徑', () => {
  assert.equal(shellQuote('/Users/t/my proj'), "'/Users/t/my proj'")
})

test('shellQuote 跳脫內嵌的單引號', () => {
  assert.equal(shellQuote("/Users/t/it's"), "'/Users/t/it'\\''s'")
})

test('shellQuote 讓注入嘗試失效 —— 交給真的 shell 判定', () => {
  // 不能只斷言「輸出裡沒有那段危險字串」：跳脫後它本來就還在，只是變成
  // 純資料。唯一有意義的驗證是問 shell 本人：它看到的是不是一模一樣的
  // 單一個參數。
  const evil = "/tmp'; rm -rf ~; echo '"
  assert.equal(throughShell(shellQuote(evil)), evil)
  assert.equal(argCount(shellQuote(evil)), 1)
})

test('shellQuote 對各種特殊字元都能原樣還原', () => {
  for (const s of ['a b', '$HOME', '`whoami`', 'a\\b', '中文路徑', 'a"b', '*', '\n']) {
    assert.equal(throughShell(shellQuote(s)), s, `無法還原：${JSON.stringify(s)}`)
    assert.equal(argCount(shellQuote(s)), 1, `被拆成多個參數：${JSON.stringify(s)}`)
  }
})

test('appleScriptQuote 跳脫雙引號與反斜線', () => {
  assert.equal(appleScriptQuote('say "hi"'), '"say \\"hi\\""')
  assert.equal(appleScriptQuote('a\\b'), '"a\\\\b"')
})

test('appleScriptQuote 先跳脫反斜線再跳脫引號，順序反了會產生假跳脫', () => {
  // 若先處理雙引號，`\"` 會變成 `\\"` 再被反斜線規則加工成 `\\\"`，
  // 意義就從「一個反斜線加一個引號」漂移成別的東西。
  assert.equal(appleScriptQuote('a\\"b'), '"a\\\\\\"b"')
})

test('appleScriptQuote 跳脫換行 —— AppleScript 字串裡不能有真的換行', () => {
  // macOS 允許目錄名含換行。未跳脫會讓 do script "..." 斷成兩行而編不過，
  // 使用者看到的是一大段 osascript 錯誤，而那個路徑還是 helm 自己找出來的。
  assert.equal(appleScriptQuote('a\nb'), '"a\\nb"')
  assert.equal(appleScriptQuote('a\rb'), '"a\\rb"')
  assert.equal(appleScriptQuote('a\tb'), '"a\\tb"')
})

test('路徑含換行時 AppleScript 仍編譯得過', () => {
  assert.ok(compiles(buildLaunchScript('terminal', '/Users/t/a\nb', 'echo ok')))
  assert.ok(compiles(buildLaunchScript('iterm', '/Users/t/a\nb', 'echo ok')))
})

test('buildResumeCommand 產生 claude --resume 加位置參數', () => {
  const c = buildResumeCommand('claude-code', 'sess-1', '讀 /tmp/b.md 後接續')
  assert.match(c, /claude --resume 'sess-1' '讀 \/tmp\/b\.md 後接續'/)
})

test('buildResumeCommand 對 codex 產生 codex resume', () => {
  assert.match(buildResumeCommand('codex', 'sess-1', 'go'), /^codex resume 'sess-1'/)
})

test('buildResumeCommand 對未知 adapter 拋出明確錯誤', () => {
  assert.throws(() => buildResumeCommand('unknown-cli', 's', 'x'), /不支援的 adapter/)
})

test('buildResumeCommand 跳脫 session id，不讓它變成指令', () => {
  const c = buildResumeCommand('claude-code', "x'; rm -rf ~; echo '", 'go')
  assert.equal(argCount(c.replace(/^claude /, '')), 3, '應為 --resume、id、訊息共三個參數')
})

test('buildLaunchScript for iterm 含 create tab 與 write text', () => {
  const s = buildLaunchScript('iterm', '/Users/t/p', 'claude --resume x')
  assert.match(s, /tell application "iTerm"/)
  assert.match(s, /create (tab|window)/)
  assert.ok(s.includes('claude --resume x'))
  assert.ok(s.includes("cd '/Users/t/p'"))
})

test('buildLaunchScript for terminal 使用 do script', () => {
  const s = buildLaunchScript('terminal', '/Users/t/p', 'claude --resume x')
  assert.match(s, /tell application "Terminal"/)
  assert.match(s, /do script/)
})

test('產生的 AppleScript 真的編譯得過（osacompile 只編譯不執行）', () => {
  assert.ok(compiles(buildLaunchScript('terminal', '/Users/t/p', 'claude --resume x')))
  assert.ok(compiles(buildLaunchScript('iterm', '/Users/t/p', 'claude --resume x')))
})

test('路徑含雙引號、反斜線與中文時，AppleScript 仍編譯得過', () => {
  // 正則數引號數不出真正的合法性；交給 AppleScript 編譯器判定才算數。
  for (const cwd of ['/Users/t/say "hi"', '/Users/t/a\\b', '/Users/t/專案 一', "/Users/t/it's"]) {
    assert.ok(compiles(buildLaunchScript('terminal', cwd, 'echo ok')), `terminal 失敗：${cwd}`)
    assert.ok(compiles(buildLaunchScript('iterm', cwd, 'echo ok')), `iterm 失敗：${cwd}`)
  }
})

test('detectTerminal 在 iTerm 存在時選 iterm', () => {
  assert.equal(detectTerminal((p) => p.includes('iTerm')), 'iterm')
})

test('detectTerminal 在 iTerm 不存在時退回 terminal', () => {
  assert.equal(detectTerminal(() => false), 'terminal')
})
