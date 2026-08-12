import { test } from 'node:test'
import assert from 'node:assert/strict'
import { liveCodexCwds, type ProcessDeps } from './processes.ts'

/** Records what was asked, so a test can assert on what was *not* run. */
function deps(over: Partial<ProcessDeps> = {}): ProcessDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    pgrep: () => {
      calls.push('pgrep')
      return []
    },
    lsofCwds: () => {
      calls.push('lsof')
      return []
    },
    ...over,
  }
}

test('沒有 codex 在跑時回空集合 —— 那是最常見的狀態，不是錯誤', () => {
  assert.deepEqual([...liveCodexCwds(deps())], [])
})

test('行程數為 0 時不呼叫 lsof —— 省一次 spawn', () => {
  // 大多數時候沒有 codex 在跑，而這條路每 5 秒走一次。
  const d = deps()
  liveCodexCwds(d)
  assert.deepEqual(d.calls, ['pgrep'], 'lsof 不該被呼叫')
})

test('有行程時把它們的 cwd 收集起來', () => {
  const d = deps({
    pgrep: () => [101, 202],
    lsofCwds: (pids) => {
      assert.deepEqual(pids, [101, 202])
      return ['/Users/u/a', '/Users/u/b']
    },
  })
  assert.deepEqual([...liveCodexCwds(d)].sort(), ['/Users/u/a', '/Users/u/b'])
})

test('cwd 含空白也不會被切斷', () => {
  const d = deps({ pgrep: () => [1], lsofCwds: () => ['/Users/u/my project/sub dir'] })
  assert.deepEqual([...liveCodexCwds(d)], ['/Users/u/my project/sub dir'])
})

test('重複的 cwd 只算一次 —— 同一個目錄可以有多個 codex', () => {
  const d = deps({ pgrep: () => [1, 2, 3], lsofCwds: () => ['/a', '/a', '/b'] })
  assert.deepEqual([...liveCodexCwds(d)].sort(), ['/a', '/b'])
})

test('lsof 整個失敗時回空集合，不讓看板掛掉', () => {
  const d = deps({
    pgrep: () => [1],
    lsofCwds: () => {
      throw new Error('lsof: command not found')
    },
  })
  assert.deepEqual([...liveCodexCwds(d)], [])
})

test('pgrep 整個失敗時回空集合', () => {
  const d = deps({
    pgrep: () => {
      throw new Error('pgrep: command not found')
    },
  })
  assert.deepEqual([...liveCodexCwds(d)], [])
})

test('非絕對路徑的 cwd 一律丟掉', () => {
  // lsof 對權限不足的行程會印出殘缺的行。那些不該變成專案路徑。
  const d = deps({ pgrep: () => [1], lsofCwds: () => ['', 'relative', '/ok'] })
  assert.deepEqual([...liveCodexCwds(d)], ['/ok'])
})
