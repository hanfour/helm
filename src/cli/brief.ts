import { readTranscriptDigest } from '../adapters/claude-code/transcript.ts'
import {
  digestOf, getFreshBrief, readCache, setBrief, writeCache,
} from '../cache/store.ts'
import type { ProjectView } from '../projects/group.ts'
import { renderBriefMarkdown, renderFallback } from '../render/brief-md.ts'
import { generateBrief, runClaudeHeadless, type ClaudeRunner } from '../summarize/brief.ts'
import { readGitSnapshot } from '../summarize/git.ts'
import { buildSummaryInput } from '../summarize/input.ts'
import type { SessionState } from '../types.ts'
import { collectStatus, currentPaths } from './status.ts'

/** Accepts the 8-char short id shown by `helm status`, or a full session id. */
export function resolveSession(
  projects: readonly ProjectView[],
  idPrefix: string,
): SessionState | null {
  const all = projects.flatMap((p) => p.sessions)
  return all.find((s) => s.sessionId.startsWith(idPrefix)) ?? null
}

export async function runBrief(
  argv: readonly string[],
  run: ClaudeRunner = runClaudeHeadless,
): Promise<number> {
  const idPrefix = argv.find((a) => !a.startsWith('--'))
  if (idPrefix === undefined) {
    process.stderr.write('用法：helm brief <session-id> [--refresh]\n')
    return 2
  }

  const paths = currentPaths()
  const { projects } = collectStatus(paths, Date.now())
  const session = resolveSession(projects, idPrefix)
  if (session === null) {
    process.stderr.write(`找不到符合 "${idPrefix}" 的 session。先跑 helm status 看看有哪些。\n`)
    return 1
  }

  const digest = readTranscriptDigest(session.transcriptPath ?? '')
  const fingerprint = digestOf(session.transcriptPath)
  const cache = readCache(paths.cacheFile)
  const cached = argv.includes('--refresh')
    ? null
    : getFreshBrief(cache, session.sessionId, fingerprint)

  const brief = cached ?? await generateBrief(
    buildSummaryInput(session, digest, readGitSnapshot(session.cwd)),
    run,
  )

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
