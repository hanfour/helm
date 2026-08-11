import { briefPathFor, defaultDeps, openSession, writeBriefFile, type LaunchDeps } from '../launch/run.ts'
import { runClaudeHeadless, type ClaudeRunner } from '../summarize/brief.ts'
import type { SessionState } from '../types.ts'
import { briefMarkdownFor } from './brief-source.ts'
import { collectStatus, currentPaths } from './status.ts'
import { resolveOrReport, type TargetHit } from './target.ts'

const SHORT_ID = 8

export interface OpenDeps {
  run: ClaudeRunner
  launch: () => LaunchDeps
}

export async function runOpen(
  argv: readonly string[],
  deps: OpenDeps = { run: runClaudeHeadless, launch: defaultDeps },
): Promise<number> {
  const query = argv.find((a) => !a.startsWith('--'))
  if (query === undefined) {
    process.stderr.write('用法：helm open <專案或 session-id> [--no-brief] [--refresh]\n')
    return 2
  }

  const paths = currentPaths()
  const { projects } = collectStatus(paths, Date.now())
  const hit = resolveOrReport(projects, query, (m) => process.stderr.write(m))
  if (hit === null) return 1

  const session = pickSession(hit, (m) => process.stderr.write(m))
  if (session === null) return 1

  const briefPath = argv.includes('--no-brief')
    ? null
    : await writeBrief(session, paths, deps, argv.includes('--refresh'))

  try {
    openSession(session, briefPath, deps.launch())
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const where = briefPath === null ? '' : `簡報已寫到 ${briefPath}，`
    process.stderr.write(`開啟終端機失敗：${msg}\n${where}可自行開終端機接續。\n`)
    return 1
  }

  const note = briefPath === null ? '' : `（簡報：${briefPath}）`
  process.stdout.write(`已開啟 ${session.cwd}${note}\n`)
  return 0
}

/**
 * Naming a session id picks that session. Naming a project needs a decision,
 * and there is exactly one case where helm must not make it: more than one
 * session in that project is still running. Those are live terminals the user
 * has open right now, and resuming the wrong one is not something an error
 * message afterwards can undo.
 *
 * With no live session — the state after a reboot, which is the whole reason
 * this tool exists — the newest session is what "接續" means.
 */
function pickSession(hit: TargetHit, write: (m: string) => void): SessionState | null {
  if (hit.session !== null) return hit.session

  const live = hit.project.sessions.filter((s) => s.lifecycle === 'running')
  if (live.length > 1) {
    write(listLive(hit.project.name, live))
    return null
  }
  const chosen = live[0] ?? hit.project.sessions[0] ?? null
  if (chosen === null) write(`專案 ${hit.project.name} 底下沒有 session 可以接續。\n`)
  return chosen
}

async function writeBrief(
  session: SessionState,
  paths: ReturnType<typeof currentPaths>,
  deps: OpenDeps,
  refresh: boolean,
): Promise<string> {
  const path = briefPathFor(paths.helmBriefs, session.sessionId)
  const outcome = await briefMarkdownFor(session, paths, deps.run, {
    refresh,
    notify: (m) => process.stderr.write(m),
    now: Date.now,
  })
  writeBriefFile(path, outcome.markdown)
  return path
}

function listLive(projectName: string, live: readonly SessionState[]): string {
  const rows = live
    .map((s) => `  ${s.sessionId.slice(0, SHORT_ID)}  ${s.nativeStatus === 'busy' ? '執行中' : '等輸入'}`)
    .join('\n')
  return `${projectName} 底下有 ${live.length} 個 session 還在跑，請指定要接續哪一個：\n${rows}\n`
}
