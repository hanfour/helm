import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { resolvePaths } from '../paths.ts'
import { collectStatus } from './status.ts'

const NOW = Date.UTC(2026, 7, 11, 3, 0, 0)
/** The registry stores procStart in UTC; keep these two in sync deliberately. */
const PROC_START_UTC = 'Tue Aug 11 02:00:00 2026'
const PROC_START_INSTANT = Date.UTC(2026, 7, 11, 2, 0, 0)

/**
 * collectStatus wires real existsSync-based cwdExists/isGitRepo checks, and
 * include.ts deliberately excludes anything under the OS temp root (/tmp,
 * and macOS's /var/folders which is what os.tmpdir() resolves to) as noise.
 * A fixture project rooted in the system temp dir would therefore always be
 * filtered out regardless of lifecycle, so fixtures live in a repo-local
 * scratch directory instead, cleaned up after this file's tests finish.
 */
const SCRATCH_ROOT = fileURLToPath(new URL('../../.test-scratch/', import.meta.url))
mkdirSync(SCRATCH_ROOT, { recursive: true })
after(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true })
})

function scaffold(): { home: string; cwd: string } {
  const home = mkdtempSync(join(SCRATCH_ROOT, 'helm-status-'))
  const cwd = join(home, 'proj')
  mkdirSync(join(cwd, '.git'), { recursive: true })
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  writeFileSync(
    join(home, '.claude', 'sessions', '4242.json'),
    JSON.stringify({
      pid: 4242, sessionId: 'sess-live', cwd,
      startedAt: NOW - 60_000, procStart: PROC_START_UTC,
      kind: 'interactive', name: 'proj-01', status: 'idle', updatedAt: NOW - 60_000,
    }),
  )
  return { home, cwd }
}

test('collectStatus 串起探索、判定與分組', () => {
  const { home } = scaffold()
  const out = collectStatus(resolvePaths({ home }), NOW, () => new Map())
  assert.equal(out.length, 1)
  assert.equal(out[0]?.name, 'proj')
  assert.equal(out[0]?.sessions.length, 1)
})

test('PID 已死時判定為 crashed', () => {
  const { home } = scaffold()
  const out = collectStatus(resolvePaths({ home }), NOW, () => new Map())
  assert.equal(out[0]?.sessions[0]?.lifecycle, 'crashed')
})

test('PID 存活且 procStart 相符時判定為 running', () => {
  const { home } = scaffold()
  const alive = new Map([[4242, fmtLocal(new Date(PROC_START_INSTANT))]])
  const out = collectStatus(resolvePaths({ home }), NOW, () => alive)
  assert.equal(out[0]?.sessions[0]?.lifecycle, 'running')
})

test('沒有 .git 的目錄不會出現', () => {
  const home = mkdtempSync(join(SCRATCH_ROOT, 'helm-status-'))
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  mkdirSync(join(home, 'plain'), { recursive: true })
  writeFileSync(
    join(home, '.claude', 'sessions', '1.json'),
    JSON.stringify({
      pid: 1, sessionId: 's', cwd: join(home, 'plain'), startedAt: NOW,
      procStart: PROC_START_UTC, kind: 'interactive', name: '',
      status: 'idle', updatedAt: NOW,
    }),
  )
  assert.deepEqual(collectStatus(resolvePaths({ home }), NOW, () => new Map()), [])
})

/** Render a Date the way `LC_ALL=C ps -o lstart=` would, in local time. */
function fmtLocal(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n: number) => String(n).padStart(2, '0')
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`
}
