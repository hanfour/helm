#!/usr/bin/env node
import { runBrief } from './brief.ts'
import { runInstall, runUninstall } from './install.ts'
import { runOpen } from './open.ts'
import { runSessions } from './sessions.ts'
import { runStatus } from './status.ts'

const USAGE = `helm — 本機 agent CLI 艦隊看板

用法：
  helm status [--json] [--no-color]   列出所有專案（一個專案一行）
  helm scan                           等同 helm status --json
  helm sessions <專案>                展開該專案底下的 session
  helm brief <專案或 id> [--refresh]  顯示交接簡報；給專案名則取最近的 session
  helm open  <專案或 id> [--no-brief]
                    [--refresh]       開終端機接續，並把簡報寫成檔案讓它讀
  helm install                        安裝 hook 與選單列 plugin（會先備份設定）
  helm uninstall                      完全移除，還原設定
  helm help                           顯示本說明

<專案> 可以只打一部分，例如 data-svc；對不上唯一目標時會列出候選讓你選。
`

async function main(argv: readonly string[]): Promise<number> {
  const [command = 'status', ...rest] = argv
  switch (command) {
    case 'status':
      return runStatus(rest)
    case 'scan':
      return runStatus([...rest, '--json'])
    case 'sessions':
      return runSessions(rest)
    case 'brief':
      return runBrief(rest)
    case 'install':
      return runInstall(rest)
    case 'uninstall':
      return runUninstall(rest)
    case 'open':
      return runOpen(rest)
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE)
      return 0
    default:
      process.stderr.write(`未知指令：${command}\n\n${USAGE}`)
      return 2
  }
}

/**
 * Every leaf module in helm degrades deliberately, but the writes that must
 * succeed — the brief file, the cache, the prefs file — can still fail on a
 * full disk or a read-only home. Without this the user gets a raw
 * `[UnhandledPromiseRejection] Error: EACCES …` and a stack trace, and the
 * exit code lands on 1 by accident rather than by decision.
 */
process.exitCode = await main(process.argv.slice(2)).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  process.stderr.write(`helm 失敗了：${msg}\n`)
  if (process.env['HELM_DEBUG'] === '1' && err instanceof Error) {
    process.stderr.write(`${err.stack ?? ''}\n`)
  } else {
    process.stderr.write('（設定 HELM_DEBUG=1 可看到完整的錯誤堆疊）\n')
  }
  return 1
})
