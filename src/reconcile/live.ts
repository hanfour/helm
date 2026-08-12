import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { LiveMarker } from '../types.ts'

const MAX_SUMMARY = 200

const LiveSchema = z.object({
  sessionId: z.string().min(1),
  ts: z.number().default(0),
  toolName: z.string().default(''),
  summary: z.string().default(''),
}).passthrough()

/**
 * Written by the PreToolUse hook, one line, replaced atomically each call.
 * helm owns this file — Claude Code never touches it — so it survives
 * upstream cleaning of the session registry (spec §4.3).
 *
 * Null means the file is genuinely absent. A file that exists but cannot be
 * parsed comes back as a `degraded` marker instead, never as null: collapsing
 * the two made lifecycle report `ended_clean` at high confidence for exactly
 * the session that had been killed mid-write, and `helm doctor` then deleted
 * the evidence. The timestamp survives regardless because it is the file's
 * mtime, so the §6 comparison against the transcript still works.
 */
export function readLiveMarker(liveDir: string, sessionId: string): LiveMarker | null {
  // Session ids come from parsed files, but they end up in a path, so treat
  // them as untrusted anyway.
  if (sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..')) {
    return null
  }
  const file = join(liveDir, `${sessionId}.json`)
  // The hook writes `ts: 0`; the kernel's mtime is the same instant with
  // better precision, and it is readable even when the body is not.
  const ts = mtimeOf(file)
  if (ts === null) return null

  const body = parseBody(file)
  if (body === null || body.sessionId !== sessionId) {
    return { sessionId, ts, toolName: '', summary: '', degraded: true }
  }
  return {
    sessionId,
    ts,
    toolName: body.toolName,
    summary: body.summary.slice(0, MAX_SUMMARY),
    degraded: false,
  }
}

/** Null distinguishes "no such file" from every other outcome. */
function mtimeOf(file: string): number | null {
  try {
    return statSync(file).mtimeMs
  } catch {
    // Absent or unreachable. Absent is the overwhelmingly common case and the
    // only one where "there is no marker" is the honest answer.
    return null
  }
}

function parseBody(file: string): { sessionId: string; toolName: string; summary: string } | null {
  try {
    const parsed = LiveSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    // Truncated, empty, or not JSON. The caller degrades rather than pretends
    // the file was never there.
    return null
  }
}
