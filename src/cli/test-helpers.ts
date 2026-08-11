import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PrefsFile } from '../projects/prefs.ts'

/**
 * Fixtures cannot live in the OS temp dir: `include.ts` deliberately excludes
 * /tmp and /var/folders as noise, so a project rooted there is never listed.
 *
 * Namespaced by pid because `node --test` runs each file as its own process
 * and a shared path would let one file's cleanup delete fixtures another is
 * still using mid-test.
 */
const ROOT = fileURLToPath(new URL(`../../.test-scratch/${process.pid}-cli/`, import.meta.url))
mkdirSync(ROOT, { recursive: true })

export const SCRATCH = {
  root: ROOT,
  cleanup: (): void => rmSync(ROOT, { recursive: true, force: true }),
}

export interface SessionSpec {
  id: string
  /** Present means a registry file too, i.e. the session is still running. */
  pid?: number
  status?: 'busy' | 'idle'
  procStart?: string
  /** Defaults to a single user turn so the transcript is not empty. */
  content?: string
}

export interface ProjectSpec {
  project: string
  sessions: readonly SessionSpec[]
}

/** A home whose projects are git repos holding the given sessions. */
export function scaffoldHome(specs: readonly ProjectSpec[]): string {
  const home = mkdtempSync(join(ROOT, 'home-'))
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
  for (const spec of specs) {
    const cwd = join(home, spec.project)
    mkdirSync(join(cwd, '.git'), { recursive: true })
    const dir = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(dir, { recursive: true })
    for (const s of spec.sessions) writeSession(home, cwd, dir, s)
  }
  return home
}

function writeSession(home: string, cwd: string, dir: string, s: SessionSpec): void {
  writeFileSync(
    join(dir, `${s.id}.jsonl`),
    `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: s.content ?? '做一件事' },
    })}\n`,
  )
  if (s.pid === undefined) return
  writeFileSync(
    join(home, '.claude', 'sessions', `${s.pid}.json`),
    JSON.stringify({
      pid: s.pid, sessionId: s.id, cwd, startedAt: Date.now(),
      procStart: s.procStart ?? 'Mon Aug 10 00:00:00 2026',
      kind: 'interactive', name: '', status: s.status ?? 'idle', updatedAt: Date.now(),
    }),
  )
}

export interface Captured {
  code: number
  out: string
  err: string
}

/** Restores the streams and HELM_FAKE_HOME even when the command throws. */
export function captureSync(home: string, fn: () => number): Captured {
  return runCaptured(home, fn) as Captured
}

export async function captureAsync(
  home: string,
  fn: () => Promise<number>,
): Promise<Captured> {
  return runCaptured(home, fn) as Promise<Captured>
}

function runCaptured(
  home: string,
  fn: () => number | Promise<number>,
): Captured | Promise<Captured> {
  const outs: string[] = []
  const errs: string[] = []
  const realOut = process.stdout.write.bind(process.stdout)
  const realErr = process.stderr.write.bind(process.stderr)
  const previous = process.env['HELM_FAKE_HOME']
  process.stdout.write = ((c: string) => (outs.push(String(c)), true)) as typeof process.stdout.write
  process.stderr.write = ((c: string) => (errs.push(String(c)), true)) as typeof process.stderr.write
  process.env['HELM_FAKE_HOME'] = home

  const restore = (): void => {
    process.stdout.write = realOut
    process.stderr.write = realErr
    if (previous === undefined) delete process.env['HELM_FAKE_HOME']
    else process.env['HELM_FAKE_HOME'] = previous
  }

  try {
    const result = fn()
    if (typeof result === 'number') {
      restore()
      return { code: result, out: outs.join(''), err: errs.join('') }
    }
    return result.then(
      (code) => {
        restore()
        return { code, out: outs.join(''), err: errs.join('') }
      },
      (err: unknown) => {
        restore()
        throw err
      },
    )
  } catch (err) {
    restore()
    throw err
  }
}

export function readPrefsOf(home: string): PrefsFile {
  return JSON.parse(readFileSync(join(home, '.helm', 'projects.json'), 'utf8')) as PrefsFile
}
