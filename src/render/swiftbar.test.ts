import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderSwiftBar } from './swiftbar.ts'
import type { Board } from '../board.ts'
import type { ProjectView } from '../projects/group.ts'
import type { SessionState } from '../types.ts'

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0)
const OPTS = { nowMs: NOW, helmBin: '/u/.local/bin/helm' }

const sess = (over: Partial<SessionState>): SessionState => ({
  adapterId: 'claude-code', sessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
  cwd: '/u/proj', pid: 1, procStart: null, startedAt: 0, updatedAt: NOW - 5 * 60_000,
  nativeStatus: 'idle', kind: 'interactive', name: '', transcriptPath: null,
  transcriptMtimeMs: null, lifecycle: 'running', lifecycleConfidence: 'high',
  live: null, ...over,
})

const proj = (over: Partial<ProjectView> = {}): ProjectView => {
  const sessions = over.sessions ?? [sess({})]
  return {
    path: '/u/proj', name: 'proj', pinned: false, lastActivityMs: NOW - 5 * 60_000,
    aggregateStatus: 'idle', sessionCount: sessions.length, ...over, sessions,
  }
}

const board = (projects: ProjectView[], over: Partial<Board> = {}): Board =>
  ({ projects, invalid: 0, prefsHealth: 'ok' as const, ...over })

const title = (out: string) => out.split('\n')[0] ?? ''
const body = (out: string) => out.slice(out.indexOf('\n---\n'))

test('標題在有中斷時為紅色', () => {
  const out = renderSwiftBar(board([proj({
    aggregateStatus: 'crashed', sessions: [sess({ lifecycle: 'crashed' })],
  })]), OPTS)
  assert.match(title(out), /中斷/)
  assert.match(title(out), /color=red/)
})

test('中斷蓋過在跑 —— 標題顯示最需要注意的那個', () => {
  const out = renderSwiftBar(board([
    proj({ path: '/a', aggregateStatus: 'busy', sessions: [sess({ nativeStatus: 'busy' })] }),
    proj({ path: '/b', aggregateStatus: 'crashed', sessions: [sess({ lifecycle: 'crashed' })] }),
  ]), OPTS)
  assert.match(title(out), /中斷/)
})

test('沒有中斷但有在跑時標題為綠色', () => {
  const out = renderSwiftBar(board([proj({
    aggregateStatus: 'busy', sessions: [sess({ nativeStatus: 'busy' })],
  })]), OPTS)
  assert.match(title(out), /在跑/)
  assert.match(title(out), /color=green/)
})

test('全部結束時標題不帶顏色也不帶數字', () => {
  const out = renderSwiftBar(board([proj({
    aggregateStatus: null, sessions: [sess({ lifecycle: 'ended_clean' })],
  })]), OPTS)
  assert.ok(!title(out).includes('color='))
})

test('標題與內容之間有 SwiftBar 的分隔線', () => {
  assert.ok(renderSwiftBar(board([proj()]), OPTS).includes('\n---\n'))
})

test('每個專案一列，session 收在子選單', () => {
  const out = body(renderSwiftBar(board([proj({
    sessions: [sess({ sessionId: 'aaaaaaaa-1' }), sess({ sessionId: 'bbbbbbbb-2' })],
  })]), OPTS))
  assert.match(out, /^proj/m)
  assert.match(out, /^--.*aaaaaaaa/m)
  assert.match(out, /^--.*bbbbbbbb/m)
})

test('每個 session 都有「開終端機接續」可點，且參數帶的是自己的 id', () => {
  const out = renderSwiftBar(board([proj()]), OPTS)
  assert.match(out, /param1=open param2=-- param3="abcdef12"/)
  assert.match(out, /bash="\/u\/\.local\/bin\/helm"/)
})

test('接續與隱藏用 terminal=false 並要求刷新', () => {
  const out = renderSwiftBar(board([proj()]), OPTS)
  const line = out.split('\n').find((l) => l.includes('param1=open')) ?? ''
  assert.match(line, /terminal=false/)
  assert.match(line, /refresh=true/)
})

test('看簡報用 terminal=true —— 它要跑 1-2 分鐘，得讓使用者看得到', () => {
  const line = renderSwiftBar(board([proj()]), OPTS).split('\n')
    .find((l) => l.includes('param1=brief')) ?? ''
  assert.match(line, /terminal=true/)
})

test('每個專案都有「隱藏此專案」', () => {
  assert.match(renderSwiftBar(board([proj()]), OPTS), /param1=hide param2=-- param3="proj"/)
})

test('沒有專案時仍輸出合法的選單，不是空字串', () => {
  const out = renderSwiftBar(board([]), OPTS)
  assert.ok(out.includes('\n---\n'))
  assert.match(out, /沒有/)
})

test('註冊表解析失敗時在選單裡明講，不靜默隱藏', () => {
  assert.match(renderSwiftBar(board([proj()], { invalid: 2 }), OPTS), /2 個/)
})

test('偏好檔毀損時也在選單裡明講', () => {
  assert.match(renderSwiftBar(board([proj()], { prefsHealth: 'quarantined' as const }), OPTS), /偏好檔/)
})

test('pinned 專案顯示釘選記號', () => {
  assert.match(renderSwiftBar(board([proj({ pinned: true })]), OPTS), /📌/)
})

test('低信心的判定帶問號，不把猜測講成事實', () => {
  const out = renderSwiftBar(board([proj({
    sessions: [sess({ lifecycle: 'crashed', lifecycleConfidence: 'low' })],
  })]), OPTS)
  assert.match(out, /●\?/)
})

test('busy 的 session 顯示此刻在跑什麼 —— 這正是 hook 存在的理由', () => {
  const out = renderSwiftBar(board([proj({
    sessions: [sess({
      nativeStatus: 'busy',
      live: { sessionId: 'x', ts: NOW, toolName: 'Bash', summary: 'npm test', degraded: false },
    })],
  })]), OPTS)
  assert.match(out, /Bash/)
  assert.match(out, /npm test/)
})

test('管線字元被過濾掉 —— 它是 SwiftBar 的參數分隔符，會把整列切壞', () => {
  // live marker 的 summary 來自 hook，hook 的 summary 來自使用者下的指令。
  // `ps aux | grep node` 是再普通不過的指令，未過濾就會把那一列解析壞掉。
  const out = renderSwiftBar(board([proj({
    sessions: [sess({
      nativeStatus: 'busy',
      live: { sessionId: 'x', ts: NOW, toolName: 'Bash', summary: 'ps aux | grep node', degraded: false },
    })],
  })]), OPTS)
  const line = out.split('\n').find((l) => l.includes('grep node')) ?? ''
  assert.equal((line.match(/\|/g) ?? []).length, 0, 'summary 裡的管線字元必須被移除')
})

test('專案名裡的管線字元同樣被過濾', () => {
  const out = renderSwiftBar(board([proj({ name: 'a|b' })]), OPTS)
  const line = out.split('\n').find((l) => l.includes('ab')) ?? ''
  assert.ok(!line.startsWith('a|b'))
})

test('每一列的參數都接在唯一一個管線字元之後', () => {
  // SwiftBar 用第一個 | 切開文字與參數。文字裡混進第二個會讓後半段
  // 被當成參數解析，整列就爛掉。
  const out = renderSwiftBar(board([proj({
    pinned: true,
    sessions: [sess({
      nativeStatus: 'busy',
      live: { sessionId: 'x', ts: NOW, toolName: 'Bash', summary: 'a | b | c', degraded: false },
    })],
  })], { invalid: 1 }), OPTS)
  for (const line of out.split('\n').filter((l) => l !== '' && l !== '---')) {
    assert.ok((line.match(/\|/g) ?? []).length <= 1, `這一列有多個管線字元：${line}`)
  }
})

test('renderSwiftBar 不修改輸入', () => {
  const input = board([proj()])
  const snapshot = structuredClone(input)
  renderSwiftBar(input, OPTS)
  assert.deepEqual(input, snapshot)
})


test('param2 的值有引號包住 —— 專案名含空格不該讓「隱藏此專案」壞掉', () => {
  // ~/Documents/My Project 就中。而該列是 terminal=false，使用者看不到
  // 任何錯誤，只會覺得按了沒反應。
  const out = renderSwiftBar(board([proj({ name: 'my proj' })]), OPTS)
  const line = out.split('\n').find((l) => l.includes('param1=hide')) ?? ''
  assert.match(line, /param3="my proj"/)
})

test('專案名不能覆寫其他參數', () => {
  // SwiftBar 把引號括起來的部分當成單一個值，所以要驗的是「使用者內容有沒有
  // 待在引號裡」。把引號區段挖掉之後再數，剩下的才是真正會被當成參數的東西。
  const out = renderSwiftBar(board([proj({ name: 'x param1=uninstall terminal=true' })]), OPTS)
  const line = out.split('\n').find((l) => l.includes('param1=hide')) ?? ''
  const outsideQuotes = line.replace(/"[^"]*"/g, '""')
  assert.equal((outsideQuotes.match(/param1=/g) ?? []).length, 1, line)
  assert.equal((outsideQuotes.match(/terminal=/g) ?? []).length, 1, line)
  assert.equal((outsideQuotes.match(/refresh=/g) ?? []).length, 1, line)
})

test('session id 也要過濾 —— live.ts 明講 session id 要當成不可信', () => {
  const out = renderSwiftBar(board([proj({
    sessions: [sess({ sessionId: 'ab|cd-ef-0000-1111-222233334444' })],
  })]), OPTS)
  for (const line of out.split('\n').filter((l) => l !== '' && l !== '---')) {
    assert.ok((line.match(/\|/g) ?? []).length <= 1, `多個管線字元：${line}`)
  }
})

test('控制字元被清掉 —— 一個 CR 就能偽造一整列選單', () => {
  const CR = String.fromCharCode(13)
  const ESC = String.fromCharCode(27)
  const TAB = String.fromCharCode(9)
  const LINE_SEP = String.fromCharCode(0x2028)
  const out = renderSwiftBar(board([proj({
    name: `cr${CR}here`,
    sessions: [sess({
      nativeStatus: 'busy',
      live: {
        sessionId: 'x', ts: NOW, toolName: 'Bash',
        summary: `a${CR}${ESC}[31mred${TAB}b${LINE_SEP}c`, degraded: false,
      },
    })],
  })]), OPTS)
  for (const ch of [CR, ESC, TAB, LINE_SEP]) {
    assert.ok(!out.includes(ch), `輸出仍含控制字元 U+${ch.charCodeAt(0).toString(16)}`)
  }
})

test('專案名以 -- 開頭不會讓階層錯位', () => {
  const out = renderSwiftBar(board([proj({ name: '--evil' })]), OPTS)
  const line = out.split('\n').find((l) => l.includes('evil')) ?? ''
  assert.ok(!line.startsWith('--'), `專案列被當成子選單項目：${line}`)
})

test('名字被清成空字串時仍有可辨識的標示', () => {
  const out = renderSwiftBar(board([proj({ name: '|||' })]), OPTS)
  const line = out.split('\n').find((l) => l.includes('分鐘前')) ?? ''
  assert.ok(line.trim().length > 0)
  assert.ok(!line.startsWith(' '), `選單上出現一列沒有名字的專案：${JSON.stringify(line)}`)
})

test('空看板時降級警告仍然顯示 —— 那正是最需要它的時候', () => {
  // prefs 毀損 → 釘選失效 → 靠 pin 豁免 14 天窗口的專案全部消失 →
  // 使用者只看到「沒有符合條件的專案」，一個字都沒提到有東西壞掉。
  const out = renderSwiftBar(board([], { invalid: 7, prefsHealth: 'quarantined' as const }), OPTS)
  assert.match(out, /7 個/)
  assert.match(out, /偏好檔/)
})
