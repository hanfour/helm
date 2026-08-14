import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Brief } from '../cache/store.ts'
import { TASK_STATUSES } from '../task-status.ts'
import { renderSummaryPrompt, type SummaryInput } from './input.ts'

const execFileAsync = promisify(execFile)

const CLAUDE_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 1024 * 1024

export type ClaudeRunner = (prompt: string) => Promise<string>

const BriefSchema = z.object({
  goal: z.string().default(''),
  done: z.array(z.string()).default([]),
  currentStep: z.string().default(''),
  nextStep: z.string().default(''),
  blockers: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  prs: z.array(z.string()).default([]),
  // 不給 default：缺少與非法都要落在 undefined，那是「未知」。
  // 給了 default 等於替模型回答，而預設值一定會是三種說法裡的某一種。
  taskStatus: z.enum(TASK_STATUSES).optional().catch(undefined),
})

/**
 * The prompt asks for bare JSON, but models still wrap it in fences or
 * preamble often enough that being strict here would mean losing briefs
 * we already paid for.
 */
export function parseBriefJson(raw: string): Brief | null {
  const candidate = extractJsonObject(raw)
  if (candidate === null) return null
  try {
    const parsed = BriefSchema.safeParse(JSON.parse(candidate))
    return parsed.success ? parsed.data : null
  } catch {
    // JSON.parse throws on a brace span that was never valid JSON (e.g.
    // extracted from prose containing unrelated braces). Degrade to null
    // so the caller falls back to the raw-prompt view instead of crashing
    // on a paid-for but unusable LLM response.
    return null
  }
}

/**
 * Take the LAST parseable candidate, not the first. Models self-correct:
 * they emit a draft block, say "actually, let me redo that", then emit the
 * real answer. Matching the first fenced block returns the discarded draft —
 * which parses cleanly and yields a complete-looking brief built from
 * abandoned content, with no error and no signal to the user.
 */
function extractJsonObject(raw: string): string | null {
  const fenced = [...raw.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)]
    .map((m) => m[1])
    .filter((c): c is string => c !== undefined)
  const lastValid = fenced.findLast(isParseableObject)
  if (lastValid !== undefined) return lastValid

  // Unfenced fallback. JSON.parse rejects trailing content, so prose-with-braces
  // and two-bare-objects both fail closed here rather than yielding garbage.
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  return first !== -1 && last > first ? raw.slice(first, last + 1) : null
}

function isParseableObject(candidate: string): boolean {
  try {
    const v: unknown = JSON.parse(candidate)
    return typeof v === 'object' && v !== null && !Array.isArray(v)
  } catch {
    // Not a finding — this is the predicate whose whole job is to answer
    // "does this parse", so a throw here is a legitimate `false`.
    return false
  }
}

export async function generateBrief(
  input: SummaryInput,
  run: ClaudeRunner,
): Promise<Brief | null> {
  try {
    return parseBriefJson(await run(renderSummaryPrompt(input)))
  } catch {
    // A failed brief degrades to the raw-prompt fallback (spec 12); it is
    // never fatal and never silently pretends to have succeeded.
    return null
  }
}

export const runClaudeHeadless: ClaudeRunner = async (prompt) => {
  const { stdout } = await execFileAsync(
    'claude',
    ['-p', prompt, '--max-turns', '1'],
    { timeout: CLAUDE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
  )
  return stdout
}
