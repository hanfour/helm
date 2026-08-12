/** One entry of `gh pr view --json statusCheckRollup`. */
export interface CheckRun {
  /** `COMPLETED`, `IN_PROGRESS`, `QUEUED`, … */
  status: string
  /** `SUCCESS`, `FAILURE`, `SKIPPED`, … Null while still running. */
  conclusion: string | null
}

export interface PrStatus {
  isDraft: boolean
  /** `gh`'s own value: APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED / null. */
  reviewDecision: string | null
  checks: readonly CheckRun[]
}

export type WaitingKind = 'draft' | 'ci' | 'changes' | 'review' | 'mergeable'

export interface Waiting {
  kind: WaitingKind
  label: string
}

/**
 * Conclusions that mean a human has to go and look.
 *
 * `SKIPPED` and `NEUTRAL` are deliberately absent: GitHub Actions produces
 * SKIPPED in bulk from conditional jobs, and counting those as failures would
 * mark nearly every PR as "waiting on CI".
 */
const BAD_CONCLUSIONS = new Set([
  'FAILURE',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
])

const LABELS: Record<WaitingKind, string> = {
  draft: '草稿',
  ci: '等 CI',
  changes: '等你改',
  review: '等人審',
  mergeable: '可合併',
}

/**
 * Who a pull request is waiting on (spec §10).
 *
 * The order is the point: it answers "what is the next thing that has to
 * happen", so whatever blocks merging soonest wins. A PR that is approved but
 * red needs its CI fixed, not a merge; one with requested changes *and* a
 * failing build needs the build looked at first, because the reviewer's notes
 * cannot be addressed without it.
 */
export function waitingOn(pr: PrStatus): Waiting {
  // A draft is not waiting on anybody — it is not asking to be merged.
  if (pr.isDraft) return { kind: 'draft', label: LABELS.draft }
  if (pr.checks.some(isUnfinished)) return { kind: 'ci', label: LABELS.ci }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { kind: 'changes', label: LABELS.changes }
  // Anything other than APPROVED — including a value `gh` starts returning
  // tomorrow — means nobody has signed off yet. Guessing would be worse.
  if (pr.reviewDecision !== 'APPROVED') return { kind: 'review', label: LABELS.review }
  return { kind: 'mergeable', label: LABELS.mergeable }
}

function isUnfinished(check: CheckRun): boolean {
  if (check.status !== 'COMPLETED') return true
  return check.conclusion !== null && BAD_CONCLUSIONS.has(check.conclusion)
}
