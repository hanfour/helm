import type { SessionState } from '../../types.ts'
import { decideCodexLifecycle } from '../../reconcile/lifecycle.ts'
import { loadMetaCache, resolveMeta, type RolloutMeta } from './meta.ts'
import { liveCodexCwds } from './processes.ts'
import { scanRollouts, type RolloutFile } from './scan.ts'

export const CODEX_ADAPTER_ID = 'codex'

export interface CodexOptions {
  sessionsDir: string
  cacheFile: string
  windowDays: number
  nowMs: number
  /** Project paths exempt from the activity window, i.e. pinned ones. */
  alwaysInclude?: readonly string[]
}

export interface CodexDeps {
  scan: (sessionsDir: string, sinceMs: number) => RolloutFile[]
  meta: (file: RolloutFile) => RolloutMeta | null
  liveCwds: () => Set<string>
  flush: () => void
}

export interface CodexResult {
  sessions: SessionState[]
  /** Rollouts helm could not read. Surfaced, never swallowed. */
  invalid: number
}

export function defaultCodexDeps(cacheFile: string): CodexDeps {
  const cache = loadMetaCache(cacheFile)
  return {
    scan: scanRollouts,
    meta: (file) => resolveMeta(file, cache),
    liveCwds: () => liveCodexCwds(),
    flush: () => cache.flush(),
  }
}

/**
 * Every Codex session with recent activity, as `SessionState`.
 *
 * Unlike Claude Code this returns fully reconciled state rather than raw
 * discoveries: Codex has no registry to cross-check and no live markers, so
 * there is nothing for a separate reconcile pass to add — the verdict falls
 * out of the process table and the newest mtime.
 *
 * **Rollout files are grouped by session id, not taken one per row.** One
 * session spans several rollouts as it continues and forks; measured here,
 * 192 files are 86 sessions and the largest single session has 33 files.
 * Emitting one row per file would draw that project 33 times.
 */
export function discoverCodex(opts: CodexOptions, deps: CodexDeps): CodexResult {
  const sinceMs = opts.nowMs - opts.windowDays * 86_400_000
  const always = new Set(opts.alwaysInclude ?? [])

  let files: RolloutFile[]
  try {
    files = deps.scan(opts.sessionsDir, earliest(sinceMs, always.size > 0))
  } catch {
    // Not having Codex, or an unreadable ~/.codex, must not take the board
    // down — the Claude Code half is entirely independent of it.
    return { sessions: [], invalid: 0 }
  }

  const groups = new Map<string, { cwd: string; files: RolloutFile[] }>()
  let invalid = 0
  for (const file of files) {
    const meta = deps.meta(file)
    if (meta === null) {
      invalid++
      continue
    }
    const group = groups.get(meta.sessionId)
    if (group === undefined) groups.set(meta.sessionId, { cwd: meta.cwd, files: [file] })
    else group.files.push(file)
  }

  const live = deps.liveCwds()
  const sessions = [...groups.entries()].flatMap(([sessionId, { cwd, files: group }]) => {
    const newest = group.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a))
    const updatedAt = newest.mtimeMs
    // The window was widened above so pinned projects could survive the scan;
    // everything else outside it is dropped here, where the cwd is known.
    if (updatedAt < sinceMs && !always.has(cwd)) return []

    const verdict = decideCodexLifecycle({
      cwdHasProcess: live.has(cwd),
      lastEventMs: updatedAt,
      nowMs: opts.nowMs,
    })
    return [{
      adapterId: CODEX_ADAPTER_ID,
      sessionId,
      cwd,
      // No PID registry exists for Codex (spec §5.3), so there is nothing
      // honest to put here.
      pid: null,
      procStart: null,
      startedAt: Math.min(...group.map((f) => f.startedAt)),
      updatedAt,
      // No hook means no way to know whether it is mid-tool-call. Inventing a
      // "busy" would be claiming knowledge helm does not have.
      nativeStatus: null,
      kind: 'interactive',
      name: '',
      transcriptPath: newest.path,
      transcriptMtimeMs: updatedAt,
      lifecycle: verdict.lifecycle,
      lifecycleConfidence: verdict.confidence,
      // Live markers come from the PreToolUse hook, which Codex has no
      // equivalent of.
      live: null,
    }]
  })

  deps.flush()
  return { sessions, invalid }
}

/**
 * Pinned projects are exempt from the activity window (spec §7), but the scan
 * filters on mtime before any cwd is known — so when anything is pinned the
 * scan has to look further back and the filtering happens after grouping.
 */
function earliest(sinceMs: number, hasPinned: boolean): number {
  return hasPinned ? 0 : sinceMs
}
