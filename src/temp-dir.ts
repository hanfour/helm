import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A temp directory that removes itself when the process exits.
 *
 * `mkdtempSync` never cleans up, and nothing in the suite was doing it by
 * hand — 30,892 of these had accumulated in the user's temp directory, about
 * 125 more with every run. Registering an `exit` handler rather than an
 * `after()` hook keeps it working no matter which file calls it, including
 * from a helper that has no test context of its own.
 */
const created: string[] = []
let registered = false

export function tempDir(prefix: string): string {
  if (!registered) {
    registered = true
    // `exit` only: the suite may end through an uncaught error, and leaving
    // fixtures behind on the unhappy path is how this got to five figures.
    process.on('exit', cleanupTempDirs)
  }
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

export function cleanupTempDirs(): void {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A fixture left read-only by a test that was checking permissions.
      // Best effort: failing here would mask the real test result.
    }
  }
}
