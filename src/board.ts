import type { ProjectView } from './projects/group.ts'
import type { PrefsHealth } from './projects/prefs.ts'
import type { CachedPr } from './remote/cache.ts'

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
  /**
   * Data sources that failed outright, one line each.
   *
   * An adapter throwing costs the user half their board; showing the
   * remaining half silently would be the same failure this project keeps
   * making — reporting success for work that did not happen.
   */
  adapterFailures: string[]
  /** Open pull requests the user opened, from the 60-second cache (spec §10). */
  prs: CachedPr[]
  /** Why there are none, when that is the reason. Never silently empty. */
  prDegraded: string | null
}
