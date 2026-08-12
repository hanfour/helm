#!/usr/bin/env node

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
  helm pin|unpin <專案>               釘選／取消釘選（釘選的專案不受 14 天窗口約束）
  helm hide|show <專案>               隱藏／取消隱藏
  helm menu                           輸出 SwiftBar 格式（由選單列 plugin 呼叫）
  helm doctor                         檢查 hook、快取與資料來源是否正常
  helm help                           顯示本說明

<專案> 可以只打一部分，例如 data-svc；對不上唯一目標時會列出候選讓你選。
名稱以 - 開頭時用 helm hide -- <名稱> 指定。
`

/**
 * Every subcommand is imported on demand. `helm menu` runs every five seconds
 * against a 200 ms contract, and statically importing the slow-path modules
 * (`summarize`, `cache`, `transcript`, the installer) charged it ~65 ms of
 * module graph it never touches — measured: `helm help`, which does nothing at
 * all, took 99-111 ms against Node's own 34-38 ms floor.
 */
async function main(argv: readonly string[]): Promise<number> {
  const [command = 'status', ...rest] = argv
  switch (command) {
    case 'status':
      return (await import('./status.ts')).runStatus(rest)
    case 'scan':
      return (await import('./status.ts')).runStatus([...rest, '--json'])
    case 'menu':
      return (await import('./menu.ts')).runMenu(rest)
    case 'sessions':
      return (await import('./sessions.ts')).runSessions(rest)
    case 'brief':
      return (await import('./brief.ts')).runBrief(rest)
    case 'open':
      return (await import('./open.ts')).runOpen(rest)
    case 'install':
      return (await import('./install.ts')).runInstall(rest)
    case 'uninstall':
      return (await import('./install.ts')).runUninstall(rest)
    case 'doctor':
      return (await import('./doctor.ts')).runDoctor(rest)
    case 'pin':
    case 'unpin':
    case 'hide':
    case 'show':
      return (await import('./prefs.ts')).runPrefs(command, rest)
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
