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

const DOT = { busy: '#4ade80', waiting: '#fbbf24', idle: 'rgba(255,255,255,0.35)' }

const row = { display: 'flex', alignItems: 'baseline', gap: '6px' }
const dim = { color: 'rgba(255,255,255,0.45)', fontSize: '11px' }
const clip = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return '剛剛'
  if (s < 3600) return \`\${Math.floor(s / 60)} 分鐘前\`
  if (s < 86400) return \`\${Math.floor(s / 3600)} 小時前\`
  return \`\${Math.floor(s / 86400)} 天前\`
}

function line(p) {
  const dot = DOT[p.aggregateStatus] || DOT.idle
  const busy = (p.sessions || []).find((s) => s.live && s.live.summary)
  return (
    <div key={p.path} style={{ marginTop: '6px' }}>
      <div style={row}>
        <span style={{ color: dot }}>●</span>
        <span style={{ flex: 1, ...clip }}>{p.name}</span>
        <span style={dim}>{ago(p.lastActivityMs)}</span>
      </div>
      {busy ? (
        <div style={{ ...dim, ...clip, paddingLeft: '14px' }}>
          {busy.live.toolName}: {busy.live.summary}
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
  const running = projects.filter((p) => p.aggregateStatus !== 'idle').length

  return (
    <div>
      <div style={{ ...row, borderBottom: '1px solid rgba(255,255,255,0.12)', paddingBottom: '6px' }}>
        <span style={{ flex: 1, fontWeight: 600 }}>⚓ helm</span>
        <span style={dim}>{running > 0 ? \`\${running} 在跑\` : '都閒著'}</span>
      </div>
      {projects.length === 0 ? <div style={{ ...dim, marginTop: '6px' }}>沒有找到 session</div> : projects.map(line)}
    </div>
  )
}
`
}
