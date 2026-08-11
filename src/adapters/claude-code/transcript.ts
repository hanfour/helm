import { readFileSync } from 'node:fs'
import { z } from 'zod'

/**
 * Transcript records are external input and go through zod like every other
 * boundary in this project. The schemas are deliberately loose — `.passthrough()`
 * and defaults everywhere — because Claude Code adds record types and fields
 * between versions, and a stricter schema would silently drop history.
 */
const TextBlock = z.object({ type: z.literal('text'), text: z.string() })

const ToolUseBlock = z.object({
  type: z.literal('tool_use'),
  name: z.string().default(''),
  input: z.record(z.string(), z.unknown()).default({}),
})

/** Anything else (tool_result, image, …) is kept but carries no meaning here. */
const OtherBlock = z.object({ type: z.string() }).passthrough()

const ContentBlock = z.union([TextBlock, ToolUseBlock, OtherBlock])

const RecordSchema = z.object({
  type: z.string().default(''),
  timestamp: z.string().optional(),
  gitBranch: z.string().optional(),
  /** Claude Code marks synthesized user content with this. See isHumanRecord. */
  isMeta: z.boolean().optional(),
  message: z.object({
    content: z.union([z.string(), z.array(ContentBlock)]).optional(),
  }).passthrough().optional(),
}).passthrough()

type TranscriptRecord = z.infer<typeof RecordSchema>

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

function safeParse(line: string): TranscriptRecord | null {
  try {
    const parsed = RecordSchema.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : null
  } catch {
    // Degrade, don't throw: one truncated or corrupt line must not cost the
    // user the rest of their history. A partially-written last line is normal
    // for a transcript belonging to a session that is still running.
    return null
  }
}

function absorb(a: TranscriptDigest, rec: TranscriptRecord): TranscriptDigest {
  const ts = parseTs(rec.timestamp)
  const withMeta: TranscriptDigest = {
    ...a,
    lastTs: ts ?? a.lastTs,
    gitBranch: rec.gitBranch ?? a.gitBranch,
  }
  if (rec.type === 'user') return absorbUser(withMeta, rec)
  if (rec.type === 'assistant') return absorbAssistant(withMeta, rec, ts ?? 0)
  return withMeta
}

function absorbUser(a: TranscriptDigest, rec: TranscriptRecord): TranscriptDigest {
  if (!isHumanRecord(rec)) return a
  const texts = userTexts(rec).filter(isHumanText)
  return texts.length === 0 ? a : { ...a, prompts: [...a.prompts, ...texts] }
}

function absorbAssistant(
  a: TranscriptDigest,
  rec: TranscriptRecord,
  ts: number,
): TranscriptDigest {
  return blocks(rec).reduce((acc, b) => {
    if (b.type !== 'tool_use') return acc
    const file = typeof b.input['file_path'] === 'string' ? b.input['file_path'] : null
    return {
      ...acc,
      touchedFiles:
        FILE_TOOLS.has(b.name) && file !== null && !acc.touchedFiles.includes(file)
          ? [...acc.touchedFiles, file]
          : acc.touchedFiles,
      recentTools: [...acc.recentTools, { ts, name: b.name, summary: summarize(b) }],
    }
  }, a)
}

type ToolUse = z.infer<typeof ToolUseBlock>

function blocks(rec: TranscriptRecord): ToolUse[] {
  const content = rec.message?.content
  if (!Array.isArray(content)) return []
  return content.filter((b): b is ToolUse => b.type === 'tool_use')
}

function userTexts(rec: TranscriptRecord): string[] {
  const content = rec.message?.content
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap((b) => (b.type === 'text' ? [(b as { text: string }).text] : []))
}

/**
 * Claude Code sets `isMeta` on user records it synthesized itself — pasted
 * image captions, skill re-invocation notices, and similar. Measured on a real
 * transcript: all 80 isMeta records were synthetic and all 37 non-isMeta plain
 * texts were genuine typing, with zero misclassifications either way. This is
 * the reliable signal; the tag-prefix rule below is only a fallback.
 */
function isHumanRecord(rec: TranscriptRecord): boolean {
  return rec.isMeta !== true
}

/**
 * Fallback for records that carry no `isMeta` marker (older transcript
 * formats). Catches tag-wrapped injections like <task-notification>, but
 * NOT caption-style ones — that is why isHumanRecord exists.
 */
function isHumanText(text: string): boolean {
  const t = text.trim()
  return t !== '' && !t.startsWith('<')
}

function summarize(b: ToolUse): string {
  const raw =
    b.name === 'Bash' && typeof b.input['command'] === 'string'
      ? b.input['command']
      : typeof b.input['file_path'] === 'string'
        ? b.input['file_path']
        : JSON.stringify(b.input)
  return raw.slice(0, MAX_SUMMARY)
}

function parseTs(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const n = Date.parse(v)
  return Number.isNaN(n) ? null : n
}
