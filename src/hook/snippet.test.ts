import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOOK_MARKER, HOOK_SCRIPT, buildHookCommand } from './snippet.ts'

interface Run {
  code: number
  written: Record<string, unknown> | null
}

/** Feeds a payload to the real shell, exactly as Claude Code would. */
function runHook(payload: string, opts: { liveDir?: string; off?: boolean } = {}): Run {
  const live = opts.liveDir ?? mkdtempSync(join(tmpdir(), 'helm-hook-'))
  let code = 0
  try {
    execFileSync('sh', ['-c', HOOK_SCRIPT], {
      input: payload,
      env: { ...process.env, HELM_LIVE: live, ...(opts.off === true ? { HELM_OFF: '1' } : {}) },
      stdio: ['pipe', 'ignore', 'ignore'],
    })
  } catch (err) {
    code = (err as { status?: number }).status ?? -1
  }
  const first = safeReaddir(live)[0]
  return {
    code,
    written: first === undefined
      ? null
      : JSON.parse(readFileSync(join(live, first), 'utf8')) as Record<string, unknown>,
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
}

const ID = 'abc12345-0000-1111-2222-333344445555'
const bash = (command: string) =>
  JSON.stringify({ session_id: ID, tool_name: 'Bash', tool_input: { command } })

test('一般 Bash 呼叫寫出 sessionId、toolName 與指令摘要', () => {
  const r = runHook(bash('npm test'))
  assert.equal(r.code, 0)
  assert.deepEqual(r.written, { sessionId: ID, ts: 0, toolName: 'Bash', summary: 'npm test' })
})

test('Write 之類的工具改用 file_path 當摘要', () => {
  const r = runHook(JSON.stringify({
    session_id: ID, tool_name: 'Write', tool_input: { file_path: '/tmp/a.txt', content: 'x' },
  }))
  assert.equal((r.written as { summary: string }).summary, '/tmp/a.txt')
})

test('指令含跳脫引號時降級成空摘要，絕不寫出壞 JSON', () => {
  // 原型實測抓到的缺陷：${C%%\"*} 會在跳脫引號處截斷並留下結尾反斜線，
  // 產生 {"summary":"echo \"} —— 解析失敗即代表當機判定從此靜默失效，
  // 而且沒有任何人會發現。失敗要往「沒有資訊」倒，不能往「壞資料」倒。
  const r = runHook(bash('echo "hi" && ls'))
  assert.equal((r.written as { summary: string }).summary, '')
  assert.equal((r.written as { toolName: string }).toolName, 'Bash')
})

test('指令含換行時同樣降級成空摘要', () => {
  const r = runHook(bash('a\nb'))
  assert.equal((r.written as { summary: string }).summary, '')
})

test('tool_input 內容假冒 session_id 不影響檔名 —— 取第一個出現的', () => {
  const r = runHook(JSON.stringify({
    session_id: ID, tool_name: 'Write',
    tool_input: { file_path: '/tmp/a.txt', content: '"session_id":"EVIL"' },
  }))
  assert.equal((r.written as { sessionId: string }).sessionId, ID)
})

test('session_id 不像 UUID 時什麼都不寫，也不報錯', () => {
  const r = runHook(JSON.stringify({ session_id: '../../etc/passwd', tool_name: 'Bash' }))
  assert.equal(r.code, 0)
  assert.equal(r.written, null)
})

test('完全沒有 session_id 的畸形輸入不寫檔且 exit 0', () => {
  const r = runHook(JSON.stringify({ tool_name: 'Bash' }))
  assert.equal(r.code, 0)
  assert.equal(r.written, null)
})

test('tool_name 含奇怪字元時退為 unknown，不讓它進到 JSON', () => {
  const r = runHook(JSON.stringify({ session_id: ID, tool_name: 'Ba"sh', tool_input: {} }))
  assert.equal((r.written as { toolName: string }).toolName, 'unknown')
})

test('HELM_OFF=1 時完全 no-op', () => {
  const r = runHook(bash('npm test'), { off: true })
  assert.equal(r.code, 0)
  assert.equal(r.written, null)
})

test('live 目錄不存在時仍 exit 0 —— 非零會擋住使用者的工具呼叫', () => {
  const r = runHook(bash('npm test'), { liveDir: join(tmpdir(), 'helm-hook-does-not-exist') })
  assert.equal(r.code, 0)
})

test('每一種輸入寫出的都是合法 JSON', () => {
  for (const payload of [
    bash('npm test'),
    bash('echo "hi"'),
    bash('a\tb\\c'),
    bash('ps aux | grep node'),
    JSON.stringify({ session_id: ID, tool_name: 'Read', tool_input: { file_path: '/a b/c.ts' } }),
  ]) {
    const r = runHook(payload)
    assert.ok(r.written !== null, `沒有寫出檔案：${payload}`)
    assert.equal((r.written as { sessionId: string }).sessionId, ID)
  }
})

test('buildHookCommand 產出可直接放進 settings.json 的單行指令', () => {
  const cmd = buildHookCommand('/h/.helm/live', '/h/.helm/hook-errors.log')
  assert.ok(cmd.startsWith('sh -c '))
  assert.ok(cmd.includes(HOOK_MARKER), '必須帶識別字，解除安裝才找得到自己')
  assert.ok(!cmd.includes('\n'), 'settings.json 裡的指令必須是單行')
})

test('buildHookCommand 產出的指令真的能跑', () => {
  const live = mkdtempSync(join(tmpdir(), 'helm-hook-'))
  const log = join(live, 'errors.log')
  execFileSync('sh', ['-c', buildHookCommand(live, log)], {
    input: bash('npm test'), stdio: ['pipe', 'ignore', 'ignore'],
  })
  assert.equal(safeReaddir(live).length, 1)
})

test('buildHookCommand 即使 live 目錄不存在也 exit 0', () => {
  const missing = join(tmpdir(), 'helm-hook-nope', 'live')
  const code = (() => {
    try {
      execFileSync('sh', ['-c', buildHookCommand(missing, join(missing, 'e.log'))], {
        input: bash('npm test'), stdio: ['pipe', 'ignore', 'ignore'],
      })
      return 0
    } catch (err) {
      return (err as { status?: number }).status ?? -1
    }
  })()
  assert.equal(code, 0, 'PreToolUse 回非零會擋住使用者的工具呼叫')
})

test('hook 不 spawn 任何外部指令 —— 那會讓每次工具呼叫多付一次 spawn', () => {
  for (const forbidden of ['date', 'mkdir', 'jq', 'node', 'cat', 'sed', 'awk', 'grep']) {
    assert.ok(
      !new RegExp(`(^|[^A-Za-z])${forbidden}([^A-Za-z]|$)`).test(HOOK_SCRIPT),
      `hook 出現了外部指令 ${forbidden}`,
    )
  }
})
