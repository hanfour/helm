import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { HelmPaths } from '../../paths.ts'
import type { DiscoveredSession } from '../../types.ts'
import { readRegistry } from './registry.ts'
import { queryProcesses, type ProcessProbe } from './processes.ts'

export const ADAPTER_ID = 'claude-code'

/**
 * Fast path only: reads the registry directory and asks `ps` about the PIDs
 * it found. Must never read a transcript — `helm menu` calls this every
 * five seconds (spec §5.1).
 *
 * The probe is injectable so tests do not depend on live processes.
 */
export function discoverClaudeCode(
  paths: HelmPaths,
  probe: ProcessProbe = queryProcesses,
): DiscoveredSession[] {
  const { entries } = readRegistry(paths.claudeSessions)
  const alive = probe(entries.map((e) => e.pid))

  return entries
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
      // `alive` is consumed by reconcile (Task 4), not stored here.
    }))
    .toSorted((a, b) => b.updatedAt - a.updatedAt)
}

/** Claude Code slugifies the cwd by replacing every non-alphanumeric run with `-`. */
export function slugifyCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]+/g, '-')
}

function findTranscript(projectsDir: string, cwd: string, sessionId: string): string | null {
  const candidate = join(projectsDir, slugifyCwd(cwd), `${sessionId}.jsonl`)
  return existsSync(candidate) ? candidate : null
}
