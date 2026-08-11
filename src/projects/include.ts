export const ACTIVITY_WINDOW_DAYS = 14
const DAY_MS = 86_400_000

/**
 * Paths that generate session noise but are never real projects.
 * Matched on path boundaries so `/Downloads-archive` is not caught by
 * the `/Downloads` rule.
 */
export const EXCLUDED_PREFIXES: readonly string[] = [
  '/private/tmp',
  '/tmp',
  '/var/folders',
]

/** Home-relative exclusions, resolved against the caller's home directory. */
export const EXCLUDED_HOME_RELATIVE: readonly string[] = ['Downloads']

export interface ProjectPrefs {
  pinned: boolean
  hidden: boolean
}

export interface IncludeInput {
  path: string
  cwdExists: boolean
  isGitRepo: boolean
  lastActivityMs: number
  nowMs: number
  prefs: ProjectPrefs | undefined
  /** Used to resolve EXCLUDED_HOME_RELATIVE. Defaults to no home-relative exclusion. */
  home?: string
}

export function shouldInclude(i: IncludeInput): boolean {
  if (i.prefs?.hidden === true) return false
  if (!i.cwdExists) return false
  if (isExcludedPath(i.path, i.home)) return false
  if (!i.isGitRepo) return false
  if (i.prefs?.pinned === true) return true
  return i.nowMs - i.lastActivityMs < ACTIVITY_WINDOW_DAYS * DAY_MS
}

function isExcludedPath(path: string, home: string | undefined): boolean {
  const prefixes = [
    ...EXCLUDED_PREFIXES,
    ...(home === undefined
      ? []
      : EXCLUDED_HOME_RELATIVE.map((rel) => `${home}/${rel}`)),
  ]
  return prefixes.some((p) => path === p || path.startsWith(`${p}/`))
}
