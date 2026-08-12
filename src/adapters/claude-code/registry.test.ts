import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRegistry } from './registry.ts'
import { tempDir } from '../../temp-dir.ts'

function makeDir(files: Record<string, string>): string {
  const dir = tempDir('helm-reg-')
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body)
  }
  return dir
}

const VALID = JSON.stringify({
  pid: 60907,
  sessionId: 'f9810d2c-4c2c-474b-9dc9-05f0707a526f',
  cwd: '/Users/testuser/Acme/data-svc-2.0',
  startedAt: 1785996974955,
  procStart: 'Thu Aug  6 06:16:12 2026',
  version: '2.1.223',
  kind: 'interactive',
  entrypoint: 'cli',
  name: 'data-svc-2-0-26',
  status: 'busy',
  updatedAt: 1786416587966,
  statusUpdatedAt: 1786416587966,
})

test('讀出有效的註冊表項目', () => {
  const dir = makeDir({ '60907.json': VALID })
  const { entries, invalid } = readRegistry(dir)
  assert.equal(entries.length, 1)
  assert.equal(invalid, 0)
  assert.equal(entries[0]?.sessionId, 'f9810d2c-4c2c-474b-9dc9-05f0707a526f')
  assert.equal(entries[0]?.status, 'busy')
  assert.equal(entries[0]?.procStart, 'Thu Aug  6 06:16:12 2026')
})

test('未知欄位不會導致解析失敗（上游會新增欄位）', () => {
  const withExtra = JSON.stringify({ ...JSON.parse(VALID), brandNewField: 123 })
  const dir = makeDir({ '60907.json': withExtra })
  assert.equal(readRegistry(dir).entries.length, 1)
})

test('缺少 status 欄位時視為 null 而非丟棄', () => {
  const noStatus = JSON.parse(VALID)
  delete noStatus.status
  const dir = makeDir({ '1.json': JSON.stringify(noStatus) })
  const { entries, invalid } = readRegistry(dir)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.status, null)
  assert.equal(invalid, 0)
})

test('畸形 JSON 計入 invalid 而不拋錯', () => {
  const dir = makeDir({ 'a.json': VALID, 'b.json': '{ 壞掉的' })
  const { entries, invalid } = readRegistry(dir)
  assert.equal(entries.length, 1)
  assert.equal(invalid, 1)
})

test('缺少必要欄位計入 invalid', () => {
  const dir = makeDir({ 'a.json': JSON.stringify({ pid: 1 }) })
  const { entries, invalid } = readRegistry(dir)
  assert.equal(entries.length, 0)
  assert.equal(invalid, 1)
})

test('目錄不存在時回傳空結果而不拋錯', () => {
  const { entries, invalid } = readRegistry('/nonexistent/path/xyz')
  assert.deepEqual(entries, [])
  assert.equal(invalid, 0)
})

test('忽略非 .json 檔（例如 compaction-log.txt）', () => {
  const dir = makeDir({ 'a.json': VALID, 'compaction-log.txt': 'noise' })
  assert.equal(readRegistry(dir).entries.length, 1)
})

test('未知的 status 值降級為 null，不丟棄整筆 session', () => {
  const shellStatus = JSON.stringify({ ...JSON.parse(VALID), status: 'shell' })
  const dir = makeDir({ '60907.json': shellStatus })
  const { entries, invalid } = readRegistry(dir)
  assert.equal(entries.length, 1, '整筆 session 不該因為未知狀態值而消失')
  assert.equal(invalid, 0)
  assert.equal(entries[0]?.status, null)
  assert.equal(entries[0]?.sessionId, 'f9810d2c-4c2c-474b-9dc9-05f0707a526f')
})

test('status 是非字串型別時同樣降級為 null 而非丟棄', () => {
  const dir = makeDir({ '1.json': JSON.stringify({ ...JSON.parse(VALID), status: 42 }) })
  const { entries, invalid } = readRegistry(dir)
  assert.equal(entries.length, 1)
  assert.equal(invalid, 0)
  assert.equal(entries[0]?.status, null)
})
