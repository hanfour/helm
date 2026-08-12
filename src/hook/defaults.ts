import { execFileSync } from 'node:child_process'

/**
 * What a preference read found. The three cases must stay distinct.
 *
 * `unset` licenses `adoptPluginDir` / `adoptWidgetDir` to write — it means the
 * app has no opinion yet. Collapsing `unreadable` into it is how a transient
 * failure turns into overwriting the folder the user chose, which makes every
 * one of their plugins or widgets disappear at once.
 */
export type PrefRead =
  | { kind: 'set'; value: string }
  | { kind: 'unset' }
  | { kind: 'unreadable'; reason: string }

export interface PrefsIO {
  readPref: (key: string) => PrefRead
  writePref: (key: string, value: string) => void
  /** Back to "never configured" — only ever used to undo helm's own write. */
  clearPref: (key: string) => void
}

/**
 * Big enough that no real preference domain reaches it. The default is 1 MB,
 * and a 1.2 MB domain was enough to throw ENOBUFS — which the old code caught
 * and reported as "this app has no setting yet".
 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/**
 * The two commands a read needs, injectable.
 *
 * Not for convenience: the `unreadable` branch decides whether helm may
 * overwrite the folder the user chose, and there is no way to make the real
 * `defaults` fail with ENOBUFS — or vanish from PATH — from inside a test.
 * Without this the branch is unreachable, and a mutation that collapsed it
 * into `unset` survived the whole suite.
 */
export interface PrefsExec {
  exportDomain: (bundleId: string) => Buffer
  extract: (key: string, plist: Buffer) => string
}

const realExec: PrefsExec = {
  exportDomain: (bundleId) => execFileSync('defaults', ['export', bundleId, '-'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: MAX_OUTPUT_BYTES,
  }),
  extract: (key, plist) => execFileSync('plutil', ['-extract', key, 'xml1', '-o', '-', '-'], {
    input: plist,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
    maxBuffer: MAX_OUTPUT_BYTES,
  }),
}

export function prefsFor(bundleId: string, exec: PrefsExec = realExec): PrefsIO {
  return {
    readPref: (key) => {
      guard(bundleId, `read ${key}`)
      return readPref(bundleId, key, exec)
    },
    writePref: (key, value) => {
      guard(bundleId, `write ${key}=${value}`)
      writePref(bundleId, key, value)
    },
    clearPref: (key) => {
      guard(bundleId, `delete ${key}`)
      clearPref(bundleId, key)
    },
  }
}

/** Domains a test may touch, because it creates them and deletes them again. */
const TEST_DOMAIN_PREFIX = 'com.helm.test.'

/**
 * Under the test suite, reaching a real preference domain is a hard error.
 *
 * Reads matter as much as writes, and that took two incidents to learn. First
 * a test wrote a temp path into Übersicht's own `widgetDir`. Then, with writes
 * guarded but reads still live, a `helm doctor` test read the real SwiftBar
 * `PluginDirectory` and installed its fixture's plugin over the working one in
 * ~/SwiftBar — the menu bar went to ⚠ and the suite stayed green.
 *
 * Both times the damage was to an app the user actually runs, and both times
 * nothing failed. So: inject a fake, or use a com.helm.test.* domain.
 */
function guard(bundleId: string, what: string): void {
  if (process.env['HELM_NO_REAL_PREFS'] !== '1') return
  if (bundleId.startsWith(TEST_DOMAIN_PREFIX)) return
  throw new Error(
    `HELM_NO_REAL_PREFS：測試不得碰真實偏好（${bundleId} ${what}）。請注入假的 PrefsIO。`,
  )
}

/**
 * Read as XML, not as `defaults read` and not as `plutil … raw`.
 *
 * `defaults read <domain> <key>` prints old-style plist, which escapes every
 * non-ASCII character: Übersicht's widget folder came back as
 * `…/Application Support/\334bersicht/widgets`, and helm looked for a
 * directory by that literal name.
 *
 * `plutil -extract <key> raw` fixes the escaping but silently compresses
 * non-strings — an array prints its element *count*, a dictionary prints a
 * key *name*. A `PluginDirectory` holding `["a","b"]` read back as the path
 * `"2"`, which is relative, so helm created ./2/ in whatever directory the
 * user happened to be standing in and reported success.
 *
 * XML carries the type, so anything that is not `<string>` can be refused.
 */
function readPref(bundleId: string, key: string, exec: PrefsExec): PrefRead {
  let xml: string
  try {
    xml = exec.extract(key, exec.exportDomain(bundleId))
  } catch (err) {
    // Both commands exit non-zero when the key or the domain does not exist,
    // which is the normal state before an app has been configured. Anything
    // else — ENOBUFS, a missing `plutil`, a sandbox denial — is a read that
    // failed, and must not be mistaken for "no setting".
    return isMissingKey(err) ? { kind: 'unset' } : { kind: 'unreadable', reason: reasonOf(err) }
  }

  // The whole document body must be one string element. Matching `<string>`
  // anywhere would accept `<array><string>a</string><string>b</string></array>`
  // and hand back everything between the first and last tag.
  const body = /<plist[^>]*>([\s\S]*)<\/plist>/.exec(xml)?.[1]?.trim()
  if (body === undefined || !body.startsWith(OPEN) || !body.endsWith(CLOSE)) {
    return {
      kind: 'unreadable',
      reason: `型別不是字串（${typeNameOf(body ?? xml)}），helm 只接受字串路徑`,
    }
  }
  const value = unescapeXml(body.slice(OPEN.length, -CLOSE.length))
  // An empty string is not a folder. Treated as a value it would reach
  // `join('', 'helm.jsx')` — a relative path, written wherever the CLI was run.
  return value === '' ? { kind: 'unset' } : { kind: 'set', value }
}

/**
 * `defaults`/`plutil` exit 1 with an empty stdout for a key that is not there.
 * A read that failed for any other reason produces a signal, a different exit
 * status, or an errno — none of which mean "not set".
 *
 * Exported for the tests: the difference decides whether `adoptWidgetDir` may
 * overwrite the folder the user chose, and reproducing an ENOBUFS or a missing
 * `plutil` from the outside is not something a test can do reliably.
 */
export function isMissingKey(err: unknown): boolean {
  const e = err as { status?: number | null; signal?: string | null; code?: string }
  if (e.signal != null) return false
  if (typeof e.code === 'string' && e.code !== '') return false
  return e.status === 1
}

function reasonOf(err: unknown): string {
  const e = err as { code?: string; message?: string }
  return e.code ?? e.message ?? String(err)
}

const OPEN = '<string>'
const CLOSE = '</string>'

function typeNameOf(xml: string): string {
  return /<(array|dict|integer|real|true|false|data|date)\b/.exec(xml)?.[1] ?? '未知'
}

/** `&amp;` last, or `&amp;lt;` would decode twice into `<`. */
function unescapeXml(s: string): string {
  return s
    .split('&lt;').join('<')
    .split('&gt;').join('>')
    .split('&quot;').join('"')
    .split('&apos;').join("'")
    .split('&amp;').join('&')
}

function clearPref(bundleId: string, key: string): void {
  try {
    execFileSync('defaults', ['delete', bundleId, key], { stdio: ['ignore', 'ignore', 'ignore'] })
  } catch {
    // Already absent, which is the state we were asking for.
  }
}

/** `-string` is not optional: without it `defaults` stores "2" as an integer. */
function writePref(bundleId: string, key: string, value: string): void {
  execFileSync('defaults', ['write', bundleId, key, '-string', value], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}
