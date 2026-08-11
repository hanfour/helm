import { join } from 'node:path'
import { renderSwiftBar } from '../render/swiftbar.ts'
import { collectStatus, currentPaths } from './status.ts'

/**
 * Called by the SwiftBar plugin every five seconds, so it only ever walks the
 * fast path: registry, transcript stats, live markers, cache. Never a
 * transcript's contents, never the network, never an LLM (spec §11.2).
 */
export function runMenu(_argv: readonly string[]): number {
  const now = Date.now()
  const paths = currentPaths()
  process.stdout.write(renderSwiftBar(collectStatus(paths, now), {
    nowMs: now,
    helmBin: join(paths.home, '.local', 'bin', 'helm'),
  }))
  return 0
}
