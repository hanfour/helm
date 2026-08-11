import type { TranscriptDigest } from '../adapters/claude-code/transcript.ts'
import { readTranscriptDigest } from '../adapters/claude-code/transcript.ts'
import type { Brief } from '../cache/store.ts'
import {
  digestOf, getFreshBrief, readCache, setBrief, writeCache,
} from '../cache/store.ts'
import { renderBriefMarkdown, renderFallback } from '../render/brief-md.ts'
import { generateBrief, runClaudeHeadless, type ClaudeRunner } from '../summarize/brief.ts'
import { readGitSnapshot } from '../summarize/git.ts'
import { buildSummaryInput } from '../summarize/input.ts'
import type { SessionState } from '../types.ts'
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

  const digest = readTranscriptDigest(session.transcriptPath ?? '')
  const fingerprint = digestOf(session.transcriptPath)
  const cache = readCache(paths.cacheFile)
  const cached = argv.includes('--refresh')
    ? null
    : getFreshBrief(cache, session.sessionId, fingerprint)

  const brief = cached ?? await generateWithNotice(session, digest, run)

  if (brief === null) {
    process.stdout.write(renderFallback(digest.prompts))
    return 1
  }

  if (cached === null && fingerprint !== null) {
    writeCache(
      paths.cacheFile,
      setBrief(cache, session.sessionId, {
        digest: fingerprint, generatedAt: Date.now(), body: brief,
      }),
    )
  }

  process.stdout.write(renderBriefMarkdown(brief, {
    sessionId: session.sessionId,
    cwd: session.cwd,
    gitBranch: digest.gitBranch,
    generatedAt: Date.now(),
  }))
  return 0
}

/**
 * Generating costs an LLM call that measured 57-86 seconds against real
 * sessions. Never spend that silently: a user staring at a frozen terminal
 * cannot tell "working" from "hung", and has no chance to abort.
 *
 * A running session's transcript keeps growing, so its digest never
 * stabilizes and the cache can never hit — say so, or the user will wonder
 * why the same command is slow every single time.
 */
async function generateWithNotice(
  session: SessionState,
  digest: TranscriptDigest,
  run: ClaudeRunner,
): Promise<Brief | null> {
  const stillRunning = session.lifecycle === 'running'
  process.stderr.write(
    `正在產生交接簡報，需要 1-2 分鐘…${stillRunning ? '\n（這個 session 還在跑，內容持續變動，所以每次都得重新產生）' : ''}\n`,
  )
  return generateBrief(buildSummaryInput(session, digest, readGitSnapshot(session.cwd)), run)
}
