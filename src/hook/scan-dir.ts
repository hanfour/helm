import { isAbsolute } from 'node:path'
import type { PrefRead } from './defaults.ts'

/**
 * Where a GUI app is actually scanning, as far as helm can tell.
 *
 * `dir === null` means helm must not write anything: either the setting could
 * not be read, or it is not a path helm is willing to create. Both cases carry
 * a warning, because the alternative — installing into the default folder and
 * reporting success — produces the dead end this module exists to prevent:
 * every file in place, every check green, and nothing on screen.
 */
export interface ScannedDir {
  dir: string | null
  /** Only ever true when the app has demonstrably never been configured. */
  adoptable: boolean
  warning: string | null
}

/**
 * SwiftBar and Übersicht differ only in which key they keep the folder under,
 * so the decision lives here once. The rules, in order:
 *
 *   - never configured  → helm's default, and helm may claim it
 *   - configured        → that folder, and helm never touches the setting
 *   - unreadable        → refuse. Guessing here overwrites a folder the user
 *                         chose, taking all of their other plugins with it.
 *   - not absolute      → refuse. A relative path is resolved against the
 *                         current working directory, so `helm install` would
 *                         create the folder wherever the user happened to be
 *                         standing and report success.
 */
export function resolveScannedDir(
  read: PrefRead,
  defaultDir: string,
  appName: string,
  key: string,
): ScannedDir {
  if (read.kind === 'unset') return { dir: defaultDir, adoptable: true, warning: null }

  if (read.kind === 'unreadable') {
    return {
      dir: null,
      adoptable: false,
      warning: `讀不到 ${appName} 的 ${key} 設定（${read.reason}），這次不動它的資料夾。`
        + `請確認 ${appName} 的偏好沒有毀損，或在它的偏好面板重新指定資料夾後再跑一次 helm install。`,
    }
  }

  if (read.value.startsWith('~')) {
    return {
      dir: null,
      adoptable: false,
      warning: `${appName} 的 ${key} 是 "${read.value}"，開頭的 ~ 不會被展開成家目錄。`
        + `請在 ${appName} 的偏好面板重新選一次資料夾。`,
    }
  }

  if (!isAbsolute(read.value)) {
    return {
      dir: null,
      adoptable: false,
      warning: `${appName} 的 ${key} 是 "${read.value}"，不是絕對路徑。`
        + `helm 不會照著它寫檔 —— 請在 ${appName} 的偏好面板重新選一次資料夾。`,
    }
  }

  return { dir: read.value, adoptable: false, warning: null }
}
