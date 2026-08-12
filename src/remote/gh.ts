import { execFileSync } from 'node:child_process'
import type { CheckRun } from './waiting.ts'

/** Runs `gh` and returns stdout. Injected so tests never touch the network. */
export type GhExec = (args: readonly string[]) => string

export interface PrRef {
  repo: string
  number: number
  title: string
  url: string
  isDraft: boolean
  updatedAt: string
}

export interface PrDetail {
  reviewDecision: string | null
  checks: CheckRun[]
}

/**
 * Either the answer, or why there is none — never an empty result standing in
 * for a failure.
 *
 * An empty array would read as "you have no pull requests", which is a
 * different and much more comforting statement than "helm could not ask".
 */
export type GhResult<T> =
  | ({ kind: 'ok' } & T)
  | { kind: 'degraded'; reason: string }

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024

export function defaultGhExec(): GhExec {
  return (args) => execFileSync('gh', [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: 30_000,
  })
}

/**
 * Every open pull request the user opened, across every repository, in one
 * request.
 *
 * Spec §10 describes running `gh pr list` per repository. Measured
 * 2026-08-12: that is 3.0 s each — 24 s across this machine's repos, and
 * 0.8 s even where there is no remote — while `gh search prs` costs 1.3 s
 * once and found a pull request the per-repo sweep had missed entirely.
 *
 * It does not carry review or CI state; `prDetail` fills that in.
 */
export function searchMyPrs(exec: GhExec): GhResult<{ prs: PrRef[] }> {
  let raw: string
  try {
    raw = exec([
      'search', 'prs', '--author', '@me', '--state', 'open', '--limit', '50',
      '--json', 'number,title,url,isDraft,updatedAt,repository',
    ])
  } catch (err) {
    return { kind: 'degraded', reason: explain(err) }
  }

  const parsed = parseJson(raw)
  if (!Array.isArray(parsed)) {
    return { kind: 'degraded', reason: 'gh 的輸出不是預期的格式，這次略過 PR 狀態。' }
  }

  // One malformed entry must not cost the user every other pull request.
  const prs = parsed.flatMap((item) => (isRecord(item) ? toPrRef(item) : []))
  return { kind: 'ok', prs }
}

export function prDetail(repo: string, number: number, exec: GhExec): GhResult<{ detail: PrDetail }> {
  let raw: string
  try {
    raw = exec([
      'pr', 'view', String(number), '--repo', repo,
      '--json', 'reviewDecision,statusCheckRollup',
    ])
  } catch (err) {
    return { kind: 'degraded', reason: explain(err) }
  }

  const parsed = parseJson(raw)
  if (!isRecord(parsed)) {
    return { kind: 'degraded', reason: `${repo}#${number} 的輸出讀不懂。` }
  }
  const rollup = parsed['statusCheckRollup']
  return {
    kind: 'ok',
    detail: {
      reviewDecision: typeof parsed['reviewDecision'] === 'string' ? parsed['reviewDecision'] : null,
      // A repository with no CI returns null here, which is not the same as a
      // failing build and must not be read as one.
      checks: Array.isArray(rollup) ? rollup.flatMap(toCheck) : [],
    },
  }
}

/**
 * Turns a `gh` failure into a sentence with a next step in it.
 *
 * Exit codes and messages verified against gh 2.76.2 on 2026-08-12. The four
 * cases spec §10 names need different actions from the user, so collapsing
 * them into one "PR 狀態讀不到" would waste the only chance to say what to do.
 */
function explain(err: unknown): string {
  const e = err as { code?: string; status?: number; stderr?: string | Buffer }
  if (e.code === 'ENOENT') {
    return '找不到 gh，PR 狀態無法取得。安裝方式：brew install gh。'
  }
  const stderr = String(e.stderr ?? '').trim()
  if (e.status === 4) {
    return 'gh 尚未登入，PR 狀態無法取得。執行 gh auth login。'
  }
  if (/\b401\b|Bad credentials/i.test(stderr)) {
    return 'gh 的憑證失效了，PR 狀態無法取得。執行 gh auth login 重新登入。'
  }
  if (/rate limit/i.test(stderr)) {
    return 'GitHub API 額度用完了，PR 狀態暫時無法更新，稍後會自己恢復。'
  }
  if (e.code === 'ETIMEDOUT' || /timed out/i.test(stderr)) {
    return 'gh 逾時，PR 狀態這次沒更新。'
  }
  // Unrecognised: pass it through rather than inventing a diagnosis. A message
  // helm has never seen is exactly the one the user needs to read verbatim.
  return `gh 失敗了：${firstLine(stderr) || '沒有錯誤訊息'}`
}

function toPrRef(item: Record<string, unknown>): PrRef[] {
  const repo = isRecord(item['repository']) ? item['repository']['nameWithOwner'] : undefined
  const { number, title, url, isDraft, updatedAt } = item
  if (typeof repo !== 'string' || typeof number !== 'number') return []
  return [{
    repo,
    number,
    title: typeof title === 'string' ? title : '',
    url: typeof url === 'string' ? url : '',
    isDraft: isDraft === true,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
  }]
}

function toCheck(item: unknown): CheckRun[] {
  if (!isRecord(item)) return []
  const { status, conclusion } = item
  return [{
    status: typeof status === 'string' ? status : 'COMPLETED',
    conclusion: typeof conclusion === 'string' ? conclusion : null,
  }]
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function firstLine(s: string): string {
  return s.split('\n')[0]?.slice(0, 160) ?? ''
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
