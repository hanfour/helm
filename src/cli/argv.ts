/**
 * The first positional argument, with `--` honoured as the end-of-flags
 * marker. Without it a project literally named `--evil` — legal on APFS, and
 * therefore reachable from the menu bar — can never be passed to any command:
 * it is skipped as a flag, the command prints usage, and because the menu row
 * runs with `terminal=false` the user sees nothing at all.
 */
export function firstPositional(argv: readonly string[]): string | undefined {
  const end = argv.indexOf('--')
  if (end !== -1) return argv[end + 1]
  return argv.find((a) => !a.startsWith('--'))
}
