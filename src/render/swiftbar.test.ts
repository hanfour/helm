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
  // 原本這條是恆真的：它用 'ab' 當關鍵字去找那一列，而 'ab' 只在過濾成功
  // 之後才存在 —— 過濾失效時 find 會挑到別的列，斷言照樣通過。
  // 直接對整份輸出斷言就沒有這個漏洞。
  const out = renderSwiftBar(board([proj({ name: 'a|b' })]), OPTS)
  assert.ok(!out.includes('a|b'), out)
  assert.match(out, /^ab {2}/m)
})

test('每一列的參數都接在唯一一個管線字元之後', () => {
  // SwiftBar 用第一個 | 切開文字與參數。文字裡混進第二個會讓後半段
  // 被當成參數解析，整列就爛掉。
  const out = renderSwiftBar(board([proj({
    name: 'a|b',
    pinned: true,
    sessions: [sess({
      sessionId: 'c|d-1111-2222-3333-444444444444',
      nativeStatus: 'busy',
      live: { sessionId: 'x', ts: NOW, toolName: 'Ba|sh', summary: 'a | b | c', degraded: false },
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


test('busy 是實心、idle 是空心 —— 規格 §11.1 的核心狀態語彙', () => {
  // 圓點對調不會讓任何既有測試變紅，但「在跑」與「等輸入」在選單列上
  // 就反過來了。
  const busy = renderSwiftBar(board([proj({
    sessions: [sess({ nativeStatus: 'busy' })],
  })]), OPTS)
  const idle = renderSwiftBar(board([proj({
    sessions: [sess({ nativeStatus: 'idle' })],
  })]), OPTS)
  assert.match(busy, /--● 執行中/)
  assert.match(idle, /--○ 等輸入/)
})

test('已結束的 session 不顯示殘留的 live marker', () => {
  // marker 只在 session 真的在跑時有意義。不看 nativeStatus 的話，一個
  // 早就結束的 session 會一直掛著「→ Bash: rm -rf …」。
  const out = renderSwiftBar(board([proj({
    sessions: [sess({
      lifecycle: 'ended_clean',
      nativeStatus: null,
      live: { sessionId: 'x', ts: NOW, toolName: 'Bash', summary: 'rm -rf tmp', degraded: false },
    })],
  })]), OPTS)
  assert.ok(!out.includes('rm -rf tmp'), out)
})

test('動作項目比 session 深一層 —— 選單結構不能被壓平', () => {
  const out = renderSwiftBar(board([proj()]), OPTS)
  assert.match(out, /^----開終端機接續/m)
  assert.match(out, /^----看交接簡報/m)
  assert.match(out, /^--● |^--○ /m)
})

test('隱藏此專案是 session 的同層項目，不是 top-level', () => {
  const out = renderSwiftBar(board([proj()]), OPTS)
  const line = out.split('\n').find((l) => l.includes('param1=hide')) ?? ''
  assert.ok(line.startsWith('--') && !line.startsWith('----'), line)
})

test('隱藏動作要求選單刷新，否則看起來沒生效', () => {
  const line = renderSwiftBar(board([proj()]), OPTS).split('\n')
    .find((l) => l.includes('param1=hide')) ?? ''
  assert.match(line, /refresh=true/)
  assert.match(line, /terminal=false/)
})

test('param3 帶的是前 8 碼，不是完整 session id', () => {
  // 原本的斷言用 /param2=abcdef12/，對完整 UUID 也成立（前綴），所以
  // 「不截短」這個變異抓不到。
  const out = renderSwiftBar(board([proj()]), OPTS)
  assert.match(out, /param3="abcdef12"/)
  assert.ok(!out.includes('abcdef12-3456'), '不該出現完整 id')
})

test('重新整理與 doctor 兩個 footer 項目都是可用的', () => {
  const out = renderSwiftBar(board([proj()]), OPTS)
  assert.match(out, /^重新整理 \| refresh=true$/m)
  assert.match(out, /^helm doctor \| bash="[^"]+" param1=doctor terminal=true$/m)
})

test('降級警告帶顏色，不會混在一般項目裡看不見', () => {
  const out = renderSwiftBar(board([proj()], { invalid: 2 }), OPTS)
  const line = out.split('\n').find((l) => l.includes('無法解析')) ?? ''
  assert.match(line, /color=orange/)
})

test('專案列一定帶相對時間 —— 那是「最後做到哪」的唯一線索', () => {
  const out = renderSwiftBar(board([proj()]), OPTS)
  assert.match(out, /^proj {2}5 分鐘前/m)
})

test('輸出以換行結尾 —— SwiftBar 逐行解析', () => {
  assert.ok(renderSwiftBar(board([proj()]), OPTS).endsWith('\n'))
})

test('clean 同時處理管線字元與換行', () => {
  const out = renderSwiftBar(board([proj({ name: 'a\nb|c' })]), OPTS)
  assert.ok(!out.includes('a\nb'), '換行必須被換掉')
  assert.match(out, /^a bc {2}/m)
})

test('標題數的是專案，跟桌面 widget 同一個單位', () => {
  // 兩邊看的是同一份資料。之前選單列數 session、widget 數專案，於是
  // 一個專案裡三個 session 在跑時，選單列寫「3 在跑」而桌面寫「1 在跑」。
  // 畫面上只有數字，使用者無從知道兩者在數不同的東西。
  const out = renderSwiftBar(board([proj({
    aggregateStatus: 'busy',
    sessions: [
      sess({ nativeStatus: 'busy' }),
      sess({ sessionId: 'bbbbbbbb-3456-7890-abcd-ef1234567890', nativeStatus: 'busy' }),
      sess({ sessionId: 'cccccccc-3456-7890-abcd-ef1234567890', nativeStatus: 'busy' }),
    ],
  })]), OPTS)
  assert.match(title(out), /⚓ 1 在跑/, title(out))
})

test('多個專案時數的是專案數', () => {
  const out = renderSwiftBar(board([
    proj({ path: '/a', aggregateStatus: 'busy', sessions: [sess({ nativeStatus: 'busy' })] }),
    proj({ path: '/b', aggregateStatus: 'busy', sessions: [sess({ nativeStatus: 'busy' })] }),
    proj({ path: '/c', aggregateStatus: 'idle' }),
  ]), OPTS)
  assert.match(title(out), /⚓ 2 在跑/, title(out))
})
