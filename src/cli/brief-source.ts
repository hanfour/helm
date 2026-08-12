import { join } from 'node:path'
import { readTranscriptDigest, type TranscriptDigest } from '../adapters/claude-code/transcript.ts'
import { codexPrompts } from '../adapters/codex/history.ts'
import { CODEX_ADAPTER_ID } from '../adapters/codex/discover.ts'
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
  // The cache is consulted before the transcript is opened. `digestOf` is one
  // statSync; `readTranscriptDigest` pulls a file measured at 8.6 MB into
  // memory and zod-parses every line. Doing that first meant every cache hit —
  // the common case — paid the entire slow path to recover one branch name.
  const fingerprint = digestOf(session.transcriptPath)
  const cache = readCache(paths.cacheFile)
  const cached = req.refresh
    ? null
    : getFreshBriefEntry(cache, session.sessionId, fingerprint)
  if (cached !== null) {
    return {
      markdown: render(session, cached.gitBranch, cached.body, cached.generatedAt),
      ok: true,
    }
  }

  const digest = digestFor(session, paths)
  if (nothingToSummarize(session, digest)) {
    return { markdown: renderNothingToSummarize(), ok: false }
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
      setBrief(cache, session.sessionId, {
        digest: fingerprint, generatedAt, gitBranch: digest.gitBranch, body: brief,
      }),
    )
  }
  return { markdown: render(session, digest.gitBranch, brief, generatedAt), ok: true }
}

/**
 * A session with no transcript, or one that never got past its first turn, has
 * nothing for the model to read. Asking anyway costs the measured 57-86 s for
 * a prompt whose every section is `（無）`, and because the fingerprint is null
 * the answer can never be cached — so the same minute is spent again on every
 * single retry.
 */
/**
 * Where a session's meaning comes from, which differs per CLI.
 *
 * A Codex rollout is not a Claude Code transcript — reading one with
 * `readTranscriptDigest` yields an empty digest, so the brief would report
 * "nothing to summarise" for a session the user sent a dozen prompts to.
 * Codex writes those prompts to `~/.codex/history.jsonl` instead, which is
 * the same semantic layer for free.
 *
 * The other fields stay empty: touched files and tool calls live inside the
 * rollout's own event stream, and parsing that is slow-path work this does
 * not need — the prompts alone carry what the brief is for.
 */
export function digestFor(session: SessionState, paths: HelmPaths): TranscriptDigest {
  if (session.adapterId !== CODEX_ADAPTER_ID) {
    return readTranscriptDigest(session.transcriptPath ?? '')
  }
  return {
    prompts: codexPrompts(join(paths.home, '.codex', 'history.jsonl'), session.sessionId),
    touchedFiles: [],
    recentTools: [],
    lastTs: null,
    gitBranch: null,
  }
}

function nothingToSummarize(session: SessionState, digest: TranscriptDigest): boolean {
  if (session.transcriptPath === null) return true
  return digest.prompts.length === 0 && digest.recentTools.length === 0
}

/** Distinct from `renderFallback`: nothing failed here, there was nothing to do. */
function renderNothingToSummarize(): string {
  return [
    '這個 session 沒有可以做成簡報的內容。',
    '',
    '找不到它的 transcript，或裡面還沒有任何對話與工具呼叫。',
    '（沒有向模型發問，因此沒有產生任何花費）',
    '',
  ].join('\n')
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
