import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { RegistryEntry } from '../../types.ts'

/**
 * Claude Code writes this file on start and deletes it on clean exit.
 * Unknown fields are tolerated on purpose: upstream adds fields between
 * versions, and dropping a session over an unknown key would be worse
 * than ignoring it.
 */
const RegistrySchema = z.object({
  pid: z.number().int().positive(),
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  startedAt: z.number(),
  procStart: z.string().min(1),
  kind: z.string().default('interactive'),
  name: z.string().default(''),
  status: z.enum(['busy', 'idle']).nullable().default(null),
  updatedAt: z.number().default(0),
}).passthrough()

export interface RegistryReadResult {
  entries: RegistryEntry[]
  /** Files that existed but could not be parsed. Surfaced by `helm doctor`. */
  invalid: number
}

export function readRegistry(sessionsDir: string): RegistryReadResult {
  let names: string[]
  try {
    names = readdirSync(sessionsDir).filter((n) => n.endsWith('.json'))
  } catch {
    return { entries: [], invalid: 0 }
  }

  return names.reduce<RegistryReadResult>(
    (acc, name) => {
      const parsed = parseOne(join(sessionsDir, name))
      return parsed === null
        ? { ...acc, invalid: acc.invalid + 1 }
        : { ...acc, entries: [...acc.entries, parsed] }
    },
    { entries: [], invalid: 0 },
  )
}

function parseOne(file: string): RegistryEntry | null {
  try {
    const result = RegistrySchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    if (!result.success) return null
    const d = result.data
    return {
      pid: d.pid,
      sessionId: d.sessionId,
      cwd: d.cwd,
      startedAt: d.startedAt,
      procStart: d.procStart,
      kind: d.kind,
      name: d.name,
      status: d.status,
      updatedAt: d.updatedAt,
    }
  } catch {
    return null
  }
}
