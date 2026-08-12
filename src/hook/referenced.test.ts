import { test } from 'node:test'
import assert from 'node:assert/strict'
import { referencedPaths } from './referenced.ts'
import { buildHookCommand } from './snippet.ts'
import { buildWidget } from './widget.ts'

test('從 hook 指令抽出解譯器、recorder，以及它的輸出位置', () => {
  // 照實抽出全部，順序就是它們在指令裡的順序。要不要檢查某一個存在，
  // 是呼叫端的判斷 —— 錯誤紀錄那一個「不存在」才是正常狀態。
  const cmd = buildHookCommand('/h/.helm/live', '/h/.helm/e.log', '/repo/record.mjs', '/abs/node')
  assert.deepEqual(referencedPaths(cmd), [
    '/abs/node', '/repo/record.mjs', '/h/.helm/live', '/h/.helm/e.log',
  ])
})

test('從 wrapper 抽出釘住的 node 與進入點', () => {
  const wrapper = [
    '#!/bin/sh',
    "NODE='/abs/node'",
    '[ -x "$NODE" ] || NODE=node',
    `exec "$NODE" '/repo/src/cli/main.ts' "$@"`,
    '# HELM_LIVE_MARKER',
  ].join('\n')
  assert.deepEqual(referencedPaths(wrapper), ['/abs/node', '/repo/src/cli/main.ts'])
})

test('從 SwiftBar plugin 抽出它依賴的 wrapper', () => {
  // The plugin is two lines and does nothing itself — when the wrapper it
  // calls disappears, the menu bar goes to ⚠ and every doctor check stays
  // green, because they only ever looked at the plugin file.
  const plugin = "#!/bin/sh\nexec '/h/.local/bin/helm' menu\n# HELM_LIVE_MARKER\n"
  assert.deepEqual(referencedPaths(plugin), ['/h/.local/bin/helm'])
})

test('從 widget 抽出 command 裡的路徑', () => {
  const paths = referencedPaths(buildWidget(['/h/.local/bin/helm', 'status', '--json']))
  assert.ok(paths.includes('/h/.local/bin/helm'), paths.join(', '))
})

test('只抽絕對路徑 —— status、--json、menu 這些不是檔案', () => {
  assert.deepEqual(referencedPaths(`exec '/a/b' 'status' '--json' 'menu'`), ['/a/b'])
})

test('路徑含跳脫的單引號時還原成原樣', () => {
  // Everything helm writes goes through shellQuote, and a home directory
  // containing a quote is unusual but legal. Getting this wrong would make
  // doctor report a perfectly good install as broken.
  assert.deepEqual(referencedPaths(`exec '/Users/it'\\''s/node' '/r/x.mjs'`), [
    "/Users/it's/node",
    '/r/x.mjs',
  ])
})

test('同一個路徑出現多次只回報一次', () => {
  assert.deepEqual(referencedPaths(`'/a' '/a' '/b'`), ['/a', '/b'])
})

test('沒有引號路徑時回空陣列，不丟例外', () => {
  for (const s of ['', 'exec node main.ts', '# comment only']) {
    assert.deepEqual(referencedPaths(s), [], JSON.stringify(s))
  }
})
