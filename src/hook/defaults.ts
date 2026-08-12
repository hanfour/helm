import { execFileSync } from 'node:child_process'

/**
 * Reading and writing one app's preference domain.
 *
 * Injected everywhere rather than called directly so the install and health
 * paths stay testable on a machine where neither app exists — and so a test
 * can never reach the real `defaults` database and change the user's own
 * settings.
 */
export interface PrefsIO {
  readPref: (key: string) => string | null
  writePref: (key: string, value: string) => void
}

export function prefsFor(bundleId: string): PrefsIO {
  return {
    readPref: (key) => readPref(bundleId, key),
    writePref: (key, value) => writePref(bundleId, key, value),
  }
}

/**
 * Read through `plutil`, not through `defaults read`.
 *
 * `defaults read <domain> <key>` prints old-style plist, which escapes every
 * non-ASCII character: Übersicht's own widget folder came back as
 * `…/Application Support/\334bersicht/widgets`. helm then looked for a
 * directory by that literal name, did not find one, and reported the widget
 * as missing seconds after installing it.
 *
 * Two spawns instead of one. This runs during install and doctor only — never
 * on the five-second path — so correctness is worth the ~10 ms.
 */
function readPref(bundleId: string, key: string): string | null {
  try {
    const plist = execFileSync('defaults', ['export', bundleId, '-'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const out = execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', '-'], {
      input: plist,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    // `plutil` appends exactly one newline of its own; anything else in the
    // value is the value. `.trim()` here would silently eat a trailing space.
    const value = out.endsWith('\n') ? out.slice(0, -1) : out
    return value === '' ? null : value
  } catch {
    // Either command exits non-zero when the domain or the key does not
    // exist, which is the normal state before the app has been configured.
    return null
  }
}

/**
 * Refuses to run under the test suite.
 *
 * A test with no injected fake once wrote a temp-directory path into the real
 * Übersicht domain and then deleted the directory, leaving the app pointed at
 * nothing. It failed silently and was found only by reading `defaults` by
 * hand — so the guard is loud, and lives here rather than in each test.
 */
function writePref(bundleId: string, key: string, value: string): void {
  if (process.env['HELM_NO_REAL_PREFS'] === '1') {
    throw new Error(
      `HELM_NO_REAL_PREFS：測試不得寫入真實偏好（${bundleId} ${key}=${value}）。請注入假的 PrefsIO。`,
    )
  }
  execFileSync('defaults', ['write', bundleId, key, '-string', value], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}
