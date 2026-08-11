import type { SessionState } from '../types.ts'
import type { ProjectView } from './group.ts'

export type ResolveResult =
  | { kind: 'project'; project: ProjectView }
  | { kind: 'session'; session: SessionState }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'notfound' }

/**
 * `helm open` and `helm brief` both accept a project name or a session id
 * prefix. Project names come first because that is the primary way in — a
 * session id is an implementation detail the user should never have to know.
 *
 * Ambiguity is never resolved by guessing. Picking the wrong session to resume
 * costs the user the exact thing this tool promises to protect: their place in
 * a piece of work.
 */
export function resolveTarget(
  projects: readonly ProjectView[],
  query: string,
): ResolveResult {
  const q = query.trim().toLowerCase()
  if (q === '') return { kind: 'notfound' }

  const exact = projects.filter((p) => p.name.toLowerCase() === q)
  const partial = projects.filter((p) => p.name.toLowerCase().includes(q))
  // Exact wins outright, otherwise `data-svc-2.0` would be dragged into
  // ambiguity by `data-svc-2.0-clone` merely containing it.
  const matched = exact.length > 0 ? exact : partial
  if (matched.length === 1) return { kind: 'project', project: matched[0] as ProjectView }
  if (matched.length > 1) return { kind: 'ambiguous', candidates: labelsOf(matched) }

  return resolveSession(projects, q)
}

function resolveSession(projects: readonly ProjectView[], q: string): ResolveResult {
  const hits = projects
    .flatMap((p) => p.sessions)
    .filter((s) => s.sessionId.toLowerCase().startsWith(q))
  if (hits.length === 1) return { kind: 'session', session: hits[0] as SessionState }
  if (hits.length > 1) {
    return { kind: 'ambiguous', candidates: hits.map((s) => s.sessionId) }
  }
  return { kind: 'notfound' }
}

/**
 * Names are what the user typed and what they will type again, so prefer them.
 * Two projects can still share a basename (`a/api` and `b/api`), and listing
 * that name twice would tell the user nothing — fall back to full paths for
 * the whole list so the candidates stay comparable.
 */
function labelsOf(projects: readonly ProjectView[]): string[] {
  const names = projects.map((p) => p.name)
  return new Set(names).size === names.length ? names : projects.map((p) => p.path)
}
