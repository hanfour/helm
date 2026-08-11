import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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

export interface PrefsRead {
  prefs: PrefsFile
  /** True when a file existed but could not be used; it has been set aside. */
  corrupt: boolean
}

/**
 * ~/.helm/projects.json is the single source of truth for user intent
 * (spec §4.4) and, unlike cache.json, it cannot be rebuilt from anything.
 *
 * That is why an unreadable file is set aside rather than treated as absent:
 * returning empty prefs is invisible, and the very next `writePrefs` would
 * overwrite the original — turning one truncated write into the permanent loss
 * of every pin and hidden flag the user ever set. A future `version: 2` file
 * takes the same path for the same reason.
 */
export function readPrefs(prefsFile: string): PrefsRead {
  if (!existsSync(prefsFile)) return { prefs: EMPTY, corrupt: false }
  try {
    const parsed = PrefsSchema.safeParse(JSON.parse(readFileSync(prefsFile, 'utf8')))
    if (parsed.success) return { prefs: { version: 1, projects: parsed.data.projects }, corrupt: false }
  } catch {
    // Falls through to quarantine — an unparseable file and a schema mismatch
    // both mean "we must not write over this".
  }
  quarantine(prefsFile)
  return { prefs: EMPTY, corrupt: true }
}

function quarantine(prefsFile: string): void {
  try {
    renameSync(prefsFile, prefsFile.replace(/\.json$/, '.corrupt.json'))
  } catch {
    // Nothing more we can do; the caller still gets usable empty prefs, and
    // `corrupt: true` means the user is told rather than silently reset.
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
