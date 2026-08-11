#!/usr/bin/env node
import { runStatus } from './status.ts'

const USAGE = `helm — 本機 agent CLI 艦隊看板

用法：
  helm status [--json] [--no-color]   列出所有專案與 session 狀態
  helm scan                           等同 helm status --json
  helm help                           顯示本說明
`

function main(argv: readonly string[]): number {
  const [command = 'status', ...rest] = argv
  switch (command) {
    case 'status':
      return runStatus(rest)
    case 'scan':
      return runStatus([...rest, '--json'])
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

process.exitCode = main(process.argv.slice(2))
