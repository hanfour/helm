/**
 * The absolute paths a generated artefact depends on at run time.
 *
 * Every script helm writes — the hook command, the wrapper, the SwiftBar
 * plugin, the Übersicht widget — is a couple of lines that hand off to
 * something else. Checking that those *files* exist says nothing about
 * whether they can run: a wrapper whose pinned Node was deleted by a version
 * manager, or a plugin whose wrapper the user tidied out of ~/.local/bin,
 * fails at exec time. The menu bar goes blank, the hook stops recording, and
 * `helm doctor` reports nine green checks because it only ever looked at the
 * files helm wrote.
 *
 * Everything helm emits is shell-single-quoted, which is what makes this
 * recoverable: `'…'` has no escape sequences inside except the `'\''`
 * idiom that `shellQuote` produces.
 */
export function referencedPaths(script: string): string[] {
  const found: string[] = []
  for (const raw of singleQuoted(script)) {
    // Arguments like 'status' and '--json' go through the same quoting; only
    // absolute paths name something that has to exist on disk.
    if (!raw.startsWith('/')) continue
    if (!found.includes(raw)) found.push(raw)
  }
  return found
}

/**
 * Walks the string rather than using one regex, because `'\''` — a quote
 * closed, an escaped quote, a quote reopened — has to rejoin into one value.
 */
function singleQuoted(script: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < script.length) {
    if (script[i] !== "'") {
      i++
      continue
    }
    let value = ''
    i++
    while (i < script.length) {
      if (script[i] !== "'") {
        value += script[i]
        i++
        continue
      }
      // Closing quote. `'\''` means the value continues with a literal quote.
      if (script.startsWith(`'\\''`, i)) {
        value += "'"
        i += 4
        continue
      }
      i++
      break
    }
    out.push(value)
  }
  return out
}
