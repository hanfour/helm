#!/usr/bin/env node
import { runBrief } from './brief.ts'
import { runSessions } from './sessions.ts'
import { runStatus } from './status.ts'

const USAGE = `helm — 本機 agent CLI 艦隊看板

用法：
  helm status [--json] [--no-color]   列出所有專案（一個專案一行）
  helm scan                           等同 helm status --json
  helm sessions <專案>                展開該專案底下的 session
  helm brief <專案或 id> [--refresh]  顯示交接簡報；給專案名則取最近的 session
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

process.exitCode = await main(process.argv.slice(2))
