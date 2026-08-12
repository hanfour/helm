import { join } from 'node:path'
import type { HelmPaths } from '../paths.ts'
import { prefsFor, type PrefsIO } from './defaults.ts'

const BUNDLE_ID = 'tracesOf.Uebersicht'

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

/**
 * The folder Übersicht actually scans: its own setting if it has one, else
 * the default. Installing anywhere else is the silent dead end — file in
 * place, checks green, desktop empty.
 */
export function scannedWidgetDir(paths: HelmPaths, deps: UbersichtDeps): string {
  return deps.readPref(WIDGET_DIR_KEY) ?? defaultWidgetDir(paths)
}

/**
 * Points Übersicht at a folder, but only when it has not already chosen one.
 * An existing value is the user's decision. Returns whether it was written.
 */
export function adoptWidgetDir(dir: string, deps: UbersichtDeps): boolean {
  if (deps.readPref(WIDGET_DIR_KEY) !== null) return false
  deps.writePref(WIDGET_DIR_KEY, dir)
  return true
}
