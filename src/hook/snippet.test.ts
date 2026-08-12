import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOOK_MARKER, buildHookCommand, recorderPath, shellQuote } from './snippet.ts'

interface Run {
  code: number
  written: Record<string, unknown> | null
  errors: string
}

/** Runs the real command exactly as Claude Code would: through a shell. */
function runHook(payload: string, opts: {
  liveDir?: string
  errorsLog?: string
  env?: Record<string, string>
} = {}): Run {
  const live = opts.liveDir ?? mkdtempSync(join(tmpdir(), 'helm-hook-'))
  const log = opts.errorsLog ?? join(live, 'errors.log')
  let code = 0
  try {
    execFileSync('sh', ['-c', buildHookCommand(live, log)], {
      input: payload,
      env: { ...process.env, ...opts.env },
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
    errors: safeRead(log),
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
}

function safeRead(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

const ID = 'abc12345-0000-1111-2222-333344445555'
const bash = (command: string) =>
  JSON.stringify({ session_id: ID, tool_name: 'Bash', tool_input: { command } })

const summaryOf = (r: Run) => (r.written as { summary: string } | null)?.summary
const toolOf = (r: Run) => (r.written as { toolName: string } | null)?.toolName

test('一般 Bash 呼叫寫出 sessionId、toolName 與指令摘要', () => {
  const r = runHook(bash('npm test'))
  assert.equal(r.code, 0)
  assert.deepEqual(r.written, { sessionId: ID, ts: 0, toolName: 'Bash', summary: 'npm test' })
})

test('Write 之類的工具改用 file_path 當摘要', () => {
  const r = runHook(JSON.stringify({
    session_id: ID, tool_name: 'Write', tool_input: { file_path: '/tmp/a.txt', content: 'x' },
  }))
  assert.equal(summaryOf(r), '/tmp/a.txt')
})

test('含連字號的 MCP 工具名原樣保留', () => {
  // 舊的 shell 版把 `-` 排除在白名單外，於是這台機器上的 mcp__chrome-devtools__*、
  // mcp__claude-in-chrome__* 全都顯示成 unknown。
  const r = runHook(JSON.stringify({
    session_id: ID, tool_name: 'mcp__chrome-devtools__click', tool_input: {},
  }))
  assert.equal(toolOf(r), 'mcp__chrome-devtools__click')
})

test('指令含引號、反斜線、換行時原樣保留且仍是合法 JSON', () => {
  // 舊的 shell 版在這裡會截斷出結尾反斜線，寫出無法解析的 JSON，
  // 於是當機判定從此靜默失效。
  for (const command of ['echo "hi" && ls', 'a\\b', 'a\nb', "it's", 'a\tb']) {
    const r = runHook(bash(command))
    assert.equal(r.code, 0)
    assert.equal(summaryOf(r), command, `摘要不該被改寫：${JSON.stringify(command)}`)
  }
})

test('session_id 含跳脫引號時整筆拒絕，不寫出壞檔名或壞 JSON', () => {
  const r = runHook(JSON.stringify({
    session_id: 'abc12345-0000-1111-2222-3333"evil', tool_name: 'Bash', tool_input: {},
  }))
  assert.equal(r.code, 0)
  assert.equal(r.written, null)
})

test('多行 pretty-print 的 payload 也讀得到 —— 格式沒有契約保證', () => {
  const r = runHook(JSON.stringify(
    { session_id: ID, tool_name: 'Bash', tool_input: { command: 'npm test' } }, null, 2,
  ))
  assert.equal(summaryOf(r), 'npm test')
})

test('冒號後有空白的 JSON 也讀得到', () => {
  const r = runHook(`{ "session_id" : "${ID}" , "tool_name" : "Bash" }`)
  assert.equal(toolOf(r), 'Bash')
})

test('tool_input 內容假冒 session_id 不影響檔名', () => {
  const r = runHook(JSON.stringify({
    session_id: ID, tool_name: 'Write',
    tool_input: { file_path: '/tmp/a.txt', content: '"session_id":"EVIL"' },
  }))
  assert.equal((r.written as { sessionId: string }).sessionId, ID)
})

test('session_id 不是 UUID 時什麼都不寫 —— 那個值會變成檔名', () => {
  for (const bad of ['../../etc/passwd', 'a/b', '', 'not-a-uuid', `${ID}/x`]) {
    const r = runHook(JSON.stringify({ session_id: bad, tool_name: 'Bash' }))
    assert.equal(r.code, 0)
    assert.equal(r.written, null, `不該寫出：${bad}`)
  }
})

test('摘要與工具名都有長度上限，不把整份 payload 寫進磁碟', () => {
  const r = runHook(JSON.stringify({
    session_id: ID, tool_name: 'T'.repeat(5000), tool_input: { command: 'x'.repeat(50_000) },
  }))
  assert.equal(summaryOf(r)?.length, 200)
  assert.equal(toolOf(r)?.length, 100)
})

test('超大 payload 仍在合理時間內完成 —— 舊實作在這裡要 6 秒', () => {
  // 上限刻意寬。這條測試要擋的是舊 shell 版的 O(n²)（6 秒），不是量效能：
  // 單獨跑 120-190ms，整套跑（每個檔案一個行程、機器同時忙）會到 800ms 以上。
  // 500ms 的門檻只是在製造偽陽性，並不會更早抓到那個回歸。
  const heredoc = `cat <<'EOF' > f.txt\n${'content line\n'.repeat(7000)}EOF`
  const started = performance.now()
  const r = runHook(bash(heredoc))
  const elapsed = performance.now() - started
  assert.equal(r.code, 0)
  assert.equal(summaryOf(r)?.length, 200, '不是只有快，內容也要對')
  assert.ok(elapsed < 3000, `98KB 的 heredoc 花了 ${elapsed.toFixed(0)}ms`)
})

test('畸形輸入一律 exit 0 且不寫檔', () => {
  for (const payload of ['', 'not json', '[]', 'null', '42', '{"tool_name":"Bash"}']) {
    const r = runHook(payload)
    assert.equal(r.code, 0, `payload: ${payload}`)
    assert.equal(r.written, null)
  }
})

test('HELM_OFF=1 時完全 no-op', () => {
  const r = runHook(bash('npm test'), { env: { HELM_OFF: '1' } })
  assert.equal(r.code, 0)
  assert.equal(r.written, null)
})

test('繼承的 SHELLOPTS=errexit 不再讓 hook 非零結束', () => {
  // 舊的 shell 版整段靠「非零狀態往下掉」運作，errexit 一開就從第二行炸掉。
  const r = runHook(bash('npm test'), { env: { SHELLOPTS: 'errexit' } })
  assert.equal(r.code, 0)
  assert.equal(summaryOf(r), 'npm test')
})

test('live 目錄不存在時 exit 0，並把原因寫進錯誤紀錄', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'helm-hook-')), 'errors.log')
  const r = runHook(bash('npm test'), {
    liveDir: join(tmpdir(), 'helm-hook-does-not-exist'),
    errorsLog: log,
  })
  assert.equal(r.code, 0)
  assert.match(safeRead(log), /ENOENT/)
})

test('live 目錄唯讀時 exit 0，且不留下暫存檔', () => {
  const live = mkdtempSync(join(tmpdir(), 'helm-hook-'))
  chmodSync(live, 0o500)
  try {
    assert.equal(runHook(bash('npm test'), { liveDir: live }).code, 0)
    assert.deepEqual(readdirSync(live), [])
  } finally {
    chmodSync(live, 0o700)
  }
})

test('連錯誤紀錄都寫不進去時仍然 exit 0', () => {
  const r = runHook(bash('npm test'), {
    liveDir: join(tmpdir(), 'helm-hook-does-not-exist'),
    errorsLog: '/proc/nonexistent/errors.log',
  })
  assert.equal(r.code, 0)
})

test('寫入是原子的 —— 不留暫存檔，且既有的合法 marker 不會被寫壞', () => {
  const live = mkdtempSync(join(tmpdir(), 'helm-hook-'))
  runHook(bash('first'), { liveDir: live })
  runHook(bash('second'), { liveDir: live })
  assert.deepEqual(readdirSync(live).filter((n) => n.includes('.tmp')), [])
  const body = readFileSync(join(live, `${ID}.json`), 'utf8')
  assert.equal((JSON.parse(body) as { summary: string }).summary, 'second')
})

test('既有 marker 是唯讀時仍然更新得了 —— 原子寫換的是 inode', () => {
  // 這條原本叫做「寫入失敗但不破壞它」，斷言是 assert.ok(… || true)：恆真。
  // 把它寫成真的斷言之後才看到，實際行為跟名字說的相反 —— rename 只需要
  // 目錄的寫權限，不需要舊檔的。而那才是對的：marker 是 helm 自己的資料，
  // 一個唯讀的舊檔不該讓「此刻正在跑什麼」從此凍結在過去。
  const live = mkdtempSync(join(tmpdir(), 'helm-hook-'))
  const target = join(live, `${ID}.json`)
  writeFileSync(target, '{"sessionId":"stale"}\n')
  chmodSync(target, 0o400)
  try {
    assert.equal(runHook(bash('npm test'), { liveDir: live }).code, 0)
    const after = JSON.parse(readFileSync(target, 'utf8')) as { summary: string }
    assert.equal(after.summary, 'npm test')
    assert.deepEqual(readdirSync(live).filter((n) => n.includes('.tmp')), [], '不留暫存檔')
  } finally {
    chmodSync(target, 0o600)
  }
})

test('buildHookCommand 產出單行、帶識別字、且路徑經過跳脫', () => {
  const cmd = buildHookCommand('/h/live', '/h/errors.log')
  assert.ok(!cmd.includes('\n'), 'settings.json 裡的指令必須是單行')
  assert.ok(cmd.includes(HOOK_MARKER))
  assert.match(cmd, /^exec '[^']+' --no-warnings /)
  assert.ok(cmd.includes(recorderPath()))
})

test('路徑含 $ 或引號時仍能正確執行', () => {
  const live = mkdirSync(join(mkdtempSync(join(tmpdir(), 'helm-hook-')), 'we$ird "dir'), {
    recursive: true,
  }) as string
  const r = runHook(bash('npm test'), { liveDir: live })
  assert.equal(r.code, 0)
  assert.equal(summaryOf(r), 'npm test')
})

test('shellQuote 交給真的 shell 驗證是單一參數', () => {
  for (const s of ['/a b', "/it's", '/a$b', '/a"b', '/a\\b']) {
    const back = execFileSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(s)}`], { encoding: 'utf8' })
    assert.equal(back, s)
  }
})
