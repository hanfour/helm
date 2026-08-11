import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Brief } from '../cache/store.ts'
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

function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
  if (fenced?.[1] !== undefined) return fenced[1]
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  return first !== -1 && last > first ? raw.slice(first, last + 1) : null
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
