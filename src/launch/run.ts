import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionState } from '../types.ts'
import {
  buildLaunchScript, buildResumeCommand, detectTerminal, type Terminal,
} from './script.ts'

const OSASCRIPT_TIMEOUT_MS = 10_000

export interface LaunchDeps {
  term: Terminal
  runOsascript: (script: string) => void
}

export function defaultDeps(): LaunchDeps {
  return { term: detectTerminal(existsSync), runOsascript }
}

export function briefPathFor(briefsDir: string, sessionId: string): string {
  return join(briefsDir, `${sessionId}.md`)
}

export function writeBriefFile(path: string, markdown: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, markdown, 'utf8')
}

/**
 * Spec §9: the brief goes to a file and the resumed session is told to read
 * it. Pasting the whole brief in as the first message would poison the new
 * session's context with a wall of text before the user says anything.
 */
export function openSession(
  session: SessionState,
  briefPath: string,
  deps: LaunchDeps,
): void {
  const opening = `讀 ${briefPath} 後接續`
  const command = buildResumeCommand(session.adapterId, session.sessionId, opening)
  deps.runOsascript(buildLaunchScript(deps.term, session.cwd, command))
}

function runOsascript(script: string): void {
  execFileSync('osascript', ['-e', script], {
    timeout: OSASCRIPT_TIMEOUT_MS,
    // stderr is piped rather than inherited so an AppleScript error surfaces
    // through the thrown error's message instead of appearing unattributed in
    // the middle of helm's own output.
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}
