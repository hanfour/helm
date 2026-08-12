import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addHelmHook, hasHelmHook, removeHelmHook } from './settings.ts'
import { HOOK_MARKER } from './snippet.ts'

const CMD = `exec '/abs/node' --no-warnings '/repo/src/hook/record.mjs' '/h/live' '/h/e.log' # ${HOOK_MARKER}`

/** The shape the user's file actually has today: no hooks key at all. */
const REAL = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  theme: 'dark',
  permissions: { allow: ['Bash(npm test)'] },
  enabledPlugins: { 'everything-claude-code@ecc': true },
}

const FOREIGN = {
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other.js' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'other-stop.sh' }] }],
  },
}

test('沒有 hooks 鍵時會建出來，其餘設定原樣保留', () => {
  const out = addHelmHook(REAL, CMD)
  assert.equal(out['theme'], 'dark')
  assert.deepEqual(out['permissions'], REAL.permissions)
  assert.deepEqual(out['enabledPlugins'], REAL.enabledPlugins)
  assert.equal(hasHelmHook(out), true)
})

test('已有別人的 PreToolUse 時用附加而非覆蓋', () => {
  const out = addHelmHook(FOREIGN, CMD)
  const pre = (out['hooks'] as { PreToolUse: unknown[] }).PreToolUse
  assert.equal(pre.length, 2)
  assert.ok(JSON.stringify(pre).includes('node other.js'), '別人的 hook 不能消失')
})

test('其他事件的 hook 完全不動', () => {
  const out = addHelmHook(FOREIGN, CMD)
  assert.deepEqual((out['hooks'] as { Stop: unknown }).Stop, FOREIGN.hooks.Stop)
})

test('重複安裝不會裝出兩份', () => {
  const twice = addHelmHook(addHelmHook(REAL, CMD), CMD)
  assert.equal((twice['hooks'] as { PreToolUse: unknown[] }).PreToolUse.length, 1)
})

test('重複安裝會更新成新的指令字串 —— repo 搬家了要跟著換', () => {
  const twice = addHelmHook(addHelmHook(REAL, CMD), `sh -c ': ${HOOK_MARKER}; NEW'`)
  assert.ok(JSON.stringify(twice).includes('NEW'))
  assert.ok(!JSON.stringify(twice).includes("; true'"))
})

test('removeHelmHook 只拿掉自己的，別人的留著', () => {
  const out = removeHelmHook(addHelmHook(FOREIGN, CMD))
  const pre = (out['hooks'] as { PreToolUse: unknown[] }).PreToolUse
  assert.equal(pre.length, 1)
  assert.ok(JSON.stringify(pre).includes('node other.js'))
  assert.equal(hasHelmHook(out), false)
})

test('解除安裝後的設定結構與安裝前完全相同', () => {
  // 這一條比對的是解析後的物件：欄位、值與鍵的順序都不能變，add 不得順手
  // 改寫別的欄位，remove 不得留下空的 hooks: {} 或 PreToolUse: [] 殘骸。
  // 位元組層級的還原（縮排、換行）由 install.test.ts 的「保留原本的縮排」
  // 那一條負責 —— 兩者是不同的保證，不要混為一談。
  assert.deepEqual(removeHelmHook(addHelmHook(FOREIGN, CMD)), FOREIGN)
  assert.deepEqual(removeHelmHook(addHelmHook(REAL, CMD)), REAL)
})

test('沒裝過就解除安裝是 no-op，不丟錯', () => {
  assert.deepEqual(removeHelmHook(REAL), REAL)
  assert.deepEqual(removeHelmHook(FOREIGN), FOREIGN)
})

test('hooks 的值不是預期形狀時拒絕改寫，原樣回傳', () => {
  // 看不懂就不要動。硬寫進去會毀掉使用者手工維護的設定。
  const weird = { hooks: 'not an object' }
  assert.deepEqual(addHelmHook(weird, CMD), weird)
  assert.equal(hasHelmHook(addHelmHook(weird, CMD)), false)
})

test('settings 不是物件時不硬闖', () => {
  assert.equal(hasHelmHook(null), false)
  assert.equal(hasHelmHook('壞掉'), false)
  assert.equal(hasHelmHook([]), false)
})

test('addHelmHook 不修改輸入', () => {
  const input = structuredClone(FOREIGN)
  const snapshot = structuredClone(FOREIGN)
  addHelmHook(input, CMD)
  assert.deepEqual(input, snapshot)
})

test('removeHelmHook 不修改輸入', () => {
  const input = addHelmHook(structuredClone(FOREIGN), CMD)
  const snapshot = structuredClone(input)
  removeHelmHook(input)
  assert.deepEqual(input, snapshot)
})

test('hook 以 async 安裝 —— 它只負責記錄，永遠不該擋住工具呼叫', () => {
  const entry = ((addHelmHook(REAL, CMD)['hooks'] as {
    PreToolUse: { hooks: { async?: boolean }[] }[]
  }).PreToolUse[0]?.hooks[0])
  assert.equal(entry?.async, true)
})

test('只提到 marker 字串的第三方 hook 不會被誤刪', () => {
  // 一個「檢查 helm 是否已安裝」的稽核腳本是很自然的東西。用整組 JSON 做
  // 子字串比對會把它連同整組靜默刪掉，而且 uninstall 不備份，無法回復。
  const foreign = {
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{ type: 'command', command: `grep -q ${HOOK_MARKER} ~/.claude/settings.json` }],
      }],
    },
  }
  assert.equal(hasHelmHook(foreign), false)
  const installed = addHelmHook(foreign, CMD)
  assert.equal((installed['hooks'] as { PreToolUse: unknown[] }).PreToolUse.length, 2)
  assert.deepEqual(removeHelmHook(installed), foreign)
})

test('形狀像但不是 helm 寫的（沒有 marker）也不會被刪', () => {
  const foreign = {
    hooks: {
      PreToolUse: [{
        matcher: '*',
        hooks: [{ type: 'command', command: 'exec /abs/node --no-warnings /somewhere/else.mjs' }],
      }],
    },
  }
  assert.equal(hasHelmHook(foreign), false)
  assert.deepEqual(removeHelmHook(foreign), foreign)
})

test('hooks 底下無關事件的形狀不影響安裝 —— 只驗 PreToolUse', () => {
  // 舊的 schema 要求每個事件的每個項目都有 command: string，於是一個
  // { type: 'prompt' } 的 SessionStart hook 就讓所有人都裝不起來。
  // Claude Code 未來多一種 hook 形狀就會中。
  const foreign = {
    hooks: { SessionStart: [{ hooks: [{ type: 'prompt', prompt: 'hi' }] }] },
  }
  const out = addHelmHook(foreign, CMD)
  assert.equal(hasHelmHook(out), true)
  assert.deepEqual((out['hooks'] as { SessionStart: unknown }).SessionStart,
    foreign.hooks.SessionStart)
})

test('PreToolUse 本身形狀不對時仍然拒絕', () => {
  const weird = { hooks: { PreToolUse: 'not an array' } }
  assert.deepEqual(addHelmHook(weird, CMD), weird)
})

test('removeHelmHook 掃描所有事件，不只 PreToolUse', () => {
  // 使用者手動把 helm 的 group 複製到別的事件之後，那是一條仍在寫
  // ~/.helm/live 的活 hook，uninstall 必須看得到它。
  const installed = {
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: CMD }] }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: CMD }] }],
    },
  }
  const out = removeHelmHook(installed)
  assert.equal(JSON.stringify(out).includes(HOOK_MARKER), false)
})

test('hasHelmHook 也看得到非 PreToolUse 的殘留', () => {
  assert.equal(hasHelmHook({
    hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: CMD }] }] },
  }), true)
})
