import { readFileSync } from 'node:fs'

/** Enough to reconstruct what the session was about, without flooding it. */
const DEFAULT_LIMIT = 40

/**
 * The user's own prompts for one Codex session.
 *
 * `~/.codex/history.jsonl` is one line per prompt across every session —
 * exactly the semantic layer Claude Code needs a `UserPromptSubmit` hook to
 * get, and here it costs nothing to read.
 *
 * Measured 2026-08-12: 552 lines covering 60 of the 192 rollouts on this
 * machine. A session with no entry is not an error — it simply never had a
 * prompt sent, and the brief falls back to the rollout itself.
 */
export function codexPrompts(
  historyPath: string,
  sessionId: string,
  limit: number = DEFAULT_LIMIT,
): string[] {
  let body: string
  try {
    body = readFileSync(historyPath, 'utf8')
  } catch {
    // Codex not installed, or no history yet. Both ordinary.
    return []
  }

  const found: { ts: number; text: string }[] = []
  for (const line of body.split('\n')) {
    if (line === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // One torn line — Codex may be appending right now — must not cost the
      // brief every other prompt in the file.
      continue
    }
    if (!isRecord(parsed)) continue
    const { session_id: id, ts, text } = parsed
    if (id !== sessionId || typeof ts !== 'number' || typeof text !== 'string') continue
    if (text === '') continue
    found.push({ ts, text })
  }

  return found
    .sort((a, b) => a.ts - b.ts)
    .slice(-limit)
    .map((e) => e.text)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
