// PreToolUse hook. Runs before every single tool call on the user's machine.
//
// Deliberately plain .mjs with no imports at all. Two reasons, both measured:
//   - Node strips types from .ts on every run: 71.6 ms against 50.7 ms for
//     .mjs. At ~15 tool calls per turn that is 315 ms per turn of pure tax.
//   - Importing anything from src/ would drag those modules through the same
//     stripping, plus their own dependency graphs.
//
// The cost of standing alone is that the record shape is written twice — here
// and in src/reconcile/live.ts. `src/reconcile/live.test.ts` runs this script
// for real and feeds its output to the real reader, so the two cannot drift
// apart silently.
//
// This replaced a pure-shell implementation. That version honoured a
// "one spawn, builtins only" rule that saved ~45 ms per call, but POSIX
// parameter expansion made it quadratic: `${C%%\"*}` on a 98 KB heredoc —
// an ordinary `cat <<'EOF'` tool call — measured 6,092 ms of dead wait before
// the tool would even start. It also mis-parsed hyphenated MCP tool names,
// broke under an inherited `SHELLOPTS=errexit`, and could emit invalid JSON
// when a session id contained an escaped quote.

import {
  readFileSync, writeFileSync, renameSync, appendFileSync, statSync, unlinkSync,
} from 'node:fs'
import { join } from 'node:path'

/** Matches the reader's cap so the hot path never writes bytes nobody reads. */
const MAX_SUMMARY = 200
const MAX_TOOL_NAME = 100

/** The value becomes a filename, so nothing but a UUID shape is accepted. */
const SESSION_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Every path through this file ends at exit 0. A PreToolUse hook that exits 2
 * blocks the tool call outright; any other non-zero is non-blocking but posts
 * an error notice into the transcript on every single call, which would make
 * the tool unusable in a different way.
 */
function main() {
  const [liveDir, errorsLog] = process.argv.slice(2)
  if (process.env.HELM_OFF === '1' || !liveDir) return

  const payload = parse(readStdin())
  if (payload === null) return

  const sessionId = payload.session_id
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return

  writeAtomic(join(liveDir, `${sessionId}.json`), `${JSON.stringify({
    sessionId,
    ts: 0,
    toolName: trim(payload.tool_name, MAX_TOOL_NAME),
    summary: trim(summaryOf(payload.tool_input), MAX_SUMMARY),
  })}\n`, errorsLog)
}

function readStdin() {
  try {
    // fd 0 in one go: the payload's newline layout is not contractually
    // specified, and a line-based read silently produced nothing whenever
    // Claude Code pretty-printed it.
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function parse(raw) {
  try {
    const value = JSON.parse(raw)
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/** Bash gets its command, file tools get their path, anything else gets nothing. */
function summaryOf(toolInput) {
  if (toolInput === null || typeof toolInput !== 'object') return ''
  for (const key of ['command', 'file_path', 'pattern', 'url']) {
    if (typeof toolInput[key] === 'string') return toolInput[key]
  }
  return ''
}

function trim(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/**
 * Temp-then-rename, because the reader treats a half-written marker as no
 * marker and lifecycle then reports the session as cleanly ended at high
 * confidence — the precise opposite of what this file exists to record, and
 * most likely exactly when it matters (closing a terminal SIGHUPs the hook).
 */
function writeAtomic(path, body, errorsLog) {
  const temp = `${path}.${process.pid}.tmp`
  try {
    // 0600. The marker's `summary` is the command being run, verbatim — a
    // curl carrying a token, a path under a private client's directory — and
    // it is rewritten on every tool call into a world-readable ~/.helm.
    writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, path)
  } catch (err) {
    cleanup(temp)
    log(errorsLog, err)
  }
}

function cleanup(temp) {
  try {
    unlinkSync(temp)
  } catch {
    // Nothing left to do; a stray temp file is harmless and the sweep in
    // `helm doctor` ignores anything that is not a .json marker.
  }
}

/**
 * The project's one exemption from "never swallow errors" (spec §12): this
 * runs on the critical path and must stay quiet there. `helm doctor` reading
 * this log is the compensation that keeps the exemption honest — including a
 * check that the log itself is writable, since a failure here is invisible.
 */
/**
 * Bounded, because a persistent failure writes one line per tool call for
 * ever. Deleting ~/.helm/live by hand is expected — uninstall explicitly
 * leaves it — and after that every single call appends ~235 bytes with no
 * rotation, while `helm doctor` reads the whole file into memory.
 *
 * Truncating to the tail keeps the newest lines, which are the ones that
 * describe what is broken now.
 */
const LOG_MAX_BYTES = 32 * 1024

function log(errorsLog, err) {
  if (!errorsLog) return
  try {
    appendFileSync(errorsLog, `${new Date().toISOString()} ${String(err)}\n`, 'utf8')
    trimLog(errorsLog)
  } catch {
    // The log is the last resort and it failed too. Exiting non-zero would
    // put an error notice in front of the user on every tool call; staying
    // silent is the lesser harm, and `helm doctor` checks writability.
  }
}

function trimLog(file) {
  const size = statSync(file).size
  if (size <= LOG_MAX_BYTES) return
  const body = readFileSync(file, 'utf8')
  const cut = body.indexOf('\n', body.length - LOG_MAX_BYTES)
  const kept = cut === -1 ? body.slice(-LOG_MAX_BYTES) : body.slice(cut + 1)
  // Same temp-then-rename as the markers: a crash mid-truncate would leave a
  // half-written log, and this runs before every tool call the user makes.
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, kept, 'utf8')
  renameSync(temp, file)
}

try {
  main()
} catch {
  // Nothing above should throw, but this is the boundary that guarantees the
  // exit code regardless of what a future edit does.
}
process.exit(0)
