import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { briefPathFor, defaultDeps, openSession, writeBriefFile } from './run.ts'
import type { SessionState } from '../types.ts'

const session = (over: Partial<SessionState> = {}): SessionState => ({
  adapterId: 'claude-code', sessionId: 'sess-1', cwd: '/Users/t/proj', pid: null,
  procStart: null, startedAt: 0, updatedAt: 0, nativeStatus: null,
  kind: 'interactive', name: '', transcriptPath: null, transcriptMtimeMs: null,
  lifecycle: 'ended_clean', lifecycleConfidence: 'high', live: null, ...over,
})

test('briefPathFor 以 session id 命名檔案', () => {
  assert.equal(briefPathFor('/h/briefs', 'sess-1'), '/h/briefs/sess-1.md')
})

test('writeBriefFile 會自動建立不存在的目錄', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'helm-run-')), 'a', 'b', 'x.md')
  writeBriefFile(path, '# 內容')
  assert.equal(readFileSync(path, 'utf8'), '# 內容')
})

test('openSession 把 cd 與 resume 指令交給 osascript', () => {
  const scripts: string[] = []
  openSession(session(), '/h/briefs/sess-1.md', {
    term: 'terminal',
    runOsascript: (s) => void scripts.push(s),
  })
  assert.equal(scripts.length, 1)
  assert.match(scripts[0] ?? '', /tell application "Terminal"/)
  assert.ok((scripts[0] ?? '').includes("cd '/Users/t/proj'"))
  assert.ok((scripts[0] ?? '').includes("claude --resume 'sess-1'"))
})

test('開場訊息只指向簡報檔，不夾帶內容 —— 否則會汙染新 session 的 context', () => {
  const scripts: string[] = []
  openSession(session(), '/h/briefs/sess-1.md', {
    term: 'iterm',
    runOsascript: (s) => void scripts.push(s),
  })
  assert.ok((scripts[0] ?? '').includes('讀 /h/briefs/sess-1.md 後接續'))
})

test('未知 adapter 讓 openSession 拋錯，而不是開一個亂七八糟的終端機', () => {
  assert.throws(
    () => openSession(session({ adapterId: 'unknown-cli' }), '/x.md', {
      term: 'terminal',
      runOsascript: () => assert.fail('不該走到這裡'),
    }),
    /不支援的 adapter/,
  )
})

test('defaultDeps 依 iTerm 是否存在挑終端機', () => {
  assert.equal(defaultDeps().term, existsSync('/Applications/iTerm.app') ? 'iterm' : 'terminal')
})

test('真的執行 osascript —— 用不碰任何應用程式的腳本，不會開視窗', () => {
  // 驗證的是 execFileSync 這段管線（路徑、逾時、stdio）本身能跑，
  // 腳本語法的正確性則由 script.test.ts 的 osacompile 負責。
  assert.doesNotThrow(() => defaultDeps().runOsascript('return 1'))
})

test('osascript 失敗時會拋錯，讓 helm open 的錯誤處理接得到', () => {
  assert.throws(() => defaultDeps().runOsascript('這不是 AppleScript ((('))
})
