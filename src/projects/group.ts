import { basename } from 'node:path'
import type { SessionState } from '../types.ts'
import { shouldInclude } from './include.ts'
import type { PrefsFile } from './prefs.ts'

export interface ProjectView {
  path: string
  name: string
  pinned: boolean
  lastActivityMs: number
  sessions: SessionState[]
}

export interface GroupDeps {
  prefs: PrefsFile
  nowMs: number
  cwdExists: (path: string) => boolean
  isGitRepo: (path: string) => boolean
  home: string
}

/**
 * Sessions belong to a project by cwd. Filtering happens here rather than
 * in the adapter so that adapters stay dumb about user preferences.
 */
export function groupIntoProjects(
  sessions: readonly SessionState[],
  deps: GroupDeps,
): ProjectView[] {
  const byPath = sessions.reduce<Map<string, SessionState[]>>(
    (acc, s) => new Map(acc).set(s.cwd, [...(acc.get(s.cwd) ?? []), s]),
    new Map(),
  )

  return [...byPath.entries()]
    .map(([path, group]): ProjectView => ({
      path,
      name: basename(path) || path,
      pinned: deps.prefs.projects[path]?.pinned ?? false,
      lastActivityMs: Math.max(...group.map((s) => s.updatedAt)),
      sessions: [...group].toSorted((a, b) => b.updatedAt - a.updatedAt),
    }))
    .filter((p) =>
      shouldInclude({
        path: p.path,
        cwdExists: deps.cwdExists(p.path),
        isGitRepo: deps.isGitRepo(p.path),
        lastActivityMs: p.lastActivityMs,
        nowMs: deps.nowMs,
        prefs: deps.prefs.projects[p.path],
        home: deps.home,
      }),
    )
    .toSorted(byPinnedThenRecent)
}

function byPinnedThenRecent(a: ProjectView, b: ProjectView): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  return b.lastActivityMs - a.lastActivityMs
}
