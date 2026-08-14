import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../temp-dir.ts'

const RECORD = fileURLToPath(new URL('./record.mjs', import.meta.url))

/**
 * The live marker is the most sensitive file helm writes and the only one
 * written continuously.
 *
 * Its `summary` is the shell command being run, verbatim — `ps aux | grep …`,
 * a curl with a token in it, a path under a private client's directory. It
 * landed in ~/.helm/live at 0644 while `prs.json` and `codex-meta.json` next
 * door were 0600, because `writeAtomic` never passed a mode.
 *
 * This runs the real hook rather than asserting on its source, because the
 * mode is a property of the file it produces.
 */
test('live marker 以 0600 寫出 —— summary 是你執行的指令原文', () => {
  // `helm install` creates the live directory; the hook only writes into it.
  const home = tempDir('helm-record-mode')
  const liveDir = join(home, 'live')
  mkdirSync(liveDir, { recursive: true })
  const errorsLog = join(home, 'errors.log')
  execFileSync(process.execPath, [RECORD, liveDir, errorsLog], {
    input: JSON.stringify({
      session_id: 'abcdef12-3456-7890-abcd-ef1234567890',
      tool_name: 'Bash',
      tool_input: { command: 'curl -H "Authorization: Bearer sk-secret" https://x' },
    }),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const written = readdirSync(liveDir)
  assert.equal(written.length, 1, `預期剛好一個 marker，得到 ${written.join(',')}`)
  const file = join(liveDir, written[0] as string)
  assert.equal(statSync(file).mode & 0o777, 0o600, 'live marker 不該是全世界可讀')
})
