# helm 任務狀態實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓看板在有可用交接簡報的 session 上顯示任務是完成、進行中還是卡住。

**Architecture:** 交接簡報的 JSON 增加 `taskStatus` 欄位，由同一次 LLM 呼叫產出。`collectStatus` 讀 `cache.json`，只對已有簡報的 session 計算 digest 比對新鮮度，把結果掛在 `SessionState` 上。會列出個別 session 的兩個呈現面讀它。

**Tech Stack:** TypeScript（Node 24 原生執行 .ts）、`node --test`、zod。

**Spec:** `docs/superpowers/specs/2026-08-14-helm-task-status-design.md`

## Global Constraints

- 測試不得碰真實家目錄。`npm test` 會設 `HELM_NO_REAL_PREFS=1`；實驗用 `/private/var/tmp`，不要用 `/tmp`（`src/projects/include.ts` 把它排除在專案之外）
- 效能量測用行程內部的 `process.uptime()`。這台機器 load average 常態 5 至 15，外部 wall clock 量不準
- `helm menu` 的快速路徑契約為 200 ms（規格 §11.2）。目前 `collectStatus` 中位數 32.3 ms
- 所有物件更新用展開運算子產生新物件，不就地修改
- commit 訊息用繁體中文，說明為什麼而不只是做了什麼，不使用破折號 `——`
- 每個 Task 結束前跑 `npm test` 與 `npm run check`，兩者都要過

---

### Task 1: 簡報產出 taskStatus

**Files:**
- Modify: `src/cache/store.ts:5-13`（`Brief` 介面）
- Modify: `src/summarize/brief.ts:14-22`（`BriefSchema`）
- Modify: `src/summarize/input.ts:37-45`（`FIELDS`）、`src/summarize/input.ts:75`（下一步那句）
- Test: `src/summarize/brief.test.ts`、`src/summarize/input.test.ts`

**Interfaces:**
- Consumes: 無
- Produces: `Brief.taskStatus?: 'done' | 'in_progress' | 'blocked'`（選用欄位，舊快取沒有時為 `undefined`）

- [ ] **Step 1: 寫會紅的測試**

在 `src/summarize/brief.test.ts` 末尾加入：

```typescript
test('三個合法的 taskStatus 都解析得出來', () => {
  for (const value of ['done', 'in_progress', 'blocked'] as const) {
    const raw = JSON.stringify({ goal: 'g', taskStatus: value })
    assert.equal(parseBriefJson(raw)?.taskStatus, value, value)
  }
})

test('taskStatus 是模型自己編的值時視為未知，不猜一個', () => {
  // 「完成了」「finished」這種回答不能硬塞進三個值之一。猜錯的方向是
  // 把沒做完的說成做完了。
  const raw = JSON.stringify({ goal: 'g', taskStatus: '完成了' })
  assert.equal(parseBriefJson(raw)?.taskStatus, undefined)
})

test('舊快取沒有 taskStatus 欄位時其餘欄位照常解析', () => {
  const raw = JSON.stringify({ goal: 'g', nextStep: 'n' })
  const brief = parseBriefJson(raw)
  assert.equal(brief?.goal, 'g')
  assert.equal(brief?.taskStatus, undefined)
})
```

在 `src/summarize/input.test.ts` 末尾加入：

```typescript
test('提示詞要求 taskStatus，並說明三個值各是什麼意思', () => {
  const prompt = renderSummaryPrompt(buildSummaryInput(session, digest, git))
  assert.match(prompt, /taskStatus/)
  for (const value of ['done', 'in_progress', 'blocked']) {
    assert.match(prompt, new RegExp(value), value)
  }
})

test('提示詞允許沒有下一步，否則模型會為了填滿欄位編一個出來', () => {
  // 原本那句是「回來後應該做的下一件事（具體到可以直接動手）」，整份提示詞
  // 的前提都是這個 session 被中斷了。不鬆開的話 taskStatus 永遠不會是 done。
  const prompt = renderSummaryPrompt(buildSummaryInput(session, digest, git))
  assert.match(prompt, /做完了.*留空|留空.*做完了|沒有下一步/)
})
```

`session`、`digest`、`git` 是 `src/summarize/input.test.ts` 第 10 至 21 行既有的常數，直接沿用。

- [ ] **Step 2: 跑測試確認它紅**

Run: `HELM_NO_REAL_PREFS=1 node --test src/summarize/brief.test.ts src/summarize/input.test.ts`
Expected: FAIL，5 條新測試全紅

- [ ] **Step 3: 改 Brief 介面**

`src/cache/store.ts` 的 `Brief` 增加一行：

```typescript
export interface Brief {
  goal: string
  done: string[]
  currentStep: string
  nextStep: string
  blockers: string[]
  files: string[]
  prs: string[]
  /**
   * 選用：舊快取沒有這個欄位，模型回傳非法值時也會是 undefined。
   * 兩種情況都代表未知，呈現面一律不顯示。
   */
  taskStatus?: 'done' | 'in_progress' | 'blocked'
}
```

- [ ] **Step 4: 改 BriefSchema**

`src/summarize/brief.ts` 的 `BriefSchema` 增加一行：

```typescript
const BriefSchema = z.object({
  goal: z.string().default(''),
  done: z.array(z.string()).default([]),
  currentStep: z.string().default(''),
  nextStep: z.string().default(''),
  blockers: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  prs: z.array(z.string()).default([]),
  // 不給 default：缺少與非法都要落在 undefined，那是「未知」。
  // 給了 default 等於替模型回答，而預設值一定會是三種說法裡的某一種。
  taskStatus: z.enum(['done', 'in_progress', 'blocked']).optional().catch(undefined),
})
```

- [ ] **Step 5: 改提示詞**

`src/summarize/input.ts` 的 `FIELDS` 增加一行：

```typescript
const FIELDS = `{
  "goal":        "這個 session 想達成什麼（一句話）",
  "done":        ["已經完成的事，每項一句"],
  "currentStep": "中斷當下正在做的那一步",
  "nextStep":    "回來後應該做的下一件事；已經做完就留空字串",
  "blockers":    ["卡住的地方；沒有就空陣列"],
  "files":       ["相關檔案路徑"],
  "prs":         ["相關的 PR 編號或網址；沒有就空陣列"],
  "taskStatus":  "done（這件事已經做完了，沒有下一步）／in_progress（還在做）／blocked（被 blockers 裡的東西擋住）"
}`
```

同一支檔案第 75 行那句改成：

```typescript
    '用繁體中文台灣用語填寫。「下一步」要具體到開發者看完就知道該動哪個檔案；如果這件事已經做完了，nextStep 留空字串並把 taskStatus 填 done，不要為了填滿欄位編一個下一步。',
```

- [ ] **Step 6: 跑測試確認它綠**

Run: `HELM_NO_REAL_PREFS=1 node --test src/summarize/brief.test.ts src/summarize/input.test.ts`
Expected: PASS

- [ ] **Step 7: 跑全套與 check**

Run: `npm test && npm run check`
Expected: 全過，check 離開碼 0

- [ ] **Step 8: Commit**

```bash
git add src/cache/store.ts src/summarize/brief.ts src/summarize/input.ts \
        src/summarize/brief.test.ts src/summarize/input.test.ts
git commit -m "feat: 交接簡報說得出這件事做完了沒

提示詞原本的第一句是「你正在為一個中斷的開發 session 寫交接簡報」，
並要求填「回來後應該做的下一件事」。整份提示詞的前提就是這個 session
被中斷了，沒有任何欄位允許模型回答「做完了」。

所以不能從既有欄位推導完成與否，要多一個 taskStatus 欄位，同時把
nextStep 那句鬆開成允許留空，否則模型會為了填滿欄位編一個下一步出來。

zod 的 taskStatus 刻意不給 default：缺少與非法都要落在 undefined。
給預設值等於替模型回答，而預設值一定會是三種說法裡的某一種。"
```

---

### Task 2: 任務狀態的判定與用詞

**Files:**
- Create: `src/task-status.ts`
- Test: `src/task-status.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Brief.taskStatus`；既有的 `BriefEntry`（`src/cache/store.ts:15-26`）
- Produces:
  - `export type TaskStatus = 'done' | 'in_progress' | 'blocked'`
  - `export const TASK_LABEL: Record<TaskStatus, string>`
  - `export function taskLabelOf(status: TaskStatus | null | undefined): string | null`

- [ ] **Step 1: 寫會紅的測試**

建立 `src/task-status.test.ts`：

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TASK_LABEL, taskLabelOf } from './task-status.ts'

test('三個狀態各有自己的詞', () => {
  assert.equal(taskLabelOf('done'), '任務完成')
  assert.equal(taskLabelOf('in_progress'), '任務進行中')
  assert.equal(taskLabelOf('blocked'), '任務卡住')
})

test('未知時回 null，讓呼叫端什麼都不畫', () => {
  // 舊快取沒有這個欄位、模型回傳非法值、簡報過期，三種都走這裡。
  // 回一個字串會逼呼叫端去猜哪個字串代表「不要畫」。
  assert.equal(taskLabelOf(null), null)
  assert.equal(taskLabelOf(undefined), null)
})

test('任務狀態的詞跟行程狀態的詞不重疊', () => {
  // 同一列會同時出現「已結束」與任務狀態，看得出是兩件事才有意義。
  const lifecycleWords = ['執行中', '等輸入', '已結束', '已中斷', '沒有動靜']
  for (const word of Object.values(TASK_LABEL)) {
    assert.ok(!lifecycleWords.includes(word), `「${word}」跟行程狀態撞詞`)
  }
})
```

- [ ] **Step 2: 跑測試確認它紅**

Run: `HELM_NO_REAL_PREFS=1 node --test src/task-status.test.ts`
Expected: FAIL，`Cannot find module './task-status.ts'`

- [ ] **Step 3: 建立模組**

建立 `src/task-status.ts`：

```typescript
/**
 * 任務狀態與行程狀態是兩個維度。
 *
 * `session-status.ts` 回答的是「這個行程還活著嗎」，這裡回答的是「我交代
 * 的那件事做完了沒」。一個已結束的 session 可能是做完才關掉，也可能是卡住
 * 就沒再回去，看板對這兩種畫的是同一個灰點。
 */
export type TaskStatus = 'done' | 'in_progress' | 'blocked'

/** 刻意與 session-status.ts 的用詞不重疊：同一列會同時出現兩者。 */
export const TASK_LABEL: Record<TaskStatus, string> = {
  done: '任務完成',
  in_progress: '任務進行中',
  blocked: '任務卡住',
}

/**
 * 未知時回 null，不是空字串。
 *
 * 舊快取沒有這個欄位、模型回傳非法值、簡報過期，三種情況都是未知，而呈現
 * 面對未知的處理是什麼都不畫。回字串會逼每個呼叫端自己判斷哪個字串代表
 * 「不要畫」。
 */
export function taskLabelOf(status: TaskStatus | null | undefined): string | null {
  return status === null || status === undefined ? null : TASK_LABEL[status]
}
```

- [ ] **Step 4: 跑測試確認它綠**

Run: `HELM_NO_REAL_PREFS=1 node --test src/task-status.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/task-status.ts src/task-status.test.ts
git commit -m "feat: 任務狀態的判定與用詞

任務狀態與行程狀態是兩個維度，同一列會同時出現，所以用詞刻意不重疊：
行程說「已結束」，任務說「任務完成」。有一條測試守著這件事。

未知時回 null 而不是空字串。舊快取沒有這個欄位、模型回傳非法值、簡報
過期，三種都是未知，而呈現面對未知的處理是什麼都不畫。回字串會逼每個
呼叫端自己判斷哪個字串代表不要畫。"
```

---

### Task 3: 把任務狀態掛到 session 上

**Files:**
- Modify: `src/types.ts:55-59`（`SessionState`）
- Create: `src/cli/task-status-of.ts`
- Modify: `src/cli/status.ts:70-89`（`collectStatus` 的回傳前）
- Test: `src/cli/task-status-of.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `TaskStatus`；既有的 `readCache`、`getFreshBriefEntry`、`digestOf`（`src/cache/store.ts`）
- Produces:
  - `SessionState.taskStatus: TaskStatus | null`（必填欄位，未知時為 `null`）
  - `export function attachTaskStatus(sessions: readonly SessionState[], cacheFile: string, deps?: TaskStatusDeps): SessionState[]`
  - `export interface TaskStatusDeps { readCache: (f: string) => CacheShape; digestOf: (p: string | null) => string | null }`

- [ ] **Step 1: 寫會紅的測試**

建立 `src/cli/task-status-of.test.ts`：

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachTaskStatus } from './task-status-of.ts'
import { EMPTY_CACHE, type BriefEntry, type CacheShape } from '../cache/store.ts'
import type { SessionState } from '../types.ts'

const sess = (over: Partial<SessionState> & { sessionId: string }): SessionState => ({
  adapterId: 'claude-code', cwd: '/p/a', pid: null, procStart: null, startedAt: 0,
  updatedAt: 0, nativeStatus: null, kind: 'interactive', name: '',
  transcriptPath: `/t/${over.sessionId}.jsonl`, transcriptMtimeMs: null,
  lifecycle: 'ended_clean', lifecycleConfidence: 'high', live: null,
  taskStatus: null, ...over,
})

const entry = (over: Partial<BriefEntry> = {}): BriefEntry => ({
  digest: '10:20', generatedAt: 0, gitBranch: null,
  body: {
    goal: '', done: [], currentStep: '', nextStep: '', blockers: [], files: [], prs: [],
    taskStatus: 'done',
  },
  ...over,
})

const cacheWith = (briefs: Record<string, BriefEntry>): CacheShape =>
  ({ ...EMPTY_CACHE, briefs })

const deps = (cache: CacheShape, digest: string | null = '10:20') => ({
  readCache: () => cache,
  digestOf: () => digest,
})

test('digest 相符時掛上簡報裡的任務狀態', () => {
  const out = attachTaskStatus([sess({ sessionId: 'a' })], '/c', deps(cacheWith({ a: entry() })))
  assert.equal(out[0]?.taskStatus, 'done')
})

test('digest 不符時不掛，顯示過期的「任務完成」比不顯示更糟', () => {
  const out = attachTaskStatus([sess({ sessionId: 'a' })], '/c', deps(cacheWith({ a: entry() }), '99:99'))
  assert.equal(out[0]?.taskStatus, null)
})

test('沒有簡報的 session 不去 stat 它的 transcript', () => {
  // 看板上 156 個 session 有 3 個有簡報。對全部都算 digest 等於多 153 次
  // stat，而那 153 次的答案一定是「沒有簡報」。
  let stats = 0
  attachTaskStatus([sess({ sessionId: 'a' }), sess({ sessionId: 'b' })], '/c', {
    readCache: () => cacheWith({ a: entry() }),
    digestOf: () => {
      stats++
      return '10:20'
    },
  })
  assert.equal(stats, 1, '只有有簡報的那個需要算 digest')
})

test('簡報沒有 taskStatus 欄位時掛 null', () => {
  const old = entry()
  const out = attachTaskStatus([sess({ sessionId: 'a' })], '/c', deps(cacheWith({
    a: { ...old, body: { ...old.body, taskStatus: undefined } },
  })))
  assert.equal(out[0]?.taskStatus, null)
})

test('快取讀不到時整批回 null，不讓看板其餘部分受影響', () => {
  const out = attachTaskStatus([sess({ sessionId: 'a' })], '/c', {
    readCache: () => {
      throw new Error('boom')
    },
    digestOf: () => '10:20',
  })
  assert.equal(out.length, 1)
  assert.equal(out[0]?.taskStatus, null)
})

test('不修改輸入', () => {
  const input = [sess({ sessionId: 'a' })]
  const snapshot = structuredClone(input)
  attachTaskStatus(input, '/c', deps(cacheWith({ a: entry() })))
  assert.deepEqual(input, snapshot)
})
```

- [ ] **Step 2: 跑測試確認它紅**

Run: `HELM_NO_REAL_PREFS=1 node --test src/cli/task-status-of.test.ts`
Expected: FAIL，`Cannot find module './task-status-of.ts'`

- [ ] **Step 3: SessionState 增加欄位**

`src/types.ts` 的 `SessionState` 改成：

```typescript
export interface SessionState extends DiscoveredSession {
  lifecycle: Lifecycle
  lifecycleConfidence: Confidence
  live: LiveMarker | null
  /**
   * 從交接簡報來的任務狀態，未知時為 null。
   *
   * adapter 產不出這個值（它來自簡報快取），所以 adapter 一律填 null，
   * 由 `attachTaskStatus` 在 collectStatus 裡補上。
   */
  taskStatus: TaskStatus | null
}
```

同一支檔案頂端加入 `import type { TaskStatus } from './task-status.ts'`。

- [ ] **Step 4: 讓兩個 adapter 填 null**

`src/adapters/codex/discover.ts` 回傳 session 的物件字面值增加 `taskStatus: null`。

`src/adapters/claude-code/` 底下產生 `SessionState` 的地方（`reconcileSessions` 在 `src/reconcile/lifecycle.ts`）同樣增加 `taskStatus: null`。用 `npm run check` 的 typecheck 找出所有缺少該欄位的位置，逐一補上。

- [ ] **Step 5: 建立 attachTaskStatus**

建立 `src/cli/task-status-of.ts`：

```typescript
import { digestOf as realDigestOf, getFreshBriefEntry, readCache as realReadCache, type CacheShape } from '../cache/store.ts'
import type { SessionState } from '../types.ts'

export interface TaskStatusDeps {
  readCache: (cacheFile: string) => CacheShape
  digestOf: (transcriptPath: string | null) => string | null
}

const DEFAULT_DEPS: TaskStatusDeps = {
  readCache: realReadCache,
  digestOf: realDigestOf,
}

/**
 * 把簡報裡的任務狀態掛到 session 上。
 *
 * 只對快取裡真的有簡報的 session 算 digest。看板上 156 個 session 中有 3 個
 * 有簡報，對全部都算等於多 153 次 stat，而那 153 次的答案一定是「沒有簡報」。
 *
 * 過期的簡報不掛。digest 比對同時處理了規格 §4.3 最後一列：還在跑的 session
 * transcript 一直在變，簡報必然過期，不需要另外判斷。
 */
export function attachTaskStatus(
  sessions: readonly SessionState[],
  cacheFile: string,
  deps: TaskStatusDeps = DEFAULT_DEPS,
): SessionState[] {
  let cache: CacheShape
  try {
    cache = deps.readCache(cacheFile)
  } catch {
    // 快取讀不到只影響這一個維度，看板其餘部分照常。
    return sessions.map((s) => ({ ...s, taskStatus: null }))
  }
  return sessions.map((s) => {
    if (cache.briefs[s.sessionId] === undefined) return { ...s, taskStatus: null }
    const fresh = getFreshBriefEntry(cache, s.sessionId, deps.digestOf(s.transcriptPath))
    return { ...s, taskStatus: fresh?.body.taskStatus ?? null }
  })
}
```

- [ ] **Step 6: 跑測試確認它綠**

Run: `HELM_NO_REAL_PREFS=1 node --test src/cli/task-status-of.test.ts`
Expected: PASS

- [ ] **Step 7: 串進 collectStatus**

`src/cli/status.ts` 在 `groupIntoProjects` 之前加入一行，並在頂端 import：

```typescript
import { attachTaskStatus } from './task-status-of.ts'
```

```typescript
  // 掛在分組之前，這樣每個呈現面拿到的 session 都已經帶著任務狀態。
  const withTask = attachTaskStatus(states, paths.cacheFile)

  const projects = groupIntoProjects(withTask, {
```

- [ ] **Step 8: 量效能**

Run:

```bash
node --input-type=module -e '
import { collectStatus } from "./src/cli/status.ts"
import { resolvePaths } from "./src/paths.ts"
const paths = resolvePaths()
collectStatus(paths, Date.now(), undefined, () => {})
const ms = []
for (let i = 0; i < 7; i++) {
  const t0 = process.uptime()
  collectStatus(paths, Date.now(), undefined, () => {})
  ms.push((process.uptime() - t0) * 1000)
}
ms.sort((a, b) => a - b)
console.log(`中位數 ${ms[3].toFixed(1)} ms`)
'
```

Expected: 中位數低於 200 ms。改動前是 32.3 ms；若超過 60 ms 要先查為什麼，多讀一個 7 KB 的檔案不該有那麼大的差別。

- [ ] **Step 9: 跑全套與 check**

Run: `npm test && npm run check`
Expected: 全過，check 離開碼 0

- [ ] **Step 10: Commit**

```bash
git add src/types.ts src/cli/task-status-of.ts src/cli/task-status-of.test.ts \
        src/cli/status.ts src/adapters src/reconcile
git commit -m "feat: 看板讀得到交接簡報的任務狀態

adapter 產不出這個值，它來自簡報快取，所以 adapter 一律填 null，由
collectStatus 補上。

只對快取裡真的有簡報的 session 算 digest。看板上 156 個 session 有 3 個
有簡報，對全部都算等於多 153 次 stat，而那 153 次的答案一定是沒有簡報。

過期的簡報不掛。digest 比對同時處理了還在跑的 session：它的 transcript
一直在變，簡報必然過期，不需要另外判斷。

快取讀不到時整批回 null，不影響看板其餘部分。"
```

---

### Task 4: helm sessions 與選單列顯示

**Files:**
- Modify: `src/render/sessions.ts:33-42`（`renderSession`）
- Modify: `src/render/swiftbar.ts:138-154`（`renderSession`）
- Test: `src/render/sessions.test.ts`、`src/render/swiftbar.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `taskLabelOf`；Task 3 的 `SessionState.taskStatus`
- Produces: 無新介面

- [ ] **Step 1: 寫會紅的測試**

在 `src/render/sessions.test.ts` 末尾加入：

```typescript
test('有任務狀態時顯示在那一列', () => {
  const out = renderSessions(proj({
    sessions: [sess({ lifecycle: 'ended_clean', taskStatus: 'blocked' })],
  }), opts)
  assert.match(out, /已結束/)
  assert.match(out, /任務卡住/)
})

test('沒有任務狀態時不留下空欄位', () => {
  // 156 個 session 裡只有 3 個有簡報。多一個永遠是空的欄位等於多 153 行雜訊。
  const out = renderSessions(proj({
    sessions: [sess({ lifecycle: 'ended_clean', taskStatus: null })],
  }), opts)
  const line = out.split('\n').find((l) => l.includes('已結束')) ?? ''
  assert.doesNotMatch(line, /任務/, line)
  assert.equal(line, line.trimEnd(), `結尾有多餘空白：${JSON.stringify(line)}`)
})
```

`proj`、`sess`、`opts` 是 `src/render/sessions.test.ts` 第 10 至 27 行既有的 fixture。`sess` 的預設值要補上 `taskStatus: null`，否則型別不過。

在 `src/render/swiftbar.test.ts` 末尾加入：

```typescript
test('選單列的 session 列也顯示任務狀態', () => {
  const out = renderSwiftBar(board([proj({
    sessions: [sess({ lifecycle: 'ended_clean', taskStatus: 'done' })],
  })]), OPTS)
  const line = body(out).split('\n').find((l) => l.includes('abcdef12')) ?? ''
  assert.match(line, /任務完成/, line)
})

test('選單列沒有任務狀態時不多出分隔空白', () => {
  const out = renderSwiftBar(board([proj({
    sessions: [sess({ lifecycle: 'ended_clean', taskStatus: null })],
  })]), OPTS)
  const line = body(out).split('\n').find((l) => l.includes('abcdef12')) ?? ''
  assert.doesNotMatch(line, /任務/, line)
  assert.doesNotMatch(line, / {3}/, `多出連續空白：${JSON.stringify(line)}`)
})
```

- [ ] **Step 2: 跑測試確認它紅**

Run: `HELM_NO_REAL_PREFS=1 node --test src/render/sessions.test.ts src/render/swiftbar.test.ts`
Expected: FAIL，4 條新測試裡至少 2 條紅（顯示那兩條）

- [ ] **Step 3: 改 helm sessions**

`src/render/sessions.ts` 的 `renderSession` 改成：

```typescript
function renderSession(s: SessionState, opts: RenderOptions): string {
  const key = statusOf(s)
  const head = [
    glyph(key, s.lifecycleConfidence, opts.color),
    isUnearnedClaim(s) ? UNEARNED_LABEL : LABEL[key],
    padTo(s.sessionId.slice(0, SHORT_ID), SHORT_ID),
    relativeTime(s.updatedAt, opts.nowMs),
  ].join('  ')
  return `${head}${taskSuffix(s)}${liveSuffix(s)}${resumeHint(s, key, opts)}`
}

/** 只有問過的 session 才有這一段。沒問過的不畫空欄位。 */
function taskSuffix(s: SessionState): string {
  const label = taskLabelOf(s.taskStatus)
  return label === null ? '' : `  ${label}`
}
```

檔案頂端加入 `import { taskLabelOf } from '../task-status.ts'`。

- [ ] **Step 4: 改選單列**

`src/render/swiftbar.ts` 的 `renderSession` 那一行改成：

```typescript
    `--${mark} ${label}  ${short}  ${relativeTime(s.updatedAt, opts.nowMs)}${taskSuffix(s)}${liveSuffix(s)}`,
```

同一支檔案加入：

```typescript
/** 與 helm sessions 同一個詞、同一個「沒有就不畫」的規則。 */
function taskSuffix(s: SessionState): string {
  const label = taskLabelOf(s.taskStatus)
  return label === null ? '' : `  ${clean(label)}`
}
```

檔案頂端加入 `import { taskLabelOf } from '../task-status.ts'`。

- [ ] **Step 5: 跑測試確認它綠**

Run: `HELM_NO_REAL_PREFS=1 node --test src/render/sessions.test.ts src/render/swiftbar.test.ts`
Expected: PASS

- [ ] **Step 6: 跑全套與 check**

Run: `npm test && npm run check`
Expected: 全過。若 `src/faces.test.ts` 紅了，先不要改它，那是 Task 6 要處理的。

- [ ] **Step 7: Commit**

```bash
git add src/render/sessions.ts src/render/swiftbar.ts \
        src/render/sessions.test.ts src/render/swiftbar.test.ts
git commit -m "feat: 兩個列出 session 的面顯示任務狀態

只有問過的 session 才畫這一段。看板上 156 個 session 有 3 個有簡報，
補一個永遠是空的欄位等於多 153 行沒有內容的字。

兩個面用同一個詞與同一條「沒有就不畫」的規則，faces.test.ts 會在
Task 6 加一條測試守住這件事。"
```

---

### Task 5: helm brief 的輸出

**Files:**
- Modify: `src/render/brief-md.ts:10-40`（`renderBriefMarkdown`）
- Test: `src/render/brief-md.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Brief.taskStatus`；Task 2 的 `taskLabelOf`
- Produces: 無新介面

- [ ] **Step 1: 寫會紅的測試**

在 `src/render/brief-md.test.ts` 末尾加入：

```typescript
test('簡報標題區說出任務狀態', () => {
  const out = renderBriefMarkdown({ ...BRIEF, taskStatus: 'blocked' }, META)
  assert.match(out, /任務卡住/)
})

test('舊簡報沒有 taskStatus 時標題區不多一行空的', () => {
  const out = renderBriefMarkdown({ ...BRIEF, taskStatus: undefined }, META)
  assert.doesNotMatch(out, /任務狀態/)
})
```

`BRIEF` 與 `META` 是 `src/render/brief-md.test.ts` 第 6 至 20 行既有的 fixture，直接沿用。

- [ ] **Step 2: 跑測試確認它紅**

Run: `HELM_NO_REAL_PREFS=1 node --test src/render/brief-md.test.ts`
Expected: FAIL，第一條紅

- [ ] **Step 3: 改 renderBriefMarkdown**

`src/render/brief-md.ts` 的標題區改成：

```typescript
export function renderBriefMarkdown(brief: Brief, meta: BriefMeta): string {
  const task = taskLabelOf(brief.taskStatus)
  return [
    `# 交接簡報 — ${meta.cwd}`,
    '',
    `- Session：\`${meta.sessionId}\``,
    `- 分支：${meta.gitBranch ?? '（未知）'}`,
    `- 產生時間：${new Date(meta.generatedAt).toISOString()}`,
    // 舊簡報沒有這個欄位，那時不多一行空的出來。
    ...(task === null ? [] : [`- 任務狀態：${task}`]),
    '',
    '## 目標',
```

檔案頂端加入 `import { taskLabelOf } from '../task-status.ts'`。

- [ ] **Step 4: 跑測試確認它綠**

Run: `HELM_NO_REAL_PREFS=1 node --test src/render/brief-md.test.ts`
Expected: PASS

- [ ] **Step 5: 跑全套與 check**

Run: `npm test && npm run check`
Expected: 全過

- [ ] **Step 6: Commit**

```bash
git add src/render/brief-md.ts src/render/brief-md.test.ts
git commit -m "feat: helm brief 的輸出說出任務狀態

舊簡報沒有這個欄位，那時不多印一行空的出來。"
```

---

### Task 6: 跨面一致性與規格同步

**Files:**
- Modify: `src/faces.test.ts`
- Modify: `docs/superpowers/specs/2026-08-11-helm-design.md`（§8 的 `Brief` 欄位表、§11.1 的狀態語彙）

**Interfaces:**
- Consumes: Task 2 的 `TASK_LABEL`；Task 4 的兩個呈現面
- Produces: 無新介面

- [ ] **Step 1: 寫會紅的測試**

在 `src/faces.test.ts` 的 `SESSIONS` 陣列增加三個帶任務狀態的 session：

```typescript
  sess({ sessionId: 'taskdone', lifecycle: 'ended_clean', taskStatus: 'done' }),
  sess({ sessionId: 'taskprog', lifecycle: 'crashed', taskStatus: 'in_progress' }),
  sess({ sessionId: 'taskblok', lifecycle: 'ended_clean', taskStatus: 'blocked' }),
```

同一支檔案的 `sess` 預設值補上 `taskStatus: null`，並在末尾加入：

```typescript
test('任務狀態在選單列與 helm sessions 用同一個詞', () => {
  const m = menu()
  const s = sessions()
  for (const session of SESSIONS) {
    const want = taskLabelOf(session.taskStatus)
    const inMenu = lineWith(m, session.sessionId)
    const inSessions = lineWith(s, session.sessionId)
    if (want === null) {
      assert.doesNotMatch(inMenu, /任務/, `選單列對沒問過的 ${session.sessionId} 畫了東西：${inMenu}`)
      assert.doesNotMatch(inSessions, /任務/, `helm sessions 同上：${inSessions}`)
      continue
    }
    assert.ok(inMenu.includes(want), `選單列對 ${session.sessionId} 用的不是「${want}」：${inMenu}`)
    assert.ok(inSessions.includes(want), `helm sessions 對 ${session.sessionId} 用的不是「${want}」：${inSessions}`)
  }
})
```

檔案頂端加入 `import { taskLabelOf } from './task-status.ts'`。

- [ ] **Step 2: 跑測試確認它紅**

先把 `src/render/swiftbar.ts` 的 `taskSuffix` 暫時改成回傳 `''`，跑：

Run: `HELM_NO_REAL_PREFS=1 node --test src/faces.test.ts`
Expected: FAIL，新測試抓到選單列少了那個詞

改回來後再跑一次，Expected: PASS。這一步是在確認新測試真的守得住，不是走個形式。

- [ ] **Step 3: 更新規格 §8**

`docs/superpowers/specs/2026-08-11-helm-design.md` 的 §8 交接簡報，在欄位表增加一列：

```
| `taskStatus` | `done` / `in_progress` / `blocked`；模型判斷這件事做完了沒。缺少或非法時視為未知，看板不顯示 |
```

- [ ] **Step 4: 更新規格 §11.1**

同一支檔案的 §11.1 在既有的狀態表後面增加一段：

```markdown
狀態分兩組，同一列可以同時出現：

**行程狀態**（上表）回答「這個行程還活著嗎」。

**任務狀態**回答「交代的那件事做完了沒」，來自交接簡報，只有產生過簡報
且簡報未過期的 session 才有：

| 值 | 顯示 |
|---|---|
| `done` | 任務完成 |
| `in_progress` | 任務進行中 |
| `blocked` | 任務卡住 |

用詞刻意與行程狀態不重疊，同一列同時出現時要看得出是兩件事。沒有簡報、
簡報過期、或模型回傳的值不合法時，這一段不顯示。
```

- [ ] **Step 5: 跑全套與 check**

Run: `npm test && npm run check`
Expected: 全過

- [ ] **Step 6: Commit**

```bash
git add src/faces.test.ts docs/superpowers/specs/2026-08-11-helm-design.md
git commit -m "test: 任務狀態的跨面一致性，並同步規格

兩個面各有一份顯示邏輯，而畫面上只有那幾個字。這條測試涵蓋有狀態與
沒狀態兩種，沒狀態時斷言兩個面都沒畫東西。

規格 §8 補上 taskStatus 欄位，§11.1 把狀態語彙分成行程與任務兩組。"
```

---

### Task 7: 變異測試與真實驗證

**Files:**
- Create: `/private/var/tmp/helm-mutate-task-status.mjs`（不進 repo）

**Interfaces:**
- Consumes: Task 1 至 6 的全部產出
- Produces: 無

- [ ] **Step 1: 寫變異測試腳本**

建立 `/private/var/tmp/helm-mutate-task-status.mjs`：

```javascript
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const FILES = [
  'src/task-status.ts', 'src/cli/task-status-of.ts',
  'src/render/sessions.ts', 'src/render/swiftbar.ts',
  'src/render/brief-md.ts', 'src/summarize/brief.ts',
]
const O = Object.fromEntries(FILES.map((f) => [f, readFileSync(f, 'utf8')]))
const TESTS = [
  'src/task-status.test.ts', 'src/cli/task-status-of.test.ts',
  'src/render/sessions.test.ts', 'src/render/swiftbar.test.ts',
  'src/render/brief-md.test.ts', 'src/summarize/brief.test.ts',
  'src/faces.test.ts',
]
const M = [
  ['T1 未知時回空字串而非 null', 'src/task-status.ts',
    "return status === null || status === undefined ? null : TASK_LABEL[status]",
    "return status === null || status === undefined ? '' : TASK_LABEL[status]"],
  ['T2 過期的簡報照樣掛上', 'src/cli/task-status-of.ts',
    'const fresh = getFreshBriefEntry(cache, s.sessionId, deps.digestOf(s.transcriptPath))',
    'const fresh = cache.briefs[s.sessionId]'],
  ['T3 對每個 session 都算 digest', 'src/cli/task-status-of.ts',
    'if (cache.briefs[s.sessionId] === undefined) return { ...s, taskStatus: null }', ''],
  ['T4 快取讀不到時整個丟例外', 'src/cli/task-status-of.ts',
    '  } catch {\n    // 快取讀不到只影響這一個維度，看板其餘部分照常。\n    return sessions.map((s) => ({ ...s, taskStatus: null }))\n  }',
    '  } catch (e) {\n    throw e\n  }'],
  ['T5 helm sessions 不畫任務狀態', 'src/render/sessions.ts',
    '${taskSuffix(s)}', ''],
  ['T6 選單列不畫任務狀態', 'src/render/swiftbar.ts',
    '${taskSuffix(s)}', ''],
  ['T7 沒有狀態時照樣畫分隔空白', 'src/render/sessions.ts',
    "return label === null ? '' : `  ${label}`", 'return `  ${label ?? \'\'}`'],
  ['T8 brief 沒有狀態時照樣印一行', 'src/render/brief-md.ts',
    '...(task === null ? [] : [`- 任務狀態：${task}`])', "`- 任務狀態：${task ?? ''}`"],
  ['T9 非法的 taskStatus 用預設值填', 'src/summarize/brief.ts',
    "taskStatus: z.enum(['done', 'in_progress', 'blocked']).optional().catch(undefined),",
    "taskStatus: z.enum(['done', 'in_progress', 'blocked']).catch('in_progress'),"],
]
const out = []
for (const [n, f, from, to] of M) {
  if (!O[f].includes(from)) { out.push([n, 'SKIP 找不到目標']); continue }
  writeFileSync(f, O[f].split(from).join(to))
  let killed = false, d = ''
  try {
    execFileSync('node', ['--test', ...TESTS], {
      encoding: 'utf8', stdio: 'pipe', env: { ...process.env, HELM_NO_REAL_PREFS: '1' },
    })
  } catch (e) {
    killed = true
    d = [...new Set((String(e.stdout ?? '').match(/^✖ (?!failing)(.+?) \(/gm) ?? [])
      .map((s) => s.slice(2).replace(/ \($/, '')))].join(' / ')
  }
  writeFileSync(f, O[f])
  out.push([n, killed ? `KILLED by: ${d}` : '*** 存活 ***'])
}
for (const f of FILES) writeFileSync(f, O[f])
for (const [n, r] of out) console.log(`${n.padEnd(32)} ${r}`)
```

- [ ] **Step 2: 跑變異測試**

Run: `node /private/var/tmp/helm-mutate-task-status.mjs`
Expected: 9 個全部 KILLED。有存活的就補測試，不是改變異。

- [ ] **Step 3: 確認 repo 沒被變異腳本改壞**

Run: `git status --short`
Expected: 沒有未預期的修改

- [ ] **Step 4: 對真實資料驗證**

Run:

```bash
node src/cli/main.ts brief --refresh <一個真實的 session id>
node src/cli/main.ts sessions <該 session 所屬的專案> --no-color | grep <session id 前 8 碼>
```

Expected: `helm brief` 的輸出有「任務狀態」那一行，`helm sessions` 那一列有同一個詞。

再跑一次 `helm sessions`，確認其餘 155 個 session 那一列沒有多出任何東西。

- [ ] **Step 5: 補跑第二輪變異測試**

若 Step 2 有存活的變異並補了測試，重跑一次確認全殺。

Run: `node /private/var/tmp/helm-mutate-task-status.mjs`
Expected: 9 個全部 KILLED

- [ ] **Step 6: Commit**

若 Step 2 或 Step 5 補了測試：

```bash
git add src
git commit -m "test: 補上變異測試抓到的缺口

<列出哪幾個變異原本存活、補了什麼測試>"
```

若沒有補測試則跳過這一步。

---

## 完成後的狀態

- `helm brief` 的輸出多一行任務狀態
- `helm sessions` 與選單列在有可用簡報的 session 上顯示同一個詞
- 沒有簡報或簡報過期的 session 完全不受影響
- 規格 §8 與 §11.1 同步
- 變異測試 9 個全殺
