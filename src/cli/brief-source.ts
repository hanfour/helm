import { readTranscriptDigest } from '../adapters/claude-code/transcript.ts'
import type { Brief } from '../cache/store.ts'
import { digestOf, getFreshBriefEntry, readCache, setBrief, writeCache } from '../cache/store.ts'
import type { HelmPaths } from '../paths.ts'
import { renderBriefMarkdown, renderFallback } from '../render/brief-md.ts'
import { generateBrief, type ClaudeRunner } from '../summarize/brief.ts'
import { readGitSnapshot } from '../summarize/git.ts'
import { buildSummaryInput } from '../summarize/input.ts'
import type { SessionState } from '../types.ts'

export interface BriefRequest {
  refresh: boolean
  /** Where to warn the user before an expensive call. Usually stderr. */
  notify: (message: string) => void
  /** Injected so callers can render a stable timestamp in tests. */
  now: () => number
}

export interface BriefOutcome {
  markdown: string
  /** False when the model returned nothing usable and the fallback was rendered. */
  ok: boolean
}

/**
 * `helm brief` and `helm open` need exactly the same thing — the freshest
 * usable brief for a session, as markdown — and they must not drift into two
 * answers about caching, cost warnings, or what to do when the model fails.
 */
export async function briefMarkdownFor(
  session: SessionState,
  paths: HelmPaths,
  run: ClaudeRunner,
  req: BriefRequest,
): Promise<BriefOutcome> {
  const digest = readTranscriptDigest(session.transcriptPath ?? '')
  const fingerprint = digestOf(session.transcriptPath)
  const cache = readCache(paths.cacheFile)
  const cached = req.refresh
    ? null
    : getFreshBriefEntry(cache, session.sessionId, fingerprint)

  if (cached !== null) {
    return { markdown: render(session, digest.gitBranch, cached.body, cached.generatedAt), ok: true }
  }

  warnBeforeSpending(session, req.notify)
  const brief = await generateBrief(
    buildSummaryInput(session, digest, readGitSnapshot(session.cwd)),
    run,
  )
  if (brief === null) return { markdown: renderFallback(digest.prompts), ok: false }

  const generatedAt = req.now()
  if (fingerprint !== null) {
    writeCache(
      paths.cacheFile,
      setBrief(cache, session.sessionId, { digest: fingerprint, generatedAt, body: brief }),
    )
  }
  return { markdown: render(session, digest.gitBranch, brief, generatedAt), ok: true }
}

function render(
  session: SessionState,
  gitBranch: string | null,
  brief: Brief,
  generatedAt: number,
): string {
  return renderBriefMarkdown(brief, {
    sessionId: session.sessionId,
    cwd: session.cwd,
    gitBranch,
    generatedAt,
  })
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
function warnBeforeSpending(session: SessionState, notify: (m: string) => void): void {
  const stillRunning = session.lifecycle === 'running'
  notify(
    `正在產生交接簡報，需要 1-2 分鐘…${stillRunning ? '\n（這個 session 還在跑，內容持續變動，所以每次都得重新產生）' : ''}\n`,
  )
}
