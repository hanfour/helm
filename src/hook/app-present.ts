import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * Whether a Mac app is installed, by bundle id and not only by path.
 *
 * `/Applications/SwiftBar.app` is false for a per-user install in
 * ~/Applications and for anything managed by Setapp, so helm told people
 * actively running the app that it was not installed and to `brew install`
 * it. helm already talks to these apps by bundle id to read their
 * preferences; the check should use the same identity.
 */
export function appInstalled(path: string, bundleId: string): boolean {
  if (existsSync(path)) return true
  try {
    const found = execFileSync(
      'mdfind',
      [`kMDItemCFBundleIdentifier == '${bundleId}'`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 },
    ).trim()
    return found !== ''
  } catch {
    // Spotlight disabled or indexing — fall back to "not found" rather than
    // blocking install. The caller's message says how to install it, which is
    // harmless advice for someone who already has it.
    return false
  }
}
