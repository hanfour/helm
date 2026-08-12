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

function readPref(bundleId: string, key: string): string | null {
  try {
    const out = execFileSync('defaults', ['read', bundleId, key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out === '' ? null : out
  } catch {
    // `defaults` exits non-zero when the domain or the key does not exist,
    // which is the normal state before the app has ever been configured.
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
