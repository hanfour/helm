import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Claude Code names each project directory after the session's cwd with every
 * non-alphanumeric character replaced by a dash — one dash per character, not
 * one per run. Measured against real directories on 2026-08-11:
 *
 *   /Users/u/.pmk/review-workspace  → -Users-u--pmk-review-workspace   (two dashes)
 *   /Users/u/Downloads/季評分Q1-...  → -Users-u-Downloads----Q1-...     (four dashes)
 *
 * An earlier implementation collapsed runs (`[^a-zA-Z0-9]+`), which silently
 * failed to locate the transcript of any project whose path contained CJK
 * characters or adjacent punctuation.
 */
export function slugifyCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export interface SlugDeps {
  /** Names of the subdirectories of `dir`. Must return empty when unreadable. */
  subdirs: (dir: string) => readonly string[]
}

/**
 * The search tree is bounded by how many ways the dash-separated slug can be
 * partitioned across nested directories. That is normally one, but a tree of
 * directories named `a`, `a-a`, `a-a-a` makes it exponential. A step budget
 * turns the pathological case into "give up" rather than "hang the board".
 */
const MAX_STEPS = 20_000

/**
 * Recover the original cwd from a project directory name. Slugification is
 * lossy — a dash may have been `/`, `.`, `-`, a space, or a CJK character —
 * so the only sound way back is to walk the real filesystem and ask which
 * directories could have produced this slug.
 *
 * Returns null when no existing path matches, which is the normal answer for
 * a project that has since been deleted (temp dirs, mostly).
 */
export function resolveSlug(slug: string, deps: SlugDeps): string | null {
  if (!slug.startsWith('-')) return null
  const budget = { steps: MAX_STEPS }
  return walk('/', slug, deps, budget)
}

function walk(dir: string, rest: string, deps: SlugDeps, budget: { steps: number }): string | null {
  if (rest === '') return dir
  if (!rest.startsWith('-')) return null
  if (budget.steps <= 0) return null

  const tail = rest.slice(1)
  for (const match of candidates(dir, tail, deps)) {
    // The budget is shared across the whole search, not per branch: what we
    // are bounding is total work, and only a decrement here can bound it.
    budget.steps -= 1
    const found = walk(join(dir, match.name), tail.slice(match.length), deps, budget)
    if (found !== null) return found
  }
  return null
}

interface Candidate {
  name: string
  length: number
}

/**
 * Longest match first. `data-svc-2-0-clone` must not be resolved as
 * `data-svc-2.0` with a stray `-clone` left over, and trying the longer
 * directory first also means the common case never backtracks.
 */
function candidates(dir: string, tail: string, deps: SlugDeps): Candidate[] {
  const lower = tail.toLowerCase()
  return deps
    .subdirs(dir)
    .flatMap((name) => {
      // Both forms are accepted: the slugified name for current Claude Code,
      // and the literal name for legacy directories written by older versions
      // that preserved dots (`-Users-u-.claude-usage-data`).
      const forms = [...new Set([slugifyCwd(name), name])]
      return forms
        .filter((form) => form.length > 0 && consumes(lower, form.toLowerCase()))
        .map((form): Candidate => ({ name, length: form.length }))
    })
    .toSorted((a, b) => b.length - a.length)
}

/** A form matches only if it ends on a dash boundary, never mid-segment. */
function consumes(tail: string, form: string): boolean {
  if (!tail.startsWith(form)) return false
  return tail.length === form.length || tail[form.length] === '-'
}

/**
 * Real-filesystem reader, memoized because every project slug under the same
 * home directory re-reads the same two or three parent directories. The cache
 * lives for one CLI invocation only, so a stale entry is not reachable.
 */
export function createSubdirReader(): (dir: string) => readonly string[] {
  const cache = new Map<string, readonly string[]>()
  return (dir) => {
    const hit = cache.get(dir)
    if (hit !== undefined) return hit
    const names = readSubdirs(dir)
    cache.set(dir, names)
    return names
  }
}

function readSubdirs(dir: string): readonly string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
  } catch {
    // Unreadable directories (permissions, races, deleted paths) simply have
    // no candidates. Throwing here would take down `helm status` because one
    // historical project happened to live somewhere we cannot read.
    return []
  }
}
