import { ACTIVITY_WINDOW_DAYS } from '../projects/include.ts'
import { shellQuote } from './snippet.ts'

/**
 * Identifies a widget helm wrote, so install never overwrites and uninstall
 * never deletes a file somebody else put in the widgets folder. A JS comment
 * rather than a shell one — Übersicht widgets are ES modules.
 */
export const WIDGET_MARKER = 'HELM_LIVE_MARKER'

export const WIDGET_NAME = 'helm.jsx'

/**
 * An Übersicht widget: an ES module exporting a shell command, how often to
 * re-run it, and how to draw the result on the desktop.
 *
 * Takes the full argv rather than a path so the caller can fall back to
 * `<node> <entry> status --json` when ~/.local/bin/helm turns out to belong to
 * somebody else — the same fallback the SwiftBar plugin has.
 *
 * Every element is embedded through two layers — a JS string literal holding a
 * shell command — so it is shell-quoted first and JSON-encoded second. A home
 * directory containing a space is ordinary and one containing a quote is
 * legal; getting either layer wrong produces a widget that silently draws
 * nothing.
 *
 * Everything between the `helm:logic` markers is plain JS with no JSX, and the
 * tests execute that block verbatim. The JSX below it only reads the object
 * `viewOf` returns. The split exists because seven mutations to the old
 * render — including `if (error)` → `if (false)` — all survived the suite:
 * that half had never been executed by a test at all.
 */
export function buildWidget(argv: readonly string[]): string {
  const command = JSON.stringify(argv.map(shellQuote).join(' '))
  return `// ${WIDGET_MARKER} —— 這個檔案由 helm install 產生。
// 想改就改：檔尾有一行內容雜湊，helm install 會據此發現你動過它，
// 改為保留你的版本並提醒你。helm uninstall 也只刪掉未經修改的版本。

export const command = ${command}

// 10 秒，不是選單列的 5 秒。Übersicht 把這個值同時當成 HTTP 逾時
// （client.js 的 runShellCommand(...).timeout(refreshFrequency)）。
// helm 自己只花約 130ms（行程內部量測），但這台機器的常態是同時跑
// 好幾個 agent，行程啟動要排隊 —— load 15 時外部 wall clock 量到 968ms。
// 5 秒仍有餘裕，10 秒讓這件事完全不必擔心，而桌面看板本來就是掃一眼的東西。
export const refreshFrequency = 10000

// 外層只當一個不佔位的錨點，實際的卡片由 render 自己定位。
// 這樣拖曳改的是我們自己的節點，不必去碰 Übersicht 建的容器。
export const className = \`
  top: 0;
  left: 0;
  font-family: -apple-system, "Helvetica Neue", sans-serif;
  font-size: 12px;
  line-height: 1.45;
\`

// --- helm:logic --- 這一段不含 JSX，測試會原封不動地執行它。
const WINDOW_DAYS = ${ACTIVITY_WINDOW_DAYS}

// aggregateStatus 的值域是 busy / idle / crashed / null（見 session-status.ts）。
// 它永遠不會回傳 'ended' —— 全部結束時回 null，而 null 的意思是「不畫點」，
// 不是「畫一個灰點」。第一版寫了一個不存在的 'waiting'，而 crashed
// 掉進預設值，於是中斷的專案看起來跟閒置的一模一樣。
const DOT = {
  busy: '#4ade80',
  crashed: '#f87171',
  idle: 'rgba(255, 255, 255, 0.55)',
  // 只有 helm 真的驗證過的中斷配得上紅色。Codex 的判定永遠是低信心
  // （decideCodexLifecycle），而它會在閒置 30 分鐘後把 session 叫做 crashed。
  guessedCrash: '#fb923c',
}

function dotOf(status) {
  return DOT[status] || null
}

// session-status.ts 的 statusOf 的複本 —— 這個檔案是 Übersicht 直接載入的
// 獨立模組，import 不進來。兩份定義分岔會讓桌面與選單列說出不同的數字，
// 所以 widget.test.ts 有一條測試拿兩邊的標題逐案比對。
function statusOf(s) {
  if (s.lifecycle === 'crashed') return 'crashed'
  if (s.lifecycle === 'ended_clean') return 'ended'
  return s.nativeStatus === 'busy' ? 'busy' : 'idle'
}

// 跟選單列同一套優先序與同一個計數單位（session）。兩邊對同一份資料
// 說出不同的數字，比少講一個數字更糟。
//
// 數過專案，那是錯的一邊：使用者在同一個 repo 開兩個 terminal 時，
// 兩邊都寫「1 在跑」。專案是從 session 的 cwd 長出來的，不是使用者開的東西。
// 選單列的問號在這裡也要有：把猜測捲進總數時，捲出來的不能變成事實。
// （這段在 template literal 裡，註解不能用反引號 —— 會把字串提前結束。）
function titleOf(projects) {
  const sessions = []
  for (const p of projects) {
    for (const s of p.sessions || []) sessions.push(s)
  }
  const pick = (k) => sessions.filter((s) => statusOf(s) === k)
  const say = (list, word, color) =>
    ({ word: list.length + ' ' + word + (list.some((s) => s.lifecycleConfidence === 'low') ? '?' : ''), color })
  const crashed = pick('crashed')
  if (crashed.length > 0) {
    // 一個驗證過的中斷仍然值得紅色，即使旁邊躺著幾個猜測。
    const verified = crashed.some((s) => s.lifecycleConfidence !== 'low')
    return say(crashed, '中斷', verified ? DOT.crashed : DOT.guessedCrash)
  }
  const busy = pick('busy')
  if (busy.length > 0) return say(busy, '在跑', DOT.busy)
  const idle = pick('idle')
  if (idle.length > 0) return say(idle, '等輸入', DOT.idle)
  return { word: '都閒著', color: DOT.idle }
}

// 擋的是「那個 session 自己」在不在跑，跟選單列一致。用專案的
// aggregateStatus 當閘門會更嚴：只要同一個專案裡有東西中斷，
// 正在跑的那道指令就被藏起來 —— 而那正是最該看到的時候。
function activeLive(p) {
  // 只要有 live 就算數。之前要求 summary 非空，於是一個寫到一半的 marker、
  // 或一個沒有東西可摘要的工具，桌面就完全不顯示 —— 選單列在同樣情況
  // 顯示的是「→ Read」。
  const running = (p.sessions || []).find((s) => s.nativeStatus === 'busy' && s.live)
  return running ? running.live : null
}

// 選單列在信心低時畫的是 ●? —— 猜測要看得出來是猜測。
// 原本只涵蓋 crashed 與 ended_clean，把 running 排除掉了 —— 而 running
// 正是 Codex 最常見的狀態（有行程、或 30 分鐘內動過）。規格 §6 要求
// 「UI 須區分呈現，不得與 Claude Code 的高信心判定混用同一視覺樣式」，
// 而低信心就是低信心，跟它猜的是哪一種狀態無關。
function isUncertain(p) {
  return (p.sessions || []).some((s) => s.lifecycleConfidence === 'low')
}

function liveTextOf(live) {
  if (!live) return null
  return live.summary ? live.toolName + ': ' + live.summary : live.toolName || null
}

// Math.floor，跟選單列的 relativeTime 一樣。用 Math.round 的話
// 59.6 秒在桌面是「1 分鐘前」、在選單列是「剛剛」。
function ago(ms, nowMs) {
  const d = Math.max(0, nowMs - ms)
  if (d < 60000) return '剛剛'
  if (d < 3600000) return Math.floor(d / 60000) + ' 分鐘前'
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小時前'
  return Math.floor(d / 86400000) + ' 天前'
}

// 看板自己回報的降級也要畫出來。選單列一直有畫這兩行；widget 一開始
// 沒有，於是釘選與隱藏靜靜失效而桌面一片健康。
function notesOf(board) {
  const notes = []
  for (const f of board.adapterFailures || []) notes.push(f)
  // 跟選單列說同一句話。兩個呈現面對同一件事給不同說法，比少講一件事更糟。
  if (board.prDegraded) notes.push(board.prDegraded)
  if (board.invalid > 0) notes.push('有 ' + board.invalid + ' 個 session 記錄無法解析')
  if (board.prefsHealth && board.prefsHealth !== 'ok') {
    notes.push('偏好檔無法解析，釘選與隱藏沒有生效')
  }
  if (notes.length > 0) notes.push('跑 helm doctor 看原因')
  return notes
}

function rowOf(p, nowMs) {
  return {
    key: p.path || p.name,
    name: p.name,
    dot: dotOf(p.aggregateStatus),
    uncertain: isUncertain(p),
    pin: p.pinned ? '📌' : '',
    when: ago(p.lastActivityMs, nowMs),
    live: liveTextOf(activeLive(p)),
  }
}

// 每一種失敗都畫出來。空白的 widget 分不出「都閒著」和「helm 壞了」。
function viewOf(output, error, nowMs) {
  if (error) return { errorText: '⚓ helm 讀不到資料：' + String(error) }
  // 先判空。JSON.parse(null) 不會丟例外，它回 null，於是「完全沒有輸出」
  // 會被歸類成「輸出裡沒有專案清單」—— 兩者要修的東西完全不同。
  if (output == null || String(output).trim() === '') {
    return { errorText: '⚓ helm 沒有輸出' }
  }

  let board
  try {
    board = JSON.parse(output)
  } catch (e) {
    const head = String(output == null ? '' : output).slice(0, 120)
    return { errorText: '⚓ helm 的輸出讀不懂：' + (head || '（沒有輸出）') }
  }
  if (!board || !Array.isArray(board.projects)) {
    return { errorText: '⚓ helm 的輸出裡沒有專案清單' }
  }

  const projects = board.projects
  return {
    errorText: null,
    title: titleOf(projects),
    rows: projects.map((p) => rowOf(p, nowMs)),
    // 「沒有找到 session」是錯的：session 通常還在，只是被時間窗口、
    // 非 git repo、或 helm hide 濾掉了。照這句話去找會找錯方向。
    // PR 自成一區，不掛在專案底下：GitHub 的 owner/repo 對不回本機路徑，
    // 對不上的就會整個消失。而「有哪些 PR 在等我」本來也不是專案層級的問題。
    prs: (board.prs || []).map((pr) => ({
      key: pr.repo + '#' + pr.number,
      text: pr.repo + '#' + pr.number + '  ' + pr.waitingLabel,
      title: pr.title || '',
    })),
    empty: projects.length === 0
      ? '沒有符合條件的專案（近 ' + WINDOW_DAYS + ' 天內有活動且是 git repo）'
      : null,
    notes: notesOf(board),
  }
}

const POS_KEY = 'helm.widget.pos'
const DEFAULT_POS = { top: 20, left: 20 }
const EDGE = 40

// localStorage 跟這個 origin 的所有東西共用，而且每次重裝都還在。
// 讀到壞資料就丟例外的話，整個 widget 會什麼都不畫，使用者也無從得知原因。
function loadPos() {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return DEFAULT_POS
    const p = JSON.parse(raw)
    return p && typeof p.top === 'number' && typeof p.left === 'number'
      ? { top: p.top, left: p.left }
      : DEFAULT_POS
  } catch (e) {
    return DEFAULT_POS
  }
}

// 存不進去就算了 —— 私密瀏覽模式的 setItem 會丟例外。
// 掉一次位置可以接受，掉整個 widget 不行。
function savePos(pos) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos))
  } catch (e) {
    // 位置記不住，但看板照常運作。
  }
}

// 拖出畫面外就再也抓不回來了 —— 至少留一角在裡面。
function clampPos(pos, viewportWidth, viewportHeight) {
  return {
    top: Math.min(Math.max(0, pos.top), Math.max(0, viewportHeight - EDGE)),
    left: Math.min(Math.max(0, pos.left), Math.max(0, viewportWidth - EDGE)),
  }
}

// 載入時就夾一次。只在拖曳中夾的話，在外接螢幕拖到右下角、
// 之後改用筆電螢幕，卡片就落在畫面外 —— 滑鼠按不到，
// 而位置存在 localStorage，重裝也清不掉。
let pos = clampPos(loadPos(), viewportWidth(), viewportHeight())

function viewportWidth() {
  return typeof window === 'undefined' ? Infinity : window.innerWidth
}

function viewportHeight() {
  return typeof window === 'undefined' ? Infinity : window.innerHeight
}

// mousemove/mouseup 掛在 document 上，否則滑鼠一離開卡片就跟丟。
function startDrag(event) {
  if (event.button !== 0) return
  const node = event.currentTarget
  const startX = event.clientX
  const startY = event.clientY
  const origin = { top: pos.top, left: pos.left }
  const move = (e) => {
    pos = clampPos(
      { top: origin.top + e.clientY - startY, left: origin.left + e.clientX - startX },
      viewportWidth(),
      viewportHeight(),
    )
    node.style.top = pos.top + 'px'
    node.style.left = pos.left + 'px'
  }
  const up = () => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
    savePos(pos)
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
  event.preventDefault()
}
// --- /helm:logic ---

const CARD = {
  position: 'fixed',
  width: '300px',
  color: 'rgba(255, 255, 255, 0.9)',
  background: 'rgba(20, 22, 26, 0.72)',
  backdropFilter: 'blur(20px)',
  borderRadius: '12px',
  padding: '12px 14px',
  boxShadow: '0 4px 20px rgba(0, 0, 0, 0.25)',
  cursor: 'move',
  userSelect: 'none',
}

const row = { display: 'flex', alignItems: 'baseline', gap: '6px' }
const dim = { color: 'rgba(255,255,255,0.45)', fontSize: '11px' }
const clip = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

export const render = ({ output, error }) => {
  const view = viewOf(output, error, Date.now())
  const card = { ...CARD, top: pos.top + 'px', left: pos.left + 'px' }
  const shell = (children) => (
    <div style={card} onMouseDown={startDrag}>{children}</div>
  )

  if (view.errorText) return shell(<div>{view.errorText}</div>)

  return shell(
    <div>
      <div style={{ ...row, borderBottom: '1px solid rgba(255,255,255,0.12)', paddingBottom: '6px' }}>
        <span style={{ flex: 1, fontWeight: 600 }}>⚓ helm</span>
        <span style={{ ...dim, color: view.title.color }}>{view.title.word}</span>
      </div>

      {view.empty ? <div style={{ ...dim, marginTop: '6px' }}>{view.empty}</div> : null}

      {view.rows.map((r) => (
        <div key={r.key} style={{ marginTop: '6px' }}>
          <div style={row}>
            <span style={{ color: r.dot || 'transparent' }}>{r.uncertain ? '◍' : '●'}</span>
            <span style={{ flex: 1, ...clip }}>{r.pin}{r.pin ? ' ' : ''}{r.name}</span>
            <span style={dim}>{r.when}</span>
          </div>
          {r.live ? <div style={{ ...dim, ...clip, paddingLeft: '14px' }}>{r.live}</div> : null}
        </div>
      ))}

      {view.prs.length > 0 ? (
        <div style={{ marginTop: '8px', paddingTop: '6px', borderTop: '1px solid rgba(255,255,255,0.12)' }}>
          {view.prs.map((pr) => (
            <div key={pr.key} style={{ ...dim, ...clip }}>{pr.text}</div>
          ))}
        </div>
      ) : null}

      {view.notes.map((n) => (
        <div key={n} style={{ ...dim, ...clip, color: '#fbbf24', marginTop: '6px' }}>⚠ {n}</div>
      ))}
    </div>,
  )
}
`
}
