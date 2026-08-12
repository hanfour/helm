# helm P3 選單列常駐看板實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓看板從「想到才去敲指令」變成選單列上一直看得到的東西，並補上唯一無法從磁碟取得的資訊 —— 此刻正卡在哪個工具呼叫。

**Architecture:** 沿用掃描式架構，不引入 daemon。新增一個 `PreToolUse` hook，用單一 `sh -c` 把「此刻在跑什麼」覆寫進 `~/.helm/live/<session_id>.json`；SwiftBar 每 5 秒呼叫 `helm menu`，後者只走既有的快速路徑並輸出 SwiftBar 格式。安裝與解除安裝是本期的一級交付物 —— 這是唯一會去動使用者 `~/.claude/settings.json` 的一期。

**Tech Stack:** 與 P1/P2 相同（TypeScript on Node 24、`node:test`、`zod`）。新增外部相依：SwiftBar（使用者自行以 `brew install --cask swiftbar` 安裝，helm 不代為安裝）。

## Global Constraints

`docs/superpowers/plans/2026-08-11-helm-p1-p2-core-cli.md` 的 Global Constraints **全部繼續適用**（不可變性、檔案 200–400 行、函式 < 50 行、80% 覆蓋率、zod 邊界驗證、降級必須帶理由註解且可見、不硬編路徑、Node ≥ 24、commit 格式、程式碼英文／使用者文案繁中）。以下為 P3 追加：

- **hook 絕不可擋住工具呼叫**：`PreToolUse` hook 回傳非零會阻擋該次工具執行。hook 腳本**任何路徑都必須以 `exit 0` 結束**，這是硬性安全要求，每個 task 的測試都要涵蓋。
- **hook 是「絕不靜默吞錯」原則的唯一豁免**（規格 §12）：它跑在關鍵路徑上，錯誤一律靜默並寫入 `~/.helm/hook-errors.log`，由 `helm doctor` 主動回報。豁免僅限 hook 腳本本身，helm 的 TypeScript 程式碼不適用。
- **hook 只准 spawn 一次**：不得呼叫 `date`、`mkdir`、`jq`、`node` 或任何外部指令。所有解析用 shell 參數展開與 `case` 完成。目錄由安裝器預先建立。
- **絕不覆寫使用者的 `~/.claude/settings.json`**：一律先備份、再以「附加」方式改寫。使用者現有 hook 由 `everything-claude-code` plugin 提供（plugin hook 與 settings.json hook 由 Claude Code 各自載入，不會互相覆蓋），安裝後兩者必須共存。
- **`helm menu` 效能契約 200ms**（規格 §11.2）：只走快速路徑，絕不讀 transcript、絕不發網路請求、絕不呼叫 LLM。以自動化測試強制。
- **可 30 秒內完全脫身**：`helm uninstall` 必須能還原到安裝前的狀態，且 `HELM_OFF=1` 能立即讓 hook no-op 而不必解除安裝。

**規格書**：`docs/superpowers/specs/2026-08-11-helm-design.md`。本計畫涵蓋其 §15 的 P3，對應 §4.3、§11.1、§11.2、§12。

---

## 前置實測（2026-08-11，撰寫計畫時已完成，實作時不必重跑）

**一、hook 的 stdin 欄位名稱**（自 `everything-claude-code` plugin 的 hook 腳本反查確認）：

```jsonc
{"session_id":"...", "transcript_path":"...", "cwd":"...",
 "hook_event_name":"PreToolUse", "tool_name":"Bash",
 "tool_input":{"command":"npm test","description":"..."}}
```

**二、`~/.claude/settings.json` 目前沒有 `hooks` 鍵**。頂層鍵為 `$schema`、`cleanupPeriodDays`、`env`、`permissions`、`enabledPlugins`、`language`、`alwaysThinkingEnabled`、`effortLevel`、`tui`、`skipWorkflowUsageWarning`、`theme`、`skipAutoPermissionPrompt`、`feedbackSurveyState`。安裝器要能處理「鍵不存在」與「鍵已存在且有別人的項目」兩種情況。

**三、hook 設定的格式**（自現有 plugin 的 `hooks/hooks.json` 確認）：

```jsonc
{"hooks": {"PreToolUse": [
  {"matcher": "*", "hooks": [{"type": "command", "command": "..."}], "description": "..."}
]}}
```

**四、SwiftBar 未安裝**（`/Applications/SwiftBar.app` 不存在，`swiftbar` 不在 PATH）。

**五、hook 腳本原型已跑過並修正兩個缺陷**，數字如下（本機 200 次穩態）：

| 做法 | 每次成本 |
|---|---|
| 純 spawn 下限 `sh -c true` | 6.72 ms |
| **本計畫的 hook（單一 spawn）** | **7.35 ms** |

實際工作僅 0.63 ms，其餘為 macOS spawn 的不可壓下限。以每 turn 15 次工具呼叫計，代價約 **110 ms/turn**。

原型抓到的兩個缺陷，**實作時務必保留對應的防線**：

1. **`mkdir -p` 是第二個 spawn**，會把成本從 7.35ms 推到 9.86ms。改由安裝器預先建立 `~/.helm/live`，hook 不建目錄。
2. **`tool_input` 內含跳脫引號會產生不合法的 JSON**。`${C%%\"*}` 會在跳脫引號的 `"` 處截斷，留下結尾的反斜線，`{"summary":"echo \"}` 無法解析 —— 於是每一次當機判定都會靜默失效。防線：截出來的片段只要含反斜線就整個丟棄，改寫空字串。**失敗要往「沒有資訊」倒，不能往「壞資料」倒。**

---

## File Structure

```
helm/
  src/
    hook/
      snippet.ts          # 產生 hook 指令字串（純函式）（Task 1）
      settings.ts         # ~/.claude/settings.json 的安全讀改寫（純函式）（Task 2）
      install.ts          # 實際落地：備份、寫檔、建目錄、wrapper、SwiftBar plugin（Task 2）
      health.ts           # doctor 的檢查項目與 live 檔清理（Task 3）
    render/
      swiftbar.ts         # SwiftBar 格式輸出（純函式）（Task 5）
    cli/
      install.ts          # helm install / helm uninstall（Task 2）
      doctor.ts           # helm doctor（Task 3）
      prefs.ts            # helm pin / hide / show（Task 4）
      menu.ts             # helm menu（Task 5）
      test-helpers.ts     # CLI 測試共用的假 home 與輸出捕捉（附錄 A，Task 2 起）
```

hook 的 stdin 樣本刻意**不**放進 `fixtures/` —— 每個測試在自己那行組出要餵的 payload，讀測試的人一眼就知道這一條在測什麼形狀的輸入，不必翻到另一個檔案去對照。

**要修改的既有檔案**：

- `src/reconcile/live.ts`：`ts` 改由檔案 mtime 決定（Task 1）
- `src/paths.ts`：新增 `claudeSettings`、`hookErrorsLog`、`backupsDir`（Task 2）
- `src/cli/main.ts`：註冊 `install`／`uninstall`／`doctor`／`pin`／`hide`／`show`／`menu`（各 task）
- `src/render/table.ts`：`helm doctor` 存在後，警告文案不再是空頭支票（Task 3）

測試檔與被測檔並置。

---

## Task 1: hook 片段與 live 檔契約

hook 是本期唯一跑在使用者關鍵路徑上的程式碼。它的正確性標準與其他模組不同：**寧可什麼都不寫，也不能寫出壞資料或擋住工具呼叫**。

**Files:**
- Create: `src/hook/snippet.ts`, `src/hook/snippet.test.ts`
- Create: `fixtures/hook-payloads/*.json`
- Modify: `src/reconcile/live.ts`, `src/reconcile/live.test.ts`

**Interfaces:**
- Consumes: `LiveMarker` from `src/types.ts`；`HelmPaths` from `src/paths.ts`
- Produces:
  - `HOOK_MARKER: string` —— 嵌在指令字串裡的識別字，解除安裝時據以找出自己的項目
  - `buildHookCommand(liveDir: string, errorsLog: string): string`
  - `HOOK_SCRIPT: string` —— 純 shell 片段，不含 `sh -c` 外殼，供測試直接餵給 `sh`
  - `readLiveMarker` 簽章不變，但 `ts` 改為檔案 mtime

### 為什麼時間戳不由 hook 寫

規格 §4.3 要求單一 spawn，但 POSIX sh 沒有取得 epoch 的 builtin（macOS `/bin/sh` 是 bash 3.2，沒有 `$EPOCHSECONDS`），寫時間戳就得呼叫 `date`，那就是第二個 spawn。

**改由檔案 mtime 提供**：hook 寫入 `"ts":0`，`readLiveMarker` 讀取時以 `statSync().mtimeMs` 覆蓋。兩者指的是同一個瞬間，而 mtime 精度更好、也不必在 shell 裡格式化時間。§6 真值表用的是「live 檔時間戳晚於 transcript 末筆」，語意完全不變。

- [ ] **Step 1: 寫 hook 片段的失敗測試**

建立 `src/hook/snippet.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOOK_MARKER, HOOK_SCRIPT, buildHookCommand } from './snippet.ts'

interface Run {
  code: number
  written: Record<string, unknown> | null
}

/** Feeds a payload to the real shell, exactly as Claude Code would. */
function runHook(payload: string, opts: { liveDir?: string; off?: boolean } = {}): Run {
  const live = opts.liveDir ?? mkdtempSync(join(tmpdir(), 'helm-hook-'))
  let code = 0
  try {
    execFileSync('sh', ['-c', HOOK_SCRIPT], {
      input: payload,
      env: { ...process.env, HELM_LIVE: live, ...(opts.off === true ? { HELM_OFF: '1' } : {}) },
      stdio: ['pipe', 'ignore', 'ignore'],
    })
  } catch (err) {
    code = (err as { status?: number }).status ?? -1
  }
  const files = safeReaddir(live)
  const first = files[0]
  return {
    code,
    written: first === undefined
      ? null
      : JSON.parse(readFileSync(join(live, first), 'utf8')) as Record<string, unknown>,
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
}

const ID = 'abc12345-0000-1111-2222-333344445555'
const bash = (command: string) =>
  JSON.stringify({ session_id: ID, tool_name: 'Bash', tool_input: { command } })

test('一般 Bash 呼叫寫出 sessionId、toolName 與指令摘要', () => {
  const r = runHook(bash('npm test'))
  assert.equal(r.code, 0)
  assert.deepEqual(r.written, { sessionId: ID, ts: 0, toolName: 'Bash', summary: 'npm test' })
})

test('Write 之類的工具改用 file_path 當摘要', () => {
  const r = runHook(JSON.stringify({
    session_id: ID, tool_name: 'Write', tool_input: { file_path: '/tmp/a.txt', content: 'x' },
  }))
  assert.equal((r.written as { summary: string }).summary, '/tmp/a.txt')
})

test('指令含跳脫引號時降級成空摘要，絕不寫出壞 JSON', () => {
  // 這是原型實測抓到的缺陷：${C%%\"*} 會在跳脫引號處截斷並留下結尾反斜線，
  // 產生 {"summary":"echo \"} —— 解析失敗即代表當機判定靜默失效。
  const r = runHook(bash('echo "hi" && ls'))
  assert.equal((r.written as { summary: string }).summary, '')
  assert.equal((r.written as { toolName: string }).toolName, 'Bash')
})

test('指令含換行時同樣降級成空摘要', () => {
  const r = runHook(bash('a\nb'))
  assert.equal((r.written as { summary: string }).summary, '')
})

test('tool_input 內容假冒 session_id 不影響檔名 —— 取第一個出現的', () => {
  const r = runHook(JSON.stringify({
    session_id: ID, tool_name: 'Write',
    tool_input: { file_path: '/tmp/a.txt', content: '"session_id":"EVIL"' },
  }))
  assert.equal((r.written as { sessionId: string }).sessionId, ID)
})

test('session_id 不像 UUID 時什麼都不寫，也不報錯', () => {
  const r = runHook(JSON.stringify({ session_id: '../../etc/passwd', tool_name: 'Bash' }))
  assert.equal(r.code, 0)
  assert.equal(r.written, null)
})

test('完全沒有 session_id 的畸形輸入不寫檔且 exit 0', () => {
  const r = runHook(JSON.stringify({ tool_name: 'Bash' }))
  assert.equal(r.code, 0)
  assert.equal(r.written, null)
})

test('tool_name 含奇怪字元時退為 unknown，不讓它進到 JSON', () => {
  const r = runHook(JSON.stringify({ session_id: ID, tool_name: 'Ba"sh', tool_input: {} }))
  assert.equal((r.written as { toolName: string }).toolName, 'unknown')
})

test('HELM_OFF=1 時完全 no-op', () => {
  const r = runHook(bash('npm test'), { off: true })
  assert.equal(r.code, 0)
  assert.equal(r.written, null)
})

test('live 目錄不存在時仍 exit 0 —— 非零會擋住使用者的工具呼叫', () => {
  const r = runHook(bash('npm test'), { liveDir: join(tmpdir(), 'helm-hook-does-not-exist') })
  assert.equal(r.code, 0)
})

test('buildHookCommand 產出可直接放進 settings.json 的單行指令', () => {
  const cmd = buildHookCommand('/h/.helm/live', '/h/.helm/hook-errors.log')
  assert.ok(cmd.startsWith('sh -c '))
  assert.ok(cmd.includes(HOOK_MARKER), '必須帶識別字，解除安裝才找得到自己')
  assert.ok(!cmd.includes('\n'), 'settings.json 裡的指令必須是單行')
})

test('buildHookCommand 產出的指令真的能跑', () => {
  const live = mkdtempSync(join(tmpdir(), 'helm-hook-'))
  const log = join(live, 'errors.log')
  execFileSync('sh', ['-c', buildHookCommand(live, log)], {
    input: bash('npm test'), stdio: ['pipe', 'ignore', 'ignore'],
  })
  assert.equal(safeReaddir(live).length, 1)
})

test('hook 不 spawn 任何外部指令 —— date/mkdir/jq/node 都不得出現', () => {
  for (const forbidden of ['date', 'mkdir', 'jq', 'node', 'cat', 'sed', 'awk', 'grep']) {
    assert.ok(
      !new RegExp(`\\b${forbidden}\\b`).test(HOOK_SCRIPT),
      `hook 出現了外部指令 ${forbidden}，會多一次 spawn`,
    )
  }
})
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test src/hook/snippet.test.ts`
Expected: FAIL，找不到模組 `./snippet.ts`

- [ ] **Step 3: 實作 snippet.ts**

```ts
/**
 * Embedded in the command string so `helm uninstall` can find helm's own
 * hook entry without pattern-matching on paths that may have moved.
 */
export const HOOK_MARKER = 'HELM_LIVE_MARKER'

/**
 * Runs before every tool call on the user's machine, so the rules here are
 * stricter than anywhere else in helm:
 *
 *   1. Every path exits 0. A non-zero PreToolUse hook blocks the tool call —
 *      a bug here would stop the user working, which is the exact opposite of
 *      what this board is for.
 *   2. One spawn only. No `date`, no `mkdir`, no `jq`. Measured: the shell
 *      itself costs 6.72 ms and this script adds 0.63 ms; calling `mkdir -p`
 *      alone pushed it to 9.86 ms.
 *   3. Anything doubtful is dropped rather than guessed. A malformed live
 *      file is worse than no live file: `readLiveMarker` would reject it and
 *      crash detection would silently stop working.
 *
 * The timestamp is deliberately written as 0 — POSIX sh has no builtin for
 * the epoch, and the file's own mtime is the same instant with better
 * precision (see `readLiveMarker`).
 */
export const HOOK_SCRIPT = [
  `: ${HOOK_MARKER}`,
  'IFS= read -r L',
  '[ "${HELM_OFF:-0}" = 1 ] && exit 0',
  'S=${L#*\\"session_id\\":\\"}',
  'S=${S%%\\"*}',
  'case $S in [0-9a-fA-F]*-*-*-*-*) ;; *) exit 0 ;; esac',
  'T=${L#*\\"tool_name\\":\\"}',
  'T=${T%%\\"*}',
  "case $T in '' | *[!A-Za-z0-9_]*) T=unknown ;; esac",
  'C=',
  'case $L in',
  '  *\'"command":"\'*) C=${L#*\\"command\\":\\"}; C=${C%%\\"*} ;;',
  '  *\'"file_path":"\'*) C=${L#*\\"file_path\\":\\"}; C=${C%%\\"*} ;;',
  'esac',
  // A backslash means the extraction stopped inside a JSON escape sequence.
  // Keeping it would emit `{"summary":"echo \"}` — unparseable, and the user
  // would never be told their crash detection had quietly stopped working.
  'case $C in *\\\\*) C= ;; esac',
  'printf \'{"sessionId":"%s","ts":0,"toolName":"%s","summary":"%s"}\\n\' "$S" "$T" "$C" > "$HELM_LIVE/$S.json"',
  'exit 0',
].join('\n')

/**
 * One line, because settings.json holds it as a JSON string. Errors are
 * appended to the log rather than shown: this is the single exemption to the
 * project's no-silent-failure rule (spec §12), and `helm doctor` is the
 * compensation that keeps it honest.
 */
export function buildHookCommand(liveDir: string, errorsLog: string): string {
  const script = HOOK_SCRIPT.split('\n').join('; ').replace(/; ;;/g, ' ;;')
  return `sh -c ${shellQuote(`HELM_LIVE=${liveDir}; { ${script}; } 2>>${errorsLog}`)}`
}

function shellQuote(s: string): string {
  return `'${s.split("'").join(`'\\''`)}'`
}
```

**實作注意**：`HOOK_SCRIPT` 是多行、`buildHookCommand` 要壓成單行，兩者的 `case ... esac` 在壓行後必須仍然合法。上面的 `replace` 只是起點 —— **以 Step 1 的「buildHookCommand 產出的指令真的能跑」那個測試為準**，跑不過就改壓行方式（例如改用 `if` 取代 `case`，或直接把 `HOOK_SCRIPT` 就寫成單行、多行版本由它 split 產生）。不要為了好看而犧牲可執行性。

- [ ] **Step 4: 執行測試確認通過**

Run: `node --test src/hook/snippet.test.ts`
Expected: PASS，13 個測試全過

- [ ] **Step 5: 讓 live 檔的時間戳改用 mtime**

修改 `src/reconcile/live.ts`：

```ts
import { readFileSync, statSync } from 'node:fs'
```

`LiveSchema` 的 `ts` 改為 `z.number().default(0)`，並在回傳處覆蓋：

```ts
    const file = join(liveDir, `${sessionId}.json`)
    const raw = readFileSync(file, 'utf8')
    const parsed = LiveSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return null
    const d = parsed.data
    return {
      sessionId: d.sessionId,
      // The hook writes 0: POSIX sh has no builtin for the epoch, and adding
      // `date` would double the spawn cost of every tool call. The file's own
      // mtime is the same instant, measured by the kernel.
      ts: statSync(file).mtimeMs,
      toolName: d.toolName,
      summary: d.summary.slice(0, MAX_SUMMARY),
    }
```

- [ ] **Step 6: 補 live.ts 的測試**

追加到 `src/reconcile/live.test.ts`：

```ts
test('ts 取檔案 mtime，而不是檔案內容裡的 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-live-'))
  const before = Date.now()
  writeFileSync(join(dir, 'sess-1.json'),
    '{"sessionId":"sess-1","ts":0,"toolName":"Bash","summary":"npm test"}\n')
  const marker = readLiveMarker(dir, 'sess-1')
  assert.ok((marker?.ts ?? 0) >= before - 2000)
  assert.ok((marker?.ts ?? 0) <= Date.now() + 2000)
})

test('hook 寫出的內容能被 readLiveMarker 直接吃下', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-live-'))
  execFileSync('sh', ['-c', HOOK_SCRIPT], {
    input: JSON.stringify({
      session_id: 'aaaa1111-0000-1111-2222-333344445555',
      tool_name: 'Bash', tool_input: { command: 'npm test' },
    }),
    env: { ...process.env, HELM_LIVE: dir },
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  const marker = readLiveMarker(dir, 'aaaa1111-0000-1111-2222-333344445555')
  assert.equal(marker?.toolName, 'Bash')
  assert.equal(marker?.summary, 'npm test')
})
```

第二個測試是本 task 最重要的一個：它讓 shell 那端與 TypeScript 這端的契約有東西守著。兩邊分開改的時候，只有它會出聲。

- [ ] **Step 7: 執行完整檢查**

Run: `bash scripts/check.sh`
Expected: 型別檢查無誤、全部測試通過

- [ ] **Step 8: Commit**

```bash
git add src/hook/ src/reconcile/live.ts src/reconcile/live.test.ts
git commit -m "feat: PreToolUse hook 片段與 live 檔契約"
```

---

## Task 2: `helm install` 與 `helm uninstall`

這是整個專案唯一會去改使用者既有設定檔的地方。標準相應提高：**先備份、只附加、可逆、且解除安裝後 settings.json 要跟安裝前一模一樣**。

**Files:**
- Create: `src/hook/settings.ts`, `src/hook/settings.test.ts`
- Create: `src/hook/install.ts`, `src/hook/install.test.ts`
- Create: `src/cli/install.ts`, `src/cli/install.test.ts`
- Modify: `src/paths.ts`, `src/paths.test.ts`, `src/cli/main.ts`

**Interfaces:**
- Consumes: `HOOK_MARKER`, `buildHookCommand` from Task 1；`HelmPaths` from `src/paths.ts`
- Produces:
  - `HelmPaths` 新增 `claudeSettings: string`、`hookErrorsLog: string`、`backupsDir: string`
  - `interface SettingsFile { hooks?: { PreToolUse?: HookGroup[] } & Record<string, unknown> }` 與 `Record<string, unknown>` 其餘欄位原樣保留
  - `addHelmHook(settings: unknown, command: string): Record<string, unknown>`
  - `removeHelmHook(settings: unknown): Record<string, unknown>`
  - `hasHelmHook(settings: unknown): boolean`
  - `installHook(paths: HelmPaths, deps: InstallDeps): InstallReport`
  - `uninstallHook(paths: HelmPaths, deps: InstallDeps): InstallReport`
  - `interface InstallDeps { now: () => number; repoRoot: string }`
  - `interface InstallReport { steps: string[]; warnings: string[] }`
  - `runInstall(argv: readonly string[]): number`、`runUninstall(argv: readonly string[]): number`

### 三件要裝的東西

| 東西 | 位置 | 為什麼需要 |
|---|---|---|
| hook 設定 | `~/.claude/settings.json` 的 `hooks.PreToolUse` | 採集「此刻在跑什麼」 |
| `helm` 執行檔 | `~/.local/bin/helm`（wrapper script） | SwiftBar plugin 與使用者都要能直接打 `helm` |
| SwiftBar plugin | `~/Library/Application Support/SwiftBar/helm.5s.sh` | 每 5 秒呼叫 `helm menu` |

wrapper 用腳本而非 symlink：`node` 需要看到 `.ts` 副檔名才會剝型別，一個叫 `helm` 的 symlink 指向 `main.ts` 會讓 Node 認不出來。腳本則明確：

```sh
#!/bin/sh
exec node "<repoRoot>/src/cli/main.ts" "$@"
```

SwiftBar plugin 內容一樣走絕對路徑 —— SwiftBar 執行 plugin 時的 PATH 很精簡，`~/.local/bin` 未必在裡面：

```sh
#!/bin/sh
exec "<repoRoot>/../.local/bin/helm" menu
```

實作時直接用 `paths` 算出的 wrapper 絕對路徑，不要相依 PATH。

- [ ] **Step 1: 寫 settings.ts 的失敗測試**

建立 `src/hook/settings.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addHelmHook, hasHelmHook, removeHelmHook } from './settings.ts'
import { HOOK_MARKER } from './snippet.ts'

const CMD = `sh -c ': ${HOOK_MARKER}; true'`

/** What the user's file actually looks like today: no hooks key at all. */
const REAL = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  theme: 'dark',
  permissions: { allow: ['Bash(npm test)'] },
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
  const once = addHelmHook(REAL, CMD)
  const twice = addHelmHook(once, CMD)
  const pre = (twice['hooks'] as { PreToolUse: unknown[] }).PreToolUse
  assert.equal(pre.length, 1)
})

test('重複安裝會更新成新的指令字串 —— 路徑換了要跟著換', () => {
  const once = addHelmHook(REAL, CMD)
  const twice = addHelmHook(once, `sh -c ': ${HOOK_MARKER}; NEW'`)
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
  // 30 秒內完全脫身：使用者必須拿回一模一樣的檔案，不是「差不多」的檔案。
  assert.deepEqual(removeHelmHook(addHelmHook(FOREIGN, CMD)), FOREIGN)
  assert.deepEqual(removeHelmHook(addHelmHook(REAL, CMD)), REAL)
})

test('沒裝過就解除安裝是 no-op，不丟錯', () => {
  assert.deepEqual(removeHelmHook(REAL), REAL)
})

test('settings 不是物件時不硬闖 —— 回傳原值讓上層報錯', () => {
  assert.equal(hasHelmHook(null), false)
  assert.equal(hasHelmHook('壞掉'), false)
})

test('addHelmHook 不修改輸入', () => {
  const input = structuredClone(FOREIGN)
  const snapshot = structuredClone(FOREIGN)
  addHelmHook(input, CMD)
  assert.deepEqual(input, snapshot)
})
```

「解除安裝後逐字相同」那個測試是本 task 的核心。它同時鎖住兩件事：`addHelmHook` 不得順手改寫別的欄位，`removeHelmHook` 不得留下空的 `hooks: {}` 殘骸。

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test src/hook/settings.test.ts`
Expected: FAIL，找不到模組 `./settings.ts`

- [ ] **Step 3: 實作 settings.ts**

```ts
import { z } from 'zod'
import { HOOK_MARKER } from './snippet.ts'

const HookEntry = z.object({ type: z.string(), command: z.string() }).passthrough()
const HookGroup = z.object({
  matcher: z.string().optional(),
  hooks: z.array(HookEntry).default([]),
}).passthrough()

const SettingsSchema = z.object({
  hooks: z.record(z.string(), z.array(HookGroup)).optional(),
}).passthrough()

type Settings = Record<string, unknown>

const DESCRIPTION = 'helm —— 記錄此刻正在執行的工具'

/**
 * Never rewrites the file wholesale. The user's settings.json is theirs, and
 * it already carries a plugin's worth of configuration; helm adds exactly one
 * entry and must be able to take exactly that one entry back out.
 */
export function addHelmHook(settings: unknown, command: string): Settings {
  const parsed = SettingsSchema.safeParse(settings)
  if (!parsed.success) return asRecord(settings)
  const base = asRecord(settings)
  const hooks = (base['hooks'] ?? {}) as Record<string, unknown[]>
  const existing = (hooks['PreToolUse'] ?? []) as unknown[]
  return {
    ...base,
    hooks: {
      ...hooks,
      PreToolUse: [
        ...existing.filter((g) => !isHelmGroup(g)),
        { matcher: '*', hooks: [{ type: 'command', command }], description: DESCRIPTION },
      ],
    },
  }
}

/**
 * Leaves the file byte-identical to how it was before install: an empty
 * PreToolUse array or an empty hooks object would be residue, and residue is
 * how "uninstall" quietly becomes "mostly uninstall".
 */
export function removeHelmHook(settings: unknown): Settings {
  const base = asRecord(settings)
  const hooks = base['hooks']
  if (!isRecord(hooks)) return base
  const existing = Array.isArray(hooks['PreToolUse']) ? hooks['PreToolUse'] : []
  const kept = existing.filter((g) => !isHelmGroup(g))
  const nextHooks = kept.length > 0
    ? { ...hooks, PreToolUse: kept }
    : omit(hooks, 'PreToolUse')
  return Object.keys(nextHooks).length > 0
    ? { ...base, hooks: nextHooks }
    : omit(base, 'hooks')
}

export function hasHelmHook(settings: unknown): boolean {
  const hooks = asRecord(settings)['hooks']
  if (!isRecord(hooks)) return false
  const pre = hooks['PreToolUse']
  return Array.isArray(pre) && pre.some(isHelmGroup)
}

/** Matches on the embedded marker, not on paths — the repo may have moved. */
function isHelmGroup(group: unknown): boolean {
  return JSON.stringify(group ?? null).includes(HOOK_MARKER)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asRecord(v: unknown): Settings {
  return isRecord(v) ? v : {}
}

function omit(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key))
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `node --test src/hook/settings.test.ts`
Expected: PASS，10 個測試全過

- [ ] **Step 5: 新增路徑**

修改 `src/paths.ts` 的 `HelmPaths` 與 `resolvePaths`：

```ts
  claudeSettings: string
  hookErrorsLog: string
  backupsDir: string
```

```ts
    claudeSettings: join(claudeHome, 'settings.json'),
    hookErrorsLog: join(helmHome, 'hook-errors.log'),
    backupsDir: join(helmHome, 'backups'),
```

追加到 `src/paths.test.ts`：

```ts
test('新增的三個路徑都掛在正確的家目錄底下', () => {
  const p = resolvePaths({ home: '/h' })
  assert.equal(p.claudeSettings, '/h/.claude/settings.json')
  assert.equal(p.hookErrorsLog, '/h/.helm/hook-errors.log')
  assert.equal(p.backupsDir, '/h/.helm/backups')
})

test('claudeHome override 也會帶著 settings.json 走', () => {
  assert.equal(resolvePaths({ home: '/h', claudeHome: '/c' }).claudeSettings, '/c/settings.json')
})
```

- [ ] **Step 6: 寫 install.ts 的失敗測試**

建立 `src/hook/install.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePaths } from '../paths.ts'
import { installHook, uninstallHook } from './install.ts'
import { hasHelmHook } from './settings.ts'

const DEPS = { now: () => 1786000000000, repoRoot: '/repo' }

function home(settings?: object): string {
  const h = mkdtempSync(join(tmpdir(), 'helm-install-'))
  mkdirSync(join(h, '.claude'), { recursive: true })
  if (settings !== undefined) {
    writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify(settings, null, 2))
  }
  return h
}

const readSettings = (h: string) =>
  JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8')) as unknown

test('安裝會寫入 hook 設定', () => {
  const h = home({ theme: 'dark' })
  installHook(resolvePaths({ home: h }), DEPS)
  assert.equal(hasHelmHook(readSettings(h)), true)
})

test('安裝前先備份，備份內容是安裝前的原始檔', () => {
  const h = home({ theme: 'dark' })
  installHook(resolvePaths({ home: h }), DEPS)
  const backups = readdirSync(join(h, '.helm', 'backups'))
  assert.equal(backups.length, 1)
  assert.deepEqual(
    JSON.parse(readFileSync(join(h, '.helm', 'backups', backups[0] as string), 'utf8')),
    { theme: 'dark' },
  )
})

test('安裝會預先建立 live 目錄 —— hook 不建目錄，多一次 spawn 太貴', () => {
  const h = home({})
  installHook(resolvePaths({ home: h }), DEPS)
  assert.ok(statSync(join(h, '.helm', 'live')).isDirectory())
})

test('安裝會寫出可執行的 helm wrapper', () => {
  const h = home({})
  installHook(resolvePaths({ home: h }), { ...DEPS, repoRoot: '/repo' })
  const wrapper = join(h, '.local', 'bin', 'helm')
  assert.match(readFileSync(wrapper, 'utf8'), /exec node "\/repo\/src\/cli\/main\.ts" "\$@"/)
  assert.ok((statSync(wrapper).mode & 0o111) !== 0, 'wrapper 必須可執行')
})

test('settings.json 不存在時視為空設定，仍能安裝', () => {
  const h = home()
  installHook(resolvePaths({ home: h }), DEPS)
  assert.equal(hasHelmHook(readSettings(h)), true)
})

test('settings.json 壞掉時拒絕安裝，不硬蓋掉使用者的檔案', () => {
  const h = home()
  writeFileSync(join(h, '.claude', 'settings.json'), '{壞掉')
  const report = installHook(resolvePaths({ home: h }), DEPS)
  assert.ok(report.warnings.some((w) => w.includes('無法解析')))
  assert.equal(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'), '{壞掉')
})

test('SwiftBar 未安裝時給出提示但不擋安裝', () => {
  const h = home({})
  const report = installHook(resolvePaths({ home: h }), DEPS)
  assert.ok(report.warnings.some((w) => w.includes('SwiftBar')))
  assert.equal(hasHelmHook(readSettings(h)), true)
})

test('解除安裝把 settings.json 還原成安裝前的樣子', () => {
  const original = { theme: 'dark', permissions: { allow: ['Bash(npm test)'] } }
  const h = home(original)
  const paths = resolvePaths({ home: h })
  installHook(paths, DEPS)
  uninstallHook(paths, DEPS)
  assert.deepEqual(readSettings(h), original)
})

test('解除安裝會移除 wrapper 與 SwiftBar plugin', () => {
  const h = home({})
  const paths = resolvePaths({ home: h })
  installHook(paths, DEPS)
  uninstallHook(paths, DEPS)
  assert.equal(existsSync(join(h, '.local', 'bin', 'helm')), false)
})

test('解除安裝保留 live 檔與快取 —— 那是使用者的資料，不是我們的殘骸', () => {
  const h = home({})
  const paths = resolvePaths({ home: h })
  installHook(paths, DEPS)
  writeFileSync(join(h, '.helm', 'live', 'x.json'), '{}')
  uninstallHook(paths, DEPS)
  assert.equal(existsSync(join(h, '.helm', 'live', 'x.json')), true)
})

test('沒裝過就解除安裝不丟錯', () => {
  const h = home({ theme: 'dark' })
  const report = uninstallHook(resolvePaths({ home: h }), DEPS)
  assert.deepEqual(readSettings(h), { theme: 'dark' })
  assert.ok(report.steps.length >= 0)
})
```

- [ ] **Step 7: 執行測試確認失敗**

Run: `node --test src/hook/install.test.ts`
Expected: FAIL，找不到模組 `./install.ts`

- [ ] **Step 8: 實作 install.ts**

```ts
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HelmPaths } from '../paths.ts'
import { buildHookCommand } from './snippet.ts'
import { addHelmHook, removeHelmHook } from './settings.ts'

const SWIFTBAR_APP = '/Applications/SwiftBar.app'
const PLUGIN_NAME = 'helm.5s.sh'

export interface InstallDeps {
  now: () => number
  repoRoot: string
}

export interface InstallReport {
  steps: string[]
  warnings: string[]
}

export function installHook(paths: HelmPaths, deps: InstallDeps): InstallReport {
  const settings = readSettings(paths.claudeSettings)
  if (settings === 'unparseable') {
    return {
      steps: [],
      warnings: [`${paths.claudeSettings} 無法解析，已中止安裝。請先修好這個檔案，helm 不會覆寫它。`],
    }
  }

  const steps: string[] = []
  const warnings: string[] = []

  if (existsSync(paths.claudeSettings)) {
    const backup = join(paths.backupsDir, `settings-${new Date(deps.now()).toISOString()}.json`)
    mkdirSync(paths.backupsDir, { recursive: true })
    writeFileSync(backup, readFileSync(paths.claudeSettings, 'utf8'), 'utf8')
    steps.push(`已備份設定到 ${backup}`)
  }

  // The hook must not spawn `mkdir`, so the directory has to exist before the
  // first tool call. Measured: adding `mkdir -p` costs 2.5 ms on every call.
  mkdirSync(paths.helmLive, { recursive: true })
  steps.push(`已建立 ${paths.helmLive}`)

  const command = buildHookCommand(paths.helmLive, paths.hookErrorsLog)
  writeJson(paths.claudeSettings, addHelmHook(settings, command))
  steps.push(`已把 hook 加進 ${paths.claudeSettings}（其餘設定未動）`)

  const wrapper = wrapperPath(paths)
  mkdirSync(dirname(wrapper), { recursive: true })
  writeFileSync(wrapper, `#!/bin/sh\nexec node "${join(deps.repoRoot, 'src/cli/main.ts')}" "$@"\n`, 'utf8')
  chmodSync(wrapper, 0o755)
  steps.push(`已安裝 ${wrapper}`)

  if (existsSync(SWIFTBAR_APP)) {
    const plugin = join(swiftbarPluginDir(paths), PLUGIN_NAME)
    mkdirSync(dirname(plugin), { recursive: true })
    writeFileSync(plugin, `#!/bin/sh\nexec "${wrapper}" menu\n`, 'utf8')
    chmodSync(plugin, 0o755)
    steps.push(`已安裝 SwiftBar plugin：${plugin}`)
  } else {
    warnings.push('找不到 SwiftBar，選單列看板尚未啟用。安裝方式：brew install --cask swiftbar，裝好後重跑 helm install。')
  }

  if (!process.env['PATH']?.split(':').includes(dirname(wrapper))) {
    warnings.push(`${dirname(wrapper)} 不在 PATH 上，直接打 helm 會找不到。把它加進 shell 設定即可。`)
  }

  return { steps, warnings }
}

export function uninstallHook(paths: HelmPaths, deps: InstallDeps): InstallReport {
  const settings = readSettings(paths.claudeSettings)
  const steps: string[] = []
  if (settings !== 'unparseable') {
    writeJson(paths.claudeSettings, removeHelmHook(settings))
    steps.push(`已從 ${paths.claudeSettings} 移除 hook`)
  }

  for (const path of [wrapperPath(paths), join(swiftbarPluginDir(paths), PLUGIN_NAME)]) {
    if (!existsSync(path)) continue
    rmSync(path, { force: true })
    steps.push(`已移除 ${path}`)
  }

  // live/ and cache.json stay. They are the user's own history, and deleting
  // them on uninstall would turn "stop collecting" into "throw away what you
  // already collected".
  return {
    steps,
    warnings: [`${paths.helmLive} 與快取保留未動，要清掉請自行刪除 ${paths.helmHome}。`],
  }
}

function wrapperPath(paths: HelmPaths): string {
  return join(paths.home, '.local', 'bin', 'helm')
}

function swiftbarPluginDir(paths: HelmPaths): string {
  return join(paths.home, 'Library', 'Application Support', 'SwiftBar')
}

/** 'unparseable' is distinct from {} so the caller can refuse rather than clobber. */
function readSettings(file: string): unknown | 'unparseable' {
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // Deliberately NOT degrading to an empty object: writing our hook into a
    // fresh {} would silently destroy every setting the user has. Refusing is
    // the only safe answer, and the caller surfaces it.
    return 'unparseable'
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
```

- [ ] **Step 9: 執行測試確認通過**

Run: `node --test src/hook/install.test.ts`
Expected: PASS，11 個測試全過

- [ ] **Step 10: 實作 CLI 並註冊子指令**

建立 `src/cli/install.ts`：

```ts
import { fileURLToPath } from 'node:url'
import { installHook, uninstallHook, type InstallReport } from '../hook/install.ts'
import { currentPaths } from './status.ts'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

export function runInstall(_argv: readonly string[]): number {
  return report(installHook(currentPaths(), { now: Date.now, repoRoot: REPO_ROOT }), '安裝')
}

export function runUninstall(_argv: readonly string[]): number {
  return report(uninstallHook(currentPaths(), { now: Date.now, repoRoot: REPO_ROOT }), '解除安裝')
}

function report(result: InstallReport, verb: string): number {
  for (const s of result.steps) process.stdout.write(`✓ ${s}\n`)
  for (const w of result.warnings) process.stderr.write(`⚠ ${w}\n`)
  if (result.steps.length === 0) {
    process.stderr.write(`${verb}未完成。\n`)
    return 1
  }
  process.stdout.write(`${verb}完成。隨時可用 HELM_OFF=1 停用 hook，或 helm uninstall 完全移除。\n`)
  return 0
}
```

在 `src/cli/main.ts` 的 `switch` 加入：

```ts
    case 'install':
      return runInstall(rest)
    case 'uninstall':
      return runUninstall(rest)
```

並在 `USAGE` 加入兩行：

```
  helm install                        安裝 hook 與選單列 plugin（會先備份設定）
  helm uninstall                      完全移除，還原設定
```

- [ ] **Step 11: 補 CLI 層測試**

建立 `src/cli/install.test.ts`，helper 用附錄 A：

```ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInstall, runUninstall } from './install.ts'
import { captureSync, scaffoldHome, SCRATCH } from './test-helpers.ts'

after(SCRATCH.cleanup)

const settingsOf = (home: string) =>
  JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) as unknown

test('安裝成功回 0 並逐項印出做了什麼', () => {
  const home = scaffoldHome([])
  const r = captureSync(home, () => runInstall([]))
  assert.equal(r.code, 0)
  assert.match(r.out, /已把 hook 加進/)
})

test('settings.json 壞掉時回 1，且不動使用者的檔案', () => {
  const home = scaffoldHome([])
  writeFileSync(join(home, '.claude', 'settings.json'), '{壞掉')
  const r = captureSync(home, () => runInstall([]))
  assert.equal(r.code, 1)
  assert.match(r.err, /無法解析/)
  assert.equal(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'), '{壞掉')
})

test('解除安裝後 settings.json 與安裝前逐字相同', () => {
  const home = scaffoldHome([])
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark' }, null, 2))
  const before = settingsOf(home)
  captureSync(home, () => runInstall([]))
  captureSync(home, () => runUninstall([]))
  assert.deepEqual(settingsOf(home), before)
})

test('輸出提到脫身方式 —— 使用者要知道怎麼收回', () => {
  const home = scaffoldHome([])
  assert.match(captureSync(home, () => runInstall([])).out, /HELM_OFF=1|helm uninstall/)
})
```

- [ ] **Step 12: 執行完整檢查**

Run: `bash scripts/check.sh`

- [ ] **Step 13: Commit**

```bash
git add src/hook/ src/cli/install.ts src/cli/install.test.ts src/cli/main.ts src/paths.ts src/paths.test.ts
git commit -m "feat: helm install 與 helm uninstall"
```

---

## Task 3: `helm doctor`

`helm doctor` 不是可有可無的診斷工具，它是兩張已經開出去的支票：

1. **hook 的靜默豁免以它為補償**（規格 §12）。沒有 doctor，hook 的錯誤就真的只是被吞掉。
2. **`render/table.ts` 已經在叫使用者「執行 helm doctor 查看原因」**，但這個指令目前不存在。這是 Task 11 review 留下的 deferred minor，本 task 一併結清。

**Files:**
- Create: `src/cli/doctor.ts`, `src/cli/doctor.test.ts`
- Create: `src/hook/health.ts`, `src/hook/health.test.ts`
- Modify: `src/cli/main.ts`

**Interfaces:**
- Consumes: `hasHelmHook` from Task 2；`collectStatus`, `currentPaths` from `src/cli/status.ts`；`readLiveMarker` from `src/reconcile/live.ts`
- Produces:
  - `interface Check { name: string; ok: boolean; detail: string }`
  - `runChecks(paths: HelmPaths, board: Board, nowMs: number): Check[]`
  - `sweepStaleLive(paths: HelmPaths, board: Board, nowMs: number): string[]` —— 回傳被刪掉的檔名
  - `runDoctor(argv: readonly string[]): number`

### 檢查項目

| 檢查 | 判定 | 不 ok 時給的下一步 |
|---|---|---|
| hook 已安裝 | `hasHelmHook(settings)` | 「執行 helm install」 |
| hook 錯誤紀錄 | `hook-errors.log` 為空或不存在 | 印出最後 5 行 |
| hook 未被停用 | `HELM_OFF` 未設為 1 | 「目前 HELM_OFF=1，hook 不會採集」 |
| live 目錄存在 | `helmLive` 是目錄 | 「執行 helm install」 |
| 註冊表解析失敗數 | `board.invalid === 0` | 印出數量與 `~/.claude/sessions` 路徑 |
| SwiftBar | `/Applications/SwiftBar.app` 存在 | 「brew install --cask swiftbar」 |
| SwiftBar plugin | plugin 檔存在且可執行 | 「執行 helm install」 |

**清理**（規格 §4.3）：`live/*.json` 在對應 session 已判為 `ended_clean`、或檔案超過 30 天時刪除。這是順手做的事，不在關鍵路徑上。

- [ ] **Step 1: 寫 health.ts 的失敗測試**

建立 `src/hook/health.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePaths } from '../paths.ts'
import { runChecks, sweepStaleLive } from './health.ts'
import type { Board } from '../board.ts'
import type { SessionState } from '../types.ts'

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0)
const DAY = 86_400_000

const sess = (over: Partial<SessionState>): SessionState => ({
  adapterId: 'claude-code', sessionId: 's', cwd: '/p', pid: null, procStart: null,
  startedAt: 0, updatedAt: NOW, nativeStatus: null, kind: 'interactive', name: '',
  transcriptPath: null, lifecycle: 'ended_clean', lifecycleConfidence: 'high',
  live: null, ...over,
})

const board = (sessions: SessionState[] = [], invalid = 0): Board => ({
  projects: sessions.length === 0 ? [] : [{
    path: '/p', name: 'p', pinned: false, lastActivityMs: NOW,
    aggregateStatus: null, sessionCount: sessions.length, sessions,
  }],
  invalid,
})

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'helm-doctor-'))
  mkdirSync(join(h, '.claude'), { recursive: true })
  return h
}

const find = (checks: ReturnType<typeof runChecks>, name: string) =>
  checks.find((c) => c.name.includes(name))

test('hook 未安裝時檢查不通過，並告訴使用者怎麼裝', () => {
  const h = home()
  writeFileSync(join(h, '.claude', 'settings.json'), '{}')
  const c = find(runChecks(resolvePaths({ home: h }), board(), NOW), 'hook')
  assert.equal(c?.ok, false)
  assert.match(c?.detail ?? '', /helm install/)
})

test('hook 錯誤紀錄非空時檢查不通過並印出內容', () => {
  const h = home()
  mkdirSync(join(h, '.helm'), { recursive: true })
  writeFileSync(join(h, '.helm', 'hook-errors.log'), 'sh: 壞掉了\n')
  const c = find(runChecks(resolvePaths({ home: h }), board(), NOW), '錯誤')
  assert.equal(c?.ok, false)
  assert.match(c?.detail ?? '', /壞掉了/)
})

test('註冊表有解析失敗時如實回報數量 —— table.ts 承諾過這裡查得到原因', () => {
  const c = find(runChecks(resolvePaths({ home: home() }), board([], 3), NOW), '註冊表')
  assert.equal(c?.ok, false)
  assert.match(c?.detail ?? '', /3/)
})

test('全部正常時每一項都 ok', () => {
  // SwiftBar 未安裝屬環境差異，這裡只斷言與環境無關的項目。
  const checks = runChecks(resolvePaths({ home: home() }), board(), NOW)
  assert.ok(checks.length >= 5)
  assert.ok(checks.every((c) => typeof c.detail === 'string'))
})

test('清理掉已正常結束的 session 的 live 檔', () => {
  const h = home()
  const live = join(h, '.helm', 'live')
  mkdirSync(live, { recursive: true })
  writeFileSync(join(live, 'done.json'), '{}')
  const removed = sweepStaleLive(
    resolvePaths({ home: h }),
    board([sess({ sessionId: 'done', lifecycle: 'ended_clean' })]),
    NOW,
  )
  assert.deepEqual(removed, ['done.json'])
  assert.equal(existsSync(join(live, 'done.json')), false)
})

test('還在跑的 session 的 live 檔不動', () => {
  const h = home()
  const live = join(h, '.helm', 'live')
  mkdirSync(live, { recursive: true })
  writeFileSync(join(live, 'busy.json'), '{}')
  const removed = sweepStaleLive(
    resolvePaths({ home: h }),
    board([sess({ sessionId: 'busy', lifecycle: 'running' })]),
    NOW,
  )
  assert.deepEqual(removed, [])
})

test('超過 30 天的孤兒 live 檔即使不認得也清掉', () => {
  const h = home()
  const live = join(h, '.helm', 'live')
  mkdirSync(live, { recursive: true })
  const f = join(live, 'orphan.json')
  writeFileSync(f, '{}')
  const old = (NOW - 31 * DAY) / 1000
  utimesSync(f, old, old)
  assert.deepEqual(sweepStaleLive(resolvePaths({ home: h }), board(), NOW), ['orphan.json'])
})

test('認不得但還很新的 live 檔留著 —— 那可能正是當機的證據', () => {
  // 當機的 session 不在註冊表裡，它的 live 檔就是唯一證據，清掉等於湮滅它。
  const h = home()
  const live = join(h, '.helm', 'live')
  mkdirSync(live, { recursive: true })
  writeFileSync(join(live, 'crashed.json'), '{}')
  assert.deepEqual(sweepStaleLive(resolvePaths({ home: h }), board(), NOW), [])
})

test('live 目錄不存在時清理是 no-op', () => {
  assert.deepEqual(sweepStaleLive(resolvePaths({ home: home() }), board(), NOW), [])
})
```

倒數第二個測試（「認不得但還很新的留著」）是這一組裡最重要的。清理寫得太積極，就會把 §6 真值表最後一列賴以判定的證據刪掉，而且刪掉之後沒有任何人會發現。

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test src/hook/health.test.ts`
Expected: FAIL，找不到模組 `./health.ts`

- [ ] **Step 3: 實作 health.ts**

```ts
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Board } from '../board.ts'
import type { HelmPaths } from '../paths.ts'
import { hasHelmHook } from './settings.ts'

const ORPHAN_MAX_AGE_MS = 30 * 86_400_000
const ERROR_TAIL_LINES = 5
const SWIFTBAR_APP = '/Applications/SwiftBar.app'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

export function runChecks(paths: HelmPaths, board: Board, _nowMs: number): Check[] {
  return [
    hookInstalled(paths),
    hookErrors(paths),
    hookEnabled(),
    liveDir(paths),
    registryParse(paths, board),
    swiftbar(paths),
  ]
}

function hookInstalled(paths: HelmPaths): Check {
  const ok = hasHelmHook(readJson(paths.claudeSettings))
  return {
    name: 'PreToolUse hook',
    ok,
    detail: ok ? '已安裝' : `未安裝，因此看不到「此刻正在跑什麼」。執行 helm install 安裝。`,
  }
}

function hookErrors(paths: HelmPaths): Check {
  const lines = readLines(paths.hookErrorsLog)
  return {
    name: 'hook 錯誤紀錄',
    ok: lines.length === 0,
    detail: lines.length === 0
      ? '沒有錯誤'
      : `${lines.length} 行錯誤，最後 ${ERROR_TAIL_LINES} 行：\n${lines.slice(-ERROR_TAIL_LINES).map((l) => `    ${l}`).join('\n')}`,
  }
}

/** The kill switch is a feature, but a silently-disabled hook is a trap. */
function hookEnabled(): Check {
  const off = process.env['HELM_OFF'] === '1'
  return {
    name: 'hook 啟用狀態',
    ok: !off,
    detail: off ? 'HELM_OFF=1，hook 目前完全不採集。取消該環境變數即可恢復。' : '啟用中',
  }
}

function liveDir(paths: HelmPaths): Check {
  const ok = isDir(paths.helmLive)
  return {
    name: 'live 目錄',
    ok,
    detail: ok ? paths.helmLive : `${paths.helmLive} 不存在，hook 會寫不進去。執行 helm install。`,
  }
}

function registryParse(paths: HelmPaths, board: Board): Check {
  return {
    name: '註冊表解析',
    ok: board.invalid === 0,
    detail: board.invalid === 0
      ? '全部可解析'
      : `有 ${board.invalid} 個檔案無法解析，位於 ${paths.claudeSessions}。多半是 Claude Code 改了格式，或檔案被截斷。`,
  }
}

function swiftbar(paths: HelmPaths): Check {
  const plugin = join(paths.home, 'Library', 'Application Support', 'SwiftBar', 'helm.5s.sh')
  if (!existsSync(SWIFTBAR_APP)) {
    return { name: 'SwiftBar', ok: false, detail: '未安裝。brew install --cask swiftbar，裝好後執行 helm install。' }
  }
  const ok = existsSync(plugin)
  return { name: 'SwiftBar', ok, detail: ok ? plugin : `plugin 未安裝，執行 helm install。` }
}

/**
 * Spec §4.3. Two rules, and the gap between them is deliberate: a live file
 * whose session helm cannot see might be the only surviving evidence of a
 * crash (§6's last row), so it is kept until it is old enough to be certainly
 * irrelevant. Deleting it early would erase the evidence with nobody noticing.
 */
export function sweepStaleLive(paths: HelmPaths, board: Board, nowMs: number): string[] {
  const ended = new Set(
    board.projects
      .flatMap((p) => p.sessions)
      .filter((s) => s.lifecycle === 'ended_clean')
      .map((s) => s.sessionId),
  )
  return listJson(paths.helmLive).flatMap((name) => {
    const file = join(paths.helmLive, name)
    const sessionId = name.slice(0, -'.json'.length)
    const expired = ageOf(file, nowMs) > ORPHAN_MAX_AGE_MS
    if (!ended.has(sessionId) && !expired) return []
    return removeQuietly(file) ? [name] : []
  })
}

function ageOf(file: string, nowMs: number): number {
  try {
    return nowMs - statSync(file).mtimeMs
  } catch {
    // Vanished between listing and stat — treat as not-expired and skip it;
    // the next sweep will find it if it is still there.
    return 0
  }
}

function removeQuietly(file: string): boolean {
  try {
    rmSync(file, { force: true })
    return true
  } catch {
    // Cleanup is off the critical path. A file we cannot delete is reported
    // as "not deleted" and retried next time, never escalated to the user.
    return false
  }
}

function listJson(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    // No live directory means nothing to sweep, which is the normal state
    // before `helm install` has ever run.
    return []
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // A missing or corrupt settings.json is itself the finding; returning
    // null lets hasHelmHook report "not installed" rather than throwing.
    return null
  }
}

function readLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '')
  } catch {
    // No log file is the healthy case.
    return []
  }
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `node --test src/hook/health.test.ts`
Expected: PASS，9 個測試全過

- [ ] **Step 5: 實作 `helm doctor` CLI**

建立 `src/cli/doctor.ts`：

```ts
import { runChecks, sweepStaleLive, type Check } from '../hook/health.ts'
import { collectStatus, currentPaths } from './status.ts'

export function runDoctor(_argv: readonly string[]): number {
  const now = Date.now()
  const paths = currentPaths()
  const board = collectStatus(paths, now)

  const checks = runChecks(paths, board, now)
  for (const c of checks) process.stdout.write(`${c.ok ? '✓' : '✗'} ${c.name}：${c.detail}\n`)

  const swept = sweepStaleLive(paths, board, now)
  if (swept.length > 0) process.stdout.write(`\n順手清掉 ${swept.length} 個過期的 live 檔。\n`)

  const failed = checks.filter((c) => !c.ok)
  if (failed.length === 0) {
    process.stdout.write('\n一切正常。\n')
    return 0
  }
  process.stdout.write(`\n${failed.length} 項需要處理，見上方每一項的說明。\n`)
  return 1
}
```

在 `src/cli/main.ts` 註冊 `case 'doctor': return runDoctor(rest)`，並在 `USAGE` 加入：

```
  helm doctor                         檢查 hook、快取與資料來源是否正常
```

- [ ] **Step 6: 補 CLI 層測試**

建立 `src/cli/doctor.test.ts`，helper 用附錄 A：

```ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { runDoctor } from './doctor.ts'
import { runInstall } from './install.ts'
import { captureSync, scaffoldHome, SCRATCH } from './test-helpers.ts'

after(SCRATCH.cleanup)

test('沒安裝過時回 1 並指出缺什麼', () => {
  const r = captureSync(scaffoldHome([]), () => runDoctor([]))
  assert.equal(r.code, 1)
  assert.match(r.out, /helm install/)
})

test('每一項都帶勾或叉，沒有含糊的行', () => {
  const r = captureSync(scaffoldHome([]), () => runDoctor([]))
  const rows = r.out.split('\n').filter((l) => l.includes('：'))
  assert.ok(rows.length >= 5)
  assert.ok(rows.every((l) => l.startsWith('✓') || l.startsWith('✗')))
})

test('裝好之後 hook 與 live 目錄兩項轉為通過', () => {
  const home = scaffoldHome([])
  captureSync(home, () => runInstall([]))
  const out = captureSync(home, () => runDoctor([])).out
  assert.match(out, /✓ PreToolUse hook/)
  assert.match(out, /✓ live 目錄/)
})
```

（SwiftBar 兩項取決於機器上有沒有裝，因此不納入斷言。）

- [ ] **Step 7: 執行完整檢查**

Run: `bash scripts/check.sh`

- [ ] **Step 8: Commit**

```bash
git add src/hook/health.ts src/hook/health.test.ts src/cli/doctor.ts src/cli/doctor.test.ts src/cli/main.ts
git commit -m "feat: helm doctor 檢查 hook 與資料來源並清理過期 live 檔"
```

---

## Task 4: `helm pin` / `helm hide` / `helm show`

P1 實作了 `~/.helm/projects.json` 的讀寫與 `pinned`／`hidden` 的納入規則，但**沒有任何指令能設定它們** —— 使用者只能手動編輯 JSON。選單列的「隱藏此專案」要能點，這個缺口就得補上。

**Files:**
- Create: `src/cli/prefs.ts`, `src/cli/prefs.test.ts`
- Modify: `src/cli/main.ts`

**Interfaces:**
- Consumes: `resolveOrReport` from `src/cli/target.ts`；`readPrefs`, `writePrefs`, `setProjectPref` from `src/projects/prefs.ts`；`collectStatus`, `currentPaths` from `src/cli/status.ts`
- Produces: `runPrefs(action: PrefAction, argv: readonly string[]): number`、`type PrefAction = 'pin' | 'unpin' | 'hide' | 'show'`

### 語意

| 指令 | 效果 |
|---|---|
| `helm pin <專案>` | `pinned: true` —— 永遠置頂，且不受 14 天窗口約束 |
| `helm unpin <專案>` | `pinned: false` |
| `helm hide <專案>` | `hidden: true` —— 永久隱藏 |
| `helm show <專案>` | `hidden: false` |

**`hide` 之後要怎麼 `show`？** 被隱藏的專案不在 `collectStatus` 的結果裡，`resolveOrReport` 就找不到它，使用者會被自己鎖在外面。因此 `show` 走不同的解析路徑：直接比對 `projects.json` 裡已存在的鍵，並在找不到時列出所有目前被隱藏的專案。

- [ ] **Step 1: 寫失敗測試**

建立 `src/cli/prefs.test.ts`。helper 用附錄 A 的 `scaffoldHome` / `captureSync` / `readPrefsOf`：

```ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { runPrefs } from './prefs.ts'
import { collectStatus } from './status.ts'
import { resolvePaths } from '../paths.ts'
import { captureSync, readPrefsOf, scaffoldHome, SCRATCH } from './test-helpers.ts'

after(SCRATCH.cleanup)

const run = (home: string, action: 'pin' | 'unpin' | 'hide' | 'show', argv: string[]) =>
  captureSync(home, () => runPrefs(action, argv))

const projectPath = (home: string, name: string) => join(home, name)

test('pin 之後 projects.json 記下該專案', () => {
  const home = scaffoldHome([{ project: 'proj', sessions: ['aaaa1111-0000-1111-2222-333344445555'] }])
  assert.equal(run(home, 'pin', ['proj']).code, 0)
  assert.equal(readPrefsOf(home).projects[projectPath(home, 'proj')]?.pinned, true)
})

test('hide 之後該專案不再出現在 helm status', () => {
  const home = scaffold('proj')
  run(home, 'hide', ['proj'])
  assert.equal(collectStatus(resolvePaths({ home }), Date.now()).projects.length, 0)
})

test('被 hide 的專案仍然 show 得回來 —— 不能把使用者鎖在外面', () => {
  const home = scaffold('proj')
  run(home, 'hide', ['proj'])
  assert.equal(run(home, 'show', ['proj']).code, 0)
  assert.equal(collectStatus(resolvePaths({ home }), Date.now()).projects.length, 1)
})

test('show 一個不存在的名字時列出目前被隱藏的專案', () => {
  const home = scaffold('proj')
  run(home, 'hide', ['proj'])
  const r = run(home, 'show', ['nope'])
  assert.equal(r.code, 1)
  assert.match(r.err, /proj/)
})

test('沒給專案時印用法並回傳 2', () => {
  assert.equal(run(scaffold('proj'), 'pin', []).code, 2)
})

test('歧義時列出候選，不自動挑', () => {
  const home = scaffold('proj', 'project-two')
  const r = run(home, 'pin', ['proj'])
  assert.equal(r.code, 1)
  assert.match(r.err, /project-two/)
})

test('pin 不會動到同一個檔案裡其他專案的設定', () => {
  const home = scaffoldHome([
    { project: 'alpha', sessions: ['aaaa1111-0000-1111-2222-333344445555'] },
    { project: 'bravo', sessions: ['bbbb2222-0000-1111-2222-333344445555'] },
  ])
  run(home, 'hide', ['bravo'])
  run(home, 'pin', ['alpha'])
  assert.equal(readPrefsOf(home).projects[projectPath(home, 'bravo')]?.hidden, true)
  assert.equal(readPrefsOf(home).projects[projectPath(home, 'alpha')]?.pinned, true)
})
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test src/cli/prefs.test.ts`
Expected: FAIL，找不到模組 `./prefs.ts`

- [ ] **Step 3: 實作 prefs.ts**

```ts
import { readPrefs, setProjectPref, writePrefs } from '../projects/prefs.ts'
import { collectStatus, currentPaths } from './status.ts'
import { resolveOrReport } from './target.ts'

export type PrefAction = 'pin' | 'unpin' | 'hide' | 'show'

const PATCH: Record<PrefAction, { pinned?: boolean; hidden?: boolean }> = {
  pin: { pinned: true },
  unpin: { pinned: false },
  hide: { hidden: true },
  show: { hidden: false },
}

const DONE: Record<PrefAction, string> = {
  pin: '已釘選', unpin: '已取消釘選', hide: '已隱藏', show: '已取消隱藏',
}

export function runPrefs(action: PrefAction, argv: readonly string[]): number {
  const query = argv.find((a) => !a.startsWith('--'))
  if (query === undefined) {
    process.stderr.write(`用法：helm ${action} <專案>\n`)
    return 2
  }

  const paths = currentPaths()
  const path = action === 'show'
    ? resolveHidden(paths.prefsFile, query)
    : resolveVisible(paths, query)
  if (path === null) return 1

  writePrefs(paths.prefsFile, setProjectPref(readPrefs(paths.prefsFile), path, PATCH[action]))
  process.stdout.write(`${DONE[action]}：${path}\n`)
  return 0
}

function resolveVisible(paths: ReturnType<typeof currentPaths>, query: string): string | null {
  const { projects } = collectStatus(paths, Date.now())
  const hit = resolveOrReport(projects, query, (m) => process.stderr.write(m))
  return hit?.project.path ?? null
}

/**
 * A hidden project is absent from the board by definition, so the normal
 * resolver can never find it — without this path the user would be locked out
 * of their own `hide` with no way back short of editing JSON by hand.
 */
function resolveHidden(prefsFile: string, query: string): string | null {
  const prefs = readPrefs(prefsFile)
  const hidden = Object.entries(prefs.projects)
    .filter(([, p]) => p.hidden)
    .map(([path]) => path)
  const q = query.trim().toLowerCase()
  const matched = hidden.filter((p) => (p.split('/').pop() ?? p).toLowerCase().includes(q))

  if (matched.length === 1) return matched[0] as string
  if (matched.length > 1) {
    process.stderr.write(`"${query}" 同時符合多個：\n${matched.map((p) => `  ${p}`).join('\n')}\n打長一點就能分辨。\n`)
    return null
  }
  process.stderr.write(
    hidden.length === 0
      ? '目前沒有被隱藏的專案。\n'
      : `找不到符合 "${query}" 的隱藏專案。目前隱藏中：\n${hidden.map((p) => `  ${p}`).join('\n')}\n`,
  )
  return null
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `node --test src/cli/prefs.test.ts`
Expected: PASS

- [ ] **Step 5: 註冊子指令**

在 `src/cli/main.ts` 加入四個 case，並在 `USAGE` 加入：

```
  helm pin|unpin <專案>               釘選／取消釘選（釘選的專案不受 14 天窗口約束）
  helm hide|show <專案>               隱藏／取消隱藏
```

- [ ] **Step 6: 執行完整檢查並 commit**

```bash
bash scripts/check.sh
git add src/cli/prefs.ts src/cli/prefs.test.ts src/cli/main.ts
git commit -m "feat: helm pin/unpin/hide/show 設定專案偏好"
```

---

## Task 5: `render/swiftbar.ts` 與 `helm menu`

本期的交付物本身。SwiftBar 每 5 秒跑一次 `helm menu`，所以這裡的效能不是「最好快一點」，而是硬契約。

**Files:**
- Create: `src/render/swiftbar.ts`, `src/render/swiftbar.test.ts`
- Create: `src/cli/menu.ts`, `src/cli/menu.test.ts`
- Modify: `src/cli/main.ts`

**Interfaces:**
- Consumes: `Board` from `src/board.ts`；`ProjectView` from `src/projects/group.ts`；`statusOf`, `StatusKey` from `src/session-status.ts`；`relativeTime` from `src/render/glyphs.ts`
- Produces:
  - `interface MenuOptions { nowMs: number; helmBin: string }`
  - `renderSwiftBar(board: Board, opts: MenuOptions): string`
  - `runMenu(argv: readonly string[]): number`

### SwiftBar 輸出格式

`---` 之前是選單列標題，之後是下拉內容。`--` 前綴代表子選單層級。參數接在 `|` 之後。

```
⚓ 1 中斷 | color=red
---
example-service  2 分鐘前 | color=red
--● 已中斷  abc12345  5 分鐘前
----開終端機接續 | bash="/Users/u/.local/bin/helm" param1=open param2=abc12345 terminal=false refresh=true
----看交接簡報 | bash="/Users/u/.local/bin/helm" param1=brief param2=abc12345 terminal=true
--隱藏此專案 | bash="/Users/u/.local/bin/helm" param1=hide param2=example-service terminal=false refresh=true
---
重新整理 | refresh=true
helm doctor | bash="/Users/u/.local/bin/helm" param1=doctor terminal=true
```

**標題規則**（規格 §11.1：「只要存在紅點，標題即為紅色」）：

| 條件 | 標題 | 顏色 |
|---|---|---|
| 有 crashed | `⚓ N 中斷` | red |
| 否則有 busy | `⚓ N 在跑` | green |
| 否則有 idle | `⚓ N 等輸入` | 預設 |
| 都沒有 | `⚓` | 預設 |

**`看交接簡報` 用 `terminal=true`**：它會呼叫 LLM、要跑 1–2 分鐘，開在終端機裡使用者才看得到進度；`開終端機接續` 與 `隱藏此專案` 是瞬間完成的動作，用 `terminal=false` 並 `refresh=true` 讓選單立刻更新。

- [ ] **Step 1: 寫 swiftbar.ts 的失敗測試**

建立 `src/render/swiftbar.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderSwiftBar } from './swiftbar.ts'
import type { Board } from '../board.ts'
import type { ProjectView } from '../projects/group.ts'
import type { SessionState } from '../types.ts'

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0)
const OPTS = { nowMs: NOW, helmBin: '/u/.local/bin/helm' }

const sess = (over: Partial<SessionState>): SessionState => ({
  adapterId: 'claude-code', sessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
  cwd: '/u/proj', pid: 1, procStart: null, startedAt: 0, updatedAt: NOW - 5 * 60_000,
  nativeStatus: 'idle', kind: 'interactive', name: '', transcriptPath: null,
  lifecycle: 'running', lifecycleConfidence: 'high', live: null, ...over,
})

const proj = (over: Partial<ProjectView> = {}): ProjectView => {
  const sessions = over.sessions ?? [sess({})]
  return {
    path: '/u/proj', name: 'proj', pinned: false, lastActivityMs: NOW - 5 * 60_000,
    aggregateStatus: 'idle', sessionCount: sessions.length, ...over, sessions,
  }
}

const board = (projects: ProjectView[], invalid = 0): Board => ({ projects, invalid })
const title = (out: string) => out.split('\n')[0] ?? ''
const body = (out: string) => out.slice(out.indexOf('\n---\n'))

test('標題在有中斷時為紅色', () => {
  const out = renderSwiftBar(board([proj({
    aggregateStatus: 'crashed', sessions: [sess({ lifecycle: 'crashed' })],
  })]), OPTS)
  assert.match(title(out), /中斷/)
  assert.match(title(out), /color=red/)
})

test('中斷蓋過在跑 —— 標題顯示最需要注意的那個', () => {
  const out = renderSwiftBar(board([
    proj({ path: '/a', aggregateStatus: 'busy', sessions: [sess({ nativeStatus: 'busy' })] }),
    proj({ path: '/b', aggregateStatus: 'crashed', sessions: [sess({ lifecycle: 'crashed' })] }),
  ]), OPTS)
  assert.match(title(out), /中斷/)
})

test('沒有中斷但有在跑時標題為綠色', () => {
  const out = renderSwiftBar(board([proj({
    aggregateStatus: 'busy', sessions: [sess({ nativeStatus: 'busy' })],
  })]), OPTS)
  assert.match(title(out), /在跑/)
  assert.match(title(out), /color=green/)
})

test('全部結束時標題不帶顏色也不帶數字', () => {
  const out = renderSwiftBar(board([proj({
    aggregateStatus: null, sessions: [sess({ lifecycle: 'ended_clean' })],
  })]), OPTS)
  assert.ok(!title(out).includes('color='))
})

test('標題與內容之間有 SwiftBar 的分隔線', () => {
  assert.ok(renderSwiftBar(board([proj()]), OPTS).includes('\n---\n'))
})

test('每個專案一列，session 收在子選單', () => {
  const out = body(renderSwiftBar(board([proj({
    sessions: [sess({ sessionId: 'aaaaaaaa-1' }), sess({ sessionId: 'bbbbbbbb-2' })],
  })]), OPTS))
  assert.match(out, /^proj/m)
  assert.match(out, /^--.*aaaaaaaa/m)
  assert.match(out, /^--.*bbbbbbbb/m)
})

test('每個 session 都有「開終端機接續」可點，且參數帶的是自己的 id', () => {
  const out = renderSwiftBar(board([proj()]), OPTS)
  assert.match(out, /param1=open param2=abcdef12/)
  assert.match(out, /bash="\/u\/\.local\/bin\/helm"/)
})

test('接續與隱藏用 terminal=false 並要求刷新', () => {
  const out = renderSwiftBar(board([proj()]), OPTS)
  const line = out.split('\n').find((l) => l.includes('param1=open')) ?? ''
  assert.match(line, /terminal=false/)
  assert.match(line, /refresh=true/)
})

test('看簡報用 terminal=true —— 它要跑 1-2 分鐘，得讓使用者看得到', () => {
  const line = renderSwiftBar(board([proj()]), OPTS).split('\n')
    .find((l) => l.includes('param1=brief')) ?? ''
  assert.match(line, /terminal=true/)
})

test('每個專案都有「隱藏此專案」', () => {
  assert.match(renderSwiftBar(board([proj()]), OPTS), /param1=hide param2=proj/)
})

test('沒有專案時仍輸出合法的選單，不是空字串', () => {
  const out = renderSwiftBar(board([]), OPTS)
  assert.ok(out.includes('\n---\n'))
  assert.match(out, /沒有/)
})

test('註冊表解析失敗時在選單裡明講，不靜默隱藏', () => {
  assert.match(renderSwiftBar(board([proj()], 2), OPTS), /2 個/)
})

test('pinned 專案顯示釘選記號', () => {
  assert.match(renderSwiftBar(board([proj({ pinned: true })]), OPTS), /📌/)
})

test('busy 的 session 顯示此刻在跑什麼 —— 這正是 hook 存在的理由', () => {
  const out = renderSwiftBar(board([proj({
    sessions: [sess({
      nativeStatus: 'busy',
      live: { sessionId: 'x', ts: NOW, toolName: 'Bash', summary: 'npm test' },
    })],
  })]), OPTS)
  assert.match(out, /Bash/)
  assert.match(out, /npm test/)
})

test('管線字元被過濾掉 —— 它是 SwiftBar 的參數分隔符，會把整列切壞', () => {
  // live marker 的 summary 來自 hook，hook 的 summary 來自使用者下的指令。
  // 未過濾的 | 會讓 SwiftBar 把後半段當成參數解析。
  const out = renderSwiftBar(board([proj({
    sessions: [sess({
      nativeStatus: 'busy',
      live: { sessionId: 'x', ts: NOW, toolName: 'Bash', summary: 'ps aux | grep node' },
    })],
  })]), OPTS)
  const line = out.split('\n').find((l) => l.includes('grep node')) ?? ''
  assert.equal((line.match(/\|/g) ?? []).length, 0, 'summary 裡的管線字元必須被移除')
})

test('renderSwiftBar 不修改輸入', () => {
  const input = board([proj()])
  const snapshot = structuredClone(input)
  renderSwiftBar(input, OPTS)
  assert.deepEqual(input, snapshot)
})
```

管線字元那個測試是這一組唯一會被真實使用者觸發的：`ps aux | grep node` 是再普通不過的指令，而它會直接把選單列那一行解析壞掉。

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test src/render/swiftbar.test.ts`
Expected: FAIL，找不到模組 `./swiftbar.ts`

- [ ] **Step 3: 實作 swiftbar.ts**

```ts
import type { Board } from '../board.ts'
import type { ProjectView } from '../projects/group.ts'
import { statusOf, type StatusKey } from '../session-status.ts'
import type { SessionState } from '../types.ts'
import { relativeTime } from './glyphs.ts'

const SHORT_ID = 8

export interface MenuOptions {
  nowMs: number
  /** Absolute path: SwiftBar runs plugins with a minimal PATH. */
  helmBin: string
}

const SHAPE: Record<StatusKey, string> = {
  busy: '●', idle: '○', ended: '●', crashed: '●',
}

const LABEL: Record<StatusKey, string> = {
  busy: '執行中', idle: '等輸入', ended: '已結束', crashed: '已中斷',
}

const TITLE: Record<Exclude<StatusKey, 'ended'>, { word: string; color: string }> = {
  crashed: { word: '中斷', color: 'red' },
  busy: { word: '在跑', color: 'green' },
  idle: { word: '等輸入', color: '' },
}

/** Spec §11.1: the title shows whatever most needs attention, red if anything crashed. */
export function renderSwiftBar(board: Board, opts: MenuOptions): string {
  const sessions = board.projects.flatMap((p) => p.sessions)
  const lines = [
    renderTitle(sessions),
    '---',
    ...renderBody(board, opts),
    '---',
    '重新整理 | refresh=true',
    `helm doctor | bash="${opts.helmBin}" param1=doctor terminal=true`,
  ]
  return `${lines.join('\n')}\n`
}

function renderTitle(sessions: readonly SessionState[]): string {
  const keys = sessions.map(statusOf)
  for (const key of ['crashed', 'busy', 'idle'] as const) {
    const n = keys.filter((k) => k === key).length
    if (n === 0) continue
    const { word, color } = TITLE[key]
    return `⚓ ${n} ${word}${color === '' ? '' : ` | color=${color}`}`
  }
  return '⚓'
}

function renderBody(board: Board, opts: MenuOptions): string[] {
  if (board.projects.length === 0) {
    return ['沒有符合條件的專案（近 14 天內有活動且是 git repo）']
  }
  return [
    ...board.projects.flatMap((p) => renderProject(p, opts)),
    ...(board.invalid === 0
      ? []
      : [`⚠ 有 ${board.invalid} 個 session 記錄無法解析 | color=orange`,
         `--看原因 | bash="${opts.helmBin}" param1=doctor terminal=true`]),
  ]
}

function renderProject(p: ProjectView, opts: MenuOptions): string[] {
  const color = p.aggregateStatus === 'crashed' ? ' | color=red' : ''
  const head = `${p.pinned ? '📌 ' : ''}${clean(p.name)}  ${relativeTime(p.lastActivityMs, opts.nowMs)}${color}`
  return [
    head,
    ...p.sessions.flatMap((s) => renderSession(s, opts)),
    `--隱藏此專案 | bash="${opts.helmBin}" param1=hide param2=${clean(p.name)} terminal=false refresh=true`,
  ]
}

function renderSession(s: SessionState, opts: MenuOptions): string[] {
  const key = statusOf(s)
  const short = s.sessionId.slice(0, SHORT_ID)
  const mark = `${SHAPE[key]}${s.lifecycleConfidence === 'low' ? '?' : ''}`
  const head = `--${mark} ${LABEL[key]}  ${short}  ${relativeTime(s.updatedAt, opts.nowMs)}${liveSuffix(s)}`
  return [
    head,
    `----開終端機接續 | bash="${opts.helmBin}" param1=open param2=${short} terminal=false refresh=true`,
    `----看交接簡報 | bash="${opts.helmBin}" param1=brief param2=${short} terminal=true`,
  ]
}

/** The one thing no file on disk can tell us — what the session is doing right now. */
function liveSuffix(s: SessionState): string {
  if (s.live === null || s.nativeStatus !== 'busy') return ''
  const summary = s.live.summary === '' ? '' : `: ${clean(s.live.summary)}`
  return `  → ${clean(s.live.toolName)}${summary}`
}

/**
 * `|` separates a SwiftBar line from its parameters, and a newline ends the
 * line entirely. Both reach here from the live marker, whose summary is
 * whatever command the user happened to run — `ps aux | grep node` would
 * otherwise silently break the row it appears in.
 */
function clean(text: string): string {
  return text.split('|').join('').split('\n').join(' ').trim()
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `node --test src/render/swiftbar.test.ts`
Expected: PASS，16 個測試全過

- [ ] **Step 5: 實作 `helm menu` 與效能契約測試**

建立 `src/cli/menu.ts`：

```ts
import { join } from 'node:path'
import { renderSwiftBar } from '../render/swiftbar.ts'
import { collectStatus, currentPaths } from './status.ts'

export function runMenu(_argv: readonly string[]): number {
  const now = Date.now()
  const paths = currentPaths()
  process.stdout.write(renderSwiftBar(collectStatus(paths, now), {
    nowMs: now,
    helmBin: join(paths.home, '.local', 'bin', 'helm'),
  }))
  return 0
}
```

建立 `src/cli/menu.test.ts`，除了一般行為外，**必須**包含效能契約（規格 §11.2）：

```ts
test('helm menu 在 fixture 環境下必須在 200ms 內完成', () => {
  // SwiftBar 每 5 秒跑一次。超過契約不是「有點慢」，是使用者的選單列會卡。
  const home = scaffoldWithSessions(20)
  const paths = resolvePaths({ home })
  const started = performance.now()
  const now = Date.now()
  renderSwiftBar(collectStatus(paths, now, () => new Map()), { nowMs: now, helmBin: '/x' })
  const elapsed = performance.now() - started
  assert.ok(elapsed < 200, `helm menu 花了 ${elapsed.toFixed(1)}ms，超過 200ms 契約`)
})

test('helm menu 絕不讀 transcript 內容 —— 那是慢速路徑', () => {
  // 塞一個大到讀了一定會超時的 transcript：只要有人偷讀就會被抓到。
  const home = scaffoldWithHugeTranscript()
  const paths = resolvePaths({ home })
  const started = performance.now()
  const now = Date.now()
  renderSwiftBar(collectStatus(paths, now, () => new Map()), { nowMs: now, helmBin: '/x' })
  assert.ok(performance.now() - started < 200)
})
```

兩個 fixture 建法（放在 `src/cli/menu.test.ts` 內；`scaffoldHome` 見附錄 A）：

```ts
const scaffoldWithSessions = (n: number) =>
  scaffoldHome([{
    project: 'proj',
    sessions: Array.from({ length: n }, (_, i) =>
      `${String(i).padStart(8, '0')}-0000-1111-2222-333344445555`),
  }])

/** 20 MB of transcript: any implementation that reads content will blow the contract. */
function scaffoldWithHugeTranscript(): string {
  const id = 'aaaa1111-0000-1111-2222-333344445555'
  const home = scaffoldHome([{ project: 'proj', sessions: [id] }])
  const slug = join(home, 'proj').replace(/[^a-zA-Z0-9]/g, '-')
  const line = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(900) } })}\n`
  writeFileSync(join(home, '.claude', 'projects', slug, `${id}.jsonl`), line.repeat(20_000))
  return home
}
```

- [ ] **Step 6: 註冊子指令**

在 `src/cli/main.ts` 加入 `case 'menu': return runMenu(rest)`，並在 `USAGE` 加入：

```
  helm menu                           輸出 SwiftBar 格式（由選單列 plugin 呼叫）
```

- [ ] **Step 7: 執行完整檢查**

Run: `bash scripts/check.sh`
Expected: 型別檢查無誤、全部測試通過、覆蓋率 ≥ 80%

- [ ] **Step 8: 端對端驗收**

先確認輸出格式：

```bash
node src/cli/main.ts menu
```
Expected: 第一行為 `⚓ …`，第二行為 `---`，之後每個專案一列、session 為 `--` 子選單、動作為 `----` 三層。

再真的裝起來（**會修改 `~/.claude/settings.json`，並需要重啟 Claude Code 才會載入 hook**）：

```bash
brew install --cask swiftbar     # 使用者自行決定是否安裝
node src/cli/main.ts install
node src/cli/main.ts doctor
```
Expected: `doctor` 每一項皆 `✓`。開啟 SwiftBar 並把 plugin 目錄指向 `~/Library/Application Support/SwiftBar`，選單列出現 `⚓`。

驗證 hook 真的在採集（需先重啟一個 Claude Code session）：

```bash
ls -la ~/.helm/live/
cat ~/.helm/live/*.json
```
Expected: 至少一個檔案，內容為單行合法 JSON，`toolName` 為剛才用過的工具。

最後驗證能完全脫身：

```bash
node src/cli/main.ts uninstall
diff <(python3 -c "import json;print(json.dumps(json.load(open('$HOME/.claude/settings.json')),sort_keys=True,indent=2))") \
     <(python3 -c "import json;print(json.dumps(json.load(open('$(ls -t ~/.helm/backups/*.json | head -1)')),sort_keys=True,indent=2))")
```
Expected: 無差異 —— 解除安裝後的設定與安裝前的備份逐字相同。

- [ ] **Step 9: Commit**

```bash
git add src/render/swiftbar.ts src/render/swiftbar.test.ts src/cli/menu.ts src/cli/menu.test.ts src/cli/main.ts
git commit -m "feat: SwiftBar 選單列輸出與 helm menu"
```

---

## 完成後的狀態

P3 完成即滿足原始需求全貌（規格 §15）。使用者得到：

- 選單列上一直看得到的看板，紅點代表有未回收的斷點
- busy 的 session 顯示**此刻卡在哪個工具呼叫** —— 唯一無法從磁碟取得的資訊
- 子選單一鍵接續或看簡報，不必回終端機打指令
- `helm doctor` 讓 hook 的靜默豁免有了補償，`table.ts` 那句「執行 helm doctor」不再是空頭支票
- `helm pin/hide/show` 讓 P1 就寫好的偏好機制真的能用
- 30 秒內完全脫身：`HELM_OFF=1` 立即停用，`helm uninstall` 還原設定

## 明確不做的事

- **stale-while-revalidate 背景 fork（規格 §4.4）留到 P5**。它的用途是讓選單列不必等 `gh` 或 `claude -p`，但 P3 沒有任何東西需要背景更新 —— 簡報是使用者點了才產生，PR 資料屬 P5。現在做等於為了不存在的需求增加一條非同步路徑。
- **Codex adapter 屬 P4**，本期不碰。
- **helm 不代為安裝 SwiftBar**。`brew install --cask swiftbar` 由使用者自己決定並執行；安裝器只偵測、只提示。

---

## 附錄 A：共用測試 helper

Task 2、3、4、5 的 CLI 測試都需要同一組東西：一個能被 `include.ts` 接受的假 home、一個能捕捉 stdout/stderr 並還原的執行器。寫四份會漂移，所以抽成一個檔。

**Files:** Create `src/cli/test-helpers.ts`

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PrefsFile } from '../projects/prefs.ts'

/**
 * Fixtures cannot live in the OS temp dir: include.ts deliberately excludes
 * /tmp and /var/folders as noise, so a project rooted there is never listed.
 * Namespaced by pid because `node --test` runs files as separate processes and
 * a shared path would let one clean up another's fixtures mid-run.
 */
const ROOT = fileURLToPath(new URL(`../../.test-scratch/${process.pid}-cli/`, import.meta.url))
mkdirSync(ROOT, { recursive: true })

export const SCRATCH = {
  root: ROOT,
  cleanup: () => rmSync(ROOT, { recursive: true, force: true }),
}

export interface ProjectSpec {
  project: string
  sessions: readonly string[]
}

/** A home whose projects are git repos with transcript-only sessions. */
export function scaffoldHome(specs: readonly ProjectSpec[]): string {
  const home = mkdtempSync(join(ROOT, 'home-'))
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  for (const spec of specs) {
    const cwd = join(home, spec.project)
    mkdirSync(join(cwd, '.git'), { recursive: true })
    const dir = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(dir, { recursive: true })
    for (const id of spec.sessions) {
      writeFileSync(
        join(dir, `${id}.jsonl`),
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: '做一件事' } })}\n`,
      )
    }
  }
  return home
}

export interface Captured {
  code: number
  out: string
  err: string
}

/** Restores the streams and HELM_FAKE_HOME even when the command throws. */
export function captureSync(home: string, fn: () => number): Captured {
  const outs: string[] = []
  const errs: string[] = []
  const realOut = process.stdout.write.bind(process.stdout)
  const realErr = process.stderr.write.bind(process.stderr)
  const previous = process.env['HELM_FAKE_HOME']
  process.stdout.write = ((c: string) => (outs.push(String(c)), true)) as typeof process.stdout.write
  process.stderr.write = ((c: string) => (errs.push(String(c)), true)) as typeof process.stderr.write
  process.env['HELM_FAKE_HOME'] = home
  try {
    return { code: fn(), out: outs.join(''), err: errs.join('') }
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
    if (previous === undefined) delete process.env['HELM_FAKE_HOME']
    else process.env['HELM_FAKE_HOME'] = previous
  }
}

export function readPrefsOf(home: string): PrefsFile {
  return JSON.parse(readFileSync(join(home, '.helm', 'projects.json'), 'utf8')) as PrefsFile
}
```

**順帶收掉一個既有的重複**：`src/cli/sessions.test.ts`、`src/cli/brief.test.ts`、`src/cli/open.test.ts` 目前各自帶著一份幾乎相同的 scaffold 與 capture。實作 Task 2 時把它們一併改用這個檔 —— 三份會漂移的複本，比一份共用的難維護得多。

## 附錄 B：規格對照

| 規格章節 | 由哪個 Task 交付 |
|---|---|
| §4.3 hook 覆寫式單行設計、單一 spawn | Task 1 |
| §4.3 kill switch `HELM_OFF=1` | Task 1（no-op）、Task 3（回報目前被停用） |
| §4.3 hook 錯誤寫入 `hook-errors.log` | Task 1（重導）、Task 3（回報） |
| §4.3 安裝方式：附加不覆蓋、先備份、與 plugin 共存 | Task 2 |
| §4.3 解除安裝、30 秒脫身 | Task 2 |
| §4.3 live 檔清理（ended_clean 或超過 30 天） | Task 3 |
| §4.3 live 檔作為不會被上游抹除的當機證據 | Task 1（契約）、Task 3（刻意不清掉認不得但還新的檔） |
| §7 pinned / hidden 的使用者操作介面 | Task 4 |
| §11.1 狀態語彙與 `?` 低信心標記 | Task 5 |
| §11.1 標題顯示最需注意者，有紅點即紅色 | Task 5 |
| §11.2 SwiftBar 為宿主、plugin 檔為單行呼叫 | Task 2（安裝 plugin 檔）、Task 5（輸出格式） |
| §11.2 200ms 效能契約，以自動化測試強制 | Task 5 |
| §12 hook 為唯一靜默豁免，由 doctor 補償 | Task 1、Task 3 |

**規格中屬 P3 但本計畫不做的**，理由已列於「明確不做的事」：§4.4 stale-while-revalidate。

**已知的 P2 規格缺口（不屬本期，但記錄下來以免遺忘）**：§11.3 要求 `helm brief` 預設以 `$PAGER` 顯示、並提供 `--open` 寫入暫存 HTML 以瀏覽器開啟。P2 實作為直接寫 stdout，兩者皆未做。這不影響 P3，但最終全分支 review 時應一併裁決是補做還是修改規格。

---

## 實作後記：偏離計畫之處（2026-08-11）

計畫寫於全分支 review 之前，中間 review 修掉的東西改變了幾個前提。逐項記錄：

### Task 1
- **無偏離。** hook 腳本與計畫的原型一致，實測 6.31 ms（純 spawn 下限 5.77 ms），
  `snippet.ts` 行／分支／函式覆蓋率皆 100%。
- 舊測試「`ts` 取自檔案內容」是刻意改掉的行為，已更新並在測試裡註明理由。

### Task 2
- `readSettings` 的「無法解析」哨兵從字串 `'unparseable'` 改為 `Symbol` ——
  字串哨兵與合法的 JSON 字串值無法區分。
- `writeJsonAtomic`：計畫直接 `writeFileSync`，改為先寫暫存再 rename。
  就地截斷若寫到一半當掉，使用者會拿到半份 settings.json 與一個啟動不了的
  Claude Code。
- `installHook` 多一道檢查：`addHelmHook` 後若 `hasHelmHook` 仍為 false，
  代表 `hooks` 欄位不是預期形狀，中止並說明，而不是回報成功卻什麼也沒裝。
- `InstallDeps` 多一個 `swiftbarInstalled?`，讓 SwiftBar 的兩條分支在任何機器上
  都測得到。
- **附錄 A 的 scaffold 做成一份共用的**（`SessionSpec` 支援 `pid`／`status`／
  `procStart`／`content`），三個既有 CLI 測試檔已遷移。

### Task 3
- `runChecks(paths, board, nowMs)` 拿掉沒用到的 `nowMs`。
- **多一項「偏好檔」檢查**：全分支 review 的 #6 之後 `Board` 才有 `prefsCorrupt`，
  計畫寫的時候還不存在，而 doctor 是它的自然歸屬。
- 清理規則多守一條：**中斷（crashed）的 session 的 live 檔也不清**。計畫只寫了
  「ended_clean 或超過 30 天」，但 crashed 的 live 檔正是它中斷的證據。

### Task 4
- `readPrefs` 在 review #6 之後回傳 `{ prefs, corrupt }` 而非 `PrefsFile`，
  計畫的程式碼片段據此調整。
- **毀損時先警告再寫**：原檔已被隔離保存，但這次寫出的是全新的檔案，先前的
  釘選與隱藏不會自動帶過來 —— 不講清楚使用者會以為設定一直都在。
- `resolveHidden` 的比對同時看 basename 與完整路徑（與 review #5 對
  `resolveTarget` 的修正保持一致，否則列出路徑卻貼不回去）。

### Task 5
- **多一列偏好檔毀損的警告**，理由同 Task 3。
- 警告列的「看原因」子項改為兩種警告共用一個，避免重複。

### 仍未執行
- **尚未對使用者真實的 `~/.claude/settings.json` 執行 `helm install`。** 那會改動
  使用者的實際設定，且之後每次工具呼叫多 6.3 ms（每 turn 約 15 次 ≈ 95 ms）。
- **SwiftBar 仍未安裝**，因此選單列本身尚未實際跑起來過。
- 兩者都需要使用者決定。在此之前，`helm menu` 的輸出格式、效能契約與所有分支
  邏輯都已由測試與真實資料驗證過（真實機器 `collectStatus` 57–63 ms）。

---

## 效能契約的量測方式（2026-08-12 修訂）

規格 §11.2 寫「`helm menu` 每 5 秒執行一次，必須在 200ms 內完成」，指的是**一次真實的指令執行**。原本那條測試宣稱在守這件事，但守不住，原因有二：

1. **它量錯了東西。** fixture 產生的 session 都沒有 `pid`，所以 `ps` 永遠不會被 spawn ——
   那條斷言實際上是 `0.8ms < 200ms`，250 倍餘裕，不可能失敗。
2. **牆鐘數字守不住。** `node --test` 平行跑各檔案。同一段程式碼單獨跑是 36ms，
   在套件裡、機器 load 3.8 時是 **4,216ms**。一個隨無關負載浮動的預算是 flake
   產生器，不是防線。

因此契約拆成三個各自**確定性**的部分：

| 守什麼 | 由誰守 |
|---|---|
| helm 自身的計算成本（演算法回歸） | `menu.test.ts` 的 60ms 預算 + 「四倍的量不該是四倍以上的時間」比值測試（stub 掉 `ps`） |
| 慢速路徑不得混進來 | `menu.test.ts` 的 import 圖檢查（已用 reviewer 當初的變異驗證過會紅） |
| `ps` 的策略 —— 剩下成本的大宗 | `processes.test.ts` 釘住「少於門檻逐一、超過才批次」 |

**端對端數字則以量測記錄，不以斷言宣稱**（2026-08-12，從 shell 連續 5 次）：

```
node -e ''（Node 自身下限）   34-38 ms
helm help（什麼都不做）        57-61 ms   ← 改 dynamic import 前是 99-111 ms
helm menu                     130-150 ms  ← 改動前 190-250 ms
```

兩項改動各自的貢獻：

- **dynamic import**：`main.ts` 原本靜態載入 brief/install/summarize/cache，
  `helm menu` 每次都得付那份 module graph 的錢。省下約 43ms。
- **`ps` 策略**：macOS 的 `ps -p a,b` 一旦超過一個 PID 就掃整張 process table，
  實測固定 ~42ms；單一 PID 只要 ~3.4ms，交叉點在 12 個左右。看板平時只追蹤
  幾個活著的 session，所以「批次比較有效率」這個直覺是反的。本機 3 個 PID
  實測 39.8ms → 13.3ms。

**注意量測方式本身。** 從一個持續變大的 Node 行程連續 spawn 會得到 360-390ms
的假數字；從 shell 量才是 130-150ms。SwiftBar 是從它自己的 Swift 行程叫 plugin，
接近後者。

---

## 追加：桌面看板（Übersicht），2026-08-12

計畫原本只有選單列。實際裝上去之後使用者的第一句話是「沒看到選單列」——
⚓ 其實一直都在，就在 LINE 圖示左邊，但它是綠色文字混在一排彩色圖示裡，
在二十個 menu bar item 之間不顯眼。**「裝好了」和「看得到」是兩件事。**

於是加了第二個呈現面：Übersicht 把指令的輸出畫在桌布上。

| 檔案 | 責任 |
|---|---|
| `src/hook/widget.ts` | 產生 Übersicht widget（一個 ES module），吃 `helm status --json` |
| `src/hook/ubersicht.ts` | `widgetDir` 偏好的讀寫；掃描資料夾以 app 自己的設定為準 |
| `src/hook/defaults.ts` | 兩個 app 共用的 `defaults` 讀寫，從 `swiftbar.ts` 抽出 |

沿用 SwiftBar 那邊已經踩過的三條規則：寫進 app **真正掃描**的資料夾、
wrapper 被別人的 `helm` 佔走時退回直接呼叫 node、失敗一律畫出來
（空白的 widget 分不出「都閒著」和「helm 壞了」）。

### 這一輪暴露出來的三個錯

**一、PATH。** GUI 啟動的 app 拿到的是 launchd 的裸 PATH
`/usr/bin:/bin:/usr/sbin:/sbin`，volta / nvm / fnm 的 shim 全在家目錄底下。

```
$ env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" ~/SwiftBar/helm.5s.sh
/Users/you/.local/bin/helm: line 2: exec: node: not found
```

當時能動，只是因為我從 shell 用 `open -a` 起 SwiftBar，繼承到完整 PATH；
重開機後就會靜默失效。wrapper、plugin、hook 一律改成把 `process.execPath`
釘進去，並保留 `[ -x "$NODE" ] || NODE=node` 的退路（版本管理器升級會刪掉舊 image）。

連帶：`settings.ts` 的 `isHelmGroup` 不能再用 `exec node --no-warnings ` 當前綴，
解譯器路徑因機器而異、升級就變。改用 `exec` / `--no-warnings` / `record.mjs`
加 marker 的結構指紋。

**二、`defaults read` 會把非 ASCII 變成八進位跳脫。** Übersicht 的資料夾讀回來是
`…/Application Support/\334bersicht/widgets`，helm 照那個字面去找、找不到，
於是在剛裝好 widget 的下一秒回報「裡面沒有 helm 的 widget」。
改走 `defaults export | plutil -extract raw`。這條路只有 install 與 doctor 會走，
多一次 spawn 不影響五秒的熱路徑。

**三、測試改壞了使用者真的在用的東西，兩次。**

1. CLI 層的安裝測試沒有注入點，把 `/var/folders/…` 寫進了真實的
   `tracesOf.Uebersicht` `widgetDir`，指向一個測完就刪掉的資料夾。
2. 補上寫入守門之後，`doctor` 的測試改成去**讀**真實的 SwiftBar
   `PluginDirectory`，helm 就照著把 fixture 的 plugin 寫進 `~/SwiftBar`，
   蓋掉正在運作的那一個 —— 選單列變成 ⚠，測試全綠。

兩次都沒有任何東西報錯，都是手動讀 `defaults` 才發現的。現在
`HELM_NO_REAL_PREFS=1`（`npm test` 與 `check.sh` 都會設）讓**讀寫都直接丟例外**，
只放行 `com.helm.test.*` 這種測試自己建、自己刪的 domain。

`health.ts` 的兩個 GUI app 檢查也改成可注入。原本讀 `/Applications`，
等於斷言結果取決於跑測試的機器 —— 在沒裝那個 app 的機器上，那些斷言什麼都沒驗。

---

## 效能契約的現況（2026-08-12，**先前的結論是錯的**）

一度記錄成「`helm menu` 422ms，超過 200ms 契約一倍」。**那個數字是量測雜訊，
不是 helm 的成本。**

發現的方式：`node -e ''` —— 一個什麼都不做的指令 —— 在同一台機器上也會
從 41ms 跳到 285ms。

```
node -e '' 外部量測 15 次，排序後：
0.041 0.042 0.042 0.043 0.043 0.043 0.045 0.051 0.052 0.285
```

這台機器同時跑著好幾個 agent session，load average 在 5 到 15 之間。
行程啟動本身就會排隊等，而 `time` 顯示的 CPU 使用率從 152% 掉到 13% ——
也就是說 87% 的時間在等排程，不是在算。

**用行程內部的 `process.uptime()` 量，不受外部排程干擾：**

```
 11 ms  script 開始（node 自身啟動）
 60 ms  menu.ts 及其相依模組載入完
 89 ms  runMenu 執行完
 89 ms  行程結束
```

五次重複：85 / 91 / 93 / 100 / 156 ms。加上 uptime 起算之前的 dyld 與 V8
初始化（約 40ms，從 `node -e ''` 的 min 推得），**真實成本約 130ms，
在 200ms 契約內。**

各階段（同樣用內部量測）：

```
scanTranscripts   10-20 ms   （28 個目錄、525 個頂層 jsonl）
menu.ts 模組載入  ~49 ms
runMenu 執行      ~29 ms
```

`scan.ts` 註解裡「499 個 transcript、6.9ms」的紀錄依然成立 —— 現在是 525 個。
那個 2,898 的數字是 `~/.claude/projects` 底下的**全部** jsonl，其中絕大多數在
巢狀的 `<session-id>/` 目錄裡，而 scan 刻意不遞迴。

### 教訓：外部 wall-clock 在忙碌的機器上量不出東西

三個獨立的量測都掉進同一個坑（我的、reviewer 的、以及計畫早先的紀錄）。
可用的做法，依可信度排序：

1. **行程內部的 `process.uptime()`** —— 完全避開外部排程
2. **交錯取樣後取最小值** —— 負載只會讓時間變長，不會變短
3. 單次 `time` —— 不可信，除非機器確定是空的

`src/cli/menu.test.ts` 的兩條效能斷言已經改用第 2 種（五次取最小）。

### 桌面 widget 的 10 秒間隔

保留，但理由要說準：不是因為 helm 慢，而是 Übersicht 把 `refreshFrequency`
**同時當成 HTTP 逾時**（`client.js` 的 `runShellCommand(...).timeout(...)`），
而這台機器的常態就是同時跑好幾個 agent。實測在 load 15 時外部 wall clock
會到 968ms —— 距離 5 秒仍有餘裕，但 10 秒讓這件事完全不必擔心，
而桌面看板本來就是掃一眼的東西。選單列維持 5 秒。
