import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquireRefreshLock, releaseRefreshLock } from './lock.ts'
import { tempDir } from '../temp-dir.ts'

const NOW = Date.UTC(2026, 7, 12, 12, 0, 0)
const file = () => join(tempDir('helm-lock-'), 'refresh.lock')

test('沒有人持有時拿得到', () => {
  assert.equal(acquireRefreshLock(file(), NOW), true)
})

test('已經有人持有時拿不到 —— 否則每 5 秒 fork 一個 gh 出去', () => {
  // 看板每 5 秒跑一次，而一次 gh 要好幾秒。沒有這道鎖的話，
  // 一分鐘內會有十幾個 gh 行程同時在跑同一件事。
  const f = file()
  assert.equal(acquireRefreshLock(f, NOW), true)
  assert.equal(acquireRefreshLock(f, NOW + 1000), false)
})

test('放開之後別人拿得到', () => {
  const f = file()
  acquireRefreshLock(f, NOW)
  releaseRefreshLock(f)
  assert.equal(acquireRefreshLock(f, NOW + 1000), true)
})

test('持有者當掉時鎖會過期 —— 不能讓 PR 狀態永遠停在那一刻', () => {
  // 更新行程被 kill -9、機器休眠、gh 卡住：沒有過期的話，
  // 那個檔案會永遠擋著，而使用者只會看到 PR 狀態再也不更新。
  const f = file()
  acquireRefreshLock(f, NOW)
  assert.equal(acquireRefreshLock(f, NOW + 4 * 60_000), false, '四分鐘還算持有中')
  assert.equal(acquireRefreshLock(f, NOW + 6 * 60_000), true, '六分鐘後視為死掉')
})

test('鎖檔壞掉時當成沒鎖 —— 不讓一個壞檔擋住更新', () => {
  for (const junk of ['', 'not a number', '{}', 'NaN']) {
    const f = file()
    writeFileSync(f, junk)
    assert.equal(acquireRefreshLock(f, NOW), true, junk)
  }
})

test('未來的時間戳也視為死掉', () => {
  const f = file()
  writeFileSync(f, String(NOW + 3600_000))
  assert.equal(acquireRefreshLock(f, NOW), true)
})

test('放開一個不存在的鎖不會丟例外', () => {
  assert.doesNotThrow(() => releaseRefreshLock(file()))
})

test('拿到鎖之後檔案存在，放開之後不見', () => {
  const f = file()
  acquireRefreshLock(f, NOW)
  assert.equal(existsSync(f), true)
  releaseRefreshLock(f)
  assert.equal(existsSync(f), false)
})

test('接管之後，原持有者跑完不會刪掉接管者的鎖', () => {
  // A 拿鎖 → 停超過五分鐘 → B 合法接管 → A 終於跑完，finally 把 B 的鎖刪掉。
  // 實測那一次筆電休眠造成四個並行的 gh sweep。
  const f = file()
  assert.equal(acquireRefreshLock(f, NOW), true, 'A 拿到')
  const later = NOW + 6 * 60_000
  assert.equal(acquireRefreshLock(f, later), true, 'B 接管')
  releaseRefreshLock(f, NOW)
  assert.equal(acquireRefreshLock(f, later + 1000), false, 'B 的鎖還在')
})

test('自己的鎖放得掉', () => {
  const f = file()
  acquireRefreshLock(f, NOW)
  releaseRefreshLock(f, NOW)
  assert.equal(existsSync(f), false)
})

test('鎖檔權限是 0600 —— ~/.helm 是 world-readable', () => {
  const f = file()
  acquireRefreshLock(f, NOW)
  assert.equal(statSync(f).mode & 0o777, 0o600)
})
