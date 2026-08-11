import type { ProjectView } from './projects/group.ts'
import type { PrefsHealth } from './projects/prefs.ts'

/**
 * What the board knows after one fast-path collection. Lives here rather than
 * in `cli/status.ts` so the render layer can consume it without importing from
 * the orchestration layer above it.
 */
export interface Board {
  projects: ProjectView[]
  /** Registry files that existed but could not be parsed. Surfaced to the user. */
  invalid: number
  /** Whether ~/.helm/projects.json was usable, and if not what became of it. */
  prefsHealth: PrefsHealth
}
