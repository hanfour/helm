import { fileURLToPath } from 'node:url'

/**
 * Embedded in the command so `helm uninstall` can find helm's own entry, but
 * only ever checked *together with* the structural shape of the group — a
 * third-party hook that merely mentions this string (an audit script asking
 * "is helm collecting?") must not be mistaken for ours and deleted.
 */
export const HOOK_MARKER = 'HELM_LIVE_MARKER'

/** Absolute path to the recorder, resolved from this module's own location. */
export function recorderPath(): string {
  return fileURLToPath(new URL('record.mjs', import.meta.url))
}

/**
 * One line, because settings.json holds the command as a JSON string.
 *
 * `--no-warnings` is measured worth ~3 ms per call, and the recorder is plain
 * .mjs rather than .ts because type stripping costs ~21 ms every single time
 * (71.6 ms against 50.7 ms). Both matter here and nowhere else in helm: this
 * command runs before every tool call the user makes.
 */
export function buildHookCommand(
  liveDir: string,
  errorsLog: string,
  recorder: string = recorderPath(),
): string {
  return [
    `exec node --no-warnings ${shellQuote(recorder)}`,
    shellQuote(liveDir),
    shellQuote(errorsLog),
    `# ${HOOK_MARKER}`,
  ].join(' ')
}

/**
 * POSIX single-quote quoting: the only form with no escape sequences inside.
 * Every path helm writes into a shell command goes through this — a repo or
 * home directory containing `$` or `"` is unusual but entirely legal, and
 * unquoted it produces a command that fails while install reports success.
 */
export function shellQuote(s: string): string {
  return `'${s.split("'").join(`'\\''`)}'`
}
