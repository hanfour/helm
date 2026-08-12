import { join } from 'node:path'
import type { HelmPaths } from '../paths.ts'
import { prefsFor, type PrefsIO } from './defaults.ts'

const BUNDLE_ID = 'com.ameba.SwiftBar'

/** SwiftBar's own preference key for the folder it scans. Verified 2026-08-12. */
const PLUGIN_DIR_KEY = 'PluginDirectory'

export const PLUGIN_NAME = 'helm.5s.sh'

export type SwiftBarDeps = PrefsIO

export function defaultSwiftBarDeps(): SwiftBarDeps {
  return prefsFor(BUNDLE_ID)
}

/**
 * Where helm puts its plugin when SwiftBar has no opinion yet.
 *
 * Deliberately visible. `~/Library/Application Support` is the conventional
 * home for this sort of thing, but ~/Library carries the `hidden` flag, and
 * the folder is one the user may end up picking in an open panel — where a
 * hidden directory simply is not there. Convention loses to being findable.
 */
export function defaultPluginDir(paths: HelmPaths): string {
  return join(paths.home, 'SwiftBar')
}

/**
 * The folder SwiftBar actually scans: its own setting if it has one, else the
 * default. Installing anywhere else produces the silent dead end this exists
 * to avoid — every file in place, every check green, and an empty menu bar.
 */
export function scannedPluginDir(paths: HelmPaths, deps: SwiftBarDeps): string {
  return deps.readPref(PLUGIN_DIR_KEY) ?? defaultPluginDir(paths)
}

/**
 * Points SwiftBar at a folder, but only when it has not already chosen one.
 * An existing value is the user's decision — helm installs into it rather
 * than redirecting them. Returns whether the preference was written.
 *
 * Setting this before SwiftBar's first launch skips the folder picker
 * entirely, which is otherwise a manual step helm cannot perform.
 */
export function adoptPluginDir(dir: string, deps: SwiftBarDeps): boolean {
  if (deps.readPref(PLUGIN_DIR_KEY) !== null) return false
  deps.writePref(PLUGIN_DIR_KEY, dir)
  return true
}
