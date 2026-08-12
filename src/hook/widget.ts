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
 */
export function buildWidget(argv: readonly string[]): string {
  const command = JSON.stringify(argv.map(shellQuote).join(' '))
  return `// ${WIDGET_MARKER} —— 這個檔案由 helm install 產生，helm uninstall 會刪掉它。
// 想調位置或配色就直接改，但改過之後 helm install 不會再覆寫它。

export const command = ${command}

export const refreshFrequency = 5000

export const className = \`
  top: 20px;
  left: 20px;
  width: 300px;
  font-family: -apple-system, "Helvetica Neue", sans-serif;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.9);
  background: rgba(20, 22, 26, 0.72);
  backdrop-filter: blur(20px);
  border-radius: 12px;
  padding: 12px 14px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
  line-height: 1.45;
\`

// --- helm:logic --- 這一段不含 JSX，測試會原封不動地執行它。
// aggregateStatus 的值域就是這四個加 null（見 session-status.ts）。
// 第一版寫了一個不存在的 'waiting'，而 ended 與 crashed 雙雙掉進預設值 ——
// 中斷的專案看起來跟閒置的一模一樣。
const DOT = {
  busy: '#4ade80',
  crashed: '#f87171',
  idle: 'rgba(255, 255, 255, 0.55)',
  ended: 'rgba(255, 255, 255, 0.22)',
}

function dotOf(status) {
  return DOT[status] || 'rgba(255, 255, 255, 0.35)'
}

// 跟選單列同一套優先序：先講最需要處理的事。單位是專案，不是 session。
function titleOf(projects) {
  const count = (k) => projects.filter((p) => p.aggregateStatus === k).length
  const crashed = count('crashed')
  if (crashed > 0) return { word: crashed + ' 中斷', color: DOT.crashed }
  const busy = count('busy')
  if (busy > 0) return { word: busy + ' 在跑', color: DOT.busy }
  const idle = count('idle')
  if (idle > 0) return { word: idle + ' 等輸入', color: DOT.idle }
  return { word: '都閒著', color: DOT.idle }
}

const row = { display: 'flex', alignItems: 'baseline', gap: '6px' }
const dim = { color: 'rgba(255,255,255,0.45)', fontSize: '11px' }
const clip = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

// 只有真的在跑才顯示動作。選單列一直是這樣（swiftbar.ts 也擋 nativeStatus），
// widget 一開始沒擋，於是一小時前停掉的專案還掛著 \`Bash: cd …\`，
// 看起來像正在跑那道指令。
function activeLive(p) {
  if (p.aggregateStatus !== 'busy') return null
  const running = (p.sessions || []).find(
    (s) => s.nativeStatus === 'busy' && s.live && s.live.summary,
  )
  return running ? running.live : null
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return '剛剛'
  if (s < 3600) return \`\${Math.floor(s / 60)} 分鐘前\`
  if (s < 86400) return \`\${Math.floor(s / 3600)} 小時前\`
  return \`\${Math.floor(s / 86400)} 天前\`
}
// --- /helm:logic ---

function line(p) {
  const dot = dotOf(p.aggregateStatus)
  const live = activeLive(p)
  return (
    <div key={p.path} style={{ marginTop: '6px' }}>
      <div style={row}>
        <span style={{ color: dot }}>●</span>
        <span style={{ flex: 1, ...clip }}>{p.name}</span>
        <span style={dim}>{ago(p.lastActivityMs)}</span>
      </div>
      {live ? (
        <div style={{ ...dim, ...clip, paddingLeft: '14px' }}>
          {live.toolName}: {live.summary}
        </div>
      ) : null}
    </div>
  )
}

export const render = ({ output, error }) => {
  // Every failure is drawn. An empty widget cannot be told apart from a quiet
  // machine, and "helm is broken" must never look like "nothing is running".
  if (error) return <div>⚓ helm 讀不到資料：{String(error)}</div>

  let board
  try {
    board = JSON.parse(output)
  } catch (e) {
    const head = String(output || '').slice(0, 120)
    return <div>⚓ helm 的輸出讀不懂：{head || '（沒有輸出）'}</div>
  }

  const projects = board.projects || []
  const title = titleOf(projects)

  return (
    <div>
      <div style={{ ...row, borderBottom: '1px solid rgba(255,255,255,0.12)', paddingBottom: '6px' }}>
        <span style={{ flex: 1, fontWeight: 600 }}>⚓ helm</span>
        <span style={{ ...dim, color: title.color }}>{title.word}</span>
      </div>
      {projects.length === 0 ? <div style={{ ...dim, marginTop: '6px' }}>沒有找到 session</div> : projects.map(line)}
    </div>
  )
}
`
}
