import { closeSync, openSync, readSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { RolloutFile } from './scan.ts'

/** The only two fields helm takes from a rollout's `session_meta`. */
export interface RolloutMeta {
  sessionId: string
  cwd: string
}

/**
 * Reads the first line of a rollout.
 *
 * This is the one place in the fast path that opens a file, and it is not
 * optional: the session id lives here, not in the filename (see
 * `rollout-name.ts`), and one session spans several rollout files. So does
 * the cwd, which decides which project the session belongs to.
 *
 * Only `session_id ?? id` and `cwd` are taken. Measured across the 192
 * rollouts on this machine, `payload` comes in 14 different shapes spanning
 * four months of Codex releases — depending on any other field would break at
 * the next one. Those two are in all 14.
 */
export function readMeta(path: string): RolloutMeta | null {
  const line = firstLine(path)
  if (line === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    // A rollout being written right now can have a torn first line. It will
    // be readable on the next poll; reporting it as broken would be noise.
    return null
  }
  if (!isRecord(parsed) || parsed['type'] !== 'session_meta') return null

  const payload = parsed['payload']
  if (!isRecord(payload)) return null

  const sessionId = payload['session_id'] ?? payload['id']
  const cwd = payload['cwd']
  if (typeof sessionId !== 'string' || sessionId === '') return null
  // Absolute only, for the same reason `scan-dir.ts` insists on it: a relative
  // path would attach the session to a project under whatever directory helm
  // happened to be run from.
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return null

  return { sessionId, cwd }
}

/**
 * The first line only, without pulling the whole file into memory.
 *
 * A rollout is a full conversation transcript; the largest here is several
 * megabytes. The first line alone is 8.6–18.6 KB because it carries Codex's
 * entire base instructions, so the buffer starts there and grows only if the
 * newline has not arrived yet.
 */
function firstLine(path: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const chunk = Buffer.allocUnsafe(32 * 1024)
    let text = ''
    for (let i = 0; i < 32; i++) {
      const n = readSync(fd, chunk, 0, chunk.length, null)
      if (n === 0) break
      text += chunk.toString('utf8', 0, n)
      const nl = text.indexOf('\n')
      if (nl !== -1) return text.slice(0, nl)
    }
    // No newline within 1 MB. Not a session_meta line by any reading.
    return text === '' ? null : null
  } catch {
    // Missing, unreadable, or vanished mid-poll — all ordinary.
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * Remembers what each rollout file said, so the read above happens once.
 *
 * A rollout's `session_meta` is written when the file is created and never
 * changes, which is what makes an unbounded cache correct here rather than
 * merely convenient.
 *
 * **Only successes are cached.** Failures used to be stored too, on the
 * reasoning that an unparseable file should not be re-read every five
 * seconds. But Codex creates the file before writing that first line, so a
 * poll landing in that window saw a torn read — and caching it meant the
 * session never appeared on the board again, and counted as `invalid` for
 * ever. Re-reading a genuinely broken file costs one `open` per poll; losing
 * a session permanently costs the user the thing they came for.
 */
export interface MetaCache {
  get: (rolloutId: string) => RolloutMeta | undefined
  set: (rolloutId: string, meta: RolloutMeta) => void
  flush: () => void
}

export function loadMetaCache(file: string): MetaCache {
  const entries = new Map<string, RolloutMeta>(Object.entries(readCache(file)))
  let dirty = false

  return {
    get: (rolloutId) => entries.get(rolloutId),
    set: (rolloutId, meta) => {
      entries.set(rolloutId, meta)
      dirty = true
    },
    flush: () => {
      // Nothing new means nothing to write. `helm menu` runs every five
      // seconds; rewriting an unchanged file that often is pure churn.
      if (!dirty) return
      dirty = false
      writeAtomic(file, Object.fromEntries(entries))
    },
  }
}

/** Cache first, file second. Returns null when the rollout is unreadable. */
export function resolveMeta(
  file: RolloutFile,
  cache: MetaCache,
  read: (path: string) => RolloutMeta | null = readMeta,
): RolloutMeta | null {
  const cached = cache.get(file.rolloutId)
  if (cached !== undefined) return cached
  const meta = read(file.path)
  if (meta !== null) cache.set(file.rolloutId, meta)
  return meta
}

function readCache(file: string): Record<string, RolloutMeta> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // Absent on first run, and corrupt is no worse than absent — every entry
    // is re-derivable from the rollout files themselves.
    return {}
  }
  if (!isRecord(parsed)) return {}

  const out: Record<string, RolloutMeta> = {}
  for (const [key, value] of Object.entries(parsed)) {
    // Nulls from an older helm are dropped on read: they are exactly the
    // permanently-lost sessions this cache used to create.
    if (!isRecord(value)) continue
    const { sessionId, cwd } = value
    if (typeof sessionId === 'string' && typeof cwd === 'string') out[key] = { sessionId, cwd }
  }
  return out
}

function writeAtomic(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.tmp`
  try {
    // 0600: this maps every project path on the machine.
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
  } catch {
    // Losing the cache costs 25 ms on the next poll and nothing else. Taking
    // the board down over it would be a much worse trade.
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
