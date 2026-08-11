import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
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
 * scratch directory instead (gitignored), cleaned up after this file's
 * tests finish.
 *
 * Namespaced by process.pid, and after() only removes that one subtree:
 * `node --test` can run multiple test files as separate processes, and an
 * unqualified shared path would let one process's cleanup delete fixtures
 * a concurrent process is still using mid-test.
 */
const SCRATCH_ROOT = fileURLToPath(
  new URL(`../../.test-scratch/${process.pid}/`, import.meta.url),
)
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
  const out = collectStatus(resolvePaths({ home }), NOW, () => ({ alive: new Map(), unreachable: new Set<number>() }))
  assert.equal(out.projects.length, 1)
  assert.equal(out.projects[0]?.name, 'proj')
  assert.equal(out.projects[0]?.sessions.length, 1)
  assert.equal(out.invalid, 0)
})

test('PID 已死時判定為 crashed', () => {
  const { home } = scaffold()
  const out = collectStatus(resolvePaths({ home }), NOW, () => ({ alive: new Map(), unreachable: new Set<number>() }))
  assert.equal(out.projects[0]?.sessions[0]?.lifecycle, 'crashed')
})

test('PID 存活且 procStart 相符時判定為 running', () => {
  const { home } = scaffold()
  const alive = new Map([[4242, fmtLocal(new Date(PROC_START_INSTANT))]])
  const out = collectStatus(resolvePaths({ home }), NOW, () => ({ alive, unreachable: new Set<number>() }))
  assert.equal(out.projects[0]?.sessions[0]?.lifecycle, 'running')
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
  assert.deepEqual(
    collectStatus(resolvePaths({ home }), NOW, () => ({ alive: new Map(), unreachable: new Set<number>() })),
    { projects: [], invalid: 0, prefsCorrupt: false },
  )
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

test('釘選的專案即使超過 14 天沒有活動仍列得出來', () => {
  // shouldInclude 的 pinned 例外只有在該專案的 session 進得了探索結果時才走得到。
  // 探索若先用同一個 14 天窗口把 transcript 濾掉，那條例外永遠是死碼，
  // 而使用者會看到自己明確釘選的專案默默消失。
  const home = mkdtempSync(join(SCRATCH_ROOT, 'helm-pinned-'))
  const cwd = join(home, 'side-project')
  mkdirSync(join(cwd, '.git'), { recursive: true })
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  const dir = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const transcript = join(dir, 'aaaa1111-0000-1111-2222-333344445555.jsonl')
  writeFileSync(transcript, '{}\n')
  const longAgo = (NOW - 20 * 86_400_000) / 1000
  utimesSync(transcript, longAgo, longAgo)

  mkdirSync(join(home, '.helm'), { recursive: true })
  writeFileSync(
    join(home, '.helm', 'projects.json'),
    JSON.stringify({ version: 1, projects: { [cwd]: { pinned: true, hidden: false } } }),
  )

  const out = collectStatus(resolvePaths({ home }), NOW, () => ({ alive: new Map(), unreachable: new Set<number>() }))
  assert.deepEqual(out.projects.map((p) => p.name), ['side-project'])
})

test('沒有釘選的專案超過 14 天沒活動就不列出 —— 窗口本身仍然有效', () => {
  const home = mkdtempSync(join(SCRATCH_ROOT, 'helm-stale-'))
  const cwd = join(home, 'old-project')
  mkdirSync(join(cwd, '.git'), { recursive: true })
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  const dir = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const transcript = join(dir, 'bbbb2222-0000-1111-2222-333344445555.jsonl')
  writeFileSync(transcript, '{}\n')
  const longAgo = (NOW - 20 * 86_400_000) / 1000
  utimesSync(transcript, longAgo, longAgo)

  assert.deepEqual(collectStatus(resolvePaths({ home }), NOW, () => ({ alive: new Map(), unreachable: new Set<number>() })).projects, [])
})
