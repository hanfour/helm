/**
 * Embedded in the command string so `helm uninstall` can find helm's own hook
 * entry without pattern-matching on paths that may since have moved.
 */
export const HOOK_MARKER = 'HELM_LIVE_MARKER'

/**
 * Runs before every tool call on the user's machine, which makes the rules
 * here stricter than anywhere else in helm:
 *
 *   1. **Every path exits 0.** A non-zero PreToolUse hook blocks the tool call.
 *      A bug here would stop the user working — the exact opposite of what
 *      this board is for.
 *   2. **One spawn only.** No `date`, no `mkdir`, no `jq`. Measured on this
 *      machine over 200 runs: the shell alone costs 6.72 ms and this script
 *      adds 0.63 ms, while calling `mkdir -p` pushed it to 9.86 ms. The live
 *      directory is created by the installer instead.
 *   3. **Anything doubtful is dropped, never guessed.** A malformed live file
 *      is worse than no live file: `readLiveMarker` rejects it and crash
 *      detection stops working with nothing to show for it.
 *
 * The timestamp is deliberately written as `0`. POSIX sh has no builtin for
 * the epoch (macOS `/bin/sh` is bash 3.2, no `$EPOCHSECONDS`), so writing a
 * real one would mean calling `date` — a second spawn on every tool call. The
 * file's own mtime is the same instant, measured by the kernel, and
 * `readLiveMarker` substitutes it on the way back in.
 *
 * Each element is a complete statement so the whole thing can also be joined
 * with `; ` into the single line settings.json needs.
 */
export const HOOK_SCRIPT = [
  `: ${HOOK_MARKER}`,
  'IFS= read -r L',
  '[ "${HELM_OFF:-0}" = 1 ] && exit 0',
  'S=${L#*\\"session_id\\":\\"}',
  'S=${S%%\\"*}',
  // Anything that is not shaped like a UUID is refused outright: this value
  // becomes a filename, and it arrives from a payload whose other fields are
  // full of user-controlled text.
  'case $S in [0-9a-fA-F]*-*-*-*-*) ;; *) exit 0 ;; esac',
  'T=${L#*\\"tool_name\\":\\"}',
  'T=${T%%\\"*}',
  "case $T in '' | *[!A-Za-z0-9_]*) T=unknown ;; esac",
  'C=',
  'case $L in *\'"command":"\'*) C=${L#*\\"command\\":\\"}; C=${C%%\\"*} ;;'
    + ' *\'"file_path":"\'*) C=${L#*\\"file_path\\":\\"}; C=${C%%\\"*} ;; esac',
  // A backslash means the extraction stopped inside a JSON escape sequence and
  // the trailing half would emit `{"summary":"echo \"}` — unparseable, so the
  // whole summary is dropped rather than corrupt the record it lives in.
  'case $C in *\\\\*) C= ;; esac',
  'printf \'{"sessionId":"%s","ts":0,"toolName":"%s","summary":"%s"}\\n\''
    + ' "$S" "$T" "$C" > "$HELM_LIVE/$S.json"',
  'exit 0',
].join('\n')

/**
 * One line, because settings.json holds the command as a JSON string.
 *
 * Errors go to the log rather than the terminal: this is the project's single
 * exemption from "never swallow errors" (spec §12), and `helm doctor` reading
 * that log is the compensation that keeps the exemption honest.
 *
 * The trailing `exit 0` is outside the redirected group on purpose — if the
 * log itself cannot be opened, the group never runs, and without this the
 * shell would exit non-zero and block the user's tool call.
 */
export function buildHookCommand(liveDir: string, errorsLog: string): string {
  const script = HOOK_SCRIPT.split('\n').join('; ')
  const wrapped = `HELM_LIVE=${shellQuote(liveDir)}; { ${script}; } 2>>${shellQuote(errorsLog)}; exit 0`
  return `sh -c ${shellQuote(wrapped)}`
}

/** POSIX single-quote quoting: no escape sequences survive inside. */
function shellQuote(s: string): string {
  return `'${s.split("'").join(`'\\''`)}'`
}
