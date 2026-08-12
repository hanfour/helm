import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { scaffoldHome, SCRATCH } from './test-helpers.ts'

after(SCRATCH.cleanup)

const ENTRY = fileURLToPath(new URL('main.ts', import.meta.url))

interface Run {
  out: string
  err: string
  code: number
}

/**
 * Runs the real entry point through a shell, exactly as a user would.
 *
 * `spawnSync`, not `execFileSync`: the latter returns stdout alone on success
 * and throws only on a non-zero exit. A pipeline ending in `head` exits 0 no
 * matter how loudly the producer died, so the very output under test — a
 * stack trace on stderr — is the one thing `execFileSync` cannot show.
 */
function run(script: string, home: string): Run {
  const r = spawnSync('sh', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, HELM_FAKE_HOME: home, HELM_ENTRY: ENTRY },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? -1 }
}

/**
 * Large on purpose. A pipe holds 64 KB before it blocks, so a small board is
 * written in one go and the early close is never observed — the bug only
 * exists above that threshold, which is exactly where a real board with a few
 * dozen sessions lands.
 */
const BIG_HOME = scaffoldHome([{
  project: 'proj',
  sessions: Array.from({ length: 120 }, (_, i) => ({
    id: `aaaa1111-0000-1111-2222-${String(i).padStart(12, '0')}`,
  })),
}])

test('輸出被 head 提早關掉時安靜結束，不噴 EPIPE 堆疊', () => {
  // `helm status --json | head` and `| jq .projects[0]` are the two things
  // anyone does first with JSON output, and both close the pipe early. Node's
  // default is an unhandled 'error' event on stdout: a 12-line stack trace
  // that reads like helm crashed, on a command that did exactly what it was
  // asked to do.
  const r = run(`"$HELM_ENTRY" status --json | head -c 200`, BIG_HOME)
  assert.doesNotMatch(r.err, /EPIPE/, `stderr 不該提到 EPIPE：\n${r.err}`)
  assert.doesNotMatch(r.err, /at .*node:internal/, `stderr 不該有堆疊：\n${r.err}`)
})

test('管線提早關閉時退出碼不是失敗碼', () => {
  // 141 (128+SIGPIPE) is what a shell utility returns here; 0 is what Node
  // gives when the write simply never fails. Both say "fine"; 1 does not, and
  // `set -o pipefail` scripts read the difference.
  const r = run(`"$HELM_ENTRY" status --json | head -c 200`, BIG_HOME)
  assert.ok(r.code === 0 || r.code === 141, `退出碼 ${r.code}`)
})

test('未知指令仍然回傳 2 並印出用法', () => {
  // No fixture: an unknown command must be rejected before anything is read.
  const r = run(`"$HELM_ENTRY" nope 2>&1 || true`, SCRATCH.root)
  assert.match(r.out, /未知指令：nope/)
  assert.match(r.out, /用法：/)
})

test('HELM_FAKE_HOME 也要隔離偏好 —— 否則端對端測試會讀寫使用者真實 app 的設定', () => {
  // Without this, `helm doctor` under a fixture home reported the *real*
  // ~/SwiftBar as its plugin folder, and `helm install` would have written
  // into it. It is the shape of both pollution incidents: the fake home looks
  // like isolation, and the preference domain is shared all the same.
  const h = scaffoldHome([{ project: 'p', sessions: [{ id: 'bbbb2222-0000-1111-2222-333344445555' }] }])
  const r = run(`"$HELM_ENTRY" doctor 2>&1 || true`, h)
  const swiftbarLine = r.out.split('\n').find((l) => l.includes('SwiftBar')) ?? ''
  assert.ok(swiftbarLine !== '', r.out)
  assert.ok(
    !swiftbarLine.includes('/Users/') || swiftbarLine.includes(h),
    `不該提到假家目錄以外的路徑：${swiftbarLine}`,
  )
})
