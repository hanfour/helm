import { runClaudeHeadless, type ClaudeRunner } from '../summarize/brief.ts'
import { briefMarkdownFor } from './brief-source.ts'
import { collectStatus, currentPaths } from './status.ts'
import { chosenSession, resolveOrReport } from './target.ts'

export async function runBrief(
  argv: readonly string[],
  run: ClaudeRunner = runClaudeHeadless,
): Promise<number> {
  const query = argv.find((a) => !a.startsWith('--'))
  if (query === undefined) {
    process.stderr.write('用法：helm brief <專案或 session-id> [--refresh]\n')
    return 2
  }

  const paths = currentPaths()
  const { projects } = collectStatus(paths, Date.now())
  const hit = resolveOrReport(projects, query, (m) => process.stderr.write(m))
  if (hit === null) return 1

  // Naming a project means "brief me on what I was last doing here", which is
  // the newest session. Naming a session id means exactly that session.
  const session = chosenSession(hit)
  if (session === null) {
    process.stderr.write(`專案 ${hit.project.name} 底下沒有 session 可以做簡報。\n`)
    return 1
  }

  const outcome = await briefMarkdownFor(session, paths, run, {
    refresh: argv.includes('--refresh'),
    notify: (m) => process.stderr.write(m),
    now: Date.now,
  })
  process.stdout.write(outcome.markdown)
  return outcome.ok ? 0 : 1
}
