# helm P1+P2 核心 CLI 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 `helm` CLI，能掃描本機所有 Claude Code session、判定哪些是異常中斷、為中斷的 session 產生交接簡報、並一鍵開啟終端機接續。

**Architecture:** 掃描式（scan-based）。不建立資料管線 —— 直接讀取 Claude Code 已寫在磁碟上的註冊表與 transcript。無 daemon、無資料庫。所有判定邏輯為純函式，I/O 集中在薄薄的 adapter 與 CLI 層。

**Tech Stack:** TypeScript on Node 24.18（原生執行 `.ts`，**不需要建置步驟**）、`node:test` 內建測試框架、`zod` 作為唯一 runtime 相依（邊界驗證）。

## Global Constraints

以下規則適用於**每一個** task，不再逐項重複：

- **不可變性（CRITICAL）**：絕不原地修改物件。所有更新函式必須回傳新物件。使用 `{...obj, field: value}`、`array.map()`、`array.filter()`，禁止 `obj.field = x`、`array.push()`、`array.sort()`（用 `[...array].sort()`）。
- **檔案大小**：單檔 200–400 行為常態，800 行為硬上限。超過就拆。
- **函式大小**：< 50 行。巢狀深度 ≤ 4 層。
- **測試覆蓋率**：80% 起跳。每個 task 都以 TDD 進行 —— 先寫失敗的測試。
- **邊界驗證**：所有外部輸入（檔案內容、`ps` 輸出、子行程結果）必須經 zod 驗證後才進入系統。
- **錯誤處理 —— 降級 ≠ 吞錯**。這兩者的差別是本專案的核心設計，reviewer 請依此判斷：
  - **允許且必要的降級**：規格 §12 表列的情況 —— 讀取外部檔案失敗、解析失敗、`gh`/`git`/`claude` 子行程失敗。這些一律回傳空值或 null 讓上層決定，**因為看板故障絕不能讓使用者正在跑的開發卡住**。每個這類 `catch` 都必須帶一行註解說明為何此處降級是對的。
  - **禁止的吞錯**：把可修復的程式錯誤、型別違規、程式邏輯錯誤靜默丟掉；或降級後對使用者謊稱成功。
  - **降級必須可見**：使用者看得到的降級（簡報產生失敗、`gh` 不可用）要在輸出中明講，不得靜靜顯示空白。
- **不硬編路徑**：所有基準目錄（`~/.claude`、`~/.helm`）由參數傳入，預設值集中在 `src/paths.ts`。這是所有測試能用 fixture 目錄的前提。
- **Node 版本下限**：24.0.0（`--experimental-strip-types` 需求）。
- **Commit 格式**：`<type>: <description>`，type 為 feat / fix / refactor / docs / test / chore。不加 Co-Authored-By（使用者全域關閉 attribution）。
- **語言**：程式碼識別字與註解用英文；CLI 對使用者輸出的文字用繁體中文台灣用語。

**規格書**：`docs/superpowers/specs/2026-08-11-helm-design.md`。本計畫涵蓋其 §15 的 P1 與 P2。

---

## File Structure

```
helm/
  package.json              # type: module, engines.node >=24, scripts
  tsconfig.json             # 僅供 tsc --noEmit 型別檢查，不產出
  src/
    paths.ts                # 所有基準路徑的唯一來源（Task 1）
    types.ts                # 跨模組共用型別（Task 2）
    adapters/
      claude-code/
        registry.ts         # 讀 ~/.claude/sessions/*.json（Task 2）
        processes.ts        # ps 查詢與 procStart 比對（Task 3）
        discover.ts         # 組合 registry + processes → DiscoveredSession（Task 3）
        transcript.ts       # transcript 解析（Task 6）
    reconcile/
      lifecycle.ts          # lifecycle 判定純函式（Task 4）
    projects/
      include.ts            # 專案納入規則純函式（Task 5）
      prefs.ts              # ~/.helm/projects.json 讀寫（Task 5）
    render/
      table.ts              # 終端機表格（純函式）（Task 5）
    cache/
      store.ts              # ~/.helm/cache.json 讀寫（Task 7）
    summarize/
      input.ts              # 組裝簡報輸入（純函式）（Task 8）
      brief.ts              # 呼叫 claude -p 產生簡報（Task 8）
    launch/
      script.ts             # AppleScript 組裝（純函式）（Task 9）
      run.ts                # 實際執行 osascript（Task 9）
    cli/
      main.ts               # 進入點與子指令分派（Task 5 起逐步擴充）
      status.ts             # helm status / scan（Task 5）
      brief.ts              # helm brief（Task 10）
      open.ts               # helm open（Task 9）
  fixtures/
    make.sh                 # 從本機真實資料擷取並匿名化（Task 1）
    claude/sessions/*.json
    claude/projects/<slug>/*.jsonl
  scripts/
    check.sh                # 型別檢查 + 測試 + 覆蓋率
```

測試檔與被測檔並置（`src/reconcile/lifecycle.test.ts`）—— 一起改動的檔案放在一起。

---

## Task 1: 專案骨架與 fixture

沒有 fixture 就無法測試任何 adapter，所以 fixture 擷取屬於骨架的一部分，不另立 task。

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/paths.ts`, `src/paths.test.ts`
- Create: `fixtures/make.sh`
- Create: `scripts/check.sh`

**Interfaces:**
- Consumes: 無（第一個 task）
- Produces:
  - `interface PathOverrides { home?: string; claudeHome?: string; helmHome?: string }`
  - `interface HelmPaths { home: string; claudeHome: string; claudeSessions: string; claudeProjects: string; helmHome: string; helmLive: string; helmBriefs: string; cacheFile: string; prefsFile: string }`
  - `resolvePaths(overrides?: PathOverrides): HelmPaths`

  注意 `HelmPaths` **包含 `home`** —— 後續 task 的專案排除規則需要它來解析 `~/Downloads`。

- [ ] **Step 1: 建立 package.json**

```json
{
  "name": "helm",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "bin": { "helm": "./src/cli/main.ts" },
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "test": "node --test \"src/**/*.test.ts\"",
    "test:cov": "node --test --experimental-test-coverage \"src/**/*.test.ts\"",
    "typecheck": "tsc --noEmit",
    "check": "bash scripts/check.sh"
  },
  "dependencies": { "zod": "^3.23.8" },
  "devDependencies": { "typescript": "^5.6.0", "@types/node": "^24.0.0" }
}
```

- [ ] **Step 2: 建立 tsconfig.json（僅型別檢查，不產出）**

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: 建立 .gitignore 與 scripts/check.sh**

`.gitignore`：
```
node_modules/
fixtures/claude/
*.log
```

`scripts/check.sh`：
```bash
#!/usr/bin/env bash
set -euo pipefail
echo "== typecheck =="; npx tsc --noEmit
echo "== test + coverage =="; node --test --experimental-test-coverage "src/**/*.test.ts"
```

執行 `chmod +x scripts/check.sh` 與 `npm install`。

- [ ] **Step 4: 寫 paths 的失敗測試**

建立 `src/paths.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePaths } from './paths.ts'

test('resolvePaths 由 home 推導出全部預設路徑', () => {
  const p = resolvePaths({ home: '/tmp/fakehome' })
  assert.equal(p.home, '/tmp/fakehome')
  assert.equal(p.claudeSessions, '/tmp/fakehome/.claude/sessions')
  assert.equal(p.claudeProjects, '/tmp/fakehome/.claude/projects')
  assert.equal(p.helmLive, '/tmp/fakehome/.helm/live')
  assert.equal(p.cacheFile, '/tmp/fakehome/.helm/cache.json')
  assert.equal(p.prefsFile, '/tmp/fakehome/.helm/projects.json')
})

test('resolvePaths 可個別覆寫且不影響其他欄位', () => {
  const p = resolvePaths({ home: '/tmp/fakehome', claudeHome: '/custom/claude' })
  assert.equal(p.claudeSessions, '/custom/claude/sessions')
  assert.equal(p.helmHome, '/tmp/fakehome/.helm')
})

test('resolvePaths 不修改傳入的 overrides 物件', () => {
  const overrides = { home: '/tmp/fakehome' }
  const snapshot = { ...overrides }
  resolvePaths(overrides)
  assert.deepEqual(overrides, snapshot)
})
```

- [ ] **Step 5: 執行測試確認失敗**

Run: `node --test src/paths.test.ts`
Expected: FAIL，錯誤訊息為找不到模組 `./paths.ts`

- [ ] **Step 6: 實作 src/paths.ts**

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface HelmPaths {
  home: string
  claudeHome: string
  claudeSessions: string
  claudeProjects: string
  helmHome: string
  helmLive: string
  helmBriefs: string
  cacheFile: string
  prefsFile: string
}

export interface PathOverrides {
  home?: string
  claudeHome?: string
  helmHome?: string
}

/** Derive every path helm touches from at most three anchors. */
export function resolvePaths(overrides: PathOverrides = {}): HelmPaths {
  const home = overrides.home ?? homedir()
  const claudeHome = overrides.claudeHome ?? join(home, '.claude')
  const helmHome = overrides.helmHome ?? join(home, '.helm')
  return {
    home,
    claudeHome,
    claudeSessions: join(claudeHome, 'sessions'),
    claudeProjects: join(claudeHome, 'projects'),
    helmHome,
    helmLive: join(helmHome, 'live'),
    helmBriefs: join(helmHome, 'briefs'),
    cacheFile: join(helmHome, 'cache.json'),
    prefsFile: join(helmHome, 'projects.json'),
  }
}
```

- [ ] **Step 7: 執行測試確認通過**

Run: `node --test src/paths.test.ts`
Expected: PASS，3 個測試全過

- [ ] **Step 8: 建立 fixtures/make.sh**

從本機真實資料擷取並匿名化。真實資料含使用者名稱與專案內容，必須替換。

**注意兩個容易踩的地方**：註解一律用英文（Global Constraints 要求；`echo` 給使用者看的訊息才用中文）；挑最大檔的 pipeline 必須避開 SIGPIPE —— `... | head -1` 在 `set -o pipefail` 下，當上游還在寫時被 `head` 關掉讀取端會回傳非零，讓 `set -e` 中止整支腳本。實測：3 個 `.jsonl` 時正常，5000 個時腳本會提前死掉。修法用 subshell 只對這條 pipeline 關掉 `pipefail`，**不要用 `|| true`** —— 那會連帶吞掉 `find` 真正的失敗，讓腳本靜默跳過 transcript fixture。

```bash
#!/usr/bin/env bash
# Build test fixtures from this machine's real Claude Code data, anonymized.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC_SESSIONS="$HOME/.claude/sessions"
SRC_PROJECTS="$HOME/.claude/projects"
REAL_USER="$(basename "$HOME")"

rm -rf "$ROOT/claude"
mkdir -p "$ROOT/claude/sessions"

# 1. Registry: take up to 3 files, rewriting the home path and username.
n=0
for f in "$SRC_SESSIONS"/*.json; do
  [ -f "$f" ] || continue
  sed "s|$HOME|/Users/testuser|g; s|$REAL_USER|testuser|g" "$f" \
    > "$ROOT/claude/sessions/$(basename "$f")"
  n=$((n+1)); [ $n -ge 3 ] && break
done

# 2. Transcript: head+tail of the largest one — keeps the shape, cuts the size.
#    pipefail is disabled for just this pipeline: `head -1` closes the read end
#    early, which SIGPIPEs `ls` and would otherwise abort the script under `set -e`.
#    Do not use `|| true` here — that would also swallow a genuine `find` failure.
big=$(set +o pipefail
      find "$SRC_PROJECTS" -name '*.jsonl' -type f -print0 \
      | xargs -0 ls -S 2>/dev/null | head -1)
if [ -n "$big" ]; then
  slug=$(basename "$(dirname "$big")" | sed "s|$REAL_USER|testuser|g")
  mkdir -p "$ROOT/claude/projects/$slug"
  out="$ROOT/claude/projects/$slug/$(basename "$big")"
  { head -200 "$big"; tail -200 "$big"; } \
    | sed "s|$HOME|/Users/testuser|g; s|$REAL_USER|testuser|g" > "$out"
  echo "transcript fixture: $out ($(wc -l < "$out") 行)"
fi

echo "註冊表 fixture: $n 個"
echo "提醒：fixtures/claude/ 已列入 .gitignore，內容不會進版控。"
```

驗證這支腳本不會提前中止（`set -e` 的 SIGPIPE 陷阱）：

```bash
bash fixtures/make.sh; echo "exit=$?"
```
Expected: 兩行「fixture:」訊息都印出來且 `exit=0`。若最後的 echo 沒印出來，就是踩到上述 pipeline 問題。

執行 `chmod +x fixtures/make.sh && bash fixtures/make.sh`，確認產出檔案存在。

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json .gitignore src/paths.ts src/paths.test.ts \
        fixtures/make.sh scripts/check.sh package-lock.json
git commit -m "chore: 專案骨架、路徑解析與 fixture 擷取腳本"
```

---

## Task 2: 共用型別與註冊表讀取

**Files:**
- Create: `src/types.ts`
- Create: `src/adapters/claude-code/registry.ts`, `src/adapters/claude-code/registry.test.ts`

**Interfaces:**
- Consumes: `resolvePaths` from Task 1
- Produces:
  - 型別 `Lifecycle`、`Confidence`、`NativeStatus`、`RegistryEntry`、`DiscoveredSession`、`LiveMarker`、`SessionState`
  - `readRegistry(sessionsDir: string): { entries: RegistryEntry[]; invalid: number }`

- [ ] **Step 1: 建立 src/types.ts**

這是純型別宣告，無邏輯，因此不需要自己的測試 —— 由使用它的模組間接覆蓋。

```ts
export type Lifecycle = 'running' | 'ended_clean' | 'crashed'
export type Confidence = 'high' | 'low'
export type NativeStatus = 'busy' | 'idle'

/** One raw ~/.claude/sessions/<PID>.json file. */
export interface RegistryEntry {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  procStart: string
  kind: string
  name: string
  status: NativeStatus | null
  updatedAt: number
}

/** A session found by an adapter, before lifecycle is decided. */
export interface DiscoveredSession {
  adapterId: string
  sessionId: string
  cwd: string
  pid: number | null
  procStart: string | null
  startedAt: number
  updatedAt: number
  nativeStatus: NativeStatus | null
  kind: string
  name: string
  transcriptPath: string | null
}

/** Contents of ~/.helm/live/<session_id>.json — always a single line. */
export interface LiveMarker {
  sessionId: string
  ts: number
  toolName: string
  summary: string
}

/** A session after lifecycle reconciliation. */
export interface SessionState extends DiscoveredSession {
  lifecycle: Lifecycle
  lifecycleConfidence: Confidence
  live: LiveMarker | null
}
```

- [ ] **Step 2: 寫 registry 的失敗測試**

建立 `src/adapters/claude-code/registry.test.ts`。測試用暫時目錄，不依賴真實 fixture，因為要涵蓋畸形輸入。

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRegistry } from './registry.ts'

function makeDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'helm-reg-'))
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body)
  }
  return dir
}

const VALID = JSON.stringify({
  pid: 60907,
  sessionId: 'f9810d2c-4c2c-474b-9dc9-05f0707a526f',
  cwd: '/Users/testuser/acme/example-service',
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
```

- [ ] **Step 3: 執行測試確認失敗**

Run: `node --test src/adapters/claude-code/registry.test.ts`
Expected: FAIL，找不到模組 `./registry.ts`

- [ ] **Step 4: 實作 registry.ts**

```ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { RegistryEntry } from '../../types.ts'

/**
 * Claude Code writes this file on start and deletes it on clean exit.
 * Unknown fields are tolerated on purpose: upstream adds fields between
 * versions, and dropping a session over an unknown key would be worse
 * than ignoring it.
 */
const RegistrySchema = z.object({
  pid: z.number().int().positive(),
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  startedAt: z.number(),
  procStart: z.string().min(1),
  kind: z.string().default('interactive'),
  name: z.string().default(''),
  status: z.enum(['busy', 'idle']).nullable().default(null),
  updatedAt: z.number().default(0),
}).passthrough()

export interface RegistryReadResult {
  entries: RegistryEntry[]
  /** Files that existed but could not be parsed. Surfaced by `helm doctor`. */
  invalid: number
}

export function readRegistry(sessionsDir: string): RegistryReadResult {
  let names: string[]
  try {
    names = readdirSync(sessionsDir).filter((n) => n.endsWith('.json'))
  } catch {
    // Degrade, don't throw: a missing or unreadable sessions directory just
    // means "no Claude Code sessions to report" — it must never take down a
    // status check the user is running mid-development.
    return { entries: [], invalid: 0 }
  }

  return names.reduce<RegistryReadResult>(
    (acc, name) => {
      const parsed = parseOne(join(sessionsDir, name))
      return parsed === null
        ? { ...acc, invalid: acc.invalid + 1 }
        : { ...acc, entries: [...acc.entries, parsed] }
    },
    { entries: [], invalid: 0 },
  )
}

function parseOne(file: string): RegistryEntry | null {
  try {
    const result = RegistrySchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    if (!result.success) return null
    const d = result.data
    return {
      pid: d.pid,
      sessionId: d.sessionId,
      cwd: d.cwd,
      startedAt: d.startedAt,
      procStart: d.procStart,
      kind: d.kind,
      name: d.name,
      status: d.status,
      updatedAt: d.updatedAt,
    }
  } catch {
    // Degrade to null (counted as `invalid`), don't throw. Two things land
    // here and both are expected: a genuinely corrupt file, and the benign
    // race where Claude Code deletes the file between our readdirSync and
    // readFileSync — which is exactly what it does on clean session exit.
    return null
  }
}
```

註解不是可選的。Global Constraints 要求每個降級的 `catch` 都說明為何此處降級是對的 —— 沒有註解的 `catch` 讀起來與吞錯無法區分。

- [ ] **Step 5: 執行測試確認通過**

Run: `node --test src/adapters/claude-code/registry.test.ts`
Expected: PASS，7 個測試全過

- [ ] **Step 6: 對真實資料做一次健全性檢查**

Run:
```bash
node --input-type=module -e "
import { readRegistry } from './src/adapters/claude-code/registry.ts'
import { resolvePaths } from './src/paths.ts'
const r = readRegistry(resolvePaths().claudeSessions)
console.log('有效:', r.entries.length, '無效:', r.invalid)
console.log(r.entries.map(e => \`\${e.pid} \${e.status} \${e.cwd}\`).join('\n'))
"
```
Expected: 列出本機所有 session，`無效: 0`。若 `無效 > 0`，表示 schema 與真實資料不符，必須修正 schema 而非放寬測試。

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/adapters/claude-code/registry.ts src/adapters/claude-code/registry.test.ts
git commit -m "feat: 共用型別與 Claude Code 註冊表讀取"
```

---

## Task 3: 行程存活性與 session 探索

**Files:**
- Create: `src/adapters/claude-code/processes.ts`, `src/adapters/claude-code/processes.test.ts`
- Create: `src/adapters/claude-code/discover.ts`, `src/adapters/claude-code/discover.test.ts`

**Interfaces:**
- Consumes: `RegistryEntry`, `DiscoveredSession` from Task 2；`readRegistry` from Task 2
- Produces:
  - `parseProcStart(s: string): number | null` — 把註冊表的 UTC 字串轉 epoch ms
  - `parseLstart(s: string): number | null` — 把 `LC_ALL=C ps -o lstart=` 的本地時間字串轉 epoch ms
  - `procStartMatches(registryProcStart: string, psLstart: string): boolean`
  - `queryProcesses(pids: number[]): Map<number, string>` — pid → lstart 原始字串，死掉的 pid 不會出現在 map 中
  - `discoverClaudeCode(paths: HelmPaths): DiscoveredSession[]`
  - `type ProcessProbe = (pids: number[]) => Map<number, string>`

**背景（實測 2026-08-11，這是本 task 最容易做錯的地方）：**

| 來源 | 樣本 | 時區 |
|---|---|---|
| 註冊表 `procStart` | `Thu Aug  6 06:16:12 2026` | **UTC** |
| `ps -o lstart=`（預設 locale） | `四 8月/ 6 14:16:12 2026` | 本地 |
| `ps -o lstart=`（`LC_ALL=C`） | `Thu Aug 6 14:16:12 2026` | 本地 |

必須加 `LC_ALL=C`，否則在中文環境下拿到的是本地化月份名稱，字串與數值解析都會失敗。兩邊正規化空白後解析成 epoch 比對，實測差距為 0 秒。容差取 ±2 秒（`ps` 的秒數可能因四捨五入差 1）。

- [ ] **Step 1: 寫 processes 的失敗測試**

建立 `src/adapters/claude-code/processes.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseProcStart, parseLstart, procStartMatches } from './processes.ts'

test('parseProcStart 將註冊表字串當作 UTC 解析', () => {
  const ms = parseProcStart('Thu Aug  6 06:16:12 2026')
  assert.equal(ms, Date.UTC(2026, 7, 6, 6, 16, 12))
})

test('parseProcStart 容忍月份與日之間的雙空格', () => {
  assert.equal(
    parseProcStart('Thu Aug  6 06:16:12 2026'),
    parseProcStart('Thu Aug 6 06:16:12 2026'),
  )
})

test('parseLstart 將 ps 輸出當作本地時間解析', () => {
  const ms = parseLstart('Thu Aug 6 14:16:12 2026')
  assert.equal(ms, new Date(2026, 7, 6, 14, 16, 12).getTime())
})

test('procStartMatches 對同一行程的兩種表示法回傳 true', () => {
  // 實測樣本：台北時區（UTC+8）下，兩者指向同一時刻
  assert.equal(
    procStartMatches('Thu Aug  6 06:16:12 2026', 'Thu Aug 6 14:16:12 2026'),
    new Date(2026, 7, 6, 14, 16, 12).getTime() === Date.UTC(2026, 7, 6, 6, 16, 12),
  )
})

test('procStartMatches 容忍 2 秒以內的誤差', () => {
  const utc = 'Thu Aug  6 06:16:12 2026'
  const localMs = Date.UTC(2026, 7, 6, 6, 16, 13)
  const local = fmtLocal(new Date(localMs))
  assert.equal(procStartMatches(utc, local), true)
})

test('procStartMatches 對相差一小時的行程回傳 false（PID 已被重用）', () => {
  const utc = 'Thu Aug  6 06:16:12 2026'
  const local = fmtLocal(new Date(Date.UTC(2026, 7, 6, 7, 16, 12)))
  assert.equal(procStartMatches(utc, local), false)
})

test('無法解析的輸入回傳 null 並使比對為 false', () => {
  assert.equal(parseProcStart('不是日期'), null)
  assert.equal(parseLstart(''), null)
  assert.equal(procStartMatches('壞掉', 'Thu Aug 6 14:16:12 2026'), false)
})

/** 產生 `LC_ALL=C ps -o lstart=` 格式的本地時間字串。 */
function fmtLocal(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n: number) => String(n).padStart(2, '0')
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`
}
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test src/adapters/claude-code/processes.test.ts`
Expected: FAIL，找不到模組 `./processes.ts`

- [ ] **Step 3: 實作 processes.ts**

```ts
import { execFileSync } from 'node:child_process'

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
}

/** Tolerance for comparing two renderings of the same process start. */
const MATCH_TOLERANCE_MS = 2000

interface Parts {
  month: number
  day: number
  hour: number
  minute: number
  second: number
  year: number
}

/** Both formats share the shape `Ddd Mmm D HH:MM:SS YYYY`, with variable spacing. */
function split(s: string): Parts | null {
  const t = s.trim().split(/\s+/)
  if (t.length !== 5) return null
  const [, mon, day, clock, year] = t
  const month = MONTHS[mon ?? '']
  const hms = (clock ?? '').split(':').map(Number)
  if (month === undefined || hms.length !== 3 || hms.some(Number.isNaN)) return null
  const [hour, minute, second] = hms as [number, number, number]
  const d = Number(day)
  const y = Number(year)
  if (!Number.isInteger(d) || !Number.isInteger(y)) return null
  return { month, day: d, hour, minute, second, year: y }
}

/** ~/.claude/sessions/<pid>.json stores procStart in UTC. */
export function parseProcStart(s: string): number | null {
  const p = split(s)
  return p === null
    ? null
    : Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second)
}

/** `LC_ALL=C ps -o lstart=` reports local time. */
export function parseLstart(s: string): number | null {
  const p = split(s)
  return p === null
    ? null
    : new Date(p.year, p.month, p.day, p.hour, p.minute, p.second).getTime()
}

/**
 * True when the live process started at the same instant the registry
 * recorded. A mismatch means the PID was recycled by an unrelated process,
 * so the original session is gone.
 */
export function procStartMatches(registryProcStart: string, psLstart: string): boolean {
  const a = parseProcStart(registryProcStart)
  const b = parseLstart(psLstart)
  if (a === null || b === null) return false
  return Math.abs(a - b) <= MATCH_TOLERANCE_MS
}

export type ProcessProbe = (pids: number[]) => Map<number, string>

/**
 * Ask the OS which of these PIDs are alive and when each started.
 * LC_ALL=C is mandatory: without it macOS renders localized month names
 * (e.g. `四 8月/ 6`) that neither parser can read.
 */
export const queryProcesses: ProcessProbe = (pids) => {
  if (pids.length === 0) return new Map()
  let out = ''
  try {
    out = execFileSync(
      'ps',
      ['-o', 'pid=,lstart=', '-p', pids.join(',')],
      { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } },
    )
  } catch {
    // ps exits non-zero when none of the PIDs exist. That is a valid answer.
    return new Map()
  }
  return out.split('\n').reduce((acc, line) => {
    const m = line.trim().match(/^(\d+)\s+(.+)$/)
    if (m === null) return acc
    const pid = Number(m[1])
    const lstart = (m[2] ?? '').trim()
    return lstart === '' ? acc : new Map(acc).set(pid, lstart)
  }, new Map<number, string>())
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `node --test src/adapters/claude-code/processes.test.ts`
Expected: PASS，7 個測試全過

- [ ] **Step 5: 對真實行程驗證 procStartMatches**

Run:
```bash
node --input-type=module -e "
import { readRegistry } from './src/adapters/claude-code/registry.ts'
import { queryProcesses, procStartMatches } from './src/adapters/claude-code/processes.ts'
import { resolvePaths } from './src/paths.ts'
const { entries } = readRegistry(resolvePaths().claudeSessions)
const live = queryProcesses(entries.map(e => e.pid))
for (const e of entries) {
  const l = live.get(e.pid)
  console.log(e.pid, l ? (procStartMatches(e.procStart, l) ? 'MATCH' : '*** MISMATCH ***') : 'DEAD')
}
"
```
Expected: 所有存活的 session 都是 `MATCH`。出現任何 `MISMATCH` 都代表解析有誤 —— 必須修正實作，不得放寬容差。

- [ ] **Step 6: 寫 discover 的失敗測試**

建立 `src/adapters/claude-code/discover.test.ts`。以注入的 `ProcessProbe` 取代真實 `ps`，讓測試不依賴系統狀態。

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePaths } from '../../paths.ts'
import { discoverClaudeCode } from './discover.ts'

function scaffold(sessions: object[], transcripts: string[] = []): string {
  const home = mkdtempSync(join(tmpdir(), 'helm-disc-'))
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  for (const s of sessions) {
    const pid = (s as { pid: number }).pid
    writeFileSync(join(home, '.claude', 'sessions', `${pid}.json`), JSON.stringify(s))
  }
  for (const t of transcripts) {
    const dir = join(home, '.claude', 'projects', t.split('/')[0] ?? '')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, t.split('/')[1] ?? ''), '{}\n')
  }
  return home
}

const BASE = {
  pid: 111,
  sessionId: 'sess-a',
  cwd: '/Users/testuser/proj',
  startedAt: 1785996974955,
  procStart: 'Thu Aug  6 06:16:12 2026',
  kind: 'interactive',
  name: 'proj-01',
  status: 'busy',
  updatedAt: 1786416587966,
}

test('探索出註冊表中的 session 並帶上 adapterId', () => {
  const home = scaffold([BASE])
  const found = discoverClaudeCode(resolvePaths({ home }))
  assert.equal(found.length, 1)
  assert.equal(found[0]?.adapterId, 'claude-code')
  assert.equal(found[0]?.sessionId, 'sess-a')
  assert.equal(found[0]?.nativeStatus, 'busy')
})

test('找得到對應的 transcript 路徑', () => {
  const slug = '-Users-testuser-proj'
  const home = scaffold([BASE], [`${slug}/sess-a.jsonl`])
  const found = discoverClaudeCode(resolvePaths({ home }))
  assert.ok(found[0]?.transcriptPath?.endsWith(`${slug}/sess-a.jsonl`))
})

test('沒有對應 transcript 時 transcriptPath 為 null', () => {
  const home = scaffold([BASE])
  const found = discoverClaudeCode(resolvePaths({ home }))
  assert.equal(found[0]?.transcriptPath, null)
})

test('探索結果依 updatedAt 由新到舊排序', () => {
  const home = scaffold([
    { ...BASE, pid: 1, sessionId: 'old', updatedAt: 1000 },
    { ...BASE, pid: 2, sessionId: 'new', updatedAt: 9000 },
  ])
  const found = discoverClaudeCode(resolvePaths({ home }))
  assert.deepEqual(found.map((f) => f.sessionId), ['new', 'old'])
})

test('探索不修改傳入的 paths 物件', () => {
  const home = scaffold([BASE])
  const paths = resolvePaths({ home })
  const snapshot = { ...paths }
  discoverClaudeCode(paths)
  assert.deepEqual(paths, snapshot)
})
```

- [ ] **Step 7: 執行測試確認失敗**

Run: `node --test src/adapters/claude-code/discover.test.ts`
Expected: FAIL，找不到模組 `./discover.ts`

- [ ] **Step 8: 實作 discover.ts**

```ts
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { HelmPaths } from '../../paths.ts'
import type { DiscoveredSession } from '../../types.ts'
import { readRegistry } from './registry.ts'

export const ADAPTER_ID = 'claude-code'

/**
 * Fast path only: reads the registry directory and locates each session's
 * transcript by path existence. Must never read a transcript's contents and
 * must never spawn a subprocess — `helm menu` calls this every five seconds
 * (spec §5.1).
 *
 * Liveness deliberately does NOT belong here. Reconciliation (Task 4) needs
 * one `ps` result for the whole session set, so `collectStatus` (Task 6)
 * makes that single call and passes it down. Probing here as well would
 * spawn `ps` twice per poll for no gain.
 */
export function discoverClaudeCode(paths: HelmPaths): DiscoveredSession[] {
  const { entries } = readRegistry(paths.claudeSessions)

  return entries
    .map((e): DiscoveredSession => ({
      adapterId: ADAPTER_ID,
      sessionId: e.sessionId,
      cwd: e.cwd,
      pid: e.pid,
      procStart: e.procStart,
      startedAt: e.startedAt,
      updatedAt: e.updatedAt,
      nativeStatus: e.status,
      kind: e.kind,
      name: e.name,
      transcriptPath: findTranscript(paths.claudeProjects, e.cwd, e.sessionId),
    }))
    .toSorted((a, b) => b.updatedAt - a.updatedAt)
}

/** Claude Code slugifies the cwd by replacing every non-alphanumeric run with `-`. */
export function slugifyCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]+/g, '-')
}

function findTranscript(projectsDir: string, cwd: string, sessionId: string): string | null {
  const candidate = join(projectsDir, slugifyCwd(cwd), `${sessionId}.jsonl`)
  return existsSync(candidate) ? candidate : null
}
```

- [ ] **Step 9: 執行測試確認通過**

Run: `node --test src/adapters/claude-code/discover.test.ts`
Expected: PASS，5 個測試全過

- [ ] **Step 10: 對真實資料驗證 slug 推導正確**

Run:
```bash
node --input-type=module -e "
import { discoverClaudeCode } from './src/adapters/claude-code/discover.ts'
import { resolvePaths } from './src/paths.ts'
const found = discoverClaudeCode(resolvePaths())
for (const f of found) console.log(f.transcriptPath ? 'OK  ' : 'MISS', f.cwd)
"
```
Expected: 絕大多數為 `OK`。若全部 `MISS`，表示 `slugifyCwd` 的規則錯了 —— 對照 `ls ~/.claude/projects/` 的實際目錄名修正。

- [ ] **Step 11: Commit**

```bash
git add src/adapters/claude-code/processes.ts src/adapters/claude-code/processes.test.ts \
        src/adapters/claude-code/discover.ts src/adapters/claude-code/discover.test.ts
git commit -m "feat: 行程存活性查詢與 session 探索"
```

---

## Task 4: Lifecycle 判定

規格 §6 的判定表。這是整個專案語意的核心，也是唯一決定「紅點」何時亮起的地方。實作為純函式，所有 I/O 由呼叫端負責。

**Files:**
- Create: `src/reconcile/lifecycle.ts`, `src/reconcile/lifecycle.test.ts`
- Create: `src/reconcile/live.ts`, `src/reconcile/live.test.ts`

**Interfaces:**
- Consumes: `DiscoveredSession`, `SessionState`, `LiveMarker`, `Lifecycle`, `Confidence` from Task 2
- Produces:
  - `readLiveMarker(liveDir: string, sessionId: string): LiveMarker | null`
  - `decideLifecycle(input: LifecycleInput): { lifecycle: Lifecycle; confidence: Confidence }`
  - `reconcileSessions(sessions: readonly DiscoveredSession[], deps: ReconcileDeps): SessionState[]`
  - `interface ReconcileDeps { alive: Map<number, string>; readLive: (sessionId: string) => LiveMarker | null; transcriptMtimeMs: (path: string) => number | null }`
    （注意是 `readLive` 這個函式，不是 `liveDir` 字串 —— Task 6 的 `collectStatus` 會傳入
    `(id) => readLiveMarker(paths.helmLive, id)` 這個 closure）
  - `interface LifecycleInput { registryFileExists: boolean; pidAlive: boolean; psLstart: string | null; procStart: string | null; live: LiveMarker | null; transcriptMtimeMs: number | null }`

- [ ] **Step 1: 寫 lifecycle 判定的失敗測試**

規格 §6 的表格有五列，每列至少一個測試。建立 `src/reconcile/lifecycle.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideLifecycle } from './lifecycle.ts'
import type { LiveMarker } from '../types.ts'

const PROC_START = 'Thu Aug  6 06:16:12 2026'
/** Same instant rendered the way `LC_ALL=C ps` would, in the test runner's zone. */
const PS_MATCHING = fmtLocal(new Date(Date.UTC(2026, 7, 6, 6, 16, 12)))
const PS_OTHER = fmtLocal(new Date(Date.UTC(2026, 7, 6, 9, 30, 0)))

const marker = (ts: number): LiveMarker =>
  ({ sessionId: 's', ts, toolName: 'Bash', summary: 'git status' })

test('註冊表在、PID 活著、procStart 相符 → running', () => {
  const r = decideLifecycle({
    registryFileExists: true, pidAlive: true, psLstart: PS_MATCHING,
    procStart: PROC_START, live: null, transcriptMtimeMs: null,
  })
  assert.deepEqual(r, { lifecycle: 'running', confidence: 'high' })
})

test('註冊表在、PID 死了 → crashed（來不及刪檔）', () => {
  const r = decideLifecycle({
    registryFileExists: true, pidAlive: false, psLstart: null,
    procStart: PROC_START, live: null, transcriptMtimeMs: null,
  })
  assert.deepEqual(r, { lifecycle: 'crashed', confidence: 'high' })
})

test('註冊表在、PID 活著、但 procStart 不符 → crashed（PID 被重用）', () => {
  const r = decideLifecycle({
    registryFileExists: true, pidAlive: true, psLstart: PS_OTHER,
    procStart: PROC_START, live: null, transcriptMtimeMs: null,
  })
  assert.deepEqual(r, { lifecycle: 'crashed', confidence: 'high' })
})

test('註冊表不在、live 檔晚於 transcript 末筆 → crashed（當機於工具執行中）', () => {
  const r = decideLifecycle({
    registryFileExists: false, pidAlive: false, psLstart: null, procStart: null,
    live: marker(5000), transcriptMtimeMs: 4000,
  })
  assert.deepEqual(r, { lifecycle: 'crashed', confidence: 'high' })
})

test('註冊表不在、live 檔早於 transcript 末筆 → ended_clean', () => {
  const r = decideLifecycle({
    registryFileExists: false, pidAlive: false, psLstart: null, procStart: null,
    live: marker(3000), transcriptMtimeMs: 4000,
  })
  assert.deepEqual(r, { lifecycle: 'ended_clean', confidence: 'high' })
})

test('註冊表不在、無 live 檔 → ended_clean', () => {
  const r = decideLifecycle({
    registryFileExists: false, pidAlive: false, psLstart: null, procStart: null,
    live: null, transcriptMtimeMs: 4000,
  })
  assert.deepEqual(r, { lifecycle: 'ended_clean', confidence: 'high' })
})

test('註冊表不在、有 live 檔但沒有 transcript → ended_clean 且信心降為 low', () => {
  const r = decideLifecycle({
    registryFileExists: false, pidAlive: false, psLstart: null, procStart: null,
    live: marker(5000), transcriptMtimeMs: null,
  })
  assert.deepEqual(r, { lifecycle: 'ended_clean', confidence: 'low' })
})

test('註冊表在、PID 活著、但 procStart 無法解析 → crashed 且信心降為 low', () => {
  const r = decideLifecycle({
    registryFileExists: true, pidAlive: true, psLstart: '無法解析',
    procStart: PROC_START, live: null, transcriptMtimeMs: null,
  })
  assert.deepEqual(r, { lifecycle: 'crashed', confidence: 'low' })
})

function fmtLocal(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n: number) => String(n).padStart(2, '0')
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`
}
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test src/reconcile/lifecycle.test.ts`
Expected: FAIL，找不到模組 `./lifecycle.ts`

- [ ] **Step 3: 實作 lifecycle.ts**

```ts
import type { Confidence, Lifecycle, LiveMarker } from '../types.ts'
import { parseLstart, procStartMatches } from '../adapters/claude-code/processes.ts'

export interface LifecycleInput {
  /** Whether ~/.claude/sessions/<pid>.json still exists. */
  registryFileExists: boolean
  pidAlive: boolean
  /** Raw `LC_ALL=C ps -o lstart=` output for the PID, if alive. */
  psLstart: string | null
  /** Raw procStart from the registry file. */
  procStart: string | null
  live: LiveMarker | null
  transcriptMtimeMs: number | null
}

export interface LifecycleVerdict {
  lifecycle: Lifecycle
  confidence: Confidence
}

/**
 * Spec §6. Three facts drive this, all established by measurement:
 *   1. Claude Code deletes the registry file on clean exit, so a leftover
 *      file with a dead PID is a crash.
 *   2. A live PID whose start time disagrees with the registry is a
 *      recycled PID — the original session is gone.
 *   3. A live marker newer than the transcript means the last tool call
 *      never wrote its result back. That is the shape of a crash.
 *
 * The transcript itself carries no end marker, so it is used only for its
 * timestamp — never parsed for content here.
 */
export function decideLifecycle(input: LifecycleInput): LifecycleVerdict {
  if (input.registryFileExists) return fromRegistry(input)
  return fromAbsence(input)
}

function fromRegistry(input: LifecycleInput): LifecycleVerdict {
  if (!input.pidAlive) return { lifecycle: 'crashed', confidence: 'high' }
  if (input.procStart === null || input.psLstart === null) {
    return { lifecycle: 'crashed', confidence: 'low' }
  }
  if (procStartMatches(input.procStart, input.psLstart)) {
    return { lifecycle: 'running', confidence: 'high' }
  }
  // Distinguish "genuinely a different process" from "we failed to parse".
  // Ask the canonical parser rather than re-deriving its rules: a second
  // format check would drift from `parseLstart` and mislabel confidence in
  // both directions.
  const unparseable = parseLstart(input.psLstart) === null
  return { lifecycle: 'crashed', confidence: unparseable ? 'low' : 'high' }
}

function fromAbsence(input: LifecycleInput): LifecycleVerdict {
  if (input.live === null) return { lifecycle: 'ended_clean', confidence: 'high' }
  if (input.transcriptMtimeMs === null) {
    // A marker with nothing to compare against proves nothing either way.
    return { lifecycle: 'ended_clean', confidence: 'low' }
  }
  return input.live.ts > input.transcriptMtimeMs
    ? { lifecycle: 'crashed', confidence: 'high' }
    : { lifecycle: 'ended_clean', confidence: 'high' }
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `node --test src/reconcile/lifecycle.test.ts`
Expected: PASS，8 個測試全過

- [ ] **Step 5: 寫 live marker 讀取的失敗測試**

建立 `src/reconcile/live.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLiveMarker } from './live.ts'

function liveDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'helm-live-'))
  mkdirSync(dir, { recursive: true })
  for (const [n, b] of Object.entries(files)) writeFileSync(join(dir, n), b)
  return dir
}

test('讀出有效的 live marker', () => {
  const dir = liveDir({
    'sess-a.json': JSON.stringify({
      sessionId: 'sess-a', ts: 1786417000000, toolName: 'Bash', summary: 'git status',
    }),
  })
  const m = readLiveMarker(dir, 'sess-a')
  assert.equal(m?.toolName, 'Bash')
  assert.equal(m?.ts, 1786417000000)
})

test('檔案不存在回傳 null', () => {
  assert.equal(readLiveMarker(liveDir({}), 'nope'), null)
})

test('畸形內容回傳 null 而不拋錯', () => {
  const dir = liveDir({ 'sess-a.json': '{壞掉' })
  assert.equal(readLiveMarker(dir, 'sess-a'), null)
})

test('summary 過長時截斷至 200 字元', () => {
  const dir = liveDir({
    'sess-a.json': JSON.stringify({
      sessionId: 'sess-a', ts: 1, toolName: 'Bash', summary: 'x'.repeat(500),
    }),
  })
  assert.equal(readLiveMarker(dir, 'sess-a')?.summary.length, 200)
})

test('session id 含路徑分隔字元時拒絕讀取（防目錄穿越）', () => {
  assert.equal(readLiveMarker(liveDir({}), '../../etc/passwd'), null)
})
```

- [ ] **Step 6: 執行測試確認失敗**

Run: `node --test src/reconcile/live.test.ts`
Expected: FAIL，找不到模組 `./live.ts`

- [ ] **Step 7: 實作 live.ts**

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { LiveMarker } from '../types.ts'

const MAX_SUMMARY = 200

const LiveSchema = z.object({
  sessionId: z.string().min(1),
  ts: z.number(),
  toolName: z.string().default(''),
  summary: z.string().default(''),
}).passthrough()

/**
 * Written by the PreToolUse hook, one line, overwritten each call.
 * helm owns this file — Claude Code never touches it — so it survives
 * upstream cleaning of the session registry (spec §4.3).
 */
export function readLiveMarker(liveDir: string, sessionId: string): LiveMarker | null {
  // Session ids come from parsed files, but they end up in a path, so treat
  // them as untrusted anyway.
  if (sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..')) {
    return null
  }
  try {
    const raw = readFileSync(join(liveDir, `${sessionId}.json`), 'utf8')
    const parsed = LiveSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return null
    const d = parsed.data
    return {
      sessionId: d.sessionId,
      ts: d.ts,
      toolName: d.toolName,
      summary: d.summary.slice(0, MAX_SUMMARY),
    }
  } catch {
    return null
  }
}
```

- [ ] **Step 8: 執行測試確認通過**

Run: `node --test src/reconcile/live.test.ts`
Expected: PASS，5 個測試全過

- [ ] **Step 9: 寫 reconcileSessions 的失敗測試**

把 discover 的輸出接到判定上。追加到 `src/reconcile/lifecycle.test.ts` 檔尾：

```ts
import { reconcileSessions } from './lifecycle.ts'
import type { DiscoveredSession } from '../types.ts'

const session = (over: Partial<DiscoveredSession> = {}): DiscoveredSession => ({
  adapterId: 'claude-code', sessionId: 's1', cwd: '/p', pid: 111,
  procStart: PROC_START, startedAt: 1, updatedAt: 2, nativeStatus: 'idle',
  kind: 'interactive', name: 'n', transcriptPath: '/t/s1.jsonl', ...over,
})

test('reconcileSessions 為每個 session 附上 lifecycle 與 live', () => {
  const out = reconcileSessions([session()], {
    alive: new Map([[111, PS_MATCHING]]),
    readLive: () => null,
    transcriptMtimeMs: () => 4000,
  })
  assert.equal(out.length, 1)
  assert.equal(out[0]?.lifecycle, 'running')
  assert.equal(out[0]?.live, null)
})

test('reconcileSessions 不修改輸入陣列或其元素', () => {
  const input = [session()]
  const snapshot = structuredClone(input)
  reconcileSessions(input, {
    alive: new Map(), readLive: () => null, transcriptMtimeMs: () => null,
  })
  assert.deepEqual(input, snapshot)
})

test('PID 為 null（例如非 Claude Code adapter）時視為註冊表不存在', () => {
  const out = reconcileSessions([session({ pid: null, procStart: null })], {
    alive: new Map(), readLive: () => null, transcriptMtimeMs: () => 4000,
  })
  assert.equal(out[0]?.lifecycle, 'ended_clean')
})
```

- [ ] **Step 10: 執行測試確認失敗**

Run: `node --test src/reconcile/lifecycle.test.ts`
Expected: FAIL，`reconcileSessions` 不存在

- [ ] **Step 11: 在 lifecycle.ts 追加 reconcileSessions**

```ts
import type { DiscoveredSession, SessionState } from '../types.ts'

export interface ReconcileDeps {
  /** pid → raw `ps` lstart string. Absent key means the PID is dead. */
  alive: Map<number, string>
  readLive: (sessionId: string) => LiveMarker | null
  transcriptMtimeMs: (path: string) => number | null
}

export function reconcileSessions(
  sessions: readonly DiscoveredSession[],
  deps: ReconcileDeps,
): SessionState[] {
  return sessions.map((s) => {
    const live = deps.readLive(s.sessionId)
    const psLstart = s.pid === null ? null : (deps.alive.get(s.pid) ?? null)
    const verdict = decideLifecycle({
      // A session discovered from the registry always has a PID; anything
      // without one was found some other way, so treat the registry as absent.
      registryFileExists: s.pid !== null,
      pidAlive: psLstart !== null,
      psLstart,
      procStart: s.procStart,
      live,
      transcriptMtimeMs:
        s.transcriptPath === null ? null : deps.transcriptMtimeMs(s.transcriptPath),
    })
    return { ...s, lifecycle: verdict.lifecycle, lifecycleConfidence: verdict.confidence, live }
  })
}
```

- [ ] **Step 12: 執行測試確認通過**

Run: `node --test src/reconcile/`
Expected: PASS，lifecycle 11 個 + live 5 個測試全過

- [ ] **Step 13: Commit**

```bash
git add src/reconcile/
git commit -m "feat: lifecycle 判定與 live marker 讀取"
```

---

## Task 5: 專案分組、納入規則與使用者偏好

session 是以 `cwd` 歸屬到專案的。規格 §7 定義了哪些專案該出現在看板上。使用者偏好（pin / hide）是唯一不可重建的資料，因此獨立存於 `~/.helm/projects.json`。

**Files:**
- Create: `src/projects/include.ts`, `src/projects/include.test.ts`
- Create: `src/projects/prefs.ts`, `src/projects/prefs.test.ts`
- Create: `src/projects/group.ts`, `src/projects/group.test.ts`

**Interfaces:**
- Consumes: `SessionState` from Task 2；`resolvePaths` from Task 1
- Produces:
  - `interface ProjectPrefs { pinned: boolean; hidden: boolean }`
  - `interface PrefsFile { version: 1; projects: Record<string, ProjectPrefs> }`
  - `readPrefs(prefsFile: string): PrefsFile`
  - `writePrefs(prefsFile: string, prefs: PrefsFile): void`
  - `setProjectPref(prefs: PrefsFile, path: string, patch: Partial<ProjectPrefs>): PrefsFile`（回傳新物件）
  - `interface IncludeInput { path: string; cwdExists: boolean; isGitRepo: boolean; lastActivityMs: number; nowMs: number; prefs: ProjectPrefs | undefined; home?: string }`（`home` 用於解析 `~/Downloads` 這類 home 相對的排除規則）
  - `EXCLUDED_HOME_RELATIVE: readonly string[]`
  - `shouldInclude(i: IncludeInput): boolean`
  - `ACTIVITY_WINDOW_DAYS = 14`、`EXCLUDED_PREFIXES: readonly string[]`
  - `interface ProjectView { path: string; name: string; pinned: boolean; lastActivityMs: number; sessions: SessionState[] }`
  - `groupIntoProjects(sessions: readonly SessionState[], deps: GroupDeps): ProjectView[]`
  - `interface GroupDeps { prefs: PrefsFile; nowMs: number; cwdExists: (p: string) => boolean; isGitRepo: (p: string) => boolean; home: string }`

- [ ] **Step 1: 寫納入規則的失敗測試**

建立 `src/projects/include.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldInclude, ACTIVITY_WINDOW_DAYS } from './include.ts'

const NOW = Date.UTC(2026, 7, 11, 3, 0, 0)
const DAY = 86_400_000

const base = {
  path: '/Users/testuser/proj',
  cwdExists: true,
  isGitRepo: true,
  lastActivityMs: NOW - DAY,
  nowMs: NOW,
  prefs: undefined,
}

test('活躍的 git 專案會被納入', () => {
  assert.equal(shouldInclude(base), true)
})

test('cwd 不存在則排除', () => {
  assert.equal(shouldInclude({ ...base, cwdExists: false }), false)
})

test('非 git repo 則排除', () => {
  assert.equal(shouldInclude({ ...base, isGitRepo: false }), false)
})

test(`超過 ${ACTIVITY_WINDOW_DAYS} 天沒活動則排除`, () => {
  const stale = NOW - (ACTIVITY_WINDOW_DAYS + 1) * DAY
  assert.equal(shouldInclude({ ...base, lastActivityMs: stale }), false)
})

test('剛好在窗口邊界內仍納入', () => {
  const edge = NOW - (ACTIVITY_WINDOW_DAYS * DAY) + 1000
  assert.equal(shouldInclude({ ...base, lastActivityMs: edge }), true)
})

test('hidden 的專案一律排除，即使活躍', () => {
  assert.equal(
    shouldInclude({ ...base, prefs: { pinned: false, hidden: true } }),
    false,
  )
})

test('pinned 的專案不受活動窗口限制', () => {
  const ancient = NOW - 400 * DAY
  assert.equal(
    shouldInclude({ ...base, lastActivityMs: ancient, prefs: { pinned: true, hidden: false } }),
    true,
  )
})

test('pinned 但 cwd 已不存在仍排除（路徑已失效）', () => {
  assert.equal(
    shouldInclude({ ...base, cwdExists: false, prefs: { pinned: true, hidden: false } }),
    false,
  )
})

test('hidden 優先於 pinned', () => {
  assert.equal(
    shouldInclude({ ...base, prefs: { pinned: true, hidden: true } }),
    false,
  )
})

for (const p of ['/private/tmp/x', '/var/folders/fs/abc/T/y', '/Users/testuser/Downloads/z']) {
  test(`排除路徑前綴：${p}`, () => {
    assert.equal(shouldInclude({ ...base, path: p, home: '/Users/testuser' }), false)
  })
}

test('排除前綴以路徑邊界比對，不誤傷同名開頭的目錄', () => {
  // /Users/testuser/Downloads 要排除，但 /Users/testuser/Downloads-archive 不該被排除
  assert.equal(
    shouldInclude({ ...base, path: '/Users/testuser/Downloads-archive/p', home: '/Users/testuser' }),
    true,
  )
})

test('沒有傳 home 時，home 相對的排除規則不生效（但絕對路徑規則仍生效）', () => {
  assert.equal(shouldInclude({ ...base, path: '/Users/testuser/Downloads/z' }), true)
  assert.equal(shouldInclude({ ...base, path: '/private/tmp/x' }), false)
})
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test src/projects/include.test.ts`
Expected: FAIL，找不到模組 `./include.ts`

- [ ] **Step 3: 實作 include.ts**

```ts
export const ACTIVITY_WINDOW_DAYS = 14
const DAY_MS = 86_400_000

/**
 * Paths that generate session noise but are never real projects.
 * Matched on path boundaries so `/Downloads-archive` is not caught by
 * the `/Downloads` rule.
 */
export const EXCLUDED_PREFIXES: readonly string[] = [
  '/private/tmp',
  '/tmp',
  '/var/folders',
]

/** Home-relative exclusions, resolved against the caller's home directory. */
export const EXCLUDED_HOME_RELATIVE: readonly string[] = ['Downloads']

export interface ProjectPrefs {
  pinned: boolean
  hidden: boolean
}

export interface IncludeInput {
  path: string
  cwdExists: boolean
  isGitRepo: boolean
  lastActivityMs: number
  nowMs: number
  prefs: ProjectPrefs | undefined
  /** Used to resolve EXCLUDED_HOME_RELATIVE. Defaults to no home-relative exclusion. */
  home?: string
}

export function shouldInclude(i: IncludeInput): boolean {
  if (i.prefs?.hidden === true) return false
  if (!i.cwdExists) return false
  if (isExcludedPath(i.path, i.home)) return false
  if (!i.isGitRepo) return false
  if (i.prefs?.pinned === true) return true
  return i.nowMs - i.lastActivityMs < ACTIVITY_WINDOW_DAYS * DAY_MS
}

function isExcludedPath(path: string, home: string | undefined): boolean {
  const prefixes = [
    ...EXCLUDED_PREFIXES,
    ...(home === undefined
      ? []
      : EXCLUDED_HOME_RELATIVE.map((rel) => `${home}/${rel}`)),
  ]
  return prefixes.some((p) => path === p || path.startsWith(`${p}/`))
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `node --test src/projects/include.test.ts`
Expected: PASS，14 個測試全過

- [ ] **Step 5: 寫 prefs 的失敗測試**

建立 `src/projects/prefs.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPrefs, writePrefs, setProjectPref } from './prefs.ts'

const tmpFile = (body?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-prefs-'))
  const f = join(dir, 'projects.json')
  if (body !== undefined) writeFileSync(f, body)
  return f
}

test('檔案不存在時回傳空的偏好結構', () => {
  const p = readPrefs(tmpFile())
  assert.deepEqual(p, { version: 1, projects: {} })
})

test('讀出既有偏好', () => {
  const f = tmpFile(JSON.stringify({
    version: 1,
    projects: { '/a': { pinned: true, hidden: false } },
  }))
  assert.equal(readPrefs(f).projects['/a']?.pinned, true)
})

test('畸形內容回傳空結構而不拋錯（偏好毀損不得讓 CLI 掛掉）', () => {
  assert.deepEqual(readPrefs(tmpFile('{壞掉')), { version: 1, projects: {} })
})

test('writePrefs 寫出的內容可被 readPrefs 讀回', () => {
  const f = tmpFile()
  const p = { version: 1 as const, projects: { '/b': { pinned: false, hidden: true } } }
  writePrefs(f, p)
  assert.deepEqual(readPrefs(f), p)
})

test('writePrefs 會建立缺少的父目錄', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-prefs-'))
  const f = join(dir, 'nested', 'deep', 'projects.json')
  writePrefs(f, { version: 1, projects: {} })
  assert.equal(existsSync(f), true)
})

test('setProjectPref 回傳新物件且不修改原物件', () => {
  const before = { version: 1 as const, projects: { '/a': { pinned: false, hidden: false } } }
  const snapshot = structuredClone(before)
  const after = setProjectPref(before, '/a', { pinned: true })
  assert.deepEqual(before, snapshot)
  assert.equal(after.projects['/a']?.pinned, true)
  assert.equal(after.projects['/a']?.hidden, false)
  assert.notEqual(after, before)
})

test('setProjectPref 可為尚未存在的專案建立條目', () => {
  const after = setProjectPref({ version: 1, projects: {} }, '/new', { hidden: true })
  assert.deepEqual(after.projects['/new'], { pinned: false, hidden: true })
})
```

- [ ] **Step 6: 執行測試確認失敗**

Run: `node --test src/projects/prefs.test.ts`
Expected: FAIL，找不到模組 `./prefs.ts`

- [ ] **Step 7: 實作 prefs.ts**

```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { ProjectPrefs } from './include.ts'

const PrefsSchema = z.object({
  version: z.literal(1),
  projects: z.record(
    z.string(),
    z.object({ pinned: z.boolean().default(false), hidden: z.boolean().default(false) }),
  ).default({}),
})

export interface PrefsFile {
  version: 1
  projects: Record<string, ProjectPrefs>
}

const EMPTY: PrefsFile = { version: 1, projects: {} }

/**
 * ~/.helm/projects.json is the single source of truth for user intent
 * (spec §4.4). Unlike cache.json it is never auto-deleted, and a corrupt
 * file must not prevent the CLI from running.
 */
export function readPrefs(prefsFile: string): PrefsFile {
  try {
    const parsed = PrefsSchema.safeParse(JSON.parse(readFileSync(prefsFile, 'utf8')))
    return parsed.success ? { version: 1, projects: parsed.data.projects } : EMPTY
  } catch {
    return EMPTY
  }
}

export function writePrefs(prefsFile: string, prefs: PrefsFile): void {
  mkdirSync(dirname(prefsFile), { recursive: true })
  writeFileSync(prefsFile, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8')
}

/** Returns a new PrefsFile; never mutates the input. */
export function setProjectPref(
  prefs: PrefsFile,
  path: string,
  patch: Partial<ProjectPrefs>,
): PrefsFile {
  const current = prefs.projects[path] ?? { pinned: false, hidden: false }
  return {
    ...prefs,
    projects: { ...prefs.projects, [path]: { ...current, ...patch } },
  }
}
```

- [ ] **Step 8: 執行測試確認通過**

Run: `node --test src/projects/prefs.test.ts`
Expected: PASS，7 個測試全過

- [ ] **Step 9: 寫 groupIntoProjects 的失敗測試**

建立 `src/projects/group.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupIntoProjects } from './group.ts'
import type { SessionState } from '../types.ts'

const NOW = Date.UTC(2026, 7, 11, 3, 0, 0)

const sess = (over: Partial<SessionState>): SessionState => ({
  adapterId: 'claude-code', sessionId: 's', cwd: '/Users/testuser/a', pid: 1,
  procStart: null, startedAt: 0, updatedAt: NOW - 1000, nativeStatus: 'idle',
  kind: 'interactive', name: '', transcriptPath: null,
  lifecycle: 'running', lifecycleConfidence: 'high', live: null, ...over,
})

const deps = {
  prefs: { version: 1 as const, projects: {} },
  nowMs: NOW,
  cwdExists: () => true,
  isGitRepo: () => true,
  home: '/Users/testuser',
}

test('同一 cwd 的多個 session 歸為一個專案', () => {
  const out = groupIntoProjects(
    [sess({ sessionId: 'a' }), sess({ sessionId: 'b' })],
    deps,
  )
  assert.equal(out.length, 1)
  assert.equal(out[0]?.sessions.length, 2)
})

test('專案名取 cwd 的最後一段', () => {
  const out = groupIntoProjects([sess({ cwd: '/Users/testuser/acme/example-service' })], deps)
  assert.equal(out[0]?.name, 'data-svc-2.0')
})

test('lastActivityMs 取該專案所有 session 的最大值', () => {
  // 時間一律用 NOW 相對值 —— 裸 epoch 會落在 1970，直接被 14 天窗口濾掉，
  // 斷言根本跑不到。
  // 較新的那個刻意放在陣列的第二個位置：這樣「回傳第一個元素」的錯誤實作
  // 也會被抓到，而不是只抓得到「取最小值」。
  const out = groupIntoProjects(
    [sess({ sessionId: 'older', updatedAt: NOW - 900_000 }),
     sess({ sessionId: 'newer', updatedAt: NOW - 100_000 })],
    deps,
  )
  assert.equal(out[0]?.lastActivityMs, NOW - 100_000)
})

test('專案排序：pinned 優先，其次依 lastActivityMs 由新到舊', () => {
  const out = groupIntoProjects(
    [
      sess({ cwd: '/Users/testuser/fresh', updatedAt: NOW - 100 }),
      sess({ cwd: '/Users/testuser/old', updatedAt: NOW - 9000 }),
      sess({ cwd: '/Users/testuser/pinned', updatedAt: NOW - 50_000 }),
    ],
    {
      ...deps,
      prefs: {
        version: 1,
        projects: { '/Users/testuser/pinned': { pinned: true, hidden: false } },
      },
    },
  )
  assert.deepEqual(out.map((p) => p.name), ['pinned', 'fresh', 'old'])
})

test('被排除的專案不出現在結果中', () => {
  const out = groupIntoProjects(
    [sess({ cwd: '/Users/testuser/ok' }), sess({ cwd: '/private/tmp/noise' })],
    deps,
  )
  assert.deepEqual(out.map((p) => p.name), ['ok'])
})

test('非 git repo 的專案被排除', () => {
  const out = groupIntoProjects([sess({ cwd: '/Users/testuser/nogit' })], {
    ...deps,
    isGitRepo: (p) => p !== '/Users/testuser/nogit',
  })
  assert.deepEqual(out, [])
})

test('專案內的 session 依 updatedAt 由新到舊排序', () => {
  // 輸入刻意給成「舊的在前」，這樣未排序或反向排序的實作都會被抓到。
  const out = groupIntoProjects(
    [sess({ sessionId: 'old', updatedAt: NOW - 900_000 }),
     sess({ sessionId: 'new', updatedAt: NOW - 100_000 })],
    deps,
  )
  assert.deepEqual(out[0]?.sessions.map((s) => s.sessionId), ['new', 'old'])
})

test('不修改輸入的 session 陣列', () => {
  const input = [sess({ sessionId: 'a' })]
  const snapshot = structuredClone(input)
  groupIntoProjects(input, deps)
  assert.deepEqual(input, snapshot)
})
```

- [ ] **Step 10: 執行測試確認失敗**

Run: `node --test src/projects/group.test.ts`
Expected: FAIL，找不到模組 `./group.ts`

- [ ] **Step 11: 實作 group.ts**

```ts
import { basename } from 'node:path'
import type { SessionState } from '../types.ts'
import { shouldInclude } from './include.ts'
import type { PrefsFile } from './prefs.ts'

export interface ProjectView {
  path: string
  name: string
  pinned: boolean
  lastActivityMs: number
  sessions: SessionState[]
}

export interface GroupDeps {
  prefs: PrefsFile
  nowMs: number
  cwdExists: (path: string) => boolean
  isGitRepo: (path: string) => boolean
  home: string
}

/**
 * Sessions belong to a project by cwd. Filtering happens here rather than
 * in the adapter so that adapters stay dumb about user preferences.
 */
export function groupIntoProjects(
  sessions: readonly SessionState[],
  deps: GroupDeps,
): ProjectView[] {
  const byPath = sessions.reduce<Map<string, SessionState[]>>(
    (acc, s) => new Map(acc).set(s.cwd, [...(acc.get(s.cwd) ?? []), s]),
    new Map(),
  )

  return [...byPath.entries()]
    .map(([path, group]): ProjectView => ({
      path,
      name: basename(path) || path,
      pinned: deps.prefs.projects[path]?.pinned ?? false,
      lastActivityMs: Math.max(...group.map((s) => s.updatedAt)),
      sessions: [...group].toSorted((a, b) => b.updatedAt - a.updatedAt),
    }))
    .filter((p) =>
      shouldInclude({
        path: p.path,
        cwdExists: deps.cwdExists(p.path),
        isGitRepo: deps.isGitRepo(p.path),
        lastActivityMs: p.lastActivityMs,
        nowMs: deps.nowMs,
        prefs: deps.prefs.projects[p.path],
        home: deps.home,
      }),
    )
    .toSorted(byPinnedThenRecent)
}

function byPinnedThenRecent(a: ProjectView, b: ProjectView): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  return b.lastActivityMs - a.lastActivityMs
}
```

- [ ] **Step 12: 執行測試確認通過**

Run: `node --test src/projects/`
Expected: PASS，include 13 個 + prefs 7 個 + group 8 個測試全過

- [ ] **Step 13: Commit**

```bash
git add src/projects/
git commit -m "feat: 專案分組、納入規則與使用者偏好"
```

---

## Task 6: 終端機輸出與 CLI 進入點（P1 完成）

本 task 結束時 `helm status` 可用 —— 一行指令看到全部 session 與紅色斷點標記。這是第一個可交付物。

**ANSI 規則（重要）**：原始碼中一律以 `\u001b` 轉義字面量表示 ESC，**絕不貼入裸控制字元**。測試中以 `String.fromCharCode(27)` 取得同一字元。兩者都讓原始碼保持純 ASCII。

**Files:**
- Create: `src/render/glyphs.ts`, `src/render/glyphs.test.ts`
- Create: `src/render/table.ts`, `src/render/table.test.ts`
- Create: `src/cli/status.ts`, `src/cli/status.test.ts`
- Create: `src/cli/main.ts`

**Interfaces:**
- Consumes: `ProjectView` from Task 5；`SessionState`, `Confidence` from Task 2；`discoverClaudeCode`, `queryProcesses`, `ProcessProbe` from Task 3；`reconcileSessions`, `readLiveMarker` from Task 4；`readPrefs` from Task 5；`resolvePaths`, `HelmPaths` from Task 1
- Produces:
  - `type StatusKey = 'busy' | 'idle' | 'ended' | 'crashed'`
  - `statusOf(s: SessionState): StatusKey`
  - `glyph(key: StatusKey, confidence: Confidence, color: boolean): string`
  - `dim(text: string, color: boolean): string`
  - `relativeTime(fromMs: number, nowMs: number): string`
  - `interface RenderOptions { color: boolean; nowMs: number }`
  - `renderTable(projects: readonly ProjectView[], opts: RenderOptions): string`
  - `collectStatus(paths: HelmPaths, nowMs: number, probe?: ProcessProbe): ProjectView[]`
  - `currentPaths(): HelmPaths`
  - `runStatus(argv: readonly string[]): number`（回傳 process exit code）

- [ ] **Step 1: 寫 glyphs 的失敗測試**

規格 §11.1 的狀態語彙。建立 `src/render/glyphs.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statusOf, glyph, relativeTime } from './glyphs.ts'
import type { SessionState } from '../types.ts'

const ESC = String.fromCharCode(27)

const s = (over: Partial<SessionState>): SessionState => ({
  adapterId: 'claude-code', sessionId: 'x', cwd: '/p', pid: 1, procStart: null,
  startedAt: 0, updatedAt: 0, nativeStatus: null, kind: 'interactive', name: '',
  transcriptPath: null, lifecycle: 'running', lifecycleConfidence: 'high',
  live: null, ...over,
})

test('running + busy → busy', () => {
  assert.equal(statusOf(s({ lifecycle: 'running', nativeStatus: 'busy' })), 'busy')
})

test('running + idle → idle', () => {
  assert.equal(statusOf(s({ lifecycle: 'running', nativeStatus: 'idle' })), 'idle')
})

test('running 但沒有 nativeStatus → idle（保守假設在等輸入）', () => {
  assert.equal(statusOf(s({ lifecycle: 'running', nativeStatus: null })), 'idle')
})

test('crashed → crashed，不受 nativeStatus 影響', () => {
  assert.equal(statusOf(s({ lifecycle: 'crashed', nativeStatus: 'busy' })), 'crashed')
})

test('ended_clean → ended', () => {
  assert.equal(statusOf(s({ lifecycle: 'ended_clean' })), 'ended')
})

test('busy 是實心、idle 是空心', () => {
  assert.equal(glyph('busy', 'high', false), '●')
  assert.equal(glyph('idle', 'high', false), '○')
})

test('低信心的判定在字元後加問號', () => {
  assert.equal(glyph('crashed', 'low', false), '●?')
  assert.equal(glyph('crashed', 'high', false), '●')
})

test('彩色模式輸出 ANSI 序列，無色模式完全不含 ESC', () => {
  assert.ok(glyph('crashed', 'high', true).includes(ESC))
  assert.ok(!glyph('crashed', 'high', false).includes(ESC))
})

test('crashed 與 ended 使用不同顏色', () => {
  assert.notEqual(glyph('crashed', 'high', true), glyph('ended', 'high', true))
})

test('relativeTime 產生中文相對時間', () => {
  const now = Date.UTC(2026, 7, 11, 12, 0, 0)
  assert.equal(relativeTime(now - 30_000, now), '剛剛')
  assert.equal(relativeTime(now - 5 * 60_000, now), '5 分鐘前')
  assert.equal(relativeTime(now - 3 * 3_600_000, now), '3 小時前')
  assert.equal(relativeTime(now - 2 * 86_400_000, now), '2 天前')
})

test('relativeTime 對未來時間回傳「剛剛」而非負數', () => {
  const now = Date.UTC(2026, 7, 11, 12, 0, 0)
  assert.equal(relativeTime(now + 60_000, now), '剛剛')
})
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test src/render/glyphs.test.ts`
Expected: FAIL，找不到模組 `./glyphs.ts`

- [ ] **Step 3: 實作 glyphs.ts**

```ts
import type { Confidence, SessionState } from '../types.ts'

export type StatusKey = 'busy' | 'idle' | 'ended' | 'crashed'

const ESC = '\u001b'
const RESET = `${ESC}[0m`

const COLOR: Record<StatusKey, string> = {
  busy: `${ESC}[32m`,    // green
  idle: `${ESC}[32m`,    // green
  ended: `${ESC}[90m`,   // bright black
  crashed: `${ESC}[31m`, // red
}

const SHAPE: Record<StatusKey, string> = {
  busy: '●',
  idle: '○',
  ended: '●',
  crashed: '●',
}

/** Spec 11.1. A crashed session is crashed regardless of what the registry claimed. */
export function statusOf(s: SessionState): StatusKey {
  if (s.lifecycle === 'crashed') return 'crashed'
  if (s.lifecycle === 'ended_clean') return 'ended'
  return s.nativeStatus === 'busy' ? 'busy' : 'idle'
}

export function glyph(key: StatusKey, confidence: Confidence, color: boolean): string {
  const mark = `${SHAPE[key]}${confidence === 'low' ? '?' : ''}`
  return color ? `${COLOR[key]}${mark}${RESET}` : mark
}

export function dim(text: string, color: boolean): string {
  return color ? `${ESC}[90m${text}${RESET}` : text
}

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

export function relativeTime(fromMs: number, nowMs: number): string {
  const d = nowMs - fromMs
  if (d < MINUTE) return '剛剛'
  if (d < HOUR) return `${Math.floor(d / MINUTE)} 分鐘前`
  if (d < DAY) return `${Math.floor(d / HOUR)} 小時前`
  return `${Math.floor(d / DAY)} 天前`
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `node --test src/render/glyphs.test.ts`
Expected: PASS，11 個測試全過

- [ ] **Step 5: 寫 table 的失敗測試**

建立 `src/render/table.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderTable } from './table.ts'
import type { ProjectView } from '../projects/group.ts'
import type { SessionState } from '../types.ts'

const ESC = String.fromCharCode(27)
const NOW = Date.UTC(2026, 7, 11, 12, 0, 0)

const sess = (over: Partial<SessionState>): SessionState => ({
  adapterId: 'claude-code', sessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
  cwd: '/Users/testuser/proj', pid: 1, procStart: null, startedAt: 0,
  updatedAt: NOW - 5 * 60_000, nativeStatus: 'idle', kind: 'interactive',
  name: 'proj-01', transcriptPath: null, lifecycle: 'running',
  lifecycleConfidence: 'high', live: null, ...over,
})

const proj = (over: Partial<ProjectView>): ProjectView => ({
  path: '/Users/testuser/proj', name: 'proj', pinned: false,
  lastActivityMs: NOW - 5 * 60_000, sessions: [sess({})], ...over,
})

const opts = { color: false, nowMs: NOW }

test('空清單顯示提示而非空字串', () => {
  assert.match(renderTable([], opts), /沒有找到/)
})

test('列出專案名稱與相對時間', () => {
  const out = renderTable([proj({})], opts)
  assert.match(out, /proj/)
  assert.match(out, /5 分鐘前/)
})

test('crashed 的 session 標示中斷並附上 resume 提示', () => {
  const out = renderTable([proj({ sessions: [sess({ lifecycle: 'crashed' })] })], opts)
  assert.match(out, /中斷/)
  assert.match(out, /helm open/)
})

test('session id 截短為前 8 碼', () => {
  const out = renderTable([proj({})], opts)
  assert.match(out, /abcdef12/)
  assert.ok(!out.includes('abcdef12-3456-7890-abcd-ef1234567890'))
})

test('busy 時顯示 live marker 的工具與摘要', () => {
  const out = renderTable([proj({
    sessions: [sess({
      nativeStatus: 'busy',
      live: { sessionId: 'x', ts: NOW, toolName: 'Bash', summary: 'npm test' },
    })],
  })], opts)
  assert.match(out, /Bash/)
  assert.match(out, /npm test/)
})

test('idle 時忽略過時的 live marker', () => {
  const out = renderTable([proj({
    sessions: [sess({
      nativeStatus: 'idle',
      live: { sessionId: 'x', ts: NOW, toolName: 'Bash', summary: 'npm test' },
    })],
  })], opts)
  assert.ok(!out.includes('npm test'))
})

test('pinned 的專案顯示釘選記號', () => {
  assert.match(renderTable([proj({ pinned: true })], opts), /📌/)
})

test('底部摘要統計各狀態數量', () => {
  const out = renderTable([proj({
    sessions: [
      sess({ sessionId: 'a', lifecycle: 'crashed' }),
      sess({ sessionId: 'b', lifecycle: 'running', nativeStatus: 'busy' }),
    ],
  })], opts)
  assert.match(out, /中斷 1/)
  assert.match(out, /執行中 1/)
})

test('color: false 時輸出不含任何 ESC', () => {
  const out = renderTable([proj({ sessions: [sess({ lifecycle: 'crashed' })] })], opts)
  assert.ok(!out.includes(ESC))
})

test('color: true 時輸出含 ESC', () => {
  const out = renderTable([proj({})], { color: true, nowMs: NOW })
  assert.ok(out.includes(ESC))
})

test('renderTable 不修改輸入', () => {
  const input = [proj({})]
  const snapshot = structuredClone(input)
  renderTable(input, opts)
  assert.deepEqual(input, snapshot)
})
```

- [ ] **Step 6: 執行測試確認失敗**

Run: `node --test src/render/table.test.ts`
Expected: FAIL，找不到模組 `./table.ts`

- [ ] **Step 7: 實作 table.ts**

```ts
import type { ProjectView } from '../projects/group.ts'
import type { SessionState } from '../types.ts'
import { dim, glyph, relativeTime, statusOf, type StatusKey } from './glyphs.ts'

export interface RenderOptions {
  color: boolean
  nowMs: number
}

const SHORT_ID = 8

/**
 * All four labels are exactly three CJK characters wide on purpose: a CJK
 * glyph occupies two terminal columns, so padEnd() with ASCII spaces can
 * never align them. Equal length is the only thing that lines the column up.
 */
const LABEL: Record<StatusKey, string> = {
  busy: '執行中',
  idle: '等輸入',
  ended: '已結束',
  crashed: '已中斷',
}

export function renderTable(projects: readonly ProjectView[], opts: RenderOptions): string {
  if (projects.length === 0) {
    return '沒有找到符合條件的專案。\n（近 14 天內有活動、且是 git repo 的專案才會列出）\n'
  }
  const body = projects.map((p) => renderProject(p, opts)).join('\n\n')
  return `${body}\n${renderSummary(projects)}\n`
}

function renderProject(p: ProjectView, opts: RenderOptions): string {
  const head = `${p.pinned ? '📌 ' : ''}${p.name}  ${dim(p.path, opts.color)}`
  return [head, ...p.sessions.map((s) => `  ${renderSession(s, opts)}`)].join('\n')
}

function renderSession(s: SessionState, opts: RenderOptions): string {
  const key = statusOf(s)
  const head = [
    glyph(key, s.lifecycleConfidence, opts.color),
    LABEL[key],
    s.sessionId.slice(0, SHORT_ID),
    relativeTime(s.updatedAt, opts.nowMs),
  ].join('  ')
  return `${head}${liveSuffix(s)}${resumeHint(s, key, opts)}`
}

/** The live marker only means anything while the session is actually working. */
function liveSuffix(s: SessionState): string {
  if (s.live === null || s.nativeStatus !== 'busy') return ''
  const summary = s.live.summary === '' ? '' : `: ${s.live.summary}`
  return `  -> ${s.live.toolName}${summary}`
}

function resumeHint(s: SessionState, key: StatusKey, opts: RenderOptions): string {
  if (key !== 'crashed') return ''
  return `  ${dim(`helm open ${s.sessionId.slice(0, SHORT_ID)}`, opts.color)}`
}

function renderSummary(projects: readonly ProjectView[]): string {
  const counts = projects
    .flatMap((p) => p.sessions)
    .reduce<Record<StatusKey, number>>(
      (acc, s) => ({ ...acc, [statusOf(s)]: acc[statusOf(s)] + 1 }),
      { busy: 0, idle: 0, ended: 0, crashed: 0 },
    )
  const parts = (['crashed', 'busy', 'idle', 'ended'] as const)
    .filter((k) => counts[k] > 0)
    .map((k) => `${LABEL[k]} ${counts[k]}`)
  return `\n${projects.length} 個專案・${parts.join('・')}`
}
```

- [ ] **Step 8: 執行測試確認通過**

Run: `node --test src/render/table.test.ts`
Expected: PASS，11 個測試全過

- [ ] **Step 9: 寫 collectStatus 的失敗測試**

這是把前五個 task 串起來的組裝層。建立 `src/cli/status.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePaths } from '../paths.ts'
import { collectStatus } from './status.ts'

const NOW = Date.UTC(2026, 7, 11, 3, 0, 0)
/** The registry stores procStart in UTC; keep these two in sync deliberately. */
const PROC_START_UTC = 'Tue Aug 11 02:00:00 2026'
const PROC_START_INSTANT = Date.UTC(2026, 7, 11, 2, 0, 0)

function scaffold(): { home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), 'helm-status-'))
  const cwd = join(home, 'proj')
  mkdirSync(join(cwd, '.git'), { recursive: true })
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  writeFileSync(
    join(home, '.claude', 'sessions', '4242.json'),
    JSON.stringify({
      pid: 4242, sessionId: 'sess-live', cwd,
      startedAt: NOW - 60_000, procStart: PROC_START_UTC,
      kind: 'interactive', name: 'proj-01', status: 'idle', updatedAt: NOW - 60_000,
    }),
  )
  return { home, cwd }
}

test('collectStatus 串起探索、判定與分組', () => {
  const { home } = scaffold()
  const out = collectStatus(resolvePaths({ home }), NOW, () => new Map())
  assert.equal(out.length, 1)
  assert.equal(out[0]?.name, 'proj')
  assert.equal(out[0]?.sessions.length, 1)
})

test('PID 已死時判定為 crashed', () => {
  const { home } = scaffold()
  const out = collectStatus(resolvePaths({ home }), NOW, () => new Map())
  assert.equal(out[0]?.sessions[0]?.lifecycle, 'crashed')
})

test('PID 存活且 procStart 相符時判定為 running', () => {
  const { home } = scaffold()
  const alive = new Map([[4242, fmtLocal(new Date(PROC_START_INSTANT))]])
  const out = collectStatus(resolvePaths({ home }), NOW, () => alive)
  assert.equal(out[0]?.sessions[0]?.lifecycle, 'running')
})

test('沒有 .git 的目錄不會出現', () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-status-'))
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  mkdirSync(join(home, 'plain'), { recursive: true })
  writeFileSync(
    join(home, '.claude', 'sessions', '1.json'),
    JSON.stringify({
      pid: 1, sessionId: 's', cwd: join(home, 'plain'), startedAt: NOW,
      procStart: PROC_START_UTC, kind: 'interactive', name: '',
      status: 'idle', updatedAt: NOW,
    }),
  )
  assert.deepEqual(collectStatus(resolvePaths({ home }), NOW, () => new Map()), [])
})

/** Render a Date the way `LC_ALL=C ps -o lstart=` would, in local time. */
function fmtLocal(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n: number) => String(n).padStart(2, '0')
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`
}
```

- [ ] **Step 10: 執行測試確認失敗**

Run: `node --test src/cli/status.test.ts`
Expected: FAIL，找不到模組 `./status.ts`

- [ ] **Step 11: 實作 status.ts**

`collectStatus` 只做組裝、不碰 `process`；`runStatus` 負責所有與行程環境有關的事。這個分界讓組裝層可以在測試中被完整驅動。

```ts
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { discoverClaudeCode } from '../adapters/claude-code/discover.ts'
import { queryProcesses, type ProcessProbe } from '../adapters/claude-code/processes.ts'
import { resolvePaths, type HelmPaths } from '../paths.ts'
import { groupIntoProjects, type ProjectView } from '../projects/group.ts'
import { readPrefs } from '../projects/prefs.ts'
import { reconcileSessions } from '../reconcile/lifecycle.ts'
import { readLiveMarker } from '../reconcile/live.ts'
import { renderTable } from '../render/table.ts'

/** Fast path: no transcript parsing, no network, no LLM (spec 5.1). */
export function collectStatus(
  paths: HelmPaths,
  nowMs: number,
  probe: ProcessProbe = queryProcesses,
): ProjectView[] {
  const discovered = discoverClaudeCode(paths)
  const alive = probe(discovered.flatMap((d) => (d.pid === null ? [] : [d.pid])))
  const states = reconcileSessions(discovered, {
    alive,
    readLive: (id) => readLiveMarker(paths.helmLive, id),
    transcriptMtimeMs: mtimeMs,
  })
  return groupIntoProjects(states, {
    prefs: readPrefs(paths.prefsFile),
    nowMs,
    cwdExists: existsSync,
    isGitRepo: (p) => existsSync(join(p, '.git')),
    home: paths.home,
  })
}

function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

export function runStatus(argv: readonly string[]): number {
  const now = Date.now()
  const projects = collectStatus(currentPaths(), now)
  const output = argv.includes('--json')
    ? `${JSON.stringify(projects, null, 2)}\n`
    : renderTable(projects, { color: useColor(argv), nowMs: now })
  process.stdout.write(output)
  return 0
}

/** HELM_FAKE_HOME lets end-to-end tests drive the real CLI against a fixture. */
export function currentPaths(): HelmPaths {
  const home = process.env['HELM_FAKE_HOME']
  return home === undefined ? resolvePaths() : resolvePaths({ home })
}

function useColor(argv: readonly string[]): boolean {
  if (argv.includes('--no-color')) return false
  if (process.env['NO_COLOR'] !== undefined) return false
  return process.stdout.isTTY === true
}
```

- [ ] **Step 12: 執行測試確認通過**

Run: `node --test src/cli/status.test.ts`
Expected: PASS，4 個測試全過

- [ ] **Step 13: 實作 CLI 進入點 main.ts**

```ts
#!/usr/bin/env node
import { runStatus } from './status.ts'

const USAGE = `helm — 本機 agent CLI 艦隊看板

用法：
  helm status [--json] [--no-color]   列出所有專案與 session 狀態
  helm scan                           等同 helm status --json
  helm help                           顯示本說明
`

function main(argv: readonly string[]): number {
  const [command = 'status', ...rest] = argv
  switch (command) {
    case 'status':
      return runStatus(rest)
    case 'scan':
      return runStatus([...rest, '--json'])
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE)
      return 0
    default:
      process.stderr.write(`未知指令：${command}\n\n${USAGE}`)
      return 2
  }
}

process.exitCode = main(process.argv.slice(2))
```

執行 `chmod +x src/cli/main.ts`。

- [ ] **Step 14: 對真實資料執行，驗收 P1**

Run: `node src/cli/main.ts status`
Expected: 列出本機所有 git 專案與其 session，含狀態圓點與相對時間。以 `ls ~/.claude/sessions/*.json | wc -l` 對照 session 總數是否合理（部分會因非 git repo 或超過 14 天而不顯示）。

Run: `node src/cli/main.ts scan | head -30`
Expected: 合法 JSON。

Run: `node src/cli/main.ts nonsense; echo "exit=$?"`
Expected: 顯示未知指令與用法，`exit=2`。

- [ ] **Step 15: 執行完整檢查**

Run: `bash scripts/check.sh`
Expected: 型別檢查無誤；全部測試通過；覆蓋率 ≥ 80%。覆蓋率不足時補測試，不得調降標準。

- [ ] **Step 16: Commit**

```bash
git add src/render/ src/cli/
git commit -m "feat: 終端機表格輸出與 helm status 指令"
```

**P1 完成。** 此時 `helm status` 已能回答「哪個專案做到哪、哪些 session 中斷了」。

---

## Task 7: Transcript 解析（慢速路徑）

交接簡報的原料。這是唯一會讀 transcript 的模組，**絕不可被 `collectStatus` 呼叫**（規格 §5.1 的效能契約）。

**實測結構**（樣本 7679 行）：
- `type: 'user'`，`message.content` 可能是字串，或是 block 陣列（含 `text` 或 `tool_result`）
- `type: 'assistant'`，`message.content` 是 block 陣列，`tool_use` block 含 `name` 與 `input`
- 每筆 `user` 記錄另有 `timestamp`、`cwd`、`gitBranch`
- 整份檔案 1451 筆 `tool_use`，但**純文字 user prompt 只有 224 筆**
- 系統注入的內容會混在 user 訊息裡，必須排除。**判斷依據是記錄上的 `isMeta` 欄位，不是文字前綴。**

**關於 `isMeta`（這是本 task 最關鍵的一件事）**：另一份 transcript 的實測顯示，僅用「以 `<` 開頭」當過濾規則會讓 **35% 的雜訊穿透** —— 圖片貼上時的自動 caption（`[Image: original 1080x2400, ...]`）與 skill 重新載入的注入訊息（`(Re-invocation of /superpowers:... )`、`Base directory for this skill: ...`）都不以 `<` 開頭。

而 transcript 本身早就標好了。同一份檔案的實測：

| 條件 | 筆數 | 內容性質 |
|---|---|---|
| `isMeta: true` | 80 | **全部**是合成內容，0 例外 |
| `isMeta` 非 true 且不以 `<` 開頭 | 37 | **全部**是真人輸入（「實機測試」「不要用 project-foxtrot，用真實機器測試」…） |
| `isMeta` 非 true 卻是合成內容 | **0** | 交叉檢查無誤判 |

所以過濾規則是：**先排除 `isMeta === true` 的記錄**，再排除以 `<` 開頭的文字當作補強（涵蓋沒有 `isMeta` 標記的舊版格式）。單靠前綴猜測是不夠的。

**Files:**
- Create: `src/adapters/claude-code/transcript.ts`, `src/adapters/claude-code/transcript.test.ts`

**Interfaces:**
- Consumes: 無（獨立解析器）
- Produces:
  - `interface ToolCall { ts: number; name: string; summary: string }`
  - `interface TranscriptDigest { prompts: string[]; touchedFiles: string[]; recentTools: ToolCall[]; lastTs: number | null; gitBranch: string | null }`
  - `readTranscriptDigest(path: string, limits?: DigestLimits): TranscriptDigest`
  - `interface DigestLimits { prompts: number; files: number; tools: number }`
  - `DEFAULT_LIMITS: DigestLimits`（`{ prompts: 20, files: 50, tools: 3 }`，對應規格 §8）

- [ ] **Step 1: 寫 transcript 解析的失敗測試**

建立 `src/adapters/claude-code/transcript.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTranscriptDigest, DEFAULT_LIMITS } from './transcript.ts'

function jsonl(records: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'helm-tr-'))
  const f = join(dir, 's.jsonl')
  writeFileSync(f, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return f
}

const userText = (text: string, ts: string) => ({
  type: 'user', timestamp: ts, cwd: '/p', gitBranch: 'main',
  message: { content: [{ type: 'text', text }] },
})

const userStringContent = (text: string, ts: string) => ({
  type: 'user', timestamp: ts, message: { content: text },
})

const toolUse = (name: string, input: object, ts: string) => ({
  type: 'assistant', timestamp: ts,
  message: { content: [{ type: 'tool_use', name, input }] },
})

test('抽出純文字 user prompt', () => {
  const f = jsonl([
    userText('修好登入流程', '2026-08-11T01:00:00.000Z'),
    userText('繼續跑最終 review', '2026-08-11T02:00:00.000Z'),
  ])
  assert.deepEqual(readTranscriptDigest(f).prompts, ['修好登入流程', '繼續跑最終 review'])
})

test('message.content 為字串時也能抽出', () => {
  const f = jsonl([userStringContent('目前狀況？', '2026-08-11T01:00:00.000Z')])
  assert.deepEqual(readTranscriptDigest(f).prompts, ['目前狀況？'])
})

test('排除 tool_result 內容，不當成使用者說的話', () => {
  const f = jsonl([{
    type: 'user', timestamp: '2026-08-11T01:00:00.000Z',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '一堆輸出' }] },
  }])
  assert.deepEqual(readTranscriptDigest(f).prompts, [])
})

test('排除 isMeta 標記的注入內容 —— 即使它不以尖括號開頭', () => {
  // 實測：圖片 caption 與 skill 重載訊息都不以 < 開頭，只靠前綴會漏 35%
  const f = jsonl([
    { ...userText('[Image: original 1080x2400, displayed at 900x2000.]', '2026-08-11T01:00:00.000Z'), isMeta: true },
    { ...userText('(Re-invocation of /superpowers:brainstorming)', '2026-08-11T01:30:00.000Z'), isMeta: true },
    userText('實機測試', '2026-08-11T02:00:00.000Z'),
  ])
  assert.deepEqual(readTranscriptDigest(f).prompts, ['實機測試'])
})

test('尖括號規則作為補強，涵蓋沒有 isMeta 標記的舊格式', () => {
  const f = jsonl([
    userText('<task-notification><task-id>abc</task-id></task-notification>', '2026-08-11T01:00:00.000Z'),
    userText('真的使用者訊息', '2026-08-11T02:00:00.000Z'),
  ])
  assert.deepEqual(readTranscriptDigest(f).prompts, ['真的使用者訊息'])
})

test('isMeta 為 false 的內容照常保留', () => {
  const f = jsonl([
    { ...userText('這是我打的字', '2026-08-11T01:00:00.000Z'), isMeta: false },
  ])
  assert.deepEqual(readTranscriptDigest(f).prompts, ['這是我打的字'])
})

test('只保留最後 N 則 prompt', () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    userText(`p${i}`, `2026-08-11T01:00:${String(i).padStart(2, '0')}.000Z`))
  const d = readTranscriptDigest(jsonl(many), { prompts: 5, files: 50, tools: 3 })
  assert.deepEqual(d.prompts, ['p25', 'p26', 'p27', 'p28', 'p29'])
})

test('從 Edit/Write 的 tool_use 抽出碰過的檔案並去重', () => {
  const f = jsonl([
    toolUse('Edit', { file_path: '/p/a.ts' }, '2026-08-11T01:00:00.000Z'),
    toolUse('Write', { file_path: '/p/b.ts' }, '2026-08-11T01:01:00.000Z'),
    toolUse('Edit', { file_path: '/p/a.ts' }, '2026-08-11T01:02:00.000Z'),
    toolUse('Read', { file_path: '/p/c.ts' }, '2026-08-11T01:03:00.000Z'),
  ])
  assert.deepEqual(readTranscriptDigest(f).touchedFiles, ['/p/a.ts', '/p/b.ts'])
})

test('最後 N 筆工具呼叫，Bash 保留完整指令', () => {
  const f = jsonl([
    toolUse('Read', { file_path: '/x' }, '2026-08-11T01:00:00.000Z'),
    toolUse('Bash', { command: 'npm test -- --watch=false' }, '2026-08-11T01:01:00.000Z'),
  ])
  const d = readTranscriptDigest(f, { prompts: 20, files: 50, tools: 2 })
  assert.equal(d.recentTools.length, 2)
  assert.equal(d.recentTools[1]?.name, 'Bash')
  assert.equal(d.recentTools[1]?.summary, 'npm test -- --watch=false')
})

test('非 Bash 工具的 summary 取檔案路徑或縮短的輸入', () => {
  const f = jsonl([toolUse('Edit', { file_path: '/p/long/path.ts' }, '2026-08-11T01:00:00.000Z')])
  assert.equal(readTranscriptDigest(f).recentTools[0]?.summary, '/p/long/path.ts')
})

test('lastTs 取最後一筆有時間戳的記錄', () => {
  const f = jsonl([
    userText('a', '2026-08-11T01:00:00.000Z'),
    { type: 'ai-title', aiTitle: 'Clone codebase' },
    userText('b', '2026-08-11T03:00:00.000Z'),
  ])
  assert.equal(readTranscriptDigest(f).lastTs, Date.parse('2026-08-11T03:00:00.000Z'))
})

test('gitBranch 取最後一筆有記錄的值', () => {
  const f = jsonl([
    { ...userText('a', '2026-08-11T01:00:00.000Z'), gitBranch: 'old' },
    { ...userText('b', '2026-08-11T02:00:00.000Z'), gitBranch: 'feature/x' },
  ])
  assert.equal(readTranscriptDigest(f).gitBranch, 'feature/x')
})

test('content block 形狀不對時只跳過該 block，不讓整份 digest 崩潰', () => {
  // {type:'text'} 缺 text 欄位會通過 union 的 OtherBlock（passthrough），
  // 用 b.type === 'text' 判斷再 cast 會拿到 undefined 並在 .trim() 炸掉。
  const f = jsonl([
    { type: 'user', timestamp: '2026-08-11T01:00:00.000Z',
      message: { content: [{ type: 'text' }] } },
    { type: 'user', timestamp: '2026-08-11T01:30:00.000Z',
      message: { content: [{ type: 'text', text: 123 }] } },
    userText('真的訊息', '2026-08-11T02:00:00.000Z'),
  ])
  assert.deepEqual(readTranscriptDigest(f).prompts, ['真的訊息'])
})

test('tool_use block 形狀不對時同樣只跳過該 block', () => {
  const f = jsonl([
    { type: 'assistant', timestamp: '2026-08-11T01:00:00.000Z',
      message: { content: [{ type: 'tool_use', input: 'not-an-object' }] } },
    toolUse('Bash', { command: 'npm test' }, '2026-08-11T02:00:00.000Z'),
  ])
  const d = readTranscriptDigest(f)
  assert.equal(d.recentTools.length, 1)
  assert.equal(d.recentTools[0]?.summary, 'npm test')
})

test('畸形行被跳過，不影響其餘解析', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-tr-'))
  const f = join(dir, 's.jsonl')
  writeFileSync(f, `{壞掉\n${JSON.stringify(userText('好的', '2026-08-11T01:00:00.000Z'))}\n`)
  assert.deepEqual(readTranscriptDigest(f).prompts, ['好的'])
})

test('檔案不存在時回傳空 digest 而不拋錯', () => {
  const d = readTranscriptDigest('/nonexistent/x.jsonl')
  assert.deepEqual(d, {
    prompts: [], touchedFiles: [], recentTools: [], lastTs: null, gitBranch: null,
  })
})

test('DEFAULT_LIMITS 對應規格 §8 的 20 / 50 / 3', () => {
  assert.deepEqual(DEFAULT_LIMITS, { prompts: 20, files: 50, tools: 3 })
})
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test src/adapters/claude-code/transcript.test.ts`
Expected: FAIL，找不到模組 `./transcript.ts`

- [ ] **Step 3: 實作 transcript.ts**

```ts
import { readFileSync } from 'node:fs'
import { z } from 'zod'

/**
 * Transcript records are external input and go through zod like every other
 * boundary in this project. The schemas are deliberately loose — `.passthrough()`
 * and defaults everywhere — because Claude Code adds record types and fields
 * between versions, and a stricter schema would silently drop history.
 */
const TextBlock = z.object({ type: z.literal('text'), text: z.string() })

const ToolUseBlock = z.object({
  type: z.literal('tool_use'),
  name: z.string().default(''),
  input: z.record(z.string(), z.unknown()).default({}),
})

/** Anything else (tool_result, image, …) is kept but carries no meaning here. */
const OtherBlock = z.object({ type: z.string() }).passthrough()

const ContentBlock = z.union([TextBlock, ToolUseBlock, OtherBlock])

const RecordSchema = z.object({
  type: z.string().default(''),
  timestamp: z.string().optional(),
  gitBranch: z.string().optional(),
  /** Claude Code marks synthesized user content with this. See isHumanRecord. */
  isMeta: z.boolean().optional(),
  message: z.object({
    content: z.union([z.string(), z.array(ContentBlock)]).optional(),
  }).passthrough().optional(),
}).passthrough()

type TranscriptRecord = z.infer<typeof RecordSchema>

export interface ToolCall {
  ts: number
  name: string
  summary: string
}

export interface TranscriptDigest {
  prompts: string[]
  touchedFiles: string[]
  recentTools: ToolCall[]
  lastTs: number | null
  gitBranch: string | null
}

export interface DigestLimits {
  prompts: number
  files: number
  tools: number
}

/** Spec 8: 20 prompts, 50 files, 3 tool calls. */
export const DEFAULT_LIMITS: DigestLimits = { prompts: 20, files: 50, tools: 3 }

const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const MAX_SUMMARY = 200

const EMPTY: TranscriptDigest = {
  prompts: [], touchedFiles: [], recentTools: [], lastTs: null, gitBranch: null,
}

/**
 * Slow path only. Never call this from collectStatus — the largest observed
 * transcript is 7679 lines and `helm menu` runs every five seconds.
 */
export function readTranscriptDigest(
  path: string,
  limits: DigestLimits = DEFAULT_LIMITS,
): TranscriptDigest {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return EMPTY
  }

  const acc = text.split('\n').reduce<TranscriptDigest>((a, line) => {
    if (line.trim() === '') return a
    const rec = safeParse(line)
    return rec === null ? a : absorb(a, rec)
  }, EMPTY)

  return {
    prompts: acc.prompts.slice(-limits.prompts),
    touchedFiles: acc.touchedFiles.slice(-limits.files),
    recentTools: acc.recentTools.slice(-limits.tools),
    lastTs: acc.lastTs,
    gitBranch: acc.gitBranch,
  }
}

function safeParse(line: string): TranscriptRecord | null {
  try {
    const parsed = RecordSchema.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : null
  } catch {
    // Degrade, don't throw: one truncated or corrupt line must not cost the
    // user the rest of their history. A partially-written last line is normal
    // for a transcript belonging to a session that is still running.
    return null
  }
}

function absorb(a: TranscriptDigest, rec: TranscriptRecord): TranscriptDigest {
  const ts = parseTs(rec.timestamp)
  const withMeta: TranscriptDigest = {
    ...a,
    lastTs: ts ?? a.lastTs,
    gitBranch: rec.gitBranch ?? a.gitBranch,
  }
  if (rec.type === 'user') return absorbUser(withMeta, rec)
  if (rec.type === 'assistant') return absorbAssistant(withMeta, rec, ts ?? 0)
  return withMeta
}

function absorbUser(a: TranscriptDigest, rec: TranscriptRecord): TranscriptDigest {
  if (!isHumanRecord(rec)) return a
  const texts = userTexts(rec).filter(isHumanText)
  return texts.length === 0 ? a : { ...a, prompts: [...a.prompts, ...texts] }
}

function absorbAssistant(
  a: TranscriptDigest,
  rec: TranscriptRecord,
  ts: number,
): TranscriptDigest {
  return blocks(rec).reduce((acc, b) => {
    if (b.type !== 'tool_use') return acc
    const file = typeof b.input['file_path'] === 'string' ? b.input['file_path'] : null
    return {
      ...acc,
      touchedFiles:
        FILE_TOOLS.has(b.name) && file !== null && !acc.touchedFiles.includes(file)
          ? [...acc.touchedFiles, file]
          : acc.touchedFiles,
      recentTools: [...acc.recentTools, { ts, name: b.name, summary: summarize(b) }],
    }
  }, a)
}

type ToolUse = z.infer<typeof ToolUseBlock>

/**
 * Re-parse each element with the specific block schema rather than testing
 * `b.type` and casting. A block like `{type:'text'}` with no `text` field
 * fails TextBlock, falls through the union to OtherBlock's passthrough, and
 * still reads as `type === 'text'` — so a cast would hand downstream code an
 * `undefined` and crash the whole digest. safeParse is the only check that
 * actually holds at runtime.
 */
function blocks(rec: TranscriptRecord): ToolUse[] {
  const content = rec.message?.content
  if (!Array.isArray(content)) return []
  return content.flatMap((b) => {
    const parsed = ToolUseBlock.safeParse(b)
    return parsed.success ? [parsed.data] : []
  })
}

function userTexts(rec: TranscriptRecord): string[] {
  const content = rec.message?.content
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap((b) => {
    const parsed = TextBlock.safeParse(b)
    return parsed.success ? [parsed.data.text] : []
  })
}

/**
 * Claude Code sets `isMeta` on user records it synthesized itself — pasted
 * image captions, skill re-invocation notices, and similar. Measured on a real
 * transcript: all 80 isMeta records were synthetic and all 37 non-isMeta plain
 * texts were genuine typing, with zero misclassifications either way. This is
 * the reliable signal; the tag-prefix rule below is only a fallback.
 */
function isHumanRecord(rec: TranscriptRecord): boolean {
  return rec.isMeta !== true
}

/**
 * Fallback for records that carry no `isMeta` marker (older transcript
 * formats). Catches tag-wrapped injections like <task-notification>, but
 * NOT caption-style ones — that is why isHumanRecord exists.
 */
function isHumanText(text: string): boolean {
  const t = text.trim()
  return t !== '' && !t.startsWith('<')
}

function summarize(b: ToolUse): string {
  const raw =
    b.name === 'Bash' && typeof b.input['command'] === 'string'
      ? b.input['command']
      : typeof b.input['file_path'] === 'string'
        ? b.input['file_path']
        : JSON.stringify(b.input)
  return raw.slice(0, MAX_SUMMARY)
}

function parseTs(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const n = Date.parse(v)
  return Number.isNaN(n) ? null : n
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `node --test src/adapters/claude-code/transcript.test.ts`
Expected: PASS，13 個測試全過

- [ ] **Step 5: 對真實 transcript 驗證**

Run:
```bash
node --input-type=module -e "
import { readTranscriptDigest } from './src/adapters/claude-code/transcript.ts'
import { execSync } from 'node:child_process'
const f = execSync(\"ls -S \$HOME/.claude/projects/*/*.jsonl | head -1\").toString().trim()
const d = readTranscriptDigest(f)
console.log('檔案:', f)
console.log('prompts:', d.prompts.length, '| 檔案:', d.touchedFiles.length,
            '| branch:', d.gitBranch)
console.log('最後三則 prompt:')
for (const p of d.prompts.slice(-3)) console.log('  -', p.slice(0, 80).replace(/\n/g, ' '))
console.log('最後的工具呼叫:', d.recentTools.map(t => t.name).join(', '))
"
```
Expected: `prompts` 的**每一筆**都是真人打的字。

**這一步要逐筆看完全部 20 筆，不是只看最後三筆。** 前一版的實作就是因為只抽查了尾巴，讓 35% 的雜訊矇混過關。以下任何一種出現在 `prompts` 裡都算失敗：

- `[Image: original 1080x2400, ...]` —— 貼圖時的自動 caption
- `(Re-invocation of /superpowers:... )` —— skill 重新載入的注入
- `Base directory for this skill: ...`
- 任何看起來像機器產生的中繼資訊

再跑一次交叉檢查，確認過濾器沒有反過來把真人輸入也濾掉：

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
const f = execSync(\"ls -S \$HOME/.claude/projects/*/*.jsonl | head -1\").toString().trim()
let meta = 0, human = 0
for (const line of readFileSync(f, 'utf8').split('\n')) {
  if (!line.trim()) continue
  let d; try { d = JSON.parse(line) } catch { continue }
  if (d.type !== 'user') continue
  const c = d.message?.content
  const texts = typeof c === 'string' ? [c]
    : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text) : []
  for (const _ of texts) d.isMeta === true ? meta++ : human++
}
console.log('isMeta 標記的:', meta, '| 未標記的:', human)
"
```

Expected: 兩個數字相加約等於該檔的純文字 user 訊息總數，且 `prompts` 的長度不超過未標記的那個數字。

- [ ] **Step 6: Commit**

```bash
git add src/adapters/claude-code/transcript.ts src/adapters/claude-code/transcript.test.ts
git commit -m "feat: transcript 解析（prompt、碰過的檔、工具呼叫）"
```

---

## Task 8: 快取與簡報輸入組裝

`cache.json` 是純衍生資料，可隨時刪除重建（規格 §4.4）。`digest` 是控制 token 花費的唯一閘門 —— transcript 沒變就不重跑 LLM。

**Files:**
- Create: `src/cache/store.ts`, `src/cache/store.test.ts`
- Create: `src/summarize/input.ts`, `src/summarize/input.test.ts`

**Interfaces:**
- Consumes: `TranscriptDigest`, `ToolCall` from Task 7；`SessionState` from Task 2
- Produces:
  - `interface Brief { goal: string; done: string[]; currentStep: string; nextStep: string; blockers: string[]; files: string[]; prs: string[] }`
  - `interface BriefEntry { digest: string; generatedAt: number; body: Brief }`
  - `interface CacheShape { version: 1; briefs: Record<string, BriefEntry>; prs: Record<string, unknown>; projects: Record<string, { name: string; gitRemote: string | null }> }`
  - `EMPTY_CACHE: CacheShape`
  - `readCache(cacheFile: string): CacheShape`
  - `writeCache(cacheFile: string, cache: CacheShape): void`
  - `setBrief(cache: CacheShape, sessionId: string, entry: BriefEntry): CacheShape`（回傳新物件）
  - `getFreshBrief(cache: CacheShape, sessionId: string, digest: string | null): Brief | null`
  - `digestOf(transcriptPath: string | null): string | null`
  - `interface SummaryInput { sessionId: string; cwd: string; gitBranch: string | null; prompts: string[]; touchedFiles: string[]; recentTools: ToolCall[]; gitDiffStat: string; gitStatusShort: string }`
  - `buildSummaryInput(session: SessionState, digest: TranscriptDigest, git: GitSnapshot): SummaryInput`
  - `interface GitSnapshot { diffStat: string; statusShort: string }`
  - `renderSummaryPrompt(input: SummaryInput): string`

- [ ] **Step 1: 寫 cache 的失敗測試**

建立 `src/cache/store.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readCache, writeCache, setBrief, getFreshBrief, digestOf, EMPTY_CACHE,
} from './store.ts'
import type { Brief } from './store.ts'

const tmpFile = (body?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-cache-'))
  const f = join(dir, 'cache.json')
  if (body !== undefined) writeFileSync(f, body)
  return f
}

const BRIEF: Brief = {
  goal: '修好登入', done: ['寫測試'], currentStep: '實作中',
  nextStep: '跑測試', blockers: [], files: ['/p/a.ts'], prs: [],
}

test('檔案不存在時回傳空快取', () => {
  assert.deepEqual(readCache(tmpFile()), EMPTY_CACHE)
})

test('毀損的快取回傳空結構，並把原檔搬到 .corrupt.json', () => {
  const f = tmpFile('{壞掉')
  assert.deepEqual(readCache(f), EMPTY_CACHE)
  assert.equal(existsSync(f.replace(/\.json$/, '.corrupt.json')), true)
})

test('writeCache 寫出的內容可被 readCache 讀回', () => {
  const f = tmpFile()
  const c = setBrief(EMPTY_CACHE, 's1', { digest: 'd1', generatedAt: 100, body: BRIEF })
  writeCache(f, c)
  assert.deepEqual(readCache(f), c)
})

test('setBrief 回傳新物件且不修改原物件', () => {
  const before = EMPTY_CACHE
  const snapshot = structuredClone(before)
  const after = setBrief(before, 's1', { digest: 'd1', generatedAt: 1, body: BRIEF })
  assert.deepEqual(before, snapshot)
  assert.equal(after.briefs['s1']?.digest, 'd1')
})

test('getFreshBrief 在 digest 相符時回傳簡報', () => {
  const c = setBrief(EMPTY_CACHE, 's1', { digest: 'd1', generatedAt: 1, body: BRIEF })
  assert.deepEqual(getFreshBrief(c, 's1', 'd1'), BRIEF)
})

test('getFreshBrief 在 digest 不符時回傳 null（已 stale）', () => {
  const c = setBrief(EMPTY_CACHE, 's1', { digest: 'd1', generatedAt: 1, body: BRIEF })
  assert.equal(getFreshBrief(c, 's1', 'd2'), null)
})

test('getFreshBrief 在 digest 為 null 時回傳 null（無法確認新鮮度）', () => {
  const c = setBrief(EMPTY_CACHE, 's1', { digest: 'd1', generatedAt: 1, body: BRIEF })
  assert.equal(getFreshBrief(c, 's1', null), null)
})

test('getFreshBrief 對未快取的 session 回傳 null', () => {
  assert.equal(getFreshBrief(EMPTY_CACHE, 'nope', 'd1'), null)
})

test('digestOf 對同一個未變動的檔案產生相同值', () => {
  const f = tmpFile('內容')
  assert.equal(digestOf(f), digestOf(f))
})

test('digestOf 在檔案變動後產生不同值', async () => {
  const f = tmpFile('a')
  const before = digestOf(f)
  await new Promise((r) => setTimeout(r, 10))
  writeFileSync(f, 'a much longer content than before')
  assert.notEqual(digestOf(f), before)
})

test('digestOf 對 null 或不存在的路徑回傳 null', () => {
  assert.equal(digestOf(null), null)
  assert.equal(digestOf('/nonexistent/x'), null)
})
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test src/cache/store.test.ts`
Expected: FAIL，找不到模組 `./store.ts`

- [ ] **Step 3: 實作 store.ts**

```ts
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

export interface Brief {
  goal: string
  done: string[]
  currentStep: string
  nextStep: string
  blockers: string[]
  files: string[]
  prs: string[]
}

export interface BriefEntry {
  /** `<byteSize>:<mtimeMs>` of the transcript when this brief was made. */
  digest: string
  generatedAt: number
  body: Brief
}

export interface CacheShape {
  version: 1
  briefs: Record<string, BriefEntry>
  prs: Record<string, unknown>
  projects: Record<string, { name: string; gitRemote: string | null }>
}

export const EMPTY_CACHE: CacheShape = { version: 1, briefs: {}, prs: {}, projects: {} }

const BriefSchema = z.object({
  goal: z.string().default(''),
  done: z.array(z.string()).default([]),
  currentStep: z.string().default(''),
  nextStep: z.string().default(''),
  blockers: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  prs: z.array(z.string()).default([]),
})

const CacheSchema = z.object({
  version: z.literal(1),
  briefs: z.record(z.string(), z.object({
    digest: z.string().min(1),
    generatedAt: z.number(),
    body: BriefSchema,
  })).default({}),
  prs: z.record(z.string(), z.unknown()).default({}),
  projects: z.record(z.string(), z.object({
    name: z.string().default(''),
    gitRemote: z.string().nullable().default(null),
  })).default({}),
})

/**
 * Everything here is derived and rebuildable. A corrupt cache must never
 * stop the CLI — it is moved aside for inspection and treated as empty.
 */
export function readCache(cacheFile: string): CacheShape {
  let raw: string
  try {
    raw = readFileSync(cacheFile, 'utf8')
  } catch {
    // Degrade, don't throw: no cache file simply means nothing has been
    // cached yet, which is the normal state on first run.
    return EMPTY_CACHE
  }
  const parsed = CacheSchema.safeParse(safeJson(raw))
  if (parsed.success) return parsed.data
  quarantine(cacheFile)
  return EMPTY_CACHE
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    // Degrade to null so the caller can quarantine and rebuild. The cache is
    // pure derived data — a truncated write (crash mid-save) must cost the
    // user a regenerated brief, never a CLI that refuses to start.
    return null
  }
}

function quarantine(cacheFile: string): void {
  try {
    renameSync(cacheFile, cacheFile.replace(/\.json$/, '.corrupt.json'))
  } catch {
    // Nothing more we can do; the caller still gets a usable empty cache.
  }
}

export function writeCache(cacheFile: string, cache: CacheShape): void {
  mkdirSync(dirname(cacheFile), { recursive: true })
  writeFileSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
}

export function setBrief(cache: CacheShape, sessionId: string, entry: BriefEntry): CacheShape {
  return { ...cache, briefs: { ...cache.briefs, [sessionId]: entry } }
}

/** Returns the cached brief only when it still matches the transcript. */
export function getFreshBrief(
  cache: CacheShape,
  sessionId: string,
  digest: string | null,
): Brief | null {
  if (digest === null) return null
  const entry = cache.briefs[sessionId]
  return entry !== undefined && entry.digest === digest ? entry.body : null
}

/** Size plus mtime is enough: an append always changes size, an edit changes mtime. */
export function digestOf(transcriptPath: string | null): string | null {
  if (transcriptPath === null) return null
  try {
    const s = statSync(transcriptPath)
    return `${s.size}:${s.mtimeMs}`
  } catch {
    // Degrade to null, which getFreshBrief treats as "cannot confirm
    // freshness" and therefore never serves a cached brief. Failing closed
    // costs one regeneration; failing open would show a stale brief.
    return null
  }
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `node --test src/cache/store.test.ts`
Expected: PASS，11 個測試全過

- [ ] **Step 5: 寫簡報輸入組裝的失敗測試**

建立 `src/summarize/input.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSummaryInput, renderSummaryPrompt } from './input.ts'
import type { SessionState } from '../types.ts'
import type { TranscriptDigest } from '../adapters/claude-code/transcript.ts'

const session: SessionState = {
  adapterId: 'claude-code', sessionId: 's1', cwd: '/Users/testuser/proj', pid: 1,
  procStart: null, startedAt: 0, updatedAt: 0, nativeStatus: null,
  kind: 'interactive', name: 'proj-01', transcriptPath: '/t/s1.jsonl',
  lifecycle: 'crashed', lifecycleConfidence: 'high', live: null,
}

const digest: TranscriptDigest = {
  prompts: ['修好登入流程', '繼續跑最終 review'],
  touchedFiles: ['/p/auth.ts'],
  recentTools: [{ ts: 1, name: 'Bash', summary: 'npm test' }],
  lastTs: 1, gitBranch: 'feature/login',
}

const git = { diffStat: ' 1 file changed, 3 insertions(+)', statusShort: ' M auth.ts' }

test('組裝出完整的簡報輸入', () => {
  const input = buildSummaryInput(session, digest, git)
  assert.equal(input.sessionId, 's1')
  assert.equal(input.cwd, '/Users/testuser/proj')
  assert.equal(input.gitBranch, 'feature/login')
  assert.deepEqual(input.prompts, digest.prompts)
  assert.equal(input.gitDiffStat, git.diffStat)
})

test('renderSummaryPrompt 含全部七欄的欄位名稱', () => {
  const p = renderSummaryPrompt(buildSummaryInput(session, digest, git))
  for (const field of
    ['goal', 'done', 'currentStep', 'nextStep', 'blockers', 'files', 'prs']) {
    assert.ok(p.includes(field), `缺少欄位 ${field}`)
  }
})

test('renderSummaryPrompt 含使用者的原話與工具呼叫', () => {
  const p = renderSummaryPrompt(buildSummaryInput(session, digest, git))
  assert.ok(p.includes('繼續跑最終 review'))
  assert.ok(p.includes('npm test'))
  assert.ok(p.includes('feature/login'))
})

test('renderSummaryPrompt 要求只輸出 JSON', () => {
  const p = renderSummaryPrompt(buildSummaryInput(session, digest, git))
  assert.match(p, /JSON/)
})

test('沒有未 commit 變更時仍能組出提示', () => {
  const p = renderSummaryPrompt(
    buildSummaryInput(session, digest, { diffStat: '', statusShort: '' }))
  assert.ok(p.includes('（無）'))
})

test('buildSummaryInput 不修改輸入', () => {
  const d = structuredClone(digest)
  buildSummaryInput(session, digest, git)
  assert.deepEqual(digest, d)
})
```

- [ ] **Step 6: 執行測試確認失敗**

Run: `node --test src/summarize/input.test.ts`
Expected: FAIL，找不到模組 `./input.ts`

- [ ] **Step 7: 實作 input.ts**

```ts
import type { ToolCall, TranscriptDigest } from '../adapters/claude-code/transcript.ts'
import type { SessionState } from '../types.ts'

export interface GitSnapshot {
  diffStat: string
  statusShort: string
}

export interface SummaryInput {
  sessionId: string
  cwd: string
  gitBranch: string | null
  prompts: string[]
  touchedFiles: string[]
  recentTools: ToolCall[]
  gitDiffStat: string
  gitStatusShort: string
}

export function buildSummaryInput(
  session: SessionState,
  digest: TranscriptDigest,
  git: GitSnapshot,
): SummaryInput {
  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    gitBranch: digest.gitBranch,
    prompts: [...digest.prompts],
    touchedFiles: [...digest.touchedFiles],
    recentTools: [...digest.recentTools],
    gitDiffStat: git.diffStat,
    gitStatusShort: git.statusShort,
  }
}

const FIELDS = `{
  "goal":        "這個 session 想達成什麼（一句話）",
  "done":        ["已經完成的事，每項一句"],
  "currentStep": "中斷當下正在做的那一步",
  "nextStep":    "回來後應該做的下一件事（具體到可以直接動手）",
  "blockers":    ["卡住的地方；沒有就空陣列"],
  "files":       ["相關檔案路徑"],
  "prs":         ["相關的 PR 編號或網址；沒有就空陣列"]
}`

/**
 * Deliberately narrow input (spec 8): the last 20 prompts, touched files,
 * uncommitted diff and the last few tool calls — roughly 3-6k tokens
 * instead of a 7679-line transcript.
 */
export function renderSummaryPrompt(input: SummaryInput): string {
  return [
    '你正在為一個中斷的開發 session 寫交接簡報，讓開發者能立刻接續工作。',
    '',
    `工作目錄：${input.cwd}`,
    `分支：${input.gitBranch ?? '（未知）'}`,
    '',
    '## 使用者最近說過的話（由舊到新）',
    orNone(input.prompts.map((p) => `- ${p}`)),
    '',
    '## 這個 session 改過的檔案',
    orNone(input.touchedFiles.map((f) => `- ${f}`)),
    '',
    '## 中斷前最後的工具呼叫',
    orNone(input.recentTools.map((t) => `- ${t.name}: ${t.summary}`)),
    '',
    '## 未 commit 的變更',
    orNone([input.gitDiffStat, input.gitStatusShort].filter((s) => s.trim() !== '')),
    '',
    '## 輸出格式',
    '只輸出一個 JSON 物件，不要有任何其他文字、不要用 markdown 程式碼圍欄。欄位如下：',
    FIELDS,
    '',
    '用繁體中文台灣用語填寫。「下一步」要具體到開發者看完就知道該動哪個檔案。',
  ].join('\n')
}

function orNone(lines: readonly string[]): string {
  return lines.length === 0 ? '（無）' : lines.join('\n')
}
```

- [ ] **Step 8: 執行測試確認通過**

Run: `node --test src/summarize/input.test.ts`
Expected: PASS，6 個測試全過

- [ ] **Step 9: Commit**

```bash
git add src/cache/ src/summarize/input.ts src/summarize/input.test.ts
git commit -m "feat: cache.json 讀寫與交接簡報輸入組裝"
```

---

## Task 9: 交接簡報產生與 `helm brief`

呼叫 headless `claude -p` 產生七欄簡報。LLM 呼叫透過注入的 runner，讓測試完全不需要真的花 token。

**Files:**
- Create: `src/summarize/git.ts`, `src/summarize/git.test.ts`
- Create: `src/summarize/brief.ts`, `src/summarize/brief.test.ts`
- Create: `src/render/brief-md.ts`, `src/render/brief-md.test.ts`
- Create: `src/cli/brief.ts`
- Modify: `src/cli/main.ts`（加入 `brief` 子指令）

**Interfaces:**
- Consumes: `Brief`, `readCache`, `writeCache`, `setBrief`, `getFreshBrief`, `digestOf` from Task 8；`SummaryInput`, `buildSummaryInput`, `renderSummaryPrompt`, `GitSnapshot` from Task 8；`readTranscriptDigest` from Task 7；`collectStatus`, `currentPaths` from Task 6
- Produces:
  - `type ClaudeRunner = (prompt: string) => Promise<string>`
  - `runClaudeHeadless: ClaudeRunner`
  - `parseBriefJson(raw: string): Brief | null`
  - `generateBrief(input: SummaryInput, run: ClaudeRunner): Promise<Brief | null>`
  - `readGitSnapshot(cwd: string): GitSnapshot`
  - `renderBriefMarkdown(brief: Brief, meta: BriefMeta): string`
  - `interface BriefMeta { sessionId: string; cwd: string; gitBranch: string | null; generatedAt: number }`
  - `renderFallback(prompts: readonly string[]): string`
  - `resolveSession(projects, idPrefix): SessionState | null`
  - `runBrief(argv: readonly string[]): Promise<number>`

- [ ] **Step 1: 寫 git snapshot 的失敗測試**

建立 `src/summarize/git.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGitSnapshot } from './git.ts'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'helm-git-'))
  const run = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  run('init', '-q')
  run('config', 'user.email', 't@example.com')
  run('config', 'user.name', 'T')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  run('add', '.')
  run('commit', '-q', '-m', 'init')
  return dir
}

test('乾淨的 repo 回傳空的 diff 與 status', () => {
  const s = readGitSnapshot(repo())
  assert.equal(s.diffStat.trim(), '')
  assert.equal(s.statusShort.trim(), '')
})

test('有未 commit 變更時回傳 diff stat 與 status', () => {
  const dir = repo()
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
  const s = readGitSnapshot(dir)
  assert.match(s.diffStat, /a\.txt/)
  assert.match(s.statusShort, /a\.txt/)
})

test('非 git 目錄回傳空值而不拋錯', () => {
  const s = readGitSnapshot(mkdtempSync(join(tmpdir(), 'helm-nogit-')))
  assert.deepEqual(s, { diffStat: '', statusShort: '' })
})

test('目錄不存在回傳空值而不拋錯', () => {
  assert.deepEqual(readGitSnapshot('/nonexistent/xyz'), { diffStat: '', statusShort: '' })
})
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test src/summarize/git.test.ts`
Expected: FAIL，找不到模組 `./git.ts`

- [ ] **Step 3: 實作 git.ts**

```ts
import { execFileSync } from 'node:child_process'
import type { GitSnapshot } from './input.ts'

const TIMEOUT_MS = 3000
const MAX_BYTES = 64 * 1024

export function readGitSnapshot(cwd: string): GitSnapshot {
  return {
    diffStat: git(cwd, ['diff', '--stat']),
    statusShort: git(cwd, ['status', '--short']),
  }
}

/** A missing repo, a detached worktree, or a slow disk must all degrade to ''. */
function git(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `node --test src/summarize/git.test.ts`
Expected: PASS，4 個測試全過

- [ ] **Step 5: 寫簡報產生的失敗測試**

建立 `src/summarize/brief.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBriefJson, generateBrief } from './brief.ts'
import type { SummaryInput } from './input.ts'

const INPUT: SummaryInput = {
  sessionId: 's1', cwd: '/p', gitBranch: 'main',
  prompts: ['修好登入'], touchedFiles: [], recentTools: [],
  gitDiffStat: '', gitStatusShort: '',
}

const VALID = JSON.stringify({
  goal: '修好登入流程', done: ['寫了測試'], currentStep: '實作 token 驗證',
  nextStep: '跑 npm test', blockers: [], files: ['/p/auth.ts'], prs: [],
})

test('解析合法的 JSON 簡報', () => {
  const b = parseBriefJson(VALID)
  assert.equal(b?.goal, '修好登入流程')
  assert.deepEqual(b?.done, ['寫了測試'])
})

test('容忍 LLM 包上的 markdown 程式碼圍欄', () => {
  const fenced = '```json\n' + VALID + '\n```'
  assert.equal(parseBriefJson(fenced)?.goal, '修好登入流程')
})

test('容忍 JSON 前後的閒聊文字', () => {
  assert.equal(parseBriefJson(`好的，這是簡報：\n${VALID}\n希望有幫助。`)?.goal, '修好登入流程')
})

test('缺少的欄位以空值補齊而非整份拒絕', () => {
  const b = parseBriefJson(JSON.stringify({ goal: '只有目標' }))
  assert.equal(b?.goal, '只有目標')
  assert.deepEqual(b?.done, [])
  assert.equal(b?.nextStep, '')
})

test('完全不是 JSON 時回傳 null', () => {
  assert.equal(parseBriefJson('抱歉我無法完成這個請求'), null)
})

test('generateBrief 把 prompt 交給 runner 並解析結果', async () => {
  let seen = ''
  const b = await generateBrief(INPUT, async (p) => { seen = p; return VALID })
  assert.ok(seen.includes('修好登入'))
  assert.equal(b?.goal, '修好登入流程')
})

test('runner 拋錯時回傳 null 而不向上拋', async () => {
  const b = await generateBrief(INPUT, async () => { throw new Error('claude 掛了') })
  assert.equal(b, null)
})

test('runner 回傳無法解析的內容時回傳 null', async () => {
  assert.equal(await generateBrief(INPUT, async () => '???'), null)
})
```

- [ ] **Step 6: 執行測試確認失敗**

Run: `node --test src/summarize/brief.test.ts`
Expected: FAIL，找不到模組 `./brief.ts`

- [ ] **Step 7: 實作 brief.ts**

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Brief } from '../cache/store.ts'
import { renderSummaryPrompt, type SummaryInput } from './input.ts'

const execFileAsync = promisify(execFile)

const CLAUDE_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 1024 * 1024

export type ClaudeRunner = (prompt: string) => Promise<string>

const BriefSchema = z.object({
  goal: z.string().default(''),
  done: z.array(z.string()).default([]),
  currentStep: z.string().default(''),
  nextStep: z.string().default(''),
  blockers: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  prs: z.array(z.string()).default([]),
})

/**
 * The prompt asks for bare JSON, but models still wrap it in fences or
 * preamble often enough that being strict here would mean losing briefs
 * we already paid for.
 */
export function parseBriefJson(raw: string): Brief | null {
  const candidate = extractJsonObject(raw)
  if (candidate === null) return null
  try {
    const parsed = BriefSchema.safeParse(JSON.parse(candidate))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Take the LAST parseable candidate, not the first. Models self-correct:
 * they emit a draft block, say "actually, let me redo that", then emit the
 * real answer. Matching the first fenced block returns the discarded draft —
 * which parses cleanly and yields a complete-looking brief built from
 * abandoned content, with no error and no signal to the user.
 */
function extractJsonObject(raw: string): string | null {
  const fenced = [...raw.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)]
    .map((m) => m[1])
    .filter((c): c is string => c !== undefined)
  const lastValid = fenced.findLast(isParseableObject)
  if (lastValid !== undefined) return lastValid

  // Unfenced fallback. JSON.parse rejects trailing content, so prose-with-braces
  // and two-bare-objects both fail closed here rather than yielding garbage.
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  return first !== -1 && last > first ? raw.slice(first, last + 1) : null
}

function isParseableObject(candidate: string): boolean {
  try {
    const v: unknown = JSON.parse(candidate)
    return typeof v === 'object' && v !== null && !Array.isArray(v)
  } catch {
    // Not a finding — this is the predicate whose whole job is to answer
    // "does this parse", so a throw here is a legitimate `false`.
    return false
  }
}

export async function generateBrief(
  input: SummaryInput,
  run: ClaudeRunner,
): Promise<Brief | null> {
  try {
    return parseBriefJson(await run(renderSummaryPrompt(input)))
  } catch {
    // A failed brief degrades to the raw-prompt fallback (spec 12); it is
    // never fatal and never silently pretends to have succeeded.
    return null
  }
}

export const runClaudeHeadless: ClaudeRunner = async (prompt) => {
  const { stdout } = await execFileAsync(
    'claude',
    ['-p', prompt, '--max-turns', '1'],
    { timeout: CLAUDE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
  )
  return stdout
}
```

- [ ] **Step 8: 執行測試確認通過**

Run: `node --test src/summarize/brief.test.ts`
Expected: PASS，8 個測試全過

- [ ] **Step 9: 寫簡報 markdown 輸出的失敗測試**

建立 `src/render/brief-md.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderBriefMarkdown, renderFallback } from './brief-md.ts'
import type { Brief } from '../cache/store.ts'

const BRIEF: Brief = {
  goal: '修好登入流程',
  done: ['寫了 token 測試', '修好 refresh 邏輯'],
  currentStep: '實作 token 驗證',
  nextStep: '跑 npm test 確認綠燈',
  blockers: ['等後端提供 JWKS 端點'],
  files: ['/p/auth.ts'],
  prs: ['#123'],
}

const META = {
  sessionId: 'abcdef12-3456', cwd: '/Users/testuser/proj',
  gitBranch: 'feature/login', generatedAt: Date.UTC(2026, 7, 11, 3, 0, 0),
}

test('七欄全部出現在輸出中', () => {
  const md = renderBriefMarkdown(BRIEF, META)
  for (const t of ['目標', '已完成', '進行到哪一步', '下一步', '卡點', '相關檔案', '相關 PR']) {
    assert.ok(md.includes(t), `缺少 ${t}`)
  }
})

test('內容值有被填進去', () => {
  const md = renderBriefMarkdown(BRIEF, META)
  assert.ok(md.includes('修好登入流程'))
  assert.ok(md.includes('跑 npm test 確認綠燈'))
  assert.ok(md.includes('等後端提供 JWKS 端點'))
  assert.ok(md.includes('feature/login'))
})

test('空的陣列欄位顯示「（無）」而非空白', () => {
  const md = renderBriefMarkdown({ ...BRIEF, blockers: [], prs: [] }, META)
  assert.ok(md.includes('（無）'))
})

test('降級輸出列出原始 prompt 並說明簡報產生失敗', () => {
  const md = renderFallback(['目前狀況？', '繼續跑最終 review'])
  assert.match(md, /簡報產生失敗/)
  assert.ok(md.includes('繼續跑最終 review'))
})

test('降級輸出在沒有 prompt 時仍給出可讀訊息', () => {
  assert.match(renderFallback([]), /沒有可用的/)
})
```

- [ ] **Step 10: 執行測試確認失敗**

Run: `node --test src/render/brief-md.test.ts`
Expected: FAIL，找不到模組 `./brief-md.ts`

- [ ] **Step 11: 實作 brief-md.ts**

```ts
import type { Brief } from '../cache/store.ts'

export interface BriefMeta {
  sessionId: string
  cwd: string
  gitBranch: string | null
  generatedAt: number
}

export function renderBriefMarkdown(brief: Brief, meta: BriefMeta): string {
  return [
    `# 交接簡報 — ${meta.cwd}`,
    '',
    `- Session：\`${meta.sessionId}\``,
    `- 分支：${meta.gitBranch ?? '（未知）'}`,
    `- 產生時間：${new Date(meta.generatedAt).toISOString()}`,
    '',
    '## 目標',
    orNone([brief.goal]),
    '',
    '## 已完成',
    bullets(brief.done),
    '',
    '## 進行到哪一步',
    orNone([brief.currentStep]),
    '',
    '## 下一步',
    orNone([brief.nextStep]),
    '',
    '## 卡點',
    bullets(brief.blockers),
    '',
    '## 相關檔案',
    bullets(brief.files),
    '',
    '## 相關 PR',
    bullets(brief.prs),
    '',
  ].join('\n')
}

/** Spec 12: a failed brief must still show the user something useful. */
export function renderFallback(prompts: readonly string[]): string {
  if (prompts.length === 0) {
    return '簡報產生失敗，而且沒有可用的原始對話內容可以顯示。\n'
  }
  return [
    '簡報產生失敗，以下是這個 session 最後幾則你說過的話：',
    '',
    ...prompts.slice(-3).map((p) => `- ${p}`),
    '',
    '（可用 `helm brief <id> --refresh` 重試）',
    '',
  ].join('\n')
}

function bullets(items: readonly string[]): string {
  return items.length === 0 ? '（無）' : items.map((i) => `- ${i}`).join('\n')
}

function orNone(items: readonly string[]): string {
  const filled = items.filter((i) => i.trim() !== '')
  return filled.length === 0 ? '（無）' : filled.join('\n')
}
```

- [ ] **Step 12: 執行測試確認通過**

Run: `node --test src/render/brief-md.test.ts`
Expected: PASS，5 個測試全過

- [ ] **Step 13: 實作 `helm brief` 指令**

建立 `src/cli/brief.ts`：

```ts
import { readTranscriptDigest } from '../adapters/claude-code/transcript.ts'
import {
  digestOf, getFreshBrief, readCache, setBrief, writeCache,
} from '../cache/store.ts'
import type { ProjectView } from '../projects/group.ts'
import { renderBriefMarkdown, renderFallback } from '../render/brief-md.ts'
import { generateBrief, runClaudeHeadless, type ClaudeRunner } from '../summarize/brief.ts'
import { readGitSnapshot } from '../summarize/git.ts'
import { buildSummaryInput } from '../summarize/input.ts'
import type { SessionState } from '../types.ts'
import { collectStatus, currentPaths } from './status.ts'

/** Accepts the 8-char short id shown by `helm status`, or a full session id. */
export function resolveSession(
  projects: readonly ProjectView[],
  idPrefix: string,
): SessionState | null {
  const all = projects.flatMap((p) => p.sessions)
  return all.find((s) => s.sessionId.startsWith(idPrefix)) ?? null
}

export async function runBrief(
  argv: readonly string[],
  run: ClaudeRunner = runClaudeHeadless,
): Promise<number> {
  const idPrefix = argv.find((a) => !a.startsWith('--'))
  if (idPrefix === undefined) {
    process.stderr.write('用法：helm brief <session-id> [--refresh]\n')
    return 2
  }

  const paths = currentPaths()
  // Task 11 changed collectStatus to return StatusResult; take .projects.
  const { projects } = collectStatus(paths, Date.now())
  const session = resolveSession(projects, idPrefix)
  if (session === null) {
    process.stderr.write(`找不到符合 "${idPrefix}" 的 session。先跑 helm status 看看有哪些。\n`)
    return 1
  }

  const digest = readTranscriptDigest(session.transcriptPath ?? '')
  const fingerprint = digestOf(session.transcriptPath)
  const cache = readCache(paths.cacheFile)
  const cached = argv.includes('--refresh')
    ? null
    : getFreshBrief(cache, session.sessionId, fingerprint)

  const brief = cached ?? await generateWithNotice(session, digest, run)

  if (brief === null) {
    process.stdout.write(renderFallback(digest.prompts))
    return 1
  }

  if (cached === null && fingerprint !== null) {
    writeCache(
      paths.cacheFile,
      setBrief(cache, session.sessionId, {
        digest: fingerprint, generatedAt: Date.now(), body: brief,
      }),
    )
  }

  process.stdout.write(renderBriefMarkdown(brief, {
    sessionId: session.sessionId,
    cwd: session.cwd,
    gitBranch: digest.gitBranch,
    generatedAt: Date.now(),
  }))
  return 0
}

/**
 * Generating costs an LLM call that measured 57-86 seconds against real
 * sessions. Never spend that silently: a user staring at a frozen terminal
 * cannot tell "working" from "hung", and has no chance to abort.
 *
 * A running session's transcript keeps growing, so its digest never
 * stabilizes and the cache can never hit — say so, or the user will wonder
 * why the same command is slow every single time.
 */
async function generateWithNotice(
  session: SessionState,
  digest: TranscriptDigest,
  run: ClaudeRunner,
): Promise<Brief | null> {
  const stillRunning = session.lifecycle === 'running'
  process.stderr.write(
    `正在產生交接簡報，需要 1-2 分鐘…${stillRunning ? '\n（這個 session 還在跑，內容持續變動，所以每次都得重新產生）' : ''}\n`,
  )
  return generateBrief(buildSummaryInput(session, digest, readGitSnapshot(session.cwd)), run)
}
```

`cli/brief.ts` 的 import 需要補 `SessionState`（from `../types.ts`）、`TranscriptDigest`（from `../adapters/claude-code/transcript.ts`）與 `Brief`（from `../cache/store.ts`）。

- [ ] **Step 13b: 補 `src/cli/brief.ts` 的測試**

`cli/brief.ts` 承載兩件事：session id 的前綴解析，以及決定要不要花錢的 cache gate 佈線。這兩件都不能只靠人工檢查。建立 `src/cli/brief.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSession } from './brief.ts'
import type { ProjectView } from '../projects/group.ts'
import type { SessionState } from '../types.ts'

const sess = (id: string): SessionState => ({
  adapterId: 'claude-code', sessionId: id, cwd: '/p', pid: 1, procStart: null,
  startedAt: 0, updatedAt: 0, nativeStatus: null, kind: 'interactive', name: '',
  transcriptPath: null, lifecycle: 'crashed', lifecycleConfidence: 'high', live: null,
})
const proj = (sessions: SessionState[]): ProjectView =>
  ({ path: '/p', name: 'p', pinned: false, lastActivityMs: 0, sessions })

test('用前 8 碼短 id 找得到 session', () => {
  const found = resolveSession([proj([sess('abcdef12-3456-7890')])], 'abcdef12')
  assert.equal(found?.sessionId, 'abcdef12-3456-7890')
})

test('用完整 id 也找得到', () => {
  const found = resolveSession([proj([sess('abcdef12-3456-7890')])], 'abcdef12-3456-7890')
  assert.equal(found?.sessionId, 'abcdef12-3456-7890')
})

test('跨專案搜尋', () => {
  const found = resolveSession(
    [proj([sess('aaa11111')]), proj([sess('bbb22222')])], 'bbb2')
  assert.equal(found?.sessionId, 'bbb22222')
})

test('找不到時回傳 null 而不是丟錯', () => {
  assert.equal(resolveSession([proj([sess('aaa11111')])], 'zzz'), null)
})

test('空清單回傳 null', () => {
  assert.equal(resolveSession([], 'abc'), null)
})

test('前綴同時符合多個時，回傳第一個而非丟錯（行為需明確）', () => {
  // 記錄現況行為：.find() 取第一個。若日後要改成報錯要求使用者給更長的
  // 前綴，這個測試會提醒你那是刻意的行為變更。
  const found = resolveSession([proj([sess('abc11111'), sess('abc22222')])], 'abc')
  assert.equal(found?.sessionId, 'abc11111')
})
```

Run: `node --test src/cli/brief.test.ts`
Expected: PASS，6 個測試全過

- [ ] **Step 14: 在 main.ts 註冊 brief 子指令**

把 `main` 改為 async，並加入分支。完整替換後的 `src/cli/main.ts`：

```ts
#!/usr/bin/env node
import { runBrief } from './brief.ts'
import { runStatus } from './status.ts'

const USAGE = `helm — 本機 agent CLI 艦隊看板

用法：
  helm status [--json] [--no-color]   列出所有專案與 session 狀態
  helm scan                           等同 helm status --json
  helm brief <id> [--refresh]         顯示某個 session 的交接簡報
  helm help                           顯示本說明
`

async function main(argv: readonly string[]): Promise<number> {
  const [command = 'status', ...rest] = argv
  switch (command) {
    case 'status':
      return runStatus(rest)
    case 'scan':
      return runStatus([...rest, '--json'])
    case 'brief':
      return runBrief(rest)
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE)
      return 0
    default:
      process.stderr.write(`未知指令：${command}\n\n${USAGE}`)
      return 2
  }
}

process.exitCode = await main(process.argv.slice(2))
```

- [ ] **Step 15: 對真實 session 產生一次簡報**

先找一個 session id：

Run: `node src/cli/main.ts status | head -20`

再對其中一個產生簡報（這一步**會實際呼叫 `claude -p`**，需要幾十秒）：

Run: `node src/cli/main.ts brief <前 8 碼>`
Expected: 輸出七欄 markdown 簡報，內容與該 session 實際在做的事吻合。

Run: `node src/cli/main.ts brief <同一個 id>`
Expected: **立刻**回傳（走快取，不再呼叫 LLM）。

Run: `node src/cli/main.ts brief zzzzzzzz; echo "exit=$?"`
Expected: 找不到 session 的訊息，`exit=1`。

- [ ] **Step 16: 執行完整檢查並 commit**

Run: `bash scripts/check.sh`
Expected: 全綠，覆蓋率 ≥ 80%

```bash
git add src/summarize/ src/render/brief-md.ts src/render/brief-md.test.ts src/cli/
git commit -m "feat: 交接簡報產生與 helm brief 指令"
```

---

## Task 10: 一鍵 Resume 與 `helm open`（P2 完成）

**已驗證**：`claude --help` 顯示用法為 `claude [options] [command] [prompt]` —— prompt 是位置參數，因此 `claude --resume <id> "<開場訊息>"` 合法，可在 resume 的同時送出第一則訊息。

規格 §9 明確要求**不把長簡報貼進 prompt**（會污染第一則訊息並吃掉 context），而是寫成檔案後只送一句指路訊息。

**跳脫是本 task 的安全核心**：`cwd` 來自外部檔案，會先進 shell 指令、再進 AppleScript 字串，兩層都必須正確跳脫。

**Files:**
- Create: `src/launch/script.ts`, `src/launch/script.test.ts`
- Create: `src/launch/run.ts`
- Create: `src/cli/open.ts`
- Modify: `src/cli/main.ts`（加入 `open` 子指令）

### 因 Task 13 而過時之處（實作時修正）

本節寫於 Task 13 之前，以下三點已不成立：

1. **`resolveSession` 不存在了**。Task 13 用 `resolveOrReport`（`src/cli/target.ts`）取代它，
   `helm open` 因此自動吃得下專案名，且歧義時列候選而非回傳第一個。
2. **`collectStatus` 回傳的是 `Board` 不是陣列**。原稿的 `resolveSession(collectStatus(...), id)`
   型別本來就不對。
3. **必須實作 Task 13 訂下的規則**：「`helm open <專案>` 若發現該專案有超過一個活著的
   session，列出來讓他選，不要自動挑。」原稿完全沒有這條。實作在 `pickSession`：
   指名 session id → 開那個；專案有 >1 個 running → 列出候選並回傳 1；恰好 1 個 → 直接開；
   0 個 → 開最近的那個（重開機後的主要用法）。

另外原稿的 Step 6 把 `cli/brief.ts` 的快取／產生流程整段複製了一份，且**漏掉花費前告知**
（那是 Task 9 review 的 Important 修正）。實作改為抽出 `src/cli/brief-source.ts` 共用，
兩個指令的快取策略、成本警告與失敗退場因此不可能漂移。順帶把
`getFreshBrief` 換成 `getFreshBriefEntry`，修掉 Task 9 留下的 deferred minor
（快取命中時「產生時間」顯示的是檢視時間而非真正產生時間）。

**Interfaces:**
- Consumes: `SessionState` from Task 2；`Brief` from Task 8；`renderBriefMarkdown` from Task 9；`resolveOrReport` from Task 13；`collectStatus`, `currentPaths` from Task 6
- Produces:
  - `type Terminal = 'iterm' | 'terminal'`
  - `shellQuote(s: string): string`
  - `appleScriptQuote(s: string): string`
  - `buildResumeCommand(adapterId: string, sessionId: string, opening: string): string`
  - `buildLaunchScript(term: Terminal, cwd: string, command: string): string`
  - `detectTerminal(exists: (appPath: string) => boolean): Terminal`
  - `openSession(session: SessionState, briefPath: string, deps: LaunchDeps): void`
  - `interface LaunchDeps { term: Terminal; runOsascript: (script: string) => void }`
  - `runOpen(argv: readonly string[]): Promise<number>`

- [ ] **Step 1: 寫跳脫與腳本組裝的失敗測試**

建立 `src/launch/script.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  shellQuote, appleScriptQuote, buildResumeCommand, buildLaunchScript, detectTerminal,
} from './script.ts'

test('shellQuote 用單引號包住一般路徑', () => {
  assert.equal(shellQuote('/Users/testuser/proj'), "'/Users/testuser/proj'")
})

test('shellQuote 正確處理含空格的路徑', () => {
  assert.equal(shellQuote('/Users/t/my proj'), "'/Users/t/my proj'")
})

test('shellQuote 跳脫內嵌的單引號', () => {
  assert.equal(shellQuote("/Users/t/it's"), "'/Users/t/it'\\''s'")
})

// ⚠️ 原稿這個測試的斷言是錯的，實作時已替換。
// `!quoted.includes("; rm -rf ~; echo ")` 必定失敗 —— 跳脫後那段字串本來就
// 還在，只是變成純資料。「有沒有被當成指令」不是字串比對答得出來的問題。
// 改成問 shell 本人：
test('shellQuote 讓注入嘗試失效 —— 交給真的 shell 判定', () => {
  const evil = "/tmp'; rm -rf ~; echo '"
  const back = execFileSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(evil)}`], { encoding: 'utf8' })
  assert.equal(back, evil)
  const n = execFileSync('/bin/sh', ['-c', `set -- ${shellQuote(evil)}; echo $#`], { encoding: 'utf8' })
  assert.equal(n.trim(), '1')
})

test('appleScriptQuote 跳脫雙引號與反斜線', () => {
  assert.equal(appleScriptQuote('say "hi"'), '"say \\"hi\\""')
  assert.equal(appleScriptQuote('a\\b'), '"a\\\\b"')
})

test('buildResumeCommand 產生 claude --resume 加位置參數', () => {
  const c = buildResumeCommand('claude-code', 'sess-1', '讀 /tmp/b.md 後接續')
  assert.match(c, /claude --resume 'sess-1' '讀 \/tmp\/b\.md 後接續'/)
})

test('buildResumeCommand 對 codex 產生 codex resume', () => {
  assert.match(buildResumeCommand('codex', 'sess-1', 'go'), /^codex resume 'sess-1'/)
})

test('buildResumeCommand 對未知 adapter 拋出明確錯誤', () => {
  assert.throws(
    () => buildResumeCommand('unknown-cli', 's', 'x'),
    /不支援的 adapter/,
  )
})

test('buildLaunchScript for iterm 含 create tab 與 write text', () => {
  const s = buildLaunchScript('iterm', '/Users/t/p', 'claude --resume x')
  assert.match(s, /tell application "iTerm"/)
  assert.match(s, /create (tab|window)/)
  assert.ok(s.includes('claude --resume x'))
  assert.ok(s.includes("cd '/Users/t/p'"))
})

test('buildLaunchScript for terminal 使用 do script', () => {
  const s = buildLaunchScript('terminal', '/Users/t/p', 'claude --resume x')
  assert.match(s, /tell application "Terminal"/)
  assert.match(s, /do script/)
})

// ⚠️ 原稿用正則數引號，數得出成對與否，數不出「AppleScript 認不認」。
// 實作時改用 osacompile —— 它只編譯不執行，且實測會正確擋下引號不成對
// （`compilation error: Expected “"” but found end of script.`）。
test('路徑含雙引號、反斜線與中文時，AppleScript 仍編譯得過', () => {
  const compiles = (s: string) =>
    execFileSync('osacompile', ['-o', '/dev/null', '-e', s], { stdio: 'pipe' })
  for (const cwd of ['/Users/t/say "hi"', '/Users/t/a\\b', '/Users/t/專案 一', "/Users/t/it's"]) {
    assert.doesNotThrow(() => compiles(buildLaunchScript('terminal', cwd, 'echo ok')))
    assert.doesNotThrow(() => compiles(buildLaunchScript('iterm', cwd, 'echo ok')))
  }
})

test('detectTerminal 在 iTerm 存在時選 iterm', () => {
  assert.equal(detectTerminal((p) => p.includes('iTerm')), 'iterm')
})

test('detectTerminal 在 iTerm 不存在時退回 terminal', () => {
  assert.equal(detectTerminal(() => false), 'terminal')
})
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test src/launch/script.test.ts`
Expected: FAIL，找不到模組 `./script.ts`

- [ ] **Step 3: 實作 script.ts**

```ts
export type Terminal = 'iterm' | 'terminal'

const ITERM_APP = '/Applications/iTerm.app'

/** POSIX single-quote quoting: the only form with no escape sequences inside. */
export function shellQuote(s: string): string {
  return `'${s.split("'").join(`'\\''`)}'`
}

/** AppleScript string literal: backslash first, then double quote. */
export function appleScriptQuote(s: string): string {
  return `"${s.split('\\').join('\\\\').split('"').join('\\"')}"`
}

export function buildResumeCommand(
  adapterId: string,
  sessionId: string,
  opening: string,
): string {
  switch (adapterId) {
    case 'claude-code':
      // Verified against `claude --help`: usage is
      // `claude [options] [command] [prompt]`, so the opening message is
      // a positional argument.
      return `claude --resume ${shellQuote(sessionId)} ${shellQuote(opening)}`
    case 'codex':
      return `codex resume ${shellQuote(sessionId)}`
    default:
      throw new Error(`不支援的 adapter：${adapterId}`)
  }
}

export function buildLaunchScript(term: Terminal, cwd: string, command: string): string {
  const full = `cd ${shellQuote(cwd)} && ${command}`
  return term === 'iterm' ? itermScript(full) : terminalScript(full)
}

function itermScript(command: string): string {
  const q = appleScriptQuote(command)
  return [
    'tell application "iTerm"',
    '  activate',
    '  if (count of windows) = 0 then',
    '    set w to (create window with default profile)',
    '    tell current session of w to write text ' + q,
    '  else',
    '    tell current window',
    '      set t to (create tab with default profile)',
    '      tell current session of t to write text ' + q,
    '    end tell',
    '  end if',
    'end tell',
  ].join('\n')
}

function terminalScript(command: string): string {
  return [
    'tell application "Terminal"',
    '  activate',
    '  do script ' + appleScriptQuote(command),
    'end tell',
  ].join('\n')
}

export function detectTerminal(exists: (appPath: string) => boolean): Terminal {
  return exists(ITERM_APP) ? 'iterm' : 'terminal'
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `node --test src/launch/script.test.ts`
Expected: PASS，13 個測試全過

- [ ] **Step 5: 實作 run.ts**

~~沒有獨立測試 —— 它只是把純函式的產出交給 `osascript`，其邏輯已由 Step 1 的測試涵蓋，實際執行則在 Step 8 手動驗收。~~

**實作時修正**：這個判斷讓 `run.ts` 的行覆蓋率只有 78.85%，缺口正是唯一真正產生副作用的地方。而且它可以測，只是不能用「真的開一個終端機跑 claude」去測。實作補了 `src/launch/run.test.ts`：

- `openSession` 交給 osascript 的內容（注入假的 `runOsascript` 即可）
- 開場訊息只含簡報路徑、不含簡報內容 —— 規格 §9 的核心約束，值得有測試守著
- 未知 adapter 時拋錯而非開一個亂七八糟的終端機
- **`runOsascript` 本身**：用 `return 1` 這種不 tell 任何應用程式的腳本跑真的 `osascript`，
  驗證 execFileSync 這段管線（路徑、逾時、stdio）能動，**不開任何視窗、不花任何錢**；
  再用一段壞腳本確認它會拋錯，讓 `helm open` 的錯誤處理接得到。

腳本語法的正確性由 Step 1 的 `osacompile` 負責，兩者合起來覆蓋率 100%。

```ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionState } from '../types.ts'
import {
  buildLaunchScript, buildResumeCommand, detectTerminal, type Terminal,
} from './script.ts'

const OSASCRIPT_TIMEOUT_MS = 10_000

export interface LaunchDeps {
  term: Terminal
  runOsascript: (script: string) => void
}

export function defaultDeps(): LaunchDeps {
  return { term: detectTerminal(existsSync), runOsascript }
}

export function briefPathFor(briefsDir: string, sessionId: string): string {
  return join(briefsDir, `${sessionId}.md`)
}

export function writeBriefFile(path: string, markdown: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, markdown, 'utf8')
}

/**
 * Spec 9: the brief goes to a file and the session is told to read it.
 * Pasting the whole brief as the first message would poison the new
 * session's context.
 */
export function openSession(
  session: SessionState,
  briefPath: string,
  deps: LaunchDeps,
): void {
  const opening = `讀 ${briefPath} 後接續`
  const command = buildResumeCommand(session.adapterId, session.sessionId, opening)
  deps.runOsascript(buildLaunchScript(deps.term, session.cwd, command))
}

function runOsascript(script: string): void {
  execFileSync('osascript', ['-e', script], {
    timeout: OSASCRIPT_TIMEOUT_MS,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}
```

- [ ] **Step 6: 實作 `helm open` 指令**

建立 `src/cli/open.ts`：

```ts
import { readTranscriptDigest } from '../adapters/claude-code/transcript.ts'
import { digestOf, getFreshBrief, readCache, setBrief, writeCache } from '../cache/store.ts'
import { briefPathFor, defaultDeps, openSession, writeBriefFile } from '../launch/run.ts'
import type { HelmPaths } from '../paths.ts'
import type { SessionState } from '../types.ts'
import { renderBriefMarkdown, renderFallback } from '../render/brief-md.ts'
import { generateBrief, runClaudeHeadless, type ClaudeRunner } from '../summarize/brief.ts'
import { readGitSnapshot } from '../summarize/git.ts'
import { buildSummaryInput } from '../summarize/input.ts'
import { resolveSession } from './brief.ts'
import { collectStatus, currentPaths } from './status.ts'

export async function runOpen(
  argv: readonly string[],
  run: ClaudeRunner = runClaudeHeadless,
): Promise<number> {
  const idPrefix = argv.find((a) => !a.startsWith('--'))
  if (idPrefix === undefined) {
    process.stderr.write('用法：helm open <session-id> [--no-brief]\n')
    return 2
  }

  const paths = currentPaths()
  const session = resolveSession(collectStatus(paths, Date.now()), idPrefix)
  if (session === null) {
    process.stderr.write(`找不到符合 "${idPrefix}" 的 session。先跑 helm status 看看有哪些。\n`)
    return 1
  }

  const briefPath = briefPathFor(paths.helmBriefs, session.sessionId)
  if (!argv.includes('--no-brief')) {
    writeBriefFile(briefPath, await briefMarkdown(session, paths, run))
  }

  try {
    openSession(session, briefPath, defaultDeps())
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`開啟終端機失敗：${msg}\n簡報已寫到 ${briefPath}，可自行開啟終端機接續。\n`)
    return 1
  }

  process.stdout.write(`已開啟 ${session.cwd}（簡報：${briefPath}）\n`)
  return 0
}

async function briefMarkdown(
  session: SessionState,
  paths: HelmPaths,
  run: ClaudeRunner,
): Promise<string> {
  const digest = readTranscriptDigest(session.transcriptPath ?? '')
  const fingerprint = digestOf(session.transcriptPath)
  const cache = readCache(paths.cacheFile)
  const cached = getFreshBrief(cache, session.sessionId, fingerprint)

  const brief = cached ?? await generateBrief(
    buildSummaryInput(session, digest, readGitSnapshot(session.cwd)),
    run,
  )
  if (brief === null) return renderFallback(digest.prompts)

  if (cached === null && fingerprint !== null) {
    writeCache(paths.cacheFile, setBrief(cache, session.sessionId, {
      digest: fingerprint, generatedAt: Date.now(), body: brief,
    }))
  }
  return renderBriefMarkdown(brief, {
    sessionId: session.sessionId,
    cwd: session.cwd,
    gitBranch: digest.gitBranch,
    generatedAt: Date.now(),
  })
}
```

- [ ] **Step 7: 在 main.ts 註冊 open 子指令**

完整替換 `src/cli/main.ts`：

```ts
#!/usr/bin/env node
import { runBrief } from './brief.ts'
import { runOpen } from './open.ts'
import { runStatus } from './status.ts'

const USAGE = `helm — 本機 agent CLI 艦隊看板

用法：
  helm status [--json] [--no-color]   列出所有專案與 session 狀態
  helm scan                           等同 helm status --json
  helm brief <id> [--refresh]         顯示某個 session 的交接簡報
  helm open  <id> [--no-brief]        開終端機接續某個 session
  helm help                           顯示本說明

<id> 可用 helm status 顯示的前 8 碼。
`

async function main(argv: readonly string[]): Promise<number> {
  const [command = 'status', ...rest] = argv
  switch (command) {
    case 'status':
      return runStatus(rest)
    case 'scan':
      return runStatus([...rest, '--json'])
    case 'brief':
      return runBrief(rest)
    case 'open':
      return runOpen(rest)
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE)
      return 0
    default:
      process.stderr.write(`未知指令：${command}\n\n${USAGE}`)
      return 2
  }
}

process.exitCode = await main(process.argv.slice(2))
```

- [ ] **Step 8: 手動驗收 —— 實際開一個終端機**

先看腳本內容正確再真的執行：

Run:
```bash
node --input-type=module -e "
import { buildLaunchScript, buildResumeCommand } from './src/launch/script.ts'
const cmd = buildResumeCommand('claude-code', 'abc-123', '讀 /tmp/b.md 後接續')
console.log(buildLaunchScript('iterm', '/Users/you/helm', cmd))
"
```
Expected: 合法的 AppleScript，路徑與 session id 都被單引號正確包住。

再實際執行（**會真的開一個 iTerm 分頁**）：

Run: `node src/cli/main.ts open <某個 session 的前 8 碼>`
Expected: iTerm 開新分頁、`cd` 到該專案、Claude Code 以該 session resume，且第一則訊息是「讀 ~/.helm/briefs/<id>.md 後接續」。確認該簡報檔存在且內容為七欄 markdown。

Run: `node src/cli/main.ts open zzzzzzzz; echo "exit=$?"`
Expected: 找不到 session 的訊息，`exit=1`。

**驗收結果（2026-08-11）**：

- ✅ 腳本預覽正確：`cd '/Users/you/helm' && claude --resume 'abc-123' '讀 /tmp/b.md 後接續'`，
  路徑與 id 都被單引號正確包住，整段再被正確跳脫進 AppleScript 字串
- ✅ `helm open zzzzzzzz` → 「找不到符合 "zzzzzzzz" 的專案或 session」，`exit=1`
- ⏸️ **真的開一個 iTerm 分頁尚未執行** —— 它會同時開視窗並送出一則付費的
  `claude --resume` 訊息，屬於要花錢又有外部副作用的動作，留給使用者決定。
  在此之前，這條路徑的每一段都已分別驗證過：腳本語法由 `osacompile` 驗、
  `osascript` 管線由 `run.test.ts` 用無害腳本驗、指令組裝與參數跳脫由真的
  `/bin/sh` 驗、`helm open` 的分支邏輯由 11 個測試驗。

- [ ] **Step 9: 執行完整檢查**

Run: `bash scripts/check.sh`
Expected: 型別檢查無誤、全部測試通過、覆蓋率 ≥ 80%

- [ ] **Step 10: Commit**

```bash
git add src/launch/ src/cli/
git commit -m "feat: 一鍵 resume 與 helm open 指令"
```

**P2 完成。** 此時 `helm status` / `helm brief` / `helm open` 三個指令合起來已解決原始需求中的「不知道做到哪」「找不到 session」「無法延續」三大痛點。

---

## 完成後的狀態

執行完 Task 1–10 之後：

| 指令 | 功能 |
|---|---|
| `helm status` | 全部專案與 session 的狀態表，紅點標出異常中斷 |
| `helm scan` | 同上，JSON 輸出，供其他工具串接 |
| `helm brief <id>` | 七欄交接簡報（有快取閘門，transcript 沒變就不重跑 LLM） |
| `helm open <id>` | 開終端機、cd、resume，並自動指向簡報檔 |

**尚未包含**（各自另立 plan）：

- **P3**：SwiftBar 選單列 + `PreToolUse` hook 與其安裝器（含 `HELM_OFF` kill switch、`settings.json` 備份與附加、`helm doctor`）。注意本 plan 已把 `readLiveMarker` 與 lifecycle 的 live 判定實作完成，P3 只需補上「寫入」那一端。
- **P4**：Codex adapter（`~/.codex/history.jsonl` + `rollout-*.jsonl`）。`buildResumeCommand` 已預留 `codex` 分支。
- **P5**：PR 追蹤（`gh` 包裝與 `waitingOn` 判定）。`CacheShape.prs` 欄位已預留。

**刻意延後的一項設計**：規格 §5.1 定義了正式的 `AgentAdapter` 介面。本 plan **不**建立它 —— 只有一個 adapter 時，抽象介面是憑空猜測而非歸納。Task 3 的 `discoverClaudeCode` 已遵守該介面的效能契約（不讀 transcript、不發網路請求），Task 7 的 `readTranscriptDigest` 對應 `readSemantics`，Task 10 的 `buildResumeCommand` 對應 `buildResumeCommand`。P4 加入 Codex 時，介面從這兩個實作歸納出來，會比現在猜的準確。

---

## Task 11: 註冊表未知狀態值與降級可見性（P1 缺陷修正）

Task 6 的真實資料驗收發現一個會讓使用者**默默少看到一個 session** 的缺陷。這是 P1 的核心承諾（不遺漏）被打破，優先於 P2 的任何工作。

**實測證據**（2026-08-11，本機七個註冊表檔）：

```
status   kind         cwd
shell    interactive  /Users/you/project-alpha     ← 完全不出現在 helm status
idle     interactive  /Users/you/Projects/project-bravo
idle     interactive  /Users/you/acme/report-tool
busy     interactive  /Users/you/acme/example-service
```

`status: "shell"` 是 Claude Code 的第三種原生狀態值。Task 2 的 schema 寫 `z.enum(['busy','idle'])`，遇到它整個 `safeParse` 失敗，該 session 被計入 `invalid` 並丟棄。

**十分鐘後的複查讓這個缺陷升級，而不是降級**：同一個 session 的 status 變回 `idle`，於是它又正常出現了。

```
idle     interactive  /Users/you/project-alpha     ← 又回來了
```

也就是說 `shell` 是**暫態值** —— Claude Code 只在該 session 正在執行 shell 指令的那段時間設定它。這代表缺陷是**間歇性**的：使用者在某個 session 跑指令的當下去看看板，那個專案就從清單上消失；等他想重現時又好了。這是最難被相信、也最難被回報的一種 bug。

**因此本 task 的驗證不得依賴真實資料當下剛好處於 `shell` 狀態** —— 那是碰運氣。改用 fixture 與人造檔案來證明修正有效。

**兩個獨立的問題，都要修**：

1. **`.passthrough()` 只容忍未知欄位，不容忍已宣告欄位的未知值。** 上游新增一個狀態值就讓整筆 session 消失，這與「邊界驗證要容忍上游演進」的設計意圖矛盾。
2. **`invalid` 計數從來沒有出口。** `discoverClaudeCode` 用 `const { entries } = readRegistry(...)` 就地丟棄它，所以任何解析失敗都是完全靜默的 —— 直接違反 Global Constraints 的「降級必須可見」。這是比第 1 點更嚴重的問題：修好 `shell` 之後，下一個未知格式仍會靜默吃掉 session。

**Files:**
- Modify: `src/adapters/claude-code/registry.ts`, `src/adapters/claude-code/registry.test.ts`
- Modify: `src/adapters/claude-code/discover.ts`, `src/adapters/claude-code/discover.test.ts`
- Modify: `src/cli/status.ts`, `src/cli/status.test.ts`
- Modify: `src/render/table.ts`, `src/render/table.test.ts`

**Interfaces:**
- Changed: `discoverClaudeCode(paths: HelmPaths): DiscoverResult`（原本回傳 `DiscoveredSession[]`）
- Changed: `collectStatus(paths, nowMs, probe?): StatusResult`（原本回傳 `ProjectView[]`）
- Changed: `renderTable(result: StatusResult, opts: RenderOptions): string`（原本第一參數是 `readonly ProjectView[]`）
- New: `interface DiscoverResult { sessions: DiscoveredSession[]; invalid: number }`
- New: `interface StatusResult { projects: ProjectView[]; invalid: number }`

- [ ] **Step 1: 寫 registry 容忍未知狀態值的失敗測試**

追加到 `src/adapters/claude-code/registry.test.ts`：

```ts
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
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test src/adapters/claude-code/registry.test.ts`
Expected: 兩個新測試 FAIL，`entries.length` 為 0、`invalid` 為 1 —— 正是缺陷本身。

- [ ] **Step 3: 修正 schema**

`src/adapters/claude-code/registry.ts` 的 `status` 欄位改為：

```ts
  // Unknown status values must not discard the whole session. `.passthrough()`
  // tolerates unknown *fields*; this tolerates unknown *values* of a known
  // field. Claude Code already ships a third value ("shell") beyond the two
  // we model, and will add more.
  status: z.unknown()
    .transform((v) => (v === 'busy' || v === 'idle' ? v : null))
    .pipe(z.enum(['busy', 'idle']).nullable()),
```

`NativeStatus` 型別與所有下游都不需要改 —— `statusOf` 已經把 `nativeStatus !== 'busy'` 一律當成 idle。

- [ ] **Step 4: 執行測試確認通過**

Run: `node --test src/adapters/claude-code/registry.test.ts`
Expected: PASS，9 個測試全過（原 7 + 新 2）

- [ ] **Step 5: 用真實資料的副本驗證，不碰使用者的目錄**

`shell` 是暫態值，不能等它出現。把真實註冊表複製一份到暫存目錄，改一筆的 status 成 `shell`，對副本驗證：

```bash
TMP=$(mktemp -d)
cp ~/.claude/sessions/*.json "$TMP/" 2>/dev/null
FIRST=$(ls "$TMP"/*.json | head -1)
python3 -c "
import json,sys
p='$FIRST'
d=json.load(open(p))
d['status']='shell'
json.dump(d, open(p,'w'))
print('已把', d['cwd'], '改成 status=shell')
"
node --input-type=module -e "
import { readRegistry } from './src/adapters/claude-code/registry.ts'
const r = readRegistry('$TMP')
console.log('有效:', r.entries.length, '無效:', r.invalid)
for (const e of r.entries) console.log(' ', String(e.status), e.cwd)
"
rm -rf "$TMP"
```

Expected: 有效數等於檔案總數、無效為 0，且被改動的那一筆以 `null` 出現在清單中而不是消失。**修正前跑同一段會看到有效數少一、無效為 1** —— 值得先跑一次記下來當對照。

絕對不要修改 `~/.claude/sessions/` 底下的真實檔案。

- [ ] **Step 6: 寫 invalid 計數貫穿到輸出的失敗測試**

追加到 `src/adapters/claude-code/discover.test.ts`：

```ts
test('discoverClaudeCode 回傳 invalid 計數而不是丟棄它', () => {
  const home = scaffold([BASE])
  writeFileSync(join(home, '.claude', 'sessions', 'broken.json'), '{壞掉')
  const result = discoverClaudeCode(resolvePaths({ home }))
  assert.equal(result.sessions.length, 1)
  assert.equal(result.invalid, 1)
})
```

追加到 `src/render/table.test.ts`：

```ts
test('有解析失敗時在輸出中明講，不靜默隱藏', () => {
  const out = renderTable({ projects: [proj({})], invalid: 2 }, opts)
  assert.match(out, /2 個/)
  assert.match(out, /無法解析|讀不到|helm doctor/)
})

test('沒有解析失敗時不顯示任何警告', () => {
  const out = renderTable({ projects: [proj({})], invalid: 0 }, opts)
  assert.ok(!out.includes('無法解析'))
})

test('全部都解析失敗時，空清單訊息也要說明原因', () => {
  const out = renderTable({ projects: [], invalid: 3 }, opts)
  assert.match(out, /3 個/)
})
```

- [ ] **Step 7: 執行測試確認失敗**

Run: `node --test src/adapters/claude-code/discover.test.ts src/render/table.test.ts`
Expected: FAIL —— `discoverClaudeCode` 目前回傳陣列沒有 `.sessions`，`renderTable` 目前第一參數是陣列。

- [ ] **Step 8: 讓 invalid 貫穿三層**

`discover.ts`：

```ts
export interface DiscoverResult {
  sessions: DiscoveredSession[]
  /** Registry files that existed but could not be parsed. Surfaced to the user. */
  invalid: number
}

export function discoverClaudeCode(paths: HelmPaths): DiscoverResult {
  const { entries, invalid } = readRegistry(paths.claudeSessions)
  const sessions = entries
    .map((e): DiscoveredSession => ({ /* 不變 */ }))
    .toSorted((a, b) => b.updatedAt - a.updatedAt)
  return { sessions, invalid }
}
```

`src/cli/status.ts`：

```ts
export interface StatusResult {
  projects: ProjectView[]
  invalid: number
}

export function collectStatus(
  paths: HelmPaths,
  nowMs: number,
  probe: ProcessProbe = queryProcesses,
): StatusResult {
  const { sessions, invalid } = discoverClaudeCode(paths)
  const alive = probe(sessions.flatMap((d) => (d.pid === null ? [] : [d.pid])))
  const states = reconcileSessions(sessions, {
    alive,
    readLive: (id) => readLiveMarker(paths.helmLive, id),
    transcriptMtimeMs: mtimeMs,
  })
  const projects = groupIntoProjects(states, { /* 不變 */ })
  return { projects, invalid }
}
```

`runStatus` 的 JSON 分支直接輸出整個 `StatusResult`；表格分支把它傳給 `renderTable`。

`src/render/table.ts`：

```ts
export function renderTable(result: StatusResult, opts: RenderOptions): string {
  const { projects, invalid } = result
  const warning = renderInvalidWarning(invalid, opts)
  if (projects.length === 0) {
    return `沒有找到符合條件的專案。\n（近 14 天內有活動、且是 git repo 的專案才會列出）\n${warning}`
  }
  const body = projects.map((p) => renderProject(p, opts)).join('\n\n')
  return `${body}\n${renderSummary(projects)}\n${warning}`
}

/**
 * Silent data loss is the worst failure mode for a board whose whole promise
 * is "nothing gets forgotten". If a registry file could not be parsed, the
 * user must be told a session is missing rather than shown a short list.
 */
function renderInvalidWarning(invalid: number, opts: RenderOptions): string {
  if (invalid === 0) return ''
  return dim(`\n⚠ 有 ${invalid} 個 session 記錄無法解析，未列於上方。執行 helm doctor 查看原因。\n`, opts.color)
}
```

`renderTable` 的其餘呼叫端（`runStatus`）與所有既有測試都要改成傳 `StatusResult`。

- [ ] **Step 9: 執行測試確認通過**

Run: `bash scripts/check.sh`
Expected: 型別檢查無誤、全部測試通過、覆蓋率維持 80% 以上。

- [ ] **Step 10: 對真實資料驗收**

Run: `node src/cli/main.ts status --no-color`
Expected: 正常列出全部專案，末尾**沒有**警告行（因為此刻 invalid 為 0）。

再用一個假的 home 驗證警告確實會出現。**不要碰 `~/.claude/sessions/`** —— 那是使用者真實的 Claude Code 目錄，往裡面寫測試檔會干擾他正在跑的工作：

```bash
FAKE=$(mktemp -d)
mkdir -p "$FAKE/.claude/sessions"
cp ~/.claude/sessions/*.json "$FAKE/.claude/sessions/" 2>/dev/null
echo '{壞掉' > "$FAKE/.claude/sessions/zzz-broken.json"
HELM_FAKE_HOME="$FAKE" node src/cli/main.ts status --no-color | tail -4
rm -rf "$FAKE"
```

Expected: 輸出末尾出現「有 1 個 session 記錄無法解析」的警告。（`HELM_FAKE_HOME` 是 Task 6 的 `currentPaths` 已經支援的環境變數，正是為這種驗證而設。）

- [ ] **Step 11: Commit**

```bash
git add src/adapters/claude-code/registry.ts src/adapters/claude-code/registry.test.ts \
        src/adapters/claude-code/discover.ts src/adapters/claude-code/discover.test.ts \
        src/cli/status.ts src/cli/status.test.ts \
        src/render/table.ts src/render/table.test.ts
git commit -m "fix: 未知的 registry 狀態值不再讓 session 消失，解析失敗改為可見"
```

---

## Task 12: 一個壞 PID 不得汙染整批存活性判定

實驗中發現：`queryProcesses` 把 `ps` 的**任何**失敗都當成「這些 PID 都不存在」，所以單一筆壞資料會讓看板誤報**所有** session 都當機。

**實測**（2026-08-11）：

```
queryProcesses([活著的 PID])              → 1 筆
queryProcesses([活著的 PID, 999999])      → 0 筆   ← 應該是 1
queryProcesses([活著的 PID, 99998])       → 1 筆   （範圍內的死 PID 沒問題）

$ LC_ALL=C ps -o pid=,lstart= -p "$$,999999"
ps: process id too large: 999999
exit=1
```

在假 home 上重現的後果：只改一個 session 的 PID 為 999999，`helm status` 把**三個專案全部**標成「已中斷」。

對照組（同樣手法但 PID 合理）行為都正確，證明 lifecycle 判定本身沒問題：

| 情境 | 結果 |
|---|---|
| PID 活著但 `procStart` 對不上 | ✅ 只有該筆 crashed |
| PID 在範圍內但已死（3999） | ✅ 只有該筆 crashed |
| PID 超出 `ps` 範圍（999999） | ❌ 全部誤判 crashed |

**根因**在 `processes.ts` 那個 catch 的假設：

```ts
} catch {
  // ps exits non-zero when none of the PIDs exist. That is a valid answer.
  return new Map()
}
```

這句話只講對一半。`ps` 回傳非零有兩種完全不同的意思：
1. **查得到、但都不存在** —— 空 Map 是正確答案
2. **呼叫本身失敗**（PID 超範圍、參數過長、環境問題）—— 空 Map 是**錯誤**答案，它宣稱「全部都死了」

第二種是誤報。而誤報比漏報更難處理：使用者會去 resume 一個其實正在跑的 session。

**目前不會在使用者機器上觸發**（他的 PID 都是 4–5 位數，遠在範圍內），但「單一筆壞資料汙染全部判定」是設計缺陷，不是邊界情況。session 數量增長時 `-p` 的參數長度也會逼近上限。

**Files:**
- Modify: `src/adapters/claude-code/processes.ts`, `src/adapters/claude-code/processes.test.ts`

**Interfaces:** `queryProcesses` 的簽章與回傳型別維持 `ProcessProbe`。

**實作時補上**：多匯出一個 `createProbe(run: PsRunner): ProcessProbe` 與 `type PsRunner`。
退回逐一查詢那條路正是整個修正的重點，但它只有在真的把 `ps` 弄壞時才走得到 ——
留著不測，等於讓「防止整片誤報」這個唯一的保護措施沒有任何測試守著。
`queryProcesses` 本身維持 `createProbe(runPs)`，呼叫端完全不受影響。

- [ ] **Step 1: 寫失敗測試**

追加到 `src/adapters/claude-code/processes.test.ts`：

```ts
import { queryProcesses } from './processes.ts'

test('一個超出範圍的 PID 不影響同批其他 PID 的查詢結果', () => {
  const alive = process.pid
  const got = queryProcesses([alive, 999999])
  assert.equal(got.has(alive), true, '活著的 PID 必須仍被回報為存活')
  assert.equal(got.has(999999), false)
})

test('全部都是無效 PID 時回傳空 Map 而不拋錯', () => {
  assert.equal(queryProcesses([999998, 999999]).size, 0)
})

test('超出範圍的 PID 在送給 ps 之前就被濾掉', () => {
  // 不合理的值不該浪費一次 spawn，也不該讓 ps 印出錯誤到 stderr
  assert.equal(queryProcesses([0, -1, 999999, 1.5]).size, 0)
})

test('空清單不 spawn 任何行程', () => {
  assert.equal(queryProcesses([]).size, 0)
})
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `node --test src/adapters/claude-code/processes.test.ts`
Expected: 第一個測試 FAIL（`got.has(alive)` 為 false），並在輸出看到 `ps: process id too large`。

- [ ] **Step 3: 實作**

兩道防線。第一道是輸入過濾，第二道是批次失敗時退回逐一查詢：

```ts
/** macOS caps PIDs at 99999; anything outside that makes `ps` reject the whole batch. */
const MAX_PID = 99_999

function isQueryablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid <= MAX_PID
}

export const queryProcesses: ProcessProbe = (pids) => {
  const queryable = pids.filter(isQueryablePid)
  if (queryable.length === 0) return new Map()
  const batched = runPs(queryable)
  if (batched !== null) return batched

  // The batch call failed as a whole. That does NOT mean every PID is dead —
  // `ps` rejects the entire invocation over one bad argument, and treating
  // that as "all sessions crashed" would show the user a board full of false
  // red dots. Fall back to asking one at a time so a single bad PID costs
  // only itself. This path is rare, so the extra spawns are acceptable.
  return queryable.reduce((acc, pid) => {
    const one = runPs([pid])
    const lstart = one?.get(pid)
    return lstart === undefined ? acc : new Map(acc).set(pid, lstart)
  }, new Map<number, string>())
}

/** Returns null when the ps invocation itself failed, empty Map when it ran and found nothing. */
function runPs(pids: readonly number[]): Map<number, string> | null {
  try {
    const out = execFileSync(
      'ps',
      ['-o', 'pid=,lstart=', '-p', pids.join(',')],
      { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return parsePsOutput(out)
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string }
    const stdout = typeof e.stdout === 'string' ? e.stdout : ''
    if (stdout.trim() !== '') return parsePsOutput(stdout)
    const stderr = typeof e.stderr === 'string' ? e.stderr : ''
    // `status` is null when the spawn never ran (ps missing, out of memory),
    // which must not be read as "these processes are gone" either.
    return typeof e.status === 'number' && stderr.trim() === '' ? new Map() : null
  }
}

function parsePsOutput(out: string): Map<number, string> {
  return out.split('\n').reduce((acc, line) => {
    const m = line.trim().match(/^(\d+)\s+(.+)$/)
    if (m === null) return acc
    const pid = Number(m[1])
    const lstart = (m[2] ?? '').trim()
    return lstart === '' ? acc : new Map(acc).set(pid, lstart)
  }, new Map<number, string>())
}
```

注意 `stdio` 明確把 stderr 設為 `'pipe'`。`execFileSync` 預設會把子行程的 stderr 直接轉給父行程，那行 `ps: process id too large: 999999` 就是這樣漏到使用者的看板中間的。

**實作時修正（原稿寫 `'ignore'`，改成 `'pipe'` 並據以判斷）**：`ps` 的兩種非零結束在 macOS 上是分得出來的，實測 2026-08-11：

| 情境 | exit | stdout | stderr |
|---|---|---|---|
| PID 合法但不存在（3999、99999） | 1 | 空 | **空** |
| PID 超出範圍（100000 以上） | 1 | 空 | `ps: process id too large: …` |
| 混合批次中至少一個活著 | 0 | 有資料 | 空 |

所以「stderr 是空的」就足以判定「跑成功、只是都不存在」，可以直接回空 Map，**不必退回逐一查詢**。這很重要：重開機後註冊表殘留的 PID 全數已死是常態，若一律退回逐一查詢，每次 `helm status` 都會多 spawn N 次 `ps`。真正需要退回的只剩「stderr 有訊息」與「spawn 根本沒跑起來」（`status` 為 null）這兩種。

邊界也一併實測：**99999 可接受、100000 被拒**，故 `MAX_PID = 99_999` 正確。

- [ ] **Step 4: 執行測試確認通過**

Run: `node --test src/adapters/claude-code/processes.test.ts`
Expected: PASS，11 個測試全過（原 7 + 新 4），且輸出中**不再**出現 `ps:` 的錯誤訊息。

- [ ] **Step 5: 端對端驗證誤報已消除**

```bash
FAKE=$(mktemp -d); mkdir -p "$FAKE/.claude/sessions"
cp ~/.claude/sessions/*.json "$FAKE/.claude/sessions/" 2>/dev/null
ln -s ~/.claude/projects "$FAKE/.claude/projects"
python3 -c "
import json, glob
f = sorted(glob.glob('$FAKE/.claude/sessions/*.json'))[0]
d = json.load(open(f)); d['pid'] = 999999; json.dump(d, open(f,'w'))
print('已把', d['cwd'], '的 PID 改成 999999')
"
HELM_FAKE_HOME="$FAKE" node src/cli/main.ts status --no-color
rm -rf "$FAKE"
```

Expected: **只有**被改的那個專案顯示「已中斷」，其餘維持原本狀態；輸出中沒有 `ps:` 錯誤訊息。修正前跑同一段會看到全部都變成已中斷。

**驗收結果（2026-08-11 實測，3 筆註冊表複本、11 個專案）**：

```
修正前（git stash 掉修正後重跑）      修正後
ps: process id too large: 999999      （無錯誤訊息）
● helm               1 個中斷未回收   ● helm               1 個在跑
● project-echo          1 個中斷未回收   ● project-echo          1 個在跑
● data-svc-2.0-clone 1 個中斷未回收  ● data-svc-2.0-clone 1 個中斷未回收  ← 唯一被竄改的
```

✅ 誤報消除、✅ stderr 不再汙染輸出、✅ 20 個測試全過（原 7 + 新 13），
`processes.ts` 行覆蓋率 100%（含真實 `ps` 的「跑成功但都不存在」分支 ——
用 `spawnSync('/usr/bin/true').pid` 取得一個確定剛死、PID 又確定在合法範圍內的行程）。

- [ ] **Step 6: 全套件與 commit**

Run: `bash scripts/check.sh`

```bash
git add src/adapters/claude-code/processes.ts src/adapters/claude-code/processes.test.ts
git commit -m "fix: 一個壞 PID 不再讓整批存活性判定誤報為當機"
```

---

## Task 13: 看板改以專案為單位，探索改以 transcript 為主（最高優先）

兩個缺陷其實是同一件事的兩面，必須一起修。

### 缺陷一：看不到已結束的 session

**這讓產品無法滿足原始需求的一半。** 使用者要的是「重新開機**或**突然當機之後能接續」，目前只涵蓋後者。

實測（2026-08-11）：註冊表 `~/.claude/sessions/*.json` 只有 **6 筆**，磁碟上有 **2846 份** transcript，近 3 天有活動卻不在註冊表的有 **30 份**。具體案例：`project-alpha` 的 session `19519d4f` 剛結束、transcript 8.6 MB 完整保留，但 `helm status` 看不到、`helm brief 19519d4f` 回「找不到」。

根因是 `discoverClaudeCode` 只列舉註冊表。而 §4.1 已實測確立「Claude Code 正常結束時會刪除註冊表檔」—— 正常重開機時所有 session 都收到 SIGTERM 正常結束，**註冊表全空，看板一片空白**。

### 缺陷二：粒度錯了

修好缺陷一之後，看板會從 6 筆變成 **158 筆**。而使用者的第一個痛點正是「找不到正確的 session 可以 resume」—— 給他一份 158 筆的 session 清單，只是把 `claude --resume` 的問題換個地方重現。

實測的規模對比：

| 單位 | 數量 |
|---|---|
| 近 14 天活躍專案 | 17（扣除 `/private/tmp`、`Downloads`、`var/folders` 等雜訊後 **12 個真專案**） |
| 近 14 天 session | **158** |
| 目前活著的 session | 6，分散在 4 個專案 |

平均一個專案 9.3 個 session，`report-tool` 近期 25 個、總共 83 個。以 session 為單位的看板，98% 是歷史雜訊。

**「接續」本來就是專案層級的動作**：使用者想的是「回去繼續 data-svc 那件事」，不是「resume `f9810d2c`」。session id 是實作細節，不該是使用者介面。

### 設計

**探索**：transcript 是主要來源（持久事實：session 存在過、在哪個 cwd、最後活動時間），註冊表降為補充（當下狀態：還活著嗎、busy/idle、PID 與 procStart）。兩者以 `sessionId` join。

**效能已實測可行**：~~靠目錄 mtime 先篩掉整個沒動過的專案，2846 份檔案只需 stat 424 份。~~

**已修正（實作時重測）**：原本的 2846 份把巢狀 `<session-id>/` 目錄底下的 sidecar 檔也算了進去，那些不是 session transcript，本來就不該掃。真正的 transcript 只在每個專案目錄的**頂層**，實測只有 499 份：

```
不遞迴、全部 stat：28 個目錄 → 499 檔 → 近 14 天 161 個 → 耗時 6.9 ms
加上目錄 mtime 預篩：只需 stat 427 檔 → 耗時 3.0 ms
```

**因此不採用目錄 mtime 預篩**。它只省 3.9 ms（契約 200ms 的 2%），卻換來一個正確性漏洞：對既有檔案 append 不會更新目錄的 mtime，所以「14 天內沒開過新 session、但一直在用同一個舊 session」的專案會被整個篩掉。純效能的優化不值得這個代價。

**不得讀取 transcript 內容，只 stat**，且**不得遞迴**。

**主視圖**：一個專案一行。

```
● data-svc-2.0       2 分鐘前   1 個在跑              13 個 session
○ report-tool       1 小時前   1 個等輸入            25 個 session
● project-alpha    1 小時前   1 個中斷未回收        21 個 session
  TokenSvc            5 小時前                         19 個 session
```

專案的狀態圓點是其下所有 session 的聚合，優先序：**有 crashed → 紅；有 busy → 綠實心；有 idle → 綠空心；全部結束 → 無圓點（不是灰點，減少視覺噪音）**。

**`helm sessions <專案>`** 展開該專案的 session 列表，沿用現有的 session 層級呈現。

**`helm open` 與 `helm brief` 兩種參數都接**：專案名或 session id 前綴，自動判斷。專案名優先比對，因為那是主要用法。

### 名稱解析

專案以 `basename` 比對，大小寫不敏感，支援部分比對（`data-svc` 要能找到 `data-svc-2.0`）。歧義時**不要猜** —— 例如 `data-svc` 同時符合 `data-svc-2.0` 與 `data-svc-2.0-clone`，此時列出候選讓使用者選，並提示可用更長的字串。

session id 前綴的比對維持現狀。判斷順序：先試專案名，無結果再試 session id 前綴。

**多個活著的 session**：使用者會同時在一個專案開多個 CLI。`helm open <專案>` 若發現該專案有超過一個活著的 session，列出來讓他選，不要自動挑。只有一個時直接開。

### slug 反解（實作時補上，計畫原本漏了）

計畫寫「transcript 探索出 cwd」，但沒說**怎麼**從目錄名拿回 cwd。實測釐清了兩件事：

1. **Claude Code 的 slug 是逐字元取代 `[^a-zA-Z0-9]` 為 `-`，不是整段取代。** 證據：
   - `/Users/u/.pmk/review-workspace` → `-Users-u--pmk-review-workspace`（兩個 dash）
   - `/Users/u/Downloads/季評分Q1-reports` → `-Users-u-Downloads----Q1-reports`（四個 dash）

   既有的 `slugifyCwd` 用的是 `[^a-zA-Z0-9]+`（整段），**這是一個既存缺陷**：任何路徑含中文或連續非英數字元的專案，`findTranscript` 都會找不到而靜默回 null。一併修掉。

2. **反解必然是有損的**，一個 `-` 可能來自 `/`、`.`、`-`、空白或任何一個中文字，所以唯一可靠的做法是**走真實檔案系統回推**：逐層 readdir，比對哪些子目錄的 slug 形式能吃掉這段前綴，長的優先、走死路要回溯。實測 28 個 slug 全部反解耗時 5.3 ms，並加了步數上限防止病態目錄結構指數展開。

3. **cwd 必須正規化。** macOS 檔案系統大小寫不敏感但保留大小寫：註冊表記的是使用者打的 `~/Acme/TokenSvc`，磁碟上是 `token-service`。不正規化的話同一個專案會裂成兩行 —— 正是這個 Task 要消滅的東西。用 `realpathSync.native`，失敗就原樣退回（該路徑已不存在，下游 `cwdExists` 本來就會濾掉）。

反解不出來的 slug 直接略過，不計入 `invalid` 警告：反解失敗等於該目錄已不存在，`shouldInclude` 的 `cwdExists` 規則本來就會濾掉它，不是靜默資料遺失。

### Files

- Modify: `src/adapters/claude-code/discover.ts` 與其測試
- Create: `src/adapters/claude-code/slug.ts` 與其測試（slugify 與反解，計畫原本漏了）
- Create: `src/adapters/claude-code/scan.ts` 與其測試（transcript 掃描）
- Create: `src/projects/resolve.ts` 與其測試（名稱解析，純函式）
- Modify: `src/projects/group.ts` 與其測試（專案層級的狀態聚合）
- Modify: `src/projects/include.ts`（補 `/private/var/folders`，macOS 會把 `/var` 解到這裡）
- Create: `src/session-status.ts` 與其測試（`StatusKey`／`statusOf` 從 render 層抽出，
  否則 `group.ts` 得反向依賴 `render/glyphs.ts`；順帶收掉 Task 11 留下的同類 minor）
- Create: `src/board.ts`（`StatusResult` 改名 `Board` 並移出 `cli/status.ts`，
  解掉 `render/table.ts` 反向 import orchestration 層的問題 —— Task 11 的 deferred minor）
- Create: `src/render/width.ts` 與其測試（終端機顯示寬度；`padEnd` 數的是 UTF-16 單位，
  對不齊中文欄位）
- Modify: `src/render/table.ts` 與其測試（一專案一行）
- Create: `src/render/sessions.ts` 與其測試（`helm sessions` 的展開視圖）
- Create: `src/cli/target.ts` 與其測試（`brief`／`sessions`／日後的 `open` 共用同一套
  目標解析與歧義訊息，避免三個指令對「你指的是哪個」給出三種答案）
- Create: `src/cli/sessions.ts` 與其測試
- Modify: `src/cli/status.ts`、`src/cli/brief.ts`、`src/cli/main.ts`
- （`src/cli/open.ts` 屬 Task 10，此時尚未存在）

### Interfaces

- `interface DiscoverOptions { windowDays: number; nowMs: number }`
- `discoverClaudeCode(paths: HelmPaths, opts: DiscoverOptions): DiscoverResult`
- `ProjectView` 新增 `aggregateStatus: StatusKey | null`（null 表示全部結束）與 `sessionCount: number`
- `resolveTarget(projects: readonly ProjectView[], query: string): ResolveResult`
- `type ResolveResult = { kind: 'project'; project: ProjectView } | { kind: 'session'; session: SessionState } | { kind: 'ambiguous'; candidates: string[] } | { kind: 'notfound' }`
- `renderTable` 改為一專案一行；session 層級的呈現移到 `renderSessions`
- `discoverClaudeCode` 第三參數 `deps: DiscoverDeps = { subdirs, canonicalPath }`，供測試注入
- `resolveSlug(slug: string, deps: { subdirs: (dir: string) => readonly string[] }): string | null`
- `resolveOrReport(projects, query, write): TargetHit | null` 與 `chosenSession(hit)`

**刻意的行為變更**：session id 前綴撞到多個時，舊的 `resolveSession` 回傳第一個
（`brief.test.ts` 當時留了測試明說「日後若改成報錯，這個測試會提醒你那是刻意的」）。
現在改為列出候選並要求使用者打長一點 —— 挑錯 session 等於弄丟他的進度。
`resolveSession` 已由 `resolveOrReport` 取代。

### 驗收（重點，不可略過）

1. `helm status` 列出 12 個左右的專案，**一個專案一行**，含 `project-alpha`（它不在註冊表裡）
2. `helm sessions project-alpha` 展開得到該專案的 session 列表
3. `helm brief project-alpha` 找得到並產生簡報
4. `helm open data-svc` 在歧義時列出 `data-svc-2.0` 與 `data-svc-2.0-clone` 讓使用者選，**不自動挑**
5. 仍在註冊表裡的 session 保留正確的 busy/idle 與紅點判定，不因改用 transcript 探索而退化
6. `time helm status` 仍在 200ms 內，數字貼進報告
7. 雜訊路徑（`/private/tmp`、`Downloads`、`var/folders`）仍被排除

### 驗收結果（2026-08-11 實測）

1. ✅ 11 個專案、一個專案一行，`project-alpha` 在列（原本完全看不到）
2. ✅ `helm sessions project-alpha` 展開 21 個 session，含計畫點名的 `19519d4f`
3. ⚠️ 部分達成 —— 解析、transcript 讀取、git 快照、prompt 組裝、渲染全通（用假 runner 跑完整條路徑，
   prompt 22,234 字元），**真正的 LLM 呼叫未執行**，那是一次要花錢的付費呼叫，留給使用者決定
4. ✅ 以同一個 resolver 驗證（`helm sessions data-svc`）：列出 `data-svc-2.0` 與
   `data-svc-2.0-clone` 並提示「打長一點」，不自動挑。`helm open` 本身屬 Task 10
5. ✅ 以 fixture 驗證：註冊表殘留（PID 已死）仍判紅點並顯示「1 個中斷未回收」，
   同專案底下 transcript-only 的 session 顯示「已結束」，兩者並存
6. ✅ `collectStatus` 5 次量測 78.0 / 78.2 / 78.4 / 81.5 / 89.4 ms（契約 200ms）。
   CLI 端到端 0.32–0.40 s，差額是 Node 啟動與 TypeScript 型別剝離，不在契約範圍
7. ✅ `/private/tmp`、`Downloads`、`var/folders` 皆未出現在輸出中

覆蓋率 96.94%（270 個測試全綠，`tsc --noEmit` 乾淨）。

### 給 Task 12 的觀察

跑驗收 fixture 時 `ps` 的錯誤訊息（`ps: process id too large: 4194303`）直接漏到使用者的終端機，
因為 `execFileSync` 繼承了 stderr。Task 12 在處理 ps 批次失敗時應一併把 stderr 導掉。

### 一個誠實的限制

P3 的 hook 尚未實作，所以註冊表之外的歷史 session 沒有 live 檔可比對，一律落到 §6 真值表的「無 live 檔 → `ended_clean`」那一列。這是刻意的：**沒有證據就不該猜是當機**。因此重開機後看到的多半是「已結束」而非紅點，紅點只會出現在真正的異常中斷（註冊表殘留）。P3 完成後，這些歷史 session 會自動獲得正確的判定。

實務上這仍然解決了使用者的核心問題：重開機後他看得到 12 個專案、各自最後做到哪，並且能對任何一個要簡報與接續 —— 不再需要正確猜出 session id。
