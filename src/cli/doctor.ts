import { runChecks, sweepStaleLive, type CheckDeps } from '../hook/health.ts'
import { collectStatus, currentPaths } from './status.ts'

/**
 * `deps` exists so tests never reach the real preference database. One that
 * did read the live SwiftBar folder and installed a fixture's plugin over the
 * working one — silently, with the suite green.
 */
export function runDoctor(_argv: readonly string[], deps: CheckDeps = {}): number {
  const now = Date.now()
  const paths = currentPaths()
  const board = collectStatus(paths, now)

  const checks = runChecks(paths, board, deps)
  for (const c of checks) process.stdout.write(`${c.ok ? '✓' : '✗'} ${c.name}：${c.detail}\n`)

  // Sweeping decides what to delete from a board that this very run may just
  // have reported unreliable — an unparseable registry file describes a
  // session whose marker would then be deleted on the strength of its absence.
  const trustworthy = board.invalid === 0 && board.prefsHealth === 'ok'
  if (trustworthy) {
    const swept = sweepStaleLive(paths, board, now)
    if (swept.length > 0) process.stdout.write(`\n順手清掉 ${swept.length} 個過期的 live 檔。\n`)
  } else {
    process.stdout.write('\n看板資料不完整，這次不清理 live 檔。先處理上面的問題再跑一次。\n')
  }

  const failed = checks.filter((c) => !c.ok)
  if (failed.length === 0) {
    process.stdout.write('\n一切正常。\n')
    return 0
  }
  process.stdout.write(`\n${failed.length} 項需要處理，每一項的下一步都寫在上面了。\n`)
  return 1
}
