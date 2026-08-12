import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveScannedDir } from './scan-dir.ts'
import type { PrefRead } from './defaults.ts'

const DEFAULT = '/h/Library/Application Support/App/widgets'
const resolve = (read: PrefRead) => resolveScannedDir(read, DEFAULT, 'Übersicht', 'widgetDir')

test('沒設定過時用預設資料夾，而且可以寫入偏好', () => {
  assert.deepEqual(resolve({ kind: 'unset' }), {
    dir: DEFAULT,
    adoptable: true,
    warning: null,
  })
})

test('app 已經選過資料夾時以它為準，而且絕不覆寫使用者的選擇', () => {
  const chosen = '/h/my-widgets'
  const r = resolve({ kind: 'set', value: chosen })
  assert.equal(r.dir, chosen)
  assert.equal(r.adoptable, false, '使用者選過的資料夾不該被改掉')
  assert.equal(r.warning, null)
})

test('讀不到設定時不寫、不猜，並且說出來', () => {
  // The distinction this whole type exists for: a transient read failure used
  // to look identical to "never configured", which licensed helm to overwrite
  // the folder the user chose — and every widget they had vanished at once.
  const r = resolve({ kind: 'unreadable', reason: 'ENOBUFS' })
  assert.equal(r.adoptable, false, '讀不到就不能假設沒設定過')
  assert.equal(r.dir, null, '不知道 app 在掃哪裡，就不該往任何地方寫')
  assert.match(r.warning ?? '', /ENOBUFS/)
  assert.match(r.warning ?? '', /widgetDir/)
})

test('相對路徑一律拒絕 —— 那會寫進使用者當下的工作目錄', () => {
  // `PluginDirectory` holding an array read back as the literal path "2", and
  // helm created ./2/ wherever the CLI happened to be run, then reported
  // success. A later `uninstall` from a different directory found nothing.
  for (const bad of ['2', 'my-plugins', './widgets', '../widgets', '']) {
    const r = resolve({ kind: 'set', value: bad })
    assert.equal(r.dir, null, `不該接受：${JSON.stringify(bad)}`)
    assert.equal(r.adoptable, false)
    assert.match(r.warning ?? '', /絕對路徑/)
  }
})

test('字面上的 ~ 不會被展開，所以也拒絕', () => {
  // `defaults write … '~/SwiftBar'` with quotes stores a literal tilde. Node
  // does not expand it, so helm would create a directory actually named "~".
  const r = resolve({ kind: 'set', value: '~/SwiftBar' })
  assert.equal(r.dir, null)
  assert.match(r.warning ?? '', /~/)
})

test('警告裡一定帶著 app 名稱與設定鍵，使用者才知道去哪裡改', () => {
  for (const read of [
    { kind: 'unreadable', reason: 'boom' } as const,
    { kind: 'set', value: 'relative' } as const,
  ]) {
    const w = resolve(read).warning ?? ''
    assert.match(w, /Übersicht/)
    assert.match(w, /widgetDir/)
  }
})
