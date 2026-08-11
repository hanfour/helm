import { readFileSync } from 'node:fs'

export interface ToolCall {
  ts: number
  name: string
  summary: string
}

export interface TranscriptDigest {
  prompts: string[]
  touchedFiles: string[]
  recentTools: ToolCall[]
  lastTs: number | null
  gitBranch: string | null
}

export interface DigestLimits {
  prompts: number
  files: number
  tools: number
}

/** Spec 8: 20 prompts, 50 files, 3 tool calls. */
export const DEFAULT_LIMITS: DigestLimits = { prompts: 20, files: 50, tools: 3 }

const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const MAX_SUMMARY = 200

const EMPTY: TranscriptDigest = {
  prompts: [], touchedFiles: [], recentTools: [], lastTs: null, gitBranch: null,
}

/**
 * Slow path only. Never call this from collectStatus — the largest observed
 * transcript is 7679 lines and `helm menu` runs every five seconds.
 */
export function readTranscriptDigest(
  path: string,
  limits: DigestLimits = DEFAULT_LIMITS,
): TranscriptDigest {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // File not found or unreadable; return empty digest so the caller
    // can decide how to present absence to the user. Contrast with
    // errors that should crash (e.g., permission denied on a directory the
    // harness expects to exist) — those still fail.
    return EMPTY
  }

  const acc = text.split('\n').reduce<TranscriptDigest>((a, line) => {
    if (line.trim() === '') return a
    const rec = safeParse(line)
    return rec === null ? a : absorb(a, rec)
  }, EMPTY)

  return {
    prompts: acc.prompts.slice(-limits.prompts),
    touchedFiles: acc.touchedFiles.slice(-limits.files),
    recentTools: acc.recentTools.slice(-limits.tools),
    lastTs: acc.lastTs,
    gitBranch: acc.gitBranch,
  }
}

function safeParse(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
  } catch {
    // Malformed line; skip it and continue parsing the rest of the transcript.
    return null
  }
}

function absorb(a: TranscriptDigest, rec: Record<string, unknown>): TranscriptDigest {
  const ts = parseTs(rec['timestamp'])
  const withMeta: TranscriptDigest = {
    ...a,
    lastTs: ts ?? a.lastTs,
    gitBranch: typeof rec['gitBranch'] === 'string' ? rec['gitBranch'] : a.gitBranch,
  }
  if (rec['type'] === 'user') return absorbUser(withMeta, rec)
  if (rec['type'] === 'assistant') return absorbAssistant(withMeta, rec, ts ?? 0)
  return withMeta
}

function absorbUser(a: TranscriptDigest, rec: Record<string, unknown>): TranscriptDigest {
  const texts = userTexts(rec).filter(isHumanPrompt)
  return texts.length === 0 ? a : { ...a, prompts: [...a.prompts, ...texts] }
}

function absorbAssistant(
  a: TranscriptDigest,
  rec: Record<string, unknown>,
  ts: number,
): TranscriptDigest {
  return blocks(rec).reduce((acc, b) => {
    if (b['type'] !== 'tool_use') return acc
    const name = typeof b['name'] === 'string' ? b['name'] : ''
    const input = (b['input'] ?? {}) as Record<string, unknown>
    const file = typeof input['file_path'] === 'string' ? input['file_path'] : null
    return {
      ...acc,
      touchedFiles:
        FILE_TOOLS.has(name) && file !== null && !acc.touchedFiles.includes(file)
          ? [...acc.touchedFiles, file]
          : acc.touchedFiles,
      recentTools: [...acc.recentTools, { ts, name, summary: summarize(name, input) }],
    }
  }, a)
}

function blocks(rec: Record<string, unknown>): Record<string, unknown>[] {
  const msg = rec['message']
  if (typeof msg !== 'object' || msg === null) return []
  const content = (msg as Record<string, unknown>)['content']
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : []
}

function userTexts(rec: Record<string, unknown>): string[] {
  const msg = rec['message']
  if (typeof msg !== 'object' || msg === null) return []
  const content = (msg as Record<string, unknown>)['content']
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap((b: unknown) => {
    if (typeof b !== 'object' || b === null) return []
    const block = b as Record<string, unknown>
    return block['type'] === 'text' && typeof block['text'] === 'string'
      ? [block['text']]
      : []
  })
}

/**
 * The transcript mixes real user typing with injected system content
 * (task notifications, reminders). Anything opening with a tag is not
 * something the user said.
 */
function isHumanPrompt(text: string): boolean {
  const t = text.trim()
  return t !== '' && !t.startsWith('<')
}

function summarize(name: string, input: Record<string, unknown>): string {
  const raw =
    name === 'Bash' && typeof input['command'] === 'string'
      ? input['command']
      : typeof input['file_path'] === 'string'
        ? input['file_path']
        : JSON.stringify(input)
  return raw.slice(0, MAX_SUMMARY)
}

function parseTs(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const n = Date.parse(v)
  return Number.isNaN(n) ? null : n
}
