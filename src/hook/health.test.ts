import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePaths } from '../paths.ts'
import { runChecks, sweepStaleLive, type Check } from './health.ts'
import type { CheckDeps } from './health.ts'
import type { Board } from '../board.ts'
import type { SessionState } from '../types.ts'
import { fakePrefs, NO_PREFS } from './test-prefs.ts'
import { installHook } from './install.ts'
import { tempDir } from '../temp-dir.ts'

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0)
const DAY = 86_400_000

const sess = (over: Partial<SessionState>): SessionState => ({
  adapterId: 'claude-code', sessionId: 's', cwd: '/p', pid: null, procStart: null,
  startedAt: 0, updatedAt: NOW, nativeStatus: null, kind: 'interactive', name: '',
  transcriptPath: null, transcriptMtimeMs: null, lifecycle: 'ended_clean',
  lifecycleConfidence: 'high', live: null, ...over,
})

const board = (
  sessions: SessionState[] = [],
  over: Partial<Board> = {},
): Board => ({
  projects: sessions.length === 0 ? [] : [{
    path: '/p', name: 'p', pinned: false, lastActivityMs: NOW,
    aggregateStatus: null, sessionCount: sessions.length, sessions,
  }],
  invalid: 0,
  prefsHealth: 'ok' as const,
  ...over,
})

const HOMES: string[] = []

after(() => {
  for (const h of HOMES) rmSync(h, { recursive: true, force: true })
})

function home(): string {
  const h = tempDir('helm-doctor-')
  HOMES.push(h)
  mkdirSync(join(h, '.claude'), { recursive: true })
  writeFileSync(join(h, '.claude', 'settings.json'), '{}')
  return h
}

/** A body the reader accepts, so the sweep is exercised rather than blocked. */
const marker = (sessionId: string) =>
  JSON.stringify({ sessionId, ts: 0, toolName: 'Bash', summary: 'x' })


/**
 * Both apps are reported as installed by default, and never probed for real.
 * Reading /Applications made every menu-bar and desktop assertion conditional
 * on the machine running the suite — which is to say, on a CI box they
 * asserted nothing at all.
 */
const SCRATCH_HOME = tmpdir()

const INSTALL_DEPS = {
  now: () => 1786000000000,
  repoRoot: fileURLToPath(new URL('../..', import.meta.url)),
  swiftbar: NO_PREFS,
  ubersicht: NO_PREFS,
  swiftbarInstalled: true,
  ubersichtInstalled: true,
}

const checksOf = (home: string, b = board(), extra: CheckDeps = {}) =>
  runChecks(resolvePaths({ home }), b, {
    swiftbar: NO_PREFS,
    ubersicht: NO_PREFS,
    swiftbarInstalled: true,
    ubersichtInstalled: true,
    ...extra,
  })

const find = (checks: readonly Check[], name: string) =>
  checks.find((c) => c.name.includes(name))

test('hook 未安裝時檢查不通過，並告訴使用者怎麼裝', () => {
  const c = find(checksOf(home(), board()), 'hook')
  assert.equal(c?.ok, false)
  assert.match(c?.detail ?? '', /helm install/)
})

test('hook 錯誤紀錄非空時檢查不通過並印出內容', () => {
  // hook 是「絕不靜默吞錯」的唯一豁免，而這裡就是它的補償。
  // 沒有這個檢查，那些錯誤就真的只是被吞掉。
  const h = home()
  mkdirSync(join(h, '.helm'), { recursive: true })
  writeFileSync(join(h, '.helm', 'hook-errors.log'), 'sh: 壞掉了\n')
  const c = find(checksOf(h, board()), '錯誤')
  assert.equal(c?.ok, false)
  assert.match(c?.detail ?? '', /壞掉了/)
})

test('註冊表有解析失敗時如實回報數量 —— table.ts 承諾過這裡查得到原因', () => {
  const c = find(checksOf(home(), board([], { invalid: 3 })), '註冊表')
  assert.equal(c?.ok, false)
  assert.match(c?.detail ?? '', /3/)
})

test('偏好檔毀損時回報，並指出原檔被保留在哪', () => {
  const c = find(checksOf(home(), board([], { prefsHealth: 'quarantined' as const })), '偏好')
  assert.equal(c?.ok, false)
  assert.match(c?.detail ?? '', /corrupt/)
})

test('live 目錄不存在時檢查不通過', () => {
  const c = find(checksOf(home(), board()), 'live')
  assert.equal(c?.ok, false)
})

test('每一項都帶名稱與說明，沒有空欄位', () => {
  const checks = checksOf(home(), board())
  assert.ok(checks.length >= 6)
  assert.ok(checks.every((c) => c.name !== '' && c.detail !== ''))
})

test('清理掉已正常結束的 session 的 live 檔', () => {
  const h = home()
  const live = join(h, '.helm', 'live')
  mkdirSync(live, { recursive: true })
  writeFileSync(join(live, 'done.json'), marker('done'))
  const removed = sweepStaleLive(
    resolvePaths({ home: h }),
    board([sess({ sessionId: 'done', lifecycle: 'ended_clean' })]),
    NOW,
  )
  assert.deepEqual(removed, ['done.json'])
  assert.equal(existsSync(join(live, 'done.json')), false)
})

test('還在跑的 session 的 live 檔不動', () => {
  const h = home()
  const live = join(h, '.helm', 'live')
  mkdirSync(live, { recursive: true })
  writeFileSync(join(live, 'busy.json'), '{}')
  const removed = sweepStaleLive(
    resolvePaths({ home: h }),
    board([sess({ sessionId: 'busy', lifecycle: 'running' })]),
    NOW,
  )
  assert.deepEqual(removed, [])
})

test('中斷的 session 的 live 檔不動 —— 那正是它中斷的證據', () => {
  const h = home()
  const live = join(h, '.helm', 'live')
  mkdirSync(live, { recursive: true })
  writeFileSync(join(live, 'crashed.json'), '{}')
  const removed = sweepStaleLive(
    resolvePaths({ home: h }),
    board([sess({ sessionId: 'crashed', lifecycle: 'crashed' })]),
    NOW,
  )
  assert.deepEqual(removed, [])
})

test('超過 30 天的孤兒 live 檔即使不認得也清掉', () => {
  const h = home()
  const live = join(h, '.helm', 'live')
  mkdirSync(live, { recursive: true })
  const f = join(live, 'orphan.json')
  writeFileSync(f, '{}')
  const old = (NOW - 31 * DAY) / 1000
  utimesSync(f, old, old)
  assert.deepEqual(sweepStaleLive(resolvePaths({ home: h }), board(), NOW), ['orphan.json'])
})

test('認不得但還很新的 live 檔留著 —— 那可能正是當機的唯一證據', () => {
  // 當機的 session 不在註冊表裡，它的 live 檔就是 §6 真值表最後一列賴以判定的
  // 東西。清得太積極等於湮滅證據，而且湮滅之後沒有任何人會發現。
  const h = home()
  const live = join(h, '.helm', 'live')
  mkdirSync(live, { recursive: true })
  writeFileSync(join(live, 'unknown.json'), '{}')
  assert.deepEqual(sweepStaleLive(resolvePaths({ home: h }), board(), NOW), [])
})

test('live 目錄不存在時清理是 no-op', () => {
  assert.deepEqual(sweepStaleLive(resolvePaths({ home: home() }), board(), NOW), [])
})

test('sweepStaleLive 不修改輸入', () => {
  const input = board([sess({ sessionId: 'done' })])
  const snapshot = structuredClone(input)
  sweepStaleLive(resolvePaths({ home: home() }), input, NOW)
  assert.deepEqual(input, snapshot)
})

test('讀不出來的 live 檔即使 session 看起來已結束也不刪 —— 那正是它中斷的證據', () => {
  // 這是整條鏈的最後一環：內容壞掉 → lifecycle 判 ended_clean（現在是低信心）
  // → sweep 看到它在 ended 集合裡 → 刪掉。刪掉之後誤判就永久了，
  // 而磁碟上再也沒有東西可供檢查。
  const h = home()
  const live = join(h, '.helm', 'live')
  mkdirSync(live, { recursive: true })
  writeFileSync(join(live, 'broken.json'), '{寫到一半')
  const removed = sweepStaleLive(
    resolvePaths({ home: h }),
    board([sess({ sessionId: 'broken', lifecycle: 'ended_clean' })]),
    NOW,
  )
  assert.deepEqual(removed, [])
  assert.equal(existsSync(join(live, 'broken.json')), true)
})

test('低信心的 ended_clean 不足以構成刪除的理由', () => {
  const h = home()
  const live = join(h, '.helm', 'live')
  mkdirSync(live, { recursive: true })
  writeFileSync(join(live, 'maybe.json'), JSON.stringify({ sessionId: 'maybe', ts: 0 }))
  const removed = sweepStaleLive(
    resolvePaths({ home: h }),
    board([sess({ sessionId: 'maybe', lifecycle: 'ended_clean', lifecycleConfidence: 'low' })]),
    NOW,
  )
  assert.deepEqual(removed, [])
})

test('超過 30 天的壞檔仍然清得掉 —— 不能無限累積', () => {
  const h = home()
  const live = join(h, '.helm', 'live')
  mkdirSync(live, { recursive: true })
  const f = join(live, 'ancient.json')
  writeFileSync(f, '{壞掉')
  const old = (NOW - 31 * DAY) / 1000
  utimesSync(f, old, old)
  assert.deepEqual(sweepStaleLive(resolvePaths({ home: h }), board(), NOW), ['ancient.json'])
})

test('資料來源整個讀不到時檢查不通過 —— invalid: 0 不代表健康', () => {
  // readRegistry 讀不到目錄時回 invalid: 0，於是主要資料來源最大的失敗模式
  // 對那個以它命名的檢查完全隱形。
  const h = home()
  const sessions = join(h, '.claude', 'sessions')
  mkdirSync(sessions, { recursive: true })
  chmodSync(sessions, 0o000)
  try {
    const c = find(checksOf(h, board()), '資料來源')
    assert.equal(c?.ok, false)
    assert.match(c?.detail ?? '', /sessions/)
  } finally {
    chmodSync(sessions, 0o755)
  }
})

test('live 目錄存在但不可寫時檢查不通過 —— 那正是這一項在講的事', () => {
  const h = home()
  const live = join(h, '.helm', 'live')
  mkdirSync(live, { recursive: true })
  chmodSync(live, 0o500)
  try {
    const c = find(checksOf(h, board()), 'live')
    assert.equal(c?.ok, false)
    assert.match(c?.detail ?? '', /寫/)
  } finally {
    chmodSync(live, 0o755)
  }
})

test('錯誤紀錄寫不進去時檢查不通過 —— 否則 hook 停擺而 doctor 全綠', () => {
  // hook 的錯誤全部導向那個檔案。它本身開不起來時，hook 一個 marker 都寫
  // 不出來，而讀它的檢查必然回報「沒有錯誤」。
  const h = home()
  mkdirSync(join(h, '.helm'), { recursive: true })
  chmodSync(join(h, '.helm'), 0o500)
  try {
    const c = find(checksOf(h, board()), '錯誤紀錄')
    assert.equal(c?.ok, false)
  } finally {
    chmodSync(join(h, '.helm'), 0o755)
  }
})

test('settings.json 解析不了時說的是「讀不到」，而不是「未安裝」', () => {
  // 回報「未安裝」並叫使用者跑 helm install，而 install 會拒絕執行 ——
  // 建議在原地打轉。而且 hook 可能其實裝著，只是檔案被別的工具弄壞了。
  const h = home()
  writeFileSync(join(h, '.claude', 'settings.json'), '{壞掉')
  const c = find(checksOf(h, board()), 'hook')
  assert.equal(c?.ok, false)
  assert.match(c?.detail ?? '', /無法解析/)
  assert.ok(!(c?.detail ?? '').includes('helm install'), '不該叫使用者跑一個會拒絕執行的指令')
})

test('hook 錯誤紀錄的說明要講出檔案在哪、以及可以清掉', () => {
  const h = home()
  mkdirSync(join(h, '.helm'), { recursive: true })
  writeFileSync(join(h, '.helm', 'hook-errors.log'), 'boom\n')
  const c = find(checksOf(h, board()), '錯誤紀錄')
  assert.match(c?.detail ?? '', /hook-errors\.log/)
  assert.match(c?.detail ?? '', /清/)
})

test('SwiftBar plugin 沒有執行權限時檢查不通過 —— SwiftBar 不會跑它', () => {
  const h = home()
  const dir = join(h, 'SwiftBar')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'helm.5s.sh'), '#!/bin/sh\n')
  chmodSync(join(dir, 'helm.5s.sh'), 0o644)
  const c = find(checksOf(h, board()), 'SwiftBar')
  assert.equal(c?.ok, false)
  assert.match(c?.detail ?? '', /執行權限/)
})

test('SwiftBar 沒裝時檢查不通過，並給出安裝指令', () => {
  const c = find(checksOf(home(), board(), { swiftbarInstalled: false }), 'SwiftBar')
  assert.equal(c?.ok, false)
  assert.match(c?.detail ?? '', /brew install --cask swiftbar/)
})

test('Übersicht 沒裝時檢查不通過，並給出安裝指令', () => {
  const c = find(checksOf(home(), board(), { ubersichtInstalled: false }), 'Übersicht')
  assert.equal(c?.ok, false)
  assert.match(c?.detail ?? '', /brew install --cask ubersicht/)
})

test('widget 不在 Übersicht 掃描的資料夾裡時檢查不通過，並說出它掃的是哪一個', () => {
  // The exact dead end helm keeps producing: file written, checks green,
  // and nothing on screen because the app is looking somewhere else.
  const h = home()
  const elsewhere = join(h, 'somewhere-else')
  const c = find(
    checksOf(h, board(), { ubersicht: fakePrefs({ widgetDir: elsewhere }) }),
    'Übersicht',
  )
  assert.equal(c?.ok, false)
  assert.ok(c?.detail.includes(elsewhere), c?.detail)
})

test('widget 在正確的資料夾裡時檢查通過', () => {
  const h = home()
  const dir = join(h, 'Library', 'Application Support', 'Übersicht', 'widgets')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'helm.jsx'), '// HELM_LIVE_MARKER\n')
  const c = find(checksOf(h, board()), 'Übersicht')
  assert.equal(c?.ok, true, c?.detail)
})

test('已經不存在的檔案不計入「順手清掉 N 個」', () => {
  // rmSync 帶 force 對不存在的檔案也不報錯，用呼叫次數當計數會灌水。
  const h = home()
  const live = join(h, '.helm', 'live')
  mkdirSync(live, { recursive: true })
  mkdirSync(join(live, 'a-directory.json'))
  const old = (NOW - 31 * DAY) / 1000
  utimesSync(join(live, 'a-directory.json'), old, old)
  assert.deepEqual(sweepStaleLive(resolvePaths({ home: h }), board(), NOW), [])
})

/** Installs for real, then breaks one thing, so the checks face a real layout. */
function installed(extra: Parameters<typeof installHook>[1] = INSTALL_DEPS): string {
  const h = home()
  installHook(resolvePaths({ home: h }), extra)
  return h
}

test('hook 釘住的 node 不見時檢查不通過 —— 那是版本管理器升級後的常態', () => {
  // Three reviewers found this independently: nvm/brew delete the old image,
  // every artefact keeps pointing at it, the hook and the menu bar die
  // silently, and doctor reports nine green checks. `hook 錯誤紀錄` cannot
  // save it either — the failure happens before record.mjs is ever loaded, so
  // no log line is written and the check says "no errors".
  const h = installed({ ...INSTALL_DEPS, nodeBin: join(SCRATCH_HOME, 'gone', 'node') })
  const c = find(checksOf(h), '執行路徑')
  assert.equal(c?.ok, false, c?.detail)
  assert.match(c?.detail ?? '', /node/)
  assert.match(c?.detail ?? '', /hook|PreToolUse/)
})

test('wrapper 被刪掉時檢查不通過 —— SwiftBar plugin 靠它才跑得起來', () => {
  // Tidying ~/.local/bin is ordinary. The plugin then exits 126 on every
  // refresh while the SwiftBar check stays green, because it only ever
  // verified that the plugin file itself exists and is executable.
  const h = installed()
  rmSync(join(h, '.local', 'bin', 'helm'), { force: true })
  const c = find(checksOf(h), '執行路徑')
  assert.equal(c?.ok, false, c?.detail)
  assert.match(c?.detail ?? '', /helm/)
})

test('進入點不見時檢查不通過 —— repo 搬家就是這樣', () => {
  const h = installed({ ...INSTALL_DEPS, repoRoot: join(SCRATCH_HOME, 'moved-away') })
  const c = find(checksOf(h), '執行路徑')
  assert.equal(c?.ok, false, c?.detail)
  assert.match(c?.detail ?? '', /main\.ts/)
})

test('全部就位時執行路徑這一項通過', () => {
  const c = find(checksOf(installed()), '執行路徑')
  assert.equal(c?.ok, true, c?.detail)
})

test('還沒安裝時執行路徑不報錯 —— 沒東西可檢查不等於壞掉', () => {
  const c = find(checksOf(home()), '執行路徑')
  assert.equal(c?.ok, true, c?.detail)
  assert.match(c?.detail ?? '', /尚未安裝|沒有/)
})

test('錯誤紀錄還不存在時這一項要通過 —— 那正是一切正常的樣子', () => {
  // The check fell back to the parent directory when the log was absent, so a
  // brand-new machine (no ~/.helm yet) was told to go and check the
  // permissions of a directory that does not exist — while `live 目錄` said
  // "run helm install" about the very same state.
  const h = installed()
  assert.equal(existsSync(join(h, '.helm', 'hook-errors.log')), false, '前提：還沒有錯誤')
  const c = find(checksOf(h), '錯誤紀錄')
  assert.equal(c?.ok, true, c?.detail)
})

test('HELM_OFF=1 時如實說 hook 停用中 —— 靜默停用是個陷阱', () => {
  const before = process.env['HELM_OFF']
  process.env['HELM_OFF'] = '1'
  try {
    const c = find(checksOf(home()), '啟用')
    assert.equal(c?.ok, false, c?.detail)
    assert.match(c?.detail ?? '', /HELM_OFF/)
  } finally {
    if (before === undefined) delete process.env['HELM_OFF']
    else process.env['HELM_OFF'] = before
  }
})

test('資料來源還沒建立時算正常 —— Claude Code 第一次跑之前本來就沒有', () => {
  const c = find(checksOf(home()), '資料來源')
  assert.equal(c?.ok, true, c?.detail)
})

test('清掉的數量只算真的刪成功的 —— 用呼叫次數會灌水', () => {
  // `rmSync` with `force` does not complain about a file that vanished
  // between the listing and the delete, so counting attempts reports work
  // that never happened. The existing test only covered the throwing path.
  const h = home()
  const live = join(h, '.helm', 'live')
  mkdirSync(live, { recursive: true })
  const id = 'dddd4444-0000-1111-2222-333344445555'
  const file = join(live, `${id}.json`)
  writeFileSync(file, marker(id))
  const old = (Date.now() - 40 * 86_400_000) / 1000
  utimesSync(file, old, old)

  const first = sweepStaleLive(resolvePaths({ home: h }), board(), Date.now())
  assert.equal(first.length, 1)
  const second = sweepStaleLive(resolvePaths({ home: h }), board(), Date.now())
  assert.deepEqual(second, [], '已經不在的檔案不算數')
})

test('孤兒的年齡界線是 30 天 —— 29 天留著，31 天清掉', () => {
  // Neither side of the boundary was tested, so shrinking it to 3 days passed
  // — and the evidence of a crash would be swept ten times sooner.
  const h = home()
  const live = join(h, '.helm', 'live')
  mkdirSync(live, { recursive: true })
  const write = (id: string, days: number) => {
    const f = join(live, `${id}.json`)
    writeFileSync(f, marker(id))
    const t = (Date.now() - days * 86_400_000) / 1000
    utimesSync(f, t, t)
    return f
  }
  const young = write('eeee5555-0000-1111-2222-333344445555', 29)
  const aged = write('ffff6666-0000-1111-2222-333344445555', 31)

  sweepStaleLive(resolvePaths({ home: h }), board(), Date.now())
  assert.equal(existsSync(young), true, '29 天還不算孤兒')
  assert.equal(existsSync(aged), false, '31 天要清掉')
})

test('錯誤紀錄印出最後 5 行 —— 少了就看不出模式', () => {
  const h = home()
  mkdirSync(join(h, '.helm'), { recursive: true })
  const lines = Array.from({ length: 12 }, (_, i) => `error-${i}`)
  writeFileSync(join(h, '.helm', 'hook-errors.log'), `${lines.join('\n')}\n`)
  const c = find(checksOf(h), '錯誤紀錄')
  assert.ok(c?.detail.includes('error-11'), c?.detail)
  assert.ok(c?.detail.includes('error-7'), `要有五行：${c?.detail}`)
  assert.ok(!c?.detail.includes('error-6'), `不該超過五行：${c?.detail}`)
})
