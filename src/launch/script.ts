export type Terminal = 'iterm' | 'terminal'

const ITERM_APP = '/Applications/iTerm.app'

/**
 * POSIX single-quote quoting: the only form with no escape sequences inside,
 * so nothing between the quotes can be reinterpreted by the shell.
 *
 * This matters more here than anywhere else in helm. The cwd comes from a file
 * helm did not write, and it ends up inside a shell command that is itself
 * inside an AppleScript string. Both layers have to hold.
 */
export function shellQuote(s: string): string {
  return `'${s.split("'").join(`'\\''`)}'`
}

/**
 * AppleScript string literal. Backslashes must be doubled before quotes are
 * escaped — the other order turns an input `\"` into a backslash escaping the
 * backslash we just added, and the quote goes unescaped.
 */
export function appleScriptQuote(s: string): string {
  return `"${s.split('\\').join('\\\\').split('"').join('\\"')}"`
}

export function buildResumeCommand(
  adapterId: string,
  sessionId: string,
  opening: string,
): string {
  switch (adapterId) {
    case 'claude-code':
      // Verified against `claude --help`: usage is
      // `claude [options] [command] [prompt]`, so the opening message is a
      // positional argument and can be sent along with the resume.
      return `claude --resume ${shellQuote(sessionId)} ${shellQuote(opening)}`
    case 'codex':
      return `codex resume ${shellQuote(sessionId)}`
    default:
      // Refuse rather than guess. Running the wrong CLI against a session id
      // is not something the user can undo by reading an error afterwards.
      throw new Error(`不支援的 adapter：${adapterId}`)
  }
}

export function buildLaunchScript(term: Terminal, cwd: string, command: string): string {
  const full = `cd ${shellQuote(cwd)} && ${command}`
  return term === 'iterm' ? itermScript(full) : terminalScript(full)
}

function itermScript(command: string): string {
  const q = appleScriptQuote(command)
  return [
    'tell application "iTerm"',
    '  activate',
    '  if (count of windows) = 0 then',
    '    set w to (create window with default profile)',
    `    tell current session of w to write text ${q}`,
    '  else',
    '    tell current window',
    '      set t to (create tab with default profile)',
    `      tell current session of t to write text ${q}`,
    '    end tell',
    '  end if',
    'end tell',
  ].join('\n')
}

function terminalScript(command: string): string {
  return [
    'tell application "Terminal"',
    '  activate',
    `  do script ${appleScriptQuote(command)}`,
    'end tell',
  ].join('\n')
}

export function detectTerminal(exists: (appPath: string) => boolean): Terminal {
  return exists(ITERM_APP) ? 'iterm' : 'terminal'
}
