# P4：Codex adapter 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓看板看得到 Codex 的 session，與 Claude Code 並列在同一個專案底下。

**Architecture:** 新增 `src/adapters/codex/`，形狀與 `claude-code/` 對稱。核心的 `collectStatus` 改成跑過一組 adapter 而不是寫死一個；`reconcile` 依 `adapterId` 分派 lifecycle 規則。UI 不動——它早就吃 `SessionState`，而低信心的區分呈現（選單列 `●?`、widget `◍`）在 P3 的 review 修正裡已經就緒。

**Tech Stack:** TypeScript on Node 24（無 build step）、`node --test`。外部指令只用 `pgrep` 與 `lsof`，兩者都在 launchd 的裸 PATH 裡。

## Global Constraints

- `discoverSessions` 的效能契約：**不得讀 transcript、不得發網路請求**。選單列每 5 秒呼叫它。
- Codex session 的 `lifecycleConfidence` **一律 `low`**（規格 §6），且**永遠不會是 `ended_clean`**——Codex 沒有終止事件。
- 測試不得碰真實的 `~/.codex`。所有 fixture 走 `tempDir()`。
- 每個降級的 `catch` 都要有註解說明為什麼；使用者可見的降級必須說出來。

---

## 實測資料（2026-08-12，本機 codex-cli 0.146.0）

計畫的每個決定都建立在這些數字上：

```
~/.codex/history.jsonl            552 行、61 個 session id
~/.codex/sessions/**/rollout-*.jsonl   192 個，近 14 天 34 個
兩者 session id 交集                60（history 只涵蓋有送出 prompt 的）
rollout 第一行大小                 8.6–18.6 KB（塞著完整的 base_instructions）
讀 34 個檔案的第一行               25.7 ms
lsof -a -d cwd -p <13 pids>        32 ms（對照：ps -eo 是 36 ms）
```

### 修正（2026-08-12，寫完計畫後用全部 192 個檔案驗證時發現）

原本寫的是「檔名就帶著 session_id，所以快速路徑只有 cwd 需要讀檔」。**那是錯的。**

檔名裡的 uuid 是**那個 rollout 檔案自己的 id**，不是 session id：

```
rollout-2026-08-03T14-25-24-019fc64c-6b8a-7882-8c7b-c019bd18484c.jsonl
        └─────── 開始時間 ──────┘ └────── 這個檔案的 id ──────────┘
```

真正的 session id 在第一行的 `payload.session_id ?? payload.id`，而**一個 session 會橫跨多個 rollout 檔**（續接與 fork）：

```
192 個 rollout 檔  →  依 meta 的 id 分組後只有 86 個 session
其中 13 個 session 橫跨多個檔案，最多的一個有 33 個
history.jsonl 的 61 個 id：60 個對得上分組後的 session（一個是舊格式）
session_meta 的 payload 有 14 種形狀（2026-04 到 2026-08 的版本演進），
  但 cwd 在 192/192 都存在且都是絕對路徑
```

照檔案畫的話，那個 33 個檔的專案會在看板上變成 33 行同一個 session。

**所以第一行非讀不可**，session id 與 cwd 都在裡面。快取仍然救得回效能——rollout 檔一旦寫好，它的 `id` 與 `cwd` 就不再改變，快取 key 用檔名（唯一），value 存 `{sessionId, cwd}`：首次付 25.7 ms，之後只有新檔案要讀。

`rollout-name.ts` 仍然有用：它解出的是**快取的 key 與這個檔案的起始時間**，不是 session id。這個角色差異要寫進它的型別名稱裡，否則下一個人會再踩一次。

## File Structure

| 檔案 | 責任 |
|---|---|
| `src/adapters/codex/paths.ts` | `~/.codex` 底下的位置，與 `HelmPaths` 對稱 |
| `src/adapters/codex/rollout-name.ts` | 檔名 → `{rolloutId, startedAt}`，純函式（不是 session id） |
| `src/adapters/codex/scan.ts` | 遞迴掃 `sessions/YYYY/MM/DD/`，只 stat 不讀內容 |
| `src/adapters/codex/meta.ts` | 讀 `session_meta` 第一行取 session id 與 `cwd`；帶持久快取 |
| `src/adapters/codex/processes.ts` | `pgrep codex` + `lsof -d cwd`，回 cwd → pid |
| `src/adapters/codex/discover.ts` | 組裝成 `DiscoveredSession[]` |
| `src/adapters/codex/history.ts` | 慢速路徑：從 `history.jsonl` 取該 session 的 prompt |
| `src/adapters/registry.ts` | 一組 adapter，`collectStatus` 跑過它 |

---

### Task 1：從 rollout 檔名解析檔案 id 與開始時間

**Files:** Create `src/adapters/codex/rollout-name.ts`、`rollout-name.test.ts`

**Interfaces:** Produces `parseRolloutName(name: string): { rolloutId: string; startedAt: number } | null`

**注意：** 回傳的是 `rolloutId`（這個檔案自己的 id），**不是 session id**。session id 只存在第一行的 payload 裡，見上面的修正。

- [x] **Step 1：寫失敗測試**——正常檔名、非 rollout 檔名、時間戳格式壞掉、uuid 少一段、目錄分隔符混進來。時間是本地時間還是 UTC 要對照 `session_meta.timestamp` 確認（實測那一筆檔名 `T14-25-24` 對應 payload 的 `06:25:24.937Z`，差 8 小時 → **檔名是本地時間**，這件事必須有測試釘住，否則排序會錯 8 小時）
- [x] **Step 2：跑測試確認紅**
- [x] **Step 3：實作**——`rollout-<YYYY>-<MM>-<DD>T<HH>-<mm>-<ss>-<uuid>.jsonl`，uuid 是最後 36 字元
- [x] **Step 4：綠**
- [x] **Step 5：commit**

### Task 2：掃描 rollout 目錄

**Files:** Create `src/adapters/codex/scan.ts`、`scan.test.ts`

**Interfaces:** Consumes Task 1。Produces `scanRollouts(sessionsDir, sinceMs): RolloutFile[]`，欄位 `{ rolloutId, path, startedAt, mtimeMs }`

- [x] **Step 1：寫失敗測試**——`YYYY/MM/DD` 三層結構、窗口過濾用 mtime 不是檔名時間（session 可能開很久）、目錄不存在回空陣列不丟例外、非 rollout 檔案略過、檔名解析失敗的檔案略過而不是讓整批失敗
- [x] **Step 2：紅**
- [x] **Step 3：實作**——`readdirSync(withFileTypes)` 遞迴三層，只 `statSync`，絕不讀內容
- [x] **Step 4：綠**
- [x] **Step 5：量測**——對真實的 `~/.codex` 跑：**1.6–2.6 ms**（掃過 192 個檔、窗口內 34 個）。只 stat 不讀內容的代價，對照讀第一行的 25.7 ms
- [x] **Step 6：commit**

### Task 3：cwd 的讀取與快取

**Files:** Create `src/adapters/codex/meta.ts`、`meta.test.ts`

**Interfaces:** Produces `readMeta(path): { sessionId: string; cwd: string } | null`、`MetaCache` 介面 `{ get(rolloutId), set(rolloutId, meta), flush() }`

**多形狀容忍：** `payload` 有 14 種變體。只取 `session_id ?? id` 與 `cwd`，其餘一律忽略——任何對其他欄位的依賴都會在下一次 Codex 改版時斷掉。

- [x] **Step 1：寫失敗測試**——第一行不是 JSON、`type` 不是 `session_meta`、`payload.cwd` 缺、cwd 不是絕對路徑（一律拒絕，同 `scan-dir.ts` 的理由）、18 KB 的第一行讀得完、快取命中時不碰檔案（用一個會丟例外的 reader 證明）
- [x] **Step 2：紅**
- [x] **Step 3：實作**——快取檔 `~/.helm/codex-cwd.json`，原子寫（temp + rename），讀不到就當空快取
- [x] **Step 4：綠**
- [x] **Step 5：實測驗證**——對真實的 192 個 rollout：**全部讀得出來（0 失敗）**，歸併成 86 個 session。冷讀 **15.6 ms** → 快取命中 **0.05 ms**
- [x] **Step 6：commit**

### Task 4：Codex 行程的存活判定

**Files:** Create `src/adapters/codex/processes.ts`、`processes.test.ts`

**Interfaces:** Produces `liveCodexCwds(deps?): Set<string>`

- [x] **Step 1：寫失敗測試**——`pgrep` 找不到任何行程（正常狀態，回空 Set 不丟例外）、`lsof` 不存在、`lsof` 回傳部分失敗、cwd 含空白、行程數為 0 時**不呼叫 lsof**（省一次 spawn）
- [x] **Step 2：紅**
- [x] **Step 3：實作**——`pgrep -x codex` 取 pid，再 `lsof -a -d cwd -Fn -p <pids>` 解 `n` 開頭的行
- [x] **Step 4：綠**
- [x] **Step 5：實測**——沒有 codex 在跑時（最常見的狀態）光是 `pgrep` 就要 **35.7 ms**，佔 200 ms 契約的 18%
- [x] **Step 6：commit**

**Task 7 要處理的**：那 35.7 ms 是一次獨立的 spawn。Claude Code adapter 已經在跑 `ps` 了，兩邊各自 spawn 是浪費。整合時應該改成一次 `ps -eo pid,comm` 餵給兩個 adapter——claude 用它驗 PID，codex 用它找行程。省下一次 spawn，且讓「查行程」變成核心的一件事而不是每個 adapter 各做各的。

### Task 5：Codex 的 lifecycle 規則

**Files:** Modify `src/reconcile/lifecycle.ts`、`lifecycle.test.ts`

**Interfaces:** 依 `adapterId` 分派。Codex 分支（規格 §6）：

| 條件 | lifecycle | confidence |
|---|---|---|
| `ps` 有 cwd 相符的 codex 行程 | `running` | `low` |
| 無行程，最後事件距今 ≤ 30 分鐘 | `running` | `low` |
| 無行程，最後事件距今 > 30 分鐘 | `crashed` | `low` |

- [x] **Step 1：寫失敗測試**——三條規則各一、邊界值 30 分鐘的兩側、**永遠不會回 `ended_clean`**（這條要對所有輸入組合斷言）、confidence 永遠是 `low`
- [x] **Step 2：紅**
- [x] **Step 3：實作**
- [x] **Step 4：綠**
- [x] **Step 5：commit**

### Task 6：組裝 DiscoveredSession

**Files:** Create `src/adapters/codex/discover.ts`、`discover.test.ts`

**Interfaces:** Consumes Tasks 1–4。Produces `discoverCodex(paths, opts, deps?): { sessions: DiscoveredSession[]; invalid: number }`

- [x] **Step 1：寫失敗測試**——**多個 rollout 檔要合併成一個 session**（依 `sessionId` 分組，`updatedAt` 取最大的 mtime、`startedAt` 取最小的、`transcriptPath` 指向最新的那個檔）、`adapterId` 是 `'codex'`、`nativeStatus` 是 `null`（Codex 沒有 hook，沒有 busy/idle 之分——這一點不得偽造）、cwd 讀不到的 session 計入 `invalid` 而不是靜默消失、`alwaysInclude`（釘選）的專案不受窗口約束
- [x] **Step 2：紅**
- [x] **Step 3：實作**
- [x] **Step 4：綠**
- [x] **Step 5：真實資料驗證**——近 14 天 **12 個 session、0 invalid**，冷跑 46.4 ms、有快取 18.9 ms
- [x] **Step 6：修規格 §6**——12 個全被判成 `crashed`（最近的一個 6 天前）。30 分鐘的規則沒有上界，套到舊 session 就是誤報。補上 6 小時上界，超過就不再宣稱中斷
- [x] **Step 7：commit**

### Task 7：把 collectStatus 改成跑過一組 adapter

**Files:** Create `src/adapters/registry.ts`；Modify `src/cli/status.ts`、`src/projects/group.ts`（若需要）

**Interfaces:** Produces `ADAPTERS: readonly AgentAdapter[]`

- [x] **Step 1：寫失敗測試**——同一個 cwd 底下的 Claude Code 與 Codex session 歸到同一個專案、`invalid` 是各 adapter 的總和、其中一個 adapter 丟例外時另一個仍然出得來（隔離，同 P3 的 install 教訓）、`aggregateStatus` 對混合 session 的優先序
- [x] **Step 2：紅**
- [x] **Step 3：實作**
- [x] **Step 4：綠**
- [x] **Step 5：效能驗證**（行程內部 `process.uptime()`，外部 wall-clock 在這台機器上量不出東西——見 P3 計畫末節）：

```
P3 末（只有 Claude Code）    89 ms
P4 後（兩個 adapter）       107 ms（取最小；三次量到 107 / 143 / 149）
冷快取的第一次              109 ms
```

多出約 18 ms，來自多掃 192 個 rollout 與載入 4.9 KB 的 meta 快取。加上
uptime 起算前的 dyld 與 V8 初始化（約 40 ms）約 150 ms，仍在 200 ms 契約內。

`pgrep` 那 35.7 ms **沒有被付出**：目前沒有任何 Codex session 在 30 分鐘的
活動窗口內，所以行程表根本沒被查——那正是 Task 6 末尾那個優化的用意。
- [x] **Step 6：commit**

### Task 8：Resume 與慢速路徑

**Files:** Create `src/adapters/codex/history.ts`、`history.test.ts`；Modify `src/launch/script.ts`、`src/summarize/input.ts`

**Interfaces:** Produces `codexPrompts(historyPath, sessionId): string[]`、resume 指令 `codex resume <session_id>`

- [x] **Step 1：寫失敗測試**——`history.jsonl` 只有 60/192 個 session 有記錄（沒送過 prompt 的就沒有），所以「找不到」是正常狀態不是錯誤；壞掉的行略過而不是整批失敗；`helm open` 對 codex session 送出的是 `codex resume`
- [x] **Step 2：紅**
- [x] **Step 3：實作**
- [x] **Step 4：綠**
- [x] **Step 5：實測發現的一件規格沒寫的事**——`codex resume --help` 的 usage 是
  `codex resume [OPTIONS] [SESSION_ID] [PROMPT]`：**PROMPT 是位置參數**，跟
  `claude` 一樣。原本的實作沒傳，使用者接手 Codex session 時完全看不到
  「去讀那份簡報」——而那正是 `helm open` 的重點。已補上。
- [x] **Step 6：驗證**——12 個近期 session 有 8 個在 `history.jsonl` 裡取得到 prompt，內容正確
- [x] **Step 7：commit**

---

## 已知的取捨

**`history.jsonl` 只涵蓋 60/192 個 session。** 沒送出過 prompt 的 session 在那裡沒有記錄，簡報只能退回讀 rollout。這不是 bug，是資料來源的形狀——UI 不得因此顯示成錯誤。

**Codex 沒有 busy/idle。** 沒有 hook 就沒有「此刻正在跑什麼」。`nativeStatus` 一律 `null`，看板上 Codex 的 session 不會有動作那一行。偽造一個「執行中」比留白更糟。

**30 分鐘的門檻是規格定的，不是量出來的。** 它防的是 `ps` 短暫抓不到就誤判成 crashed。真實的 codex session 閒置多久算死，目前沒有資料——所以那個常數要有名字、有註解、可以改。
