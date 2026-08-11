import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSessions } from './sessions.ts'

/**
 * Fixtures cannot live in the OS temp dir: include.ts deliberately excludes
 * /tmp and /var/folders as noise, so a project rooted there would never be
 * listed. Namespaced by pid because `node --test` runs files as separate
 * processes and a shared path would let one clean up another's fixtures.
 */
const SCRATCH_ROOT = fileURLToPath(
  new URL(`../../.test-scratch/${process.pid}-sessions/`, import.meta.url),
)
mkdirSync(SCRATCH_ROOT, { recursive: true })
after(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true })
})

const slugify = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-')

/** A home whose only project holds one ended session, found via transcript. */
function scaffold(projectName: string, sessionIds: readonly string[]): string {
  const home = mkdtempSync(join(SCRATCH_ROOT, 'home-'))
  const cwd = join(home, projectName)
  mkdirSync(join(cwd, '.git'), { recursive: true })
  const dir = join(home, '.claude', 'projects', slugify(cwd))
  mkdirSync(dir, { recursive: true })
  for (const id of sessionIds) writeFileSync(join(dir, `${id}.jsonl`), '{}\n')
  return home
}

interface Captured {
  code: number
  out: string
  err: string
}

function run(home: string | null, argv: readonly string[]): Captured {
  const outs: string[] = []
  const errs: string[] = []
  const realOut = process.stdout.write.bind(process.stdout)
  const realErr = process.stderr.write.bind(process.stderr)
  const previous = process.env['HELM_FAKE_HOME']
  process.stdout.write = ((c: string) => (outs.push(String(c)), true)) as typeof process.stdout.write
  process.stderr.write = ((c: string) => (errs.push(String(c)), true)) as typeof process.stderr.write
  if (home !== null) process.env['HELM_FAKE_HOME'] = home
  try {
    return { code: runSessions(argv), out: outs.join(''), err: errs.join('') }
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
    if (previous === undefined) delete process.env['HELM_FAKE_HOME']
    else process.env['HELM_FAKE_HOME'] = previous
  }
}

test('沒給專案時印出用法並回傳 2', () => {
  const r = run(null, [])
  assert.equal(r.code, 2)
  assert.match(r.err, /用法/)
})

test('只給旗標而沒給專案，仍視為沒給', () => {
  assert.equal(run(null, ['--no-color']).code, 2)
})

test('展開專案底下的 session', () => {
  const home = scaffold('proj', ['aaaa1111-0000-0000-0000-000000000000'])
  const r = run(home, ['proj', '--no-color'])
  assert.equal(r.code, 0)
  assert.match(r.out, /proj/)
  assert.match(r.out, /aaaa1111/)
})

test('列出的是註冊表以外、只靠 transcript 找到的 session', () => {
  // 這個 fixture 完全沒有 ~/.claude/sessions 檔案 —— 重開機後的實況。
  const home = scaffold('proj', [
    'aaaa1111-0000-0000-0000-000000000000',
    'bbbb2222-0000-0000-0000-000000000000',
  ])
  const r = run(home, ['proj', '--no-color'])
  assert.match(r.out, /aaaa1111/)
  assert.match(r.out, /bbbb2222/)
  assert.match(r.out, /2 個 session/)
})

test('用 session id 前綴指定時，展開的是它所屬的專案', () => {
  const home = scaffold('proj', ['aaaa1111-0000-0000-0000-000000000000'])
  const r = run(home, ['aaaa1111', '--no-color'])
  assert.equal(r.code, 0)
  assert.match(r.out, /proj/)
})

test('找不到專案時回傳 1 並說明', () => {
  const home = scaffold('proj', ['aaaa1111-0000-0000-0000-000000000000'])
  const r = run(home, ['nope', '--no-color'])
  assert.equal(r.code, 1)
  assert.match(r.err, /找不到/)
  assert.equal(r.out, '')
})

test('--no-color 時輸出不含 ANSI', () => {
  const home = scaffold('proj', ['aaaa1111-0000-0000-0000-000000000000'])
  assert.ok(!run(home, ['proj', '--no-color']).out.includes(String.fromCharCode(27)))
})
