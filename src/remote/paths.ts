import { join } from 'node:path'
import type { HelmPaths } from '../paths.ts'
import type { RefreshPaths } from './refresh.ts'

export function prPaths(paths: HelmPaths): RefreshPaths {
  return {
    cacheFile: join(paths.helmHome, 'prs.json'),
    lockFile: join(paths.helmHome, 'pr-refresh.lock'),
  }
}
