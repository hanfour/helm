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

/**
 * `quarantined` and `unreadable` are deliberately different answers. The first
 * means the original is safe on disk under another name; the second means it
 * is still sitting there unusable and a write would destroy it. Collapsing the
 * two is how a promise of "your original was preserved" becomes a lie.
 */
export type PrefsHealth = 'ok' | 'quarantined' | 'unreadable'

export interface PrefsRead {
  prefs: PrefsFile
  health: PrefsHealth
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
  if (!existsSync(prefsFile)) return { prefs: EMPTY, health: 'ok' }
  try {
    const parsed = PrefsSchema.safeParse(JSON.parse(readFileSync(prefsFile, 'utf8')))
    if (parsed.success) return { prefs: { version: 1, projects: parsed.data.projects }, health: 'ok' }
  } catch {
    // Falls through to quarantine — an unparseable file and a schema mismatch
    // both mean "we must not write over this".
  }
  return { prefs: EMPTY, health: quarantine(prefsFile) ? 'quarantined' : 'unreadable' }
}

/**
 * Returns whether the original actually got out of the way. A rename needs
 * write permission on the *directory*, while truncating an existing file does
 * not — so "quarantine failed but the write will succeed" is a real state, and
 * the one where silence costs the user everything they ever pinned or hid.
 */
function quarantine(prefsFile: string): boolean {
  try {
    renameSync(prefsFile, quarantinePath(prefsFile))
    return true
  } catch {
    // The caller is told `unreadable` and must refuse to write.
    return false
  }
}

export function quarantinePath(prefsFile: string): string {
  return prefsFile.replace(/\.json$/, '.corrupt.json')
}

/**
 * Temp-then-rename, like the cache and settings.json. This file holds the only
 * data helm cannot rebuild, yet it was the one writing in place: measured, 8
 * concurrent `helm hide` runs produced a truncated file that the next read
 * quarantined, taking all eight settings with it.
 */
export function writePrefs(prefsFile: string, prefs: PrefsFile): void {
  mkdirSync(dirname(prefsFile), { recursive: true })
  const temp = `${prefsFile}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8')
  renameSync(temp, prefsFile)
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
