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
  ({ projects, invalid: 0, prefsHealth: 'ok' as const, adapterFailures: [], prs: [], prDegraded: null, ...over })

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
  assert.match(renderSwiftBar(board([proj()], { prefsHealth: 'quarantined' as const, adapterFailures: [], prs: [], prDegraded: null }), OPTS), /偏好檔/)
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
  const out = renderSwiftBar(board([], { invalid: 7, prefsHealth: 'quarantined' as const, adapterFailures: [], prs: [], prDegraded: null }), OPTS)
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

test('標題數的是在跑的 session，跟桌面 widget 同一個單位', () => {
  // 兩邊看的是同一份資料，單位必須一致 —— 曾經選單列數 session、widget
  // 數專案，同一時刻一邊寫「3 在跑」一邊寫「1 在跑」，畫面上只有數字，
  // 使用者無從知道兩者在數不同的東西。
  //
  // 當時統一到「專案」，那是錯的一邊。實測 2026-08-13：使用者兩個 terminal
  // 在跑、cwd 都是 super-dsp-2.0，選單列寫「1 在跑」—— 在同一個專案開多個
  // terminal 是再常見不過的用法，而標題把它們摺掉了。使用者數的是 terminal，
  // 一個 terminal 就是一個 session。
  const out = renderSwiftBar(board([proj({
    aggregateStatus: 'busy',
    sessions: [
      sess({ nativeStatus: 'busy' }),
      sess({ sessionId: 'bbbbbbbb-3456-7890-abcd-ef1234567890', nativeStatus: 'busy' }),
      sess({ sessionId: 'cccccccc-3456-7890-abcd-ef1234567890', nativeStatus: 'busy' }),
    ],
  })]), OPTS)
  assert.match(title(out), /⚓ 3 在跑/, title(out))
})

test('同一個專案裡兩個 terminal 在跑，標題要說 2', () => {
  // 這正是回報的症狀。摺成專案之後它跟「一個 terminal 在跑」長得一模一樣。
  const two = renderSwiftBar(board([proj({
    aggregateStatus: 'busy',
    sessions: [
      sess({ nativeStatus: 'busy' }),
      sess({ sessionId: 'bbbbbbbb-3456-7890-abcd-ef1234567890', nativeStatus: 'busy' }),
    ],
  })]), OPTS)
  const one = renderSwiftBar(board([proj({
    aggregateStatus: 'busy', sessions: [sess({ nativeStatus: 'busy' })],
  })]), OPTS)
  assert.match(title(two), /⚓ 2 在跑/, title(two))
  assert.notEqual(title(two), title(one), '兩個在跑跟一個在跑不能長得一樣')
})

test('中斷也數 session —— 同一專案裡兩個斷掉就是兩個要撿回來', () => {
  const out = renderSwiftBar(board([proj({
    aggregateStatus: 'crashed',
    sessions: [
      sess({ lifecycle: 'crashed' }),
      sess({ sessionId: 'bbbbbbbb-3456-7890-abcd-ef1234567890', lifecycle: 'crashed' }),
    ],
  })]), OPTS)
  assert.match(title(out), /⚓ 2 中斷/, title(out))
})

test('多個專案時把每個專案在跑的 session 加起來', () => {
  const out = renderSwiftBar(board([
    proj({ path: '/a', aggregateStatus: 'busy', sessions: [sess({ nativeStatus: 'busy' })] }),
    proj({ path: '/b', aggregateStatus: 'busy', sessions: [sess({ nativeStatus: 'busy' })] }),
    proj({ path: '/c', aggregateStatus: 'idle' }),
  ]), OPTS)
  assert.match(title(out), /⚓ 2 在跑/, title(out))
})

test('PR 獨立一區，每行說出在等誰', () => {
  const out = renderSwiftBar(board([proj({})], {
    prs: [
      { repo: 'a/b', number: 142, title: 'feat: x', url: 'https://gh/a/b/pull/142', isDraft: false, updatedAt: '', waiting: 'review', waitingLabel: '等人審' },
      { repo: 'a/c', number: 7, title: 'fix: y', url: 'https://gh/a/c/pull/7', isDraft: false, updatedAt: '', waiting: 'changes', waitingLabel: '等你改' },
    ],
  }), OPTS)
  assert.match(body(out), /a\/b#142/)
  assert.match(body(out), /等人審/)
  assert.match(body(out), /a\/c#7/)
  assert.match(body(out), /等你改/)
})

test('PR 那一行可以點開瀏覽器', () => {
  const out = renderSwiftBar(board([proj({})], {
    prs: [{ repo: 'a/b', number: 1, title: 't', url: 'https://gh/a/b/pull/1', isDraft: false, updatedAt: '', waiting: 'review', waitingLabel: '等人審' }],
  }), OPTS)
  assert.match(body(out), /href="https:\/\/gh\/a\/b\/pull\/1"/)
})

test('沒有 PR 時不畫那一區 —— 不佔空間也不說謊', () => {
  const out = renderSwiftBar(board([proj({})], { prs: [] }), OPTS)
  assert.doesNotMatch(body(out), /PR/)
})

test('PR 讀不到時說出原因與下一步，而不是靜靜留白', () => {
  const out = renderSwiftBar(board([proj({})], {
    prs: [], prDegraded: 'gh 尚未登入，PR 狀態無法取得。執行 gh auth login。',
  }), OPTS)
  assert.match(body(out), /gh auth login/)
  assert.match(body(out), /color=orange/)
})

test('沒有專案時，PR 區與降級訊息仍然要畫 —— 桌面一直都有畫', () => {
  // renderBody 的 early return 讓整個 PR 區與 gh 的降級訊息一起消失，
  // 而它上面三行自己的註解寫著「Warnings belong on the empty board too
  // — arguably more so」。放假回來、換機器、或全部 hide 掉的時候，
  // 選單列什麼都不說，桌面卻說了。
  const out = renderSwiftBar(board([], {
    prs: [{ repo: 'a/b', number: 1, title: 't', url: 'u', isDraft: false, updatedAt: '', waiting: 'changes', waitingLabel: '等你改' }],
  }), OPTS)
  assert.match(body(out), /a\/b#1/)
  assert.match(body(out), /等你改/)
})

test('沒有專案且 gh 沒登入時，那句話也要出現', () => {
  const out = renderSwiftBar(board([], { prDegraded: 'gh 尚未登入，執行 gh auth login。' }), OPTS)
  assert.match(body(out), /gh auth login/)
})

test('沒有專案時 adapter 的失敗也要說', () => {
  const out = renderSwiftBar(board([], { adapterFailures: ['codex：讀不到 /x'] }), OPTS)
  assert.match(body(out), /讀不到 \/x/)
})

test('PR 的 href 也要引號 —— 那是唯一沒過 param() 的不可信值', () => {
  // clean() 拿掉 | 與控制字元，但保留空白，而 | 之後是照空白切的 key=value。
  // GitHub 回的 URL 不可能含空白，所以走不通 —— 但 prs.json 被寫壞時就成立，
  // 而同一支檔案裡其他每個進參數區的值都有引號。
  const out = renderSwiftBar(board([proj({})], {
    prs: [{
      repo: 'a/b', number: 1, title: 't',
      url: 'https://x/ bash="/bin/sh" param1=-c param2="touch /tmp/PWNED"',
      isDraft: false, updatedAt: '', waiting: 'review', waitingLabel: '等人審',
    }],
  }), OPTS)
  const line = body(out).split('\n').find((l) => l.includes('a/b#1')) ?? ''
  const params = line.slice(line.indexOf('|') + 1).trim()
  // 整串必須落在一組引號裡 —— 那樣 SwiftBar 會把它當成 href 的值，
  // 而不是切成 bash=/param1=/param2= 這幾個參數。
  assert.match(params, /^href="[^"]*"$/, `注入成功了：${params}`)
})

test('PR 區前面有分隔線 —— 否則它會黏在最後一個專案下面', () => {
  const lines = renderSwiftBar(board([proj({})], {
    prs: [{
      repo: 'a/b', number: 1, title: 't', url: 'https://gh/a/b/pull/1',
      isDraft: false, updatedAt: '', waiting: 'review', waitingLabel: '等人審',
    }],
  }), OPTS).split('\n')
  const i = lines.indexOf('PR')
  assert.ok(i > 0, `找不到 PR 區標題：${lines.join('\n')}`)
  assert.equal(lines[i - 1], '---', `PR 區前面不是分隔線：${JSON.stringify(lines[i - 1])}`)
})

test('六種 waitingOn 狀態並存時，每個 PR 各自帶自己的那一句', () => {
  // 這台機器上只有一個開啟中的 PR，所以混合狀態的畫面從沒被真實資料走過。
  // waiting.ts 產得出六種 kind，而渲染測試只見過 review 與 changes 兩種。
  const kinds = [
    ['draft', '草稿'], ['ci', '等 CI'], ['changes', '等你改'],
    ['review', '等人審'], ['mergeable', '可合併'], ['unknown', '狀態讀不到'],
  ] as const
  const out = body(renderSwiftBar(board([proj({})], {
    prs: kinds.map(([waiting, waitingLabel], i) => ({
      repo: `o/r${i}`, number: i + 1, title: `t${i}`,
      url: `https://gh/o/r${i}/pull/${i + 1}`,
      isDraft: waiting === 'draft', updatedAt: '', waiting, waitingLabel,
    })),
  }), OPTS))
  for (const [i, [, waitingLabel]] of kinds.entries()) {
    assert.match(out, new RegExp(`^--o/r${i}#${i + 1} {2}${waitingLabel} {2}t${i} \\|`, 'm'),
      `o/r${i} 這一列不見了或標籤配錯：${out}`)
  }
})

test('PR 標題裡的管線字元與控制字元同樣要清掉', () => {
  // PR 標題是自由文字，`fix: 處理 a|b 的解析` 是再普通不過的標題 —— 比那條
  // 已經有測試的 url 注入好走得多。repo 與 waitingLabel 走的是同一條字串路徑，
  // 而 cache.ts 的 toCachedPr 對這三個欄位只檢查「是不是字串」。
  const CR = String.fromCharCode(13)
  const out = renderSwiftBar(board([proj({})], {
    prs: [{
      repo: `o|r${CR}x`, number: 1, title: 'fix: 處理 a|b 的解析',
      url: 'https://gh/o/r/pull/1', isDraft: false, updatedAt: '',
      waiting: 'review', waitingLabel: '等|人審',
    }],
  }), OPTS)
  assert.ok(!out.includes(CR), '輸出仍含 CR，一個 CR 就能偽造一整列選單')
  for (const line of body(out).split('\n').filter((l) => l !== '' && l !== '---')) {
    assert.ok((line.match(/\|/g) ?? []).length <= 1, `這一列有多個管線字元：${line}`)
  }
})

test('部分資料的降級訊息不能把手上的 PR 一起吃掉', () => {
  // refresh.ts 有兩條路徑會同時寫出「有 PR」與「有 degraded 訊息」：
  // `gh search` 打到 --limit 50（listing.truncated），以及 sweep 超過四分鐘
  // 預算（「只更新了 N/M 個」）。兩者說的都是「資料是部分的」，不是「沒有
  // 資料」。renderPrs 的 early return 把兩者當成後者 —— 畫面會寫著
  // 「只更新了 12/50 個」，然後那 12 個一個都看不到。
  const out = renderSwiftBar(board([proj({})], {
    prs: [
      { repo: 'a/b', number: 1, title: 'feat: x', url: 'https://gh/a/b/pull/1', isDraft: false, updatedAt: '', waiting: 'changes', waitingLabel: '等你改' },
      { repo: 'a/c', number: 2, title: 'fix: y', url: 'https://gh/a/c/pull/2', isDraft: false, updatedAt: '', waiting: 'ci', waitingLabel: '等 CI' },
    ],
    prDegraded: 'PR 太多，這次只更新了 2/50 個，其餘下次補上。',
  }), OPTS)
  assert.match(body(out), /a\/b#1/, '有 PR 卻一個都沒畫出來')
  assert.match(body(out), /a\/c#2/)
  assert.match(body(out), /只更新了 2\/50 個/, '降級訊息也要留著')
})

test('低信心的「已結束」不能講得像確定的 —— helm 其實不知道', () => {
  // lifecycle.ts 借用 ended_clean 表示「helm 停止猜測」，理由是它在 UI 上
  // 的效果是「不畫點」。但那只描述了三個呈現面裡的一個：選單列、
  // helm sessions、helm status 都直接印出「已結束」這個詞，而那是宣稱。
  const out = renderSwiftBar(board([proj({
    aggregateStatus: null,
    sessions: [sess({ adapterId: 'codex', lifecycle: 'ended_clean', lifecycleConfidence: 'low' })],
  })]), OPTS)
  const line = body(out).split('\n').find((l) => l.includes('●?')) ?? ''
  assert.doesNotMatch(line, /已結束/, `低信心不該講「已結束」：${line}`)
  assert.match(line, /不確定|無法確認|沒有動靜/, line)
})

test('高信心的已結束照樣講「已結束」', () => {
  const out = renderSwiftBar(board([proj({
    aggregateStatus: null,
    sessions: [sess({ lifecycle: 'ended_clean', lifecycleConfidence: 'high' })],
  })]), OPTS)
  assert.match(body(out), /已結束/)
})
