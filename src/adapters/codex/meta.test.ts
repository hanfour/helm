import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadMetaCache, readMeta, resolveMeta } from './meta.ts'
import { tempDir } from '../../temp-dir.ts'

const SID = '019f40fa-de00-7f01-9f17-23f4771535c1'
const CWD = '/Users/u/project'

/** A first line shaped like the real thing, including the 18 KB of noise. */
const metaLine = (over: Record<string, unknown> = {}, huge = false) =>
  `${JSON.stringify({
    timestamp: '2026-08-03T06:25:24.937Z',
    type: 'session_meta',
    payload: {
      id: SID,
      cwd: CWD,
      cli_version: '0.146.0',
      ...(huge ? { base_instructions: { text: 'x'.repeat(18_000) } } : {}),
      ...over,
    },
  })}\n`

function rollout(body: string): string {
  const path = join(tempDir('helm-codex-'), 'rollout.jsonl')
  writeFileSync(path, body)
  return path
}

test('讀出 session id 與 cwd', () => {
  assert.deepEqual(readMeta(rollout(metaLine())), { sessionId: SID, cwd: CWD })
})

test('session_id 優先於 id —— 兩個都有時以前者為準', () => {
  const other = '019fc64c-6b8a-7882-8c7b-c019bd18484c'
  assert.equal(readMeta(rollout(metaLine({ session_id: other })))?.sessionId, other)
})

test('18 KB 的第一行讀得完 —— 真實檔案就是這麼大', () => {
  assert.deepEqual(readMeta(rollout(metaLine({}, true))), { sessionId: SID, cwd: CWD })
})

test('只認第一行，後面的內容不影響', () => {
  const body = metaLine() + `${JSON.stringify({ type: 'event_msg', payload: { cwd: '/evil' } })}\n`
  assert.equal(readMeta(rollout(body))?.cwd, CWD)
})

test('payload 的 14 種形狀都吃得下 —— 只取 id 與 cwd，其餘一律忽略', () => {
  // 實測 2026-04 到 2026-08 的 rollout 有 14 種 payload 形狀。
  // 依賴其他任何欄位都會在下一次 Codex 改版時斷掉。
  const shapes = [
    { agent_nickname: 'x', context_window: 1, history_mode: 'a', git: {} },
    { model_provider: 'OpenAI', originator: 'codex-tui', source: 'cli' },
    { forked_from_id: 'other', agent_path: '/p', multi_agent_version: 2 },
  ]
  for (const extra of shapes) {
    assert.deepEqual(readMeta(rollout(metaLine(extra))), { sessionId: SID, cwd: CWD }, JSON.stringify(extra))
  }
})

test('壞掉的第一行回 null，不讓整批失敗', () => {
  for (const body of ['', 'not json\n', '{}\n', '{"type":"event_msg"}\n', 'null\n', '[]\n']) {
    assert.equal(readMeta(rollout(body)), null, JSON.stringify(body))
  }
})

test('缺 id 或缺 cwd 時回 null', () => {
  assert.equal(readMeta(rollout(metaLine({ id: undefined }))), null)
  assert.equal(readMeta(rollout(metaLine({ cwd: undefined }))), null)
  assert.equal(readMeta(rollout(metaLine({ id: 123 }))), null)
})

test('cwd 不是絕對路徑時拒絕 —— 相對路徑會歸到執行目錄底下的專案', () => {
  for (const cwd of ['relative/path', '~/project', '', '.']) {
    assert.equal(readMeta(rollout(metaLine({ cwd }))), null, cwd)
  }
})

test('檔案讀不到時回 null', () => {
  assert.equal(readMeta(join(tempDir('helm-codex-'), 'nope.jsonl')), null)
})

test('快取命中時完全不碰檔案', () => {
  // 這是整個設計的重點：rollout 一旦寫好，它的 id 與 cwd 就不再改變，
  // 所以第二次之後應該零 I/O。用一個會爆炸的 reader 證明。
  const cache = loadMetaCache(join(tempDir('helm-codex-'), 'cache.json'))
  const boom = () => {
    throw new Error('不該讀檔')
  }
  const file = { rolloutId: 'r1', path: '/nope', startedAt: 0, mtimeMs: 0 }
  assert.deepEqual(resolveMeta(file, cache, () => ({ sessionId: SID, cwd: CWD })), { sessionId: SID, cwd: CWD })
  assert.deepEqual(resolveMeta(file, cache, boom), { sessionId: SID, cwd: CWD })
})

test('快取寫得出去也讀得回來，而且是原子的', () => {
  const path = join(tempDir('helm-codex-'), 'cache.json')
  const cache = loadMetaCache(path)
  const file = { rolloutId: 'r1', path: '/nope', startedAt: 0, mtimeMs: 0 }
  resolveMeta(file, cache, () => ({ sessionId: SID, cwd: CWD }))
  cache.flush()

  assert.equal(existsSync(path), true)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8'))['r1'], { sessionId: SID, cwd: CWD })
  const reloaded = loadMetaCache(path)
  assert.deepEqual(resolveMeta(file, reloaded, () => { throw new Error('不該讀檔') }), { sessionId: SID, cwd: CWD })
})

test('快取檔壞掉時當空的，不讓整個看板掛掉', () => {
  const path = join(tempDir('helm-codex-'), 'cache.json')
  for (const junk of ['not json', 'null', '[]', '42', '{"r1":"not an object"}']) {
    writeFileSync(path, junk)
    const cache = loadMetaCache(path)
    const file = { rolloutId: 'r1', path: '/nope', startedAt: 0, mtimeMs: 0 }
    assert.deepEqual(
      resolveMeta(file, cache, () => ({ sessionId: SID, cwd: CWD })),
      { sessionId: SID, cwd: CWD },
      junk,
    )
  }
})

test('讀不出來的檔案不會被反覆重讀 —— 否則每 5 秒付一次 25ms', () => {
  const cache = loadMetaCache(join(tempDir('helm-codex-'), 'cache.json'))
  const file = { rolloutId: 'r1', path: '/nope', startedAt: 0, mtimeMs: 0 }
  let reads = 0
  const reader = () => {
    reads++
    return null
  }
  assert.equal(resolveMeta(file, cache, reader), null)
  assert.equal(resolveMeta(file, cache, reader), null)
  assert.equal(reads, 1, '失敗也要記住')
})

test('沒有任何新東西時 flush 不寫檔 —— 不必每 5 秒動一次磁碟', () => {
  const path = join(tempDir('helm-codex-'), 'cache.json')
  const cache = loadMetaCache(path)
  cache.flush()
  assert.equal(existsSync(path), false)
})
