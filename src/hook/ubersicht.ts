import { join } from 'node:path'
import type { HelmPaths } from '../paths.ts'
import { prefsFor, type PrefsIO } from './defaults.ts'
import { resolveScannedDir, type ScannedDir } from './scan-dir.ts'

const BUNDLE_ID = 'tracesOf.Uebersicht'
const APP_NAME = 'Übersicht'

/** Übersicht's own preference key for the folder it scans. Verified 2026-08-12. */
const WIDGET_DIR_KEY = 'widgetDir'

export type UbersichtDeps = PrefsIO

export function defaultUbersichtDeps(): UbersichtDeps {
  return prefsFor(BUNDLE_ID)
}

/**
 * Übersicht's own default, kept rather than replaced.
 *
 * SwiftBar got a visible folder because it makes the user pick one in an open
 * panel, where a hidden ~/Library simply is not there. Übersicht never asks —
 * it creates this folder itself on first launch — so there is nothing to work
 * around, and matching the app's convention is what a user following its
 * documentation will expect to find.
 */
export function defaultWidgetDir(paths: HelmPaths): string {
  return join(paths.home, 'Library', 'Application Support', 'Übersicht', 'widgets')
}

/** The folder Übersicht actually scans, or null when helm must not write. */
export function resolveWidgetDir(paths: HelmPaths, deps: UbersichtDeps): ScannedDir {
  return resolveScannedDir(
    deps.readPref(WIDGET_DIR_KEY), defaultWidgetDir(paths), APP_NAME, WIDGET_DIR_KEY,
  )
}

/** Only ever called with a resolution that said `adoptable`. */
export function adoptWidgetDir(dir: string, deps: UbersichtDeps): void {
  deps.writePref(WIDGET_DIR_KEY, dir)
}
