import { runChecks, sweepStaleLive } from '../hook/health.ts'
import { collectStatus, currentPaths } from './status.ts'

export function runDoctor(_argv: readonly string[]): number {
  const now = Date.now()
  const paths = currentPaths()
  const board = collectStatus(paths, now)

  const checks = runChecks(paths, board)
  for (const c of checks) process.stdout.write(`${c.ok ? '✓' : '✗'} ${c.name}：${c.detail}\n`)

  const swept = sweepStaleLive(paths, board, now)
  if (swept.length > 0) process.stdout.write(`\n順手清掉 ${swept.length} 個過期的 live 檔。\n`)

  const failed = checks.filter((c) => !c.ok)
  if (failed.length === 0) {
    process.stdout.write('\n一切正常。\n')
    return 0
  }
  process.stdout.write(`\n${failed.length} 項需要處理，每一項的下一步都寫在上面了。\n`)
  return 1
}
