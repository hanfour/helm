import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { HelmPaths } from '../../paths.ts'
import type { DiscoveredSession } from '../../types.ts'
import { readRegistry } from './registry.ts'

export const ADAPTER_ID = 'claude-code'

export interface DiscoverResult {
  sessions: DiscoveredSession[]
  /** Registry files that existed but could not be parsed. Surfaced to the user. */
  invalid: number
}

/**
 * Fast path only: reads the registry directory and locates each session's
 * transcript by path existence. Must never read a transcript's contents and
 * must never spawn a subprocess — `helm menu` calls this every five seconds
 * (spec §5.1).
 *
 * Liveness deliberately does NOT belong here. Reconciliation (Task 4) needs
 * one `ps` result for the whole session set, so `collectStatus` (Task 6)
 * makes that single call and passes it down. Probing here as well would
 * spawn `ps` twice per poll for no gain.
 */
export function discoverClaudeCode(paths: HelmPaths): DiscoverResult {
  const { entries, invalid } = readRegistry(paths.claudeSessions)

  const sessions = entries
    .map((e): DiscoveredSession => ({
      adapterId: ADAPTER_ID,
      sessionId: e.sessionId,
      cwd: e.cwd,
      pid: e.pid,
      procStart: e.procStart,
      startedAt: e.startedAt,
      updatedAt: e.updatedAt,
      nativeStatus: e.status,
      kind: e.kind,
      name: e.name,
      transcriptPath: findTranscript(paths.claudeProjects, e.cwd, e.sessionId),
    }))
    .toSorted((a, b) => b.updatedAt - a.updatedAt)

  return { sessions, invalid }
}

/** Claude Code slugifies the cwd by replacing every non-alphanumeric run with `-`. */
export function slugifyCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]+/g, '-')
}

function findTranscript(projectsDir: string, cwd: string, sessionId: string): string | null {
  const candidate = join(projectsDir, slugifyCwd(cwd), `${sessionId}.jsonl`)
  return existsSync(candidate) ? candidate : null
}
