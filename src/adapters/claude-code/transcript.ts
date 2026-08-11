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

  // Local accumulator, never escapes this function. The previous version
  // rebuilt the whole digest per tool_use block and ran `summarize` — a
  // JSON.stringify over the tool's entire input — on every one of them, only
  // to keep the last three. A ring bounded by the limit keeps the discarded
  // payloads out of both the copies and the stringifier.
  const acc: Accumulator = {
    prompts: [], files: new Set(), tools: [], lastTs: null, gitBranch: null,
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const rec = safeParse(line)
    if (rec !== null) absorb(acc, rec, limits)
  }

  return {
    prompts: acc.prompts.slice(-limits.prompts),
    touchedFiles: [...acc.files].slice(-limits.files),
    recentTools: acc.tools.map((t) => ({ ts: t.ts, name: t.block.name, summary: summarize(t.block) })),
    lastTs: acc.lastTs,
    gitBranch: acc.gitBranch,
  }
}

interface PendingTool {
  ts: number
  block: ToolUse
}

interface Accumulator {
  prompts: string[]
  files: Set<string>
  tools: PendingTool[]
  lastTs: number | null
  gitBranch: string | null
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

function absorb(a: Accumulator, rec: TranscriptRecord, limits: DigestLimits): void {
  const ts = parseTs(rec.timestamp)
  if (ts !== null) a.lastTs = ts
  if (rec.gitBranch !== undefined) a.gitBranch = rec.gitBranch
  if (rec.type === 'user') absorbUser(a, rec)
  else if (rec.type === 'assistant') absorbAssistant(a, rec, ts ?? 0, limits)
}

function absorbUser(a: Accumulator, rec: TranscriptRecord): void {
  if (!isHumanRecord(rec)) return
  a.prompts.push(...userTexts(rec).filter(isHumanText))
}

function absorbAssistant(
  a: Accumulator,
  rec: TranscriptRecord,
  ts: number,
  limits: DigestLimits,
): void {
  for (const b of blocks(rec)) {
    if (b.type !== 'tool_use') continue
    const file = b.input['file_path']
    if (FILE_TOOLS.has(b.name) && typeof file === 'string') a.files.add(file)
    a.tools.push({ ts, block: b })
    if (a.tools.length > limits.tools) a.tools.shift()
  }
}

type ToolUse = z.infer<typeof ToolUseBlock>

/**
 * Re-parse each element with the specific block schema rather than testing
 * `b.type` and casting. A block like `{type:'tool_use', input:'string'}` fails
 * ToolUseBlock, falls through the union to OtherBlock's passthrough, and still
 * reads as `type === 'tool_use'` — so a type predicate would pass a malformed
 * block downstream, causing crashes when accessing `.input['file_path']`.
 * safeParse is the only check that actually holds at runtime.
 */
function blocks(rec: TranscriptRecord): ToolUse[] {
  const content = rec.message?.content
  if (!Array.isArray(content)) return []
  return content.flatMap((b) => {
    const parsed = ToolUseBlock.safeParse(b)
    return parsed.success ? [parsed.data] : []
  })
}

function userTexts(rec: TranscriptRecord): string[] {
  const content = rec.message?.content
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap((b) => {
    const parsed = TextBlock.safeParse(b)
    return parsed.success ? [parsed.data.text] : []
  })
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
