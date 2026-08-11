import { execFileSync } from 'node:child_process'
import type { GitSnapshot } from './input.ts'

const TIMEOUT_MS = 3000
const MAX_BYTES = 64 * 1024

export function readGitSnapshot(cwd: string): GitSnapshot {
  return {
    diffStat: git(cwd, ['diff', '--stat']),
    statusShort: git(cwd, ['status', '--short']),
  }
}

function git(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    // A missing repo, a detached worktree, a dirty timeout, or a slow disk
    // must all degrade to '' — git context is decoration for the brief
    // prompt, never load-bearing, so failing loud here would block a
    // handoff brief over something the user can't even fix mid-crash.
    return ''
  }
}
