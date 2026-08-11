import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addHelmHook, hasHelmHook, removeHelmHook } from './settings.ts'
import { HOOK_MARKER } from './snippet.ts'

const CMD = `sh -c ': ${HOOK_MARKER}; true'`

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

test('解除安裝後的設定與安裝前逐字相同', () => {
  // 「30 秒內完全脫身」的意思是拿回一模一樣的檔案，不是「差不多」的檔案。
  // 這條同時鎖住兩件事：add 不得順手改寫別的欄位，remove 不得留下空的
  // hooks: {} 或 PreToolUse: [] 殘骸。
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
