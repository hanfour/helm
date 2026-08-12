import { basename } from 'node:path'
import type { HelmPaths } from '../paths.ts'
import { quarantinePath, readPrefs, setProjectPref, writePrefs } from '../projects/prefs.ts'
import { collectStatus, currentPaths } from './status.ts'
import { matchByTiers } from '../projects/resolve.ts'
import { resolveOrReport } from './target.ts'

export type PrefAction = 'pin' | 'unpin' | 'hide' | 'show'

const PATCH: Record<PrefAction, { pinned?: boolean; hidden?: boolean }> = {
  pin: { pinned: true },
  unpin: { pinned: false },
  hide: { hidden: true },
  show: { hidden: false },
}

const DONE: Record<PrefAction, string> = {
  pin: '已釘選', unpin: '已取消釘選', hide: '已隱藏', show: '已取消隱藏',
}

export function runPrefs(action: PrefAction, argv: readonly string[]): number {
  const query = argv.find((a) => !a.startsWith('--'))
  if (query === undefined) {
    process.stderr.write(`用法：helm ${action} <專案>\n`)
    return 2
  }

  const paths = currentPaths()
  const { prefs, health } = readPrefs(paths.prefsFile)
  if (health === 'unreadable') {
    // The original is unusable *and* still sitting there. Writing now would
    // truncate the one file helm cannot rebuild, so refuse and hand the user
    // the decision instead.
    process.stderr.write(
      `${paths.prefsFile} 無法解析，而且搬不開它（目錄可能不可寫）。\n` +
      '為了不覆蓋掉你先前的釘選與隱藏，這次不寫入。請自行修好或移走該檔後重試。\n',
    )
    return 1
  }
  if (health === 'quarantined') {
    process.stderr.write(
      `⚠ ${paths.prefsFile} 無法解析，原檔已保留為 ${quarantinePath(paths.prefsFile)}。\n` +
      '  這次的設定會寫進一個全新的檔案，先前的釘選與隱藏不會自動帶過來。\n',
    )
  }

  // `show` has to look somewhere else: a hidden project is absent from the
  // board by definition, so the normal resolver can never find it. Without
  // this the user would be locked out of their own `hide` with no way back
  // short of editing JSON by hand.
  const path = action === 'show'
    ? resolveHidden(prefs.projects, query)
    : resolveVisible(paths, query)
  if (path === null) return 1

  writePrefs(paths.prefsFile, setProjectPref(prefs, path, PATCH[action]))
  process.stdout.write(`${DONE[action]}：${path}\n`)
  return 0
}

function resolveVisible(paths: HelmPaths, query: string): string | null {
  const { projects } = collectStatus(paths, Date.now())
  const hit = resolveOrReport(projects, query, (m) => process.stderr.write(m))
  return hit?.project.path ?? null
}

function resolveHidden(
  projects: Record<string, { pinned: boolean; hidden: boolean }>,
  query: string,
): string | null {
  const hidden = Object.entries(projects).filter(([, p]) => p.hidden).map(([path]) => path)
  // The same tiered matching `resolveTarget` uses. Reimplementing it here
  // without the exact-match tier is what made `helm show proj` impossible once
  // `proj2` was also hidden — and `show` is the only documented way back.
  const matched = matchByTiers(hidden, query, (path) => [basename(path), path])

  if (matched.length === 1) return matched[0] as string
  if (matched.length > 1) {
    process.stderr.write(
      `"${query}" 同時符合多個隱藏中的專案：\n${matched.map((p) => `  ${p}`).join('\n')}\n打長一點就能分辨。\n`,
    )
    return null
  }
  process.stderr.write(
    hidden.length === 0
      ? '目前沒有被隱藏的專案。\n'
      : `找不到符合 "${query}" 的隱藏專案。目前隱藏中：\n${hidden.map((p) => `  ${p}`).join('\n')}\n`,
  )
  return null
}
