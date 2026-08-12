import { join } from 'node:path'
import type { HelmPaths } from '../paths.ts'
import { prefsFor, type PrefsIO } from './defaults.ts'
import { resolveScannedDir, type ScannedDir } from './scan-dir.ts'

const BUNDLE_ID = 'com.ameba.SwiftBar'
const APP_NAME = 'SwiftBar'

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

/** The folder SwiftBar actually scans, or null when helm must not write. */
export function resolvePluginDir(paths: HelmPaths, deps: SwiftBarDeps): ScannedDir {
  return resolveScannedDir(
    deps.readPref(PLUGIN_DIR_KEY), defaultPluginDir(paths), APP_NAME, PLUGIN_DIR_KEY,
  )
}

/**
 * Only ever called with a resolution that said `adoptable`.
 *
 * Setting this before SwiftBar's first launch skips its folder picker
 * entirely, which is otherwise a manual step helm cannot perform.
 */
export function adoptPluginDir(dir: string, deps: SwiftBarDeps): void {
  deps.writePref(PLUGIN_DIR_KEY, dir)
}
