import { homedir } from 'node:os'
import { join } from 'node:path'

export interface HelmPaths {
  home: string
  claudeHome: string
  claudeSessions: string
  claudeProjects: string
  claudeSettings: string
  helmHome: string
  helmLive: string
  helmBriefs: string
  cacheFile: string
  prefsFile: string
  hookErrorsLog: string
  backupsDir: string
}

export interface PathOverrides {
  home?: string
  claudeHome?: string
  helmHome?: string
}

/** Derive every path helm touches from at most three anchors. */
export function resolvePaths(overrides: PathOverrides = {}): HelmPaths {
  const home = overrides.home ?? homedir()
  const claudeHome = overrides.claudeHome ?? join(home, '.claude')
  const helmHome = overrides.helmHome ?? join(home, '.helm')
  return {
    home,
    claudeHome,
    claudeSessions: join(claudeHome, 'sessions'),
    claudeProjects: join(claudeHome, 'projects'),
    claudeSettings: join(claudeHome, 'settings.json'),
    helmHome,
    helmLive: join(helmHome, 'live'),
    helmBriefs: join(helmHome, 'briefs'),
    cacheFile: join(helmHome, 'cache.json'),
    prefsFile: join(helmHome, 'projects.json'),
    hookErrorsLog: join(helmHome, 'hook-errors.log'),
    backupsDir: join(helmHome, 'backups'),
  }
}
