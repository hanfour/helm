import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { LiveMarker } from '../types.ts'

const MAX_SUMMARY = 200

const LiveSchema = z.object({
  sessionId: z.string().min(1),
  ts: z.number(),
  toolName: z.string().default(''),
  summary: z.string().default(''),
}).passthrough()

/**
 * Written by the PreToolUse hook, one line, overwritten each call.
 * helm owns this file — Claude Code never touches it — so it survives
 * upstream cleaning of the session registry (spec §4.3).
 */
export function readLiveMarker(liveDir: string, sessionId: string): LiveMarker | null {
  // Session ids come from parsed files, but they end up in a path, so treat
  // them as untrusted anyway.
  if (sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..')) {
    return null
  }
  try {
    const raw = readFileSync(join(liveDir, `${sessionId}.json`), 'utf8')
    const parsed = LiveSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return null
    const d = parsed.data
    return {
      sessionId: d.sessionId,
      ts: d.ts,
      toolName: d.toolName,
      summary: d.summary.slice(0, MAX_SUMMARY),
    }
  } catch {
    // File read or JSON parse failed; treating this as "no live marker"
    // is correct because the marker is owned by helm and was written
    // correctly when it existed.
    return null
  }
}
