import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { liveCodexCwds, matchesLive, type ProcessDeps } from './processes.ts'

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

test('cwd 比對要正規化 —— lsof 回的是 realpath，Codex 存的是字面路徑', () => {
  // 在 /tmp 或 $TMPDIR 開的 session：Codex 記 /tmp/x，lsof 回
  // /private/tmp/x。精確字串比對永遠對不上，正在跑的 Codex 被畫成已結束。
  // 本機 192 個 rollout 裡就有 4 個記著 /var/folders/… 這種非正規化路徑。
  // 這裡用 macOS 真實存在的 /tmp → /private/tmp symlink。
  const name = `helm-realpath-${process.pid}`
  const literal = join('/tmp', name)
  mkdirSync(literal, { recursive: true })
  try {
    const resolved = realpathSync(literal)
    assert.notEqual(resolved, literal, '前提：這台機器的 /tmp 是 symlink')
    const live = liveCodexCwds(deps({ pgrep: () => [1], lsofCwds: () => [resolved] }))
    assert.equal(matchesLive(live, literal), true, '字面路徑要對得上 realpath')
    assert.equal(matchesLive(live, resolved), true)
  } finally {
    rmSync(literal, { recursive: true, force: true })
  }
})

test('對不上的路徑不會被誤判成在跑', () => {
  const d = deps({ pgrep: () => [1], lsofCwds: () => ['/private/tmp/a'] })
  assert.equal(matchesLive(liveCodexCwds(d), '/tmp/definitely-not-that-one'), false)
})

test('路徑已經不存在時退回字面比對，不丟例外', () => {
  const d = deps({ pgrep: () => [1], lsofCwds: () => ['/gone/x'] })
  assert.equal(matchesLive(liveCodexCwds(d), '/gone/x'), true)
  assert.equal(matchesLive(liveCodexCwds(d), '/gone/y'), false)
})
