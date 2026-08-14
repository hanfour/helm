import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderSwiftBar } from './render/swiftbar.ts'
import { renderTable } from './render/table.ts'
import { renderSessions } from './render/sessions.ts'
import { buildWidget } from './hook/widget.ts'
import { UNEARNED_LABEL, isUnearnedClaim, statusOf } from './session-status.ts'
import type { Board } from './board.ts'
import type { ProjectView } from './projects/group.ts'
import type { SessionState } from './types.ts'

/**
 * helm shows the same board through four faces: the SwiftBar menu, the
 * Übersicht widget, `helm status` and `helm sessions`. Three of the six bugs
 * found on 2026-08-13 were one face describing a session differently from
 * another — the menu bar counting projects while the desktop counted the same
 * thing differently, and `helm status` reporting 「已結束 142」 for sessions
 * `helm sessions` called 「沒有動靜」.
 *
 * Each face has its own tests for its own formatting. This file asserts only
 * what has to hold *between* them, because that is the part no single face's
 * test can see.
 */

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0)
const HELM = '/u/.local/bin/helm'

const sess = (over: Partial<SessionState> & { sessionId: string }): SessionState => ({
  adapterId: 'claude-code', cwd: '/p/a', pid: null, procStart: null, startedAt: 0,
  updatedAt: NOW - 5 * 60_000, nativeStatus: 'idle', kind: 'interactive', name: '',
  transcriptPath: null, transcriptMtimeMs: null, lifecycle: 'running',
  lifecycleConfidence: 'high', live: null, ...over,
})

/**
 * Every (status, confidence) pair a session can land on, which is what the
 * faces disagreed about. Ids are stable and distinct so a row can be found in
 * each rendering.
 */
const SESSIONS: SessionState[] = [
  sess({ sessionId: 'busyhigh', nativeStatus: 'busy' }),
  sess({ sessionId: 'busylow_', nativeStatus: 'busy', adapterId: 'codex', lifecycleConfidence: 'low' }),
  sess({ sessionId: 'idlehigh', nativeStatus: 'idle' }),
  sess({ sessionId: 'idlelow_', nativeStatus: 'idle', adapterId: 'codex', lifecycleConfidence: 'low' }),
  sess({ sessionId: 'crshhigh', lifecycle: 'crashed' }),
  sess({ sessionId: 'crshlow_', lifecycle: 'crashed', adapterId: 'codex', lifecycleConfidence: 'low' }),
  sess({ sessionId: 'endehigh', lifecycle: 'ended_clean' }),
  sess({ sessionId: 'endelow_', lifecycle: 'ended_clean', adapterId: 'codex', lifecycleConfidence: 'low' }),
]

const project: ProjectView = {
  path: '/p/a', name: 'proj', pinned: false, lastActivityMs: NOW - 5 * 60_000,
  aggregateStatus: 'crashed', sessionCount: SESSIONS.length, sessions: SESSIONS,
}

const board: Board = {
  projects: [project], invalid: 0, prefsHealth: 'ok',
  adapterFailures: [], prs: [], prDegraded: null,
}

const menu = () => renderSwiftBar(board, { nowMs: NOW, helmBin: HELM })
const table = () => renderTable(board, { color: false, nowMs: NOW })
const sessions = () => renderSessions(project, { color: false, nowMs: NOW })

/** Runs the widget's own logic block, the way `widget.test.ts` does. */
function widgetTitle(): { word: string; color: string } {
  const src = buildWidget([HELM, 'status', '--json'])
  const block = /\/\/ --- helm:logic ---[^\n]*\n([\s\S]*?)\/\/ --- \/helm:logic ---/.exec(src)
  assert.ok(block?.[1], 'widget 裡找不到 helm:logic 區塊')
  const viewOf = new Function('localStorage', 'window', `${block[1]}\nreturn viewOf`)(
    { getItem: () => null, setItem: () => {} }, { innerWidth: 1440, innerHeight: 900 },
  ) as (o: string, e: unknown, n: number) => { title: { word: string; color: string } }
  return viewOf(JSON.stringify(board), null, NOW).title
}

/** The word a face is expected to use for one session, per session-status.ts. */
const expectedLabel = (s: SessionState) =>
  isUnearnedClaim(s) ? UNEARNED_LABEL : ({
    busy: '執行中', idle: '等輸入', ended: '已結束', crashed: '已中斷',
  })[statusOf(s)]

const lineWith = (text: string, id: string) =>
  text.split('\n').find((l) => l.includes(id)) ?? ''

test('每個 session 在選單列與 helm sessions 裡用的是同一個詞', () => {
  // 這條守的是 session-status.ts 那句「Every face that renders a label has to
  // ask this」。isUnearnedClaim 的分支特別容易漏 —— 它只對低信心的
  // ended_clean 為真，而那正是 Codex 最常見的狀態。
  const m = menu()
  const s = sessions()
  for (const session of SESSIONS) {
    const want = expectedLabel(session)
    const inMenu = lineWith(m, session.sessionId)
    const inSessions = lineWith(s, session.sessionId)
    assert.notEqual(inMenu, '', `選單列找不到 ${session.sessionId}`)
    assert.notEqual(inSessions, '', `helm sessions 找不到 ${session.sessionId}`)
    assert.ok(inMenu.includes(want), `選單列對 ${session.sessionId} 用的不是「${want}」：${inMenu}`)
    assert.ok(inSessions.includes(want), `helm sessions 對 ${session.sessionId} 用的不是「${want}」：${inSessions}`)
  }
})

test('低信心的 session 在兩個面都帶問號', () => {
  const m = menu()
  const s = sessions()
  for (const session of SESSIONS) {
    const low = session.lifecycleConfidence === 'low'
    for (const [face, text] of [['選單列', m], ['helm sessions', s]] as const) {
      const line = lineWith(text, session.sessionId)
      assert.equal(line.includes('●?') || line.includes('○?'), low,
        `${face} 對 ${session.sessionId}（信心 ${session.lifecycleConfidence}）的問號不對：${line}`)
    }
  }
})

test('helm status 的摘要用的詞跟 helm sessions 一致', () => {
  // 實際發生過：摘要寫「已結束 142」，其中 5 個在 helm sessions 是「沒有動靜」。
  const summary = table().split('\n').find((l) => l.includes('個專案')) ?? ''
  const expected = new Map<string, number>()
  for (const session of SESSIONS) {
    const w = expectedLabel(session)
    expected.set(w, (expected.get(w) ?? 0) + 1)
  }
  for (const [word, n] of expected) {
    assert.match(summary, new RegExp(`${word} ${n}(?!\\d)`), `摘要少了「${word} ${n}」：${summary}`)
  }
})

test('選單列與桌面的標題完全一樣', () => {
  // 兩份計數邏輯，一份在 TS 一份在 widget 的 template literal 裡。
  const menuTitle = (menu().split('\n')[0] ?? '').replace(/^⚓ ?/, '').split(' |')[0] ?? ''
  assert.equal(menuTitle === '' ? '都閒著' : menuTitle, widgetTitle().word)
})

test('標題的數字跟 helm status 摘要的同一個詞對得上', () => {
  // 標題只講優先序最高的那個狀態，摘要全部列出。兩者對同一個詞必須同一個數字。
  const title = (menu().split('\n')[0] ?? '').replace(/^⚓ ?/, '').split(' |')[0] ?? ''
  const m = /^(\d+) (.+?)\??$/.exec(title)
  const count = m?.[1]
  const word = m?.[2]
  assert.ok(count !== undefined && word !== undefined, `標題不是「N 詞」的形狀：${title}`)
  // 標題用的是短詞（中斷／在跑／等輸入），摘要用的是三字標籤。
  const asSummary: Record<string, string | undefined> = { 中斷: '已中斷', 在跑: '執行中', 等輸入: '等輸入' }
  const summaryWord = asSummary[word]
  assert.ok(summaryWord !== undefined, `標題的詞「${word}」沒有對應的摘要標籤`)
  const summary = table().split('\n').find((l) => l.includes('個專案')) ?? ''
  assert.match(summary, new RegExp(`${summaryWord} ${count}(?!\\d)`),
    `標題說「${title}」，摘要卻是：${summary}`)
})

test('標題帶問號時，摘要對同一個詞也帶問號', () => {
  const title = (menu().split('\n')[0] ?? '').replace(/^⚓ ?/, '').split(' |')[0] ?? ''
  const summary = table().split('\n').find((l) => l.includes('個專案')) ?? ''
  assert.equal(title.endsWith('?'), /已中斷 \d+\?/.test(summary),
    `標題「${title}」與摘要「${summary}」對不確定性的說法不一致`)
})
