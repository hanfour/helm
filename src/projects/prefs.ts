import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { ProjectPrefs } from './include.ts'

const PrefsSchema = z.object({
  version: z.literal(1),
  projects: z.record(
    z.string(),
    z.object({ pinned: z.boolean().default(false), hidden: z.boolean().default(false) }),
  ).default({}),
})

export interface PrefsFile {
  version: 1
  projects: Record<string, ProjectPrefs>
}

const EMPTY: PrefsFile = { version: 1, projects: {} }

/**
 * ~/.helm/projects.json is the single source of truth for user intent
 * (spec §4.4). Unlike cache.json it is never auto-deleted, and a corrupt
 * file must not prevent the CLI from running.
 */
export function readPrefs(prefsFile: string): PrefsFile {
  try {
    const parsed = PrefsSchema.safeParse(JSON.parse(readFileSync(prefsFile, 'utf8')))
    return parsed.success ? { version: 1, projects: parsed.data.projects } : EMPTY
  } catch {
    return EMPTY
  }
}

export function writePrefs(prefsFile: string, prefs: PrefsFile): void {
  mkdirSync(dirname(prefsFile), { recursive: true })
  writeFileSync(prefsFile, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8')
}

/** Returns a new PrefsFile; never mutates the input. */
export function setProjectPref(
  prefs: PrefsFile,
  path: string,
  patch: Partial<ProjectPrefs>,
): PrefsFile {
  const current = prefs.projects[path] ?? { pinned: false, hidden: false }
  return {
    ...prefs,
    projects: { ...prefs.projects, [path]: { ...current, ...patch } },
  }
}
