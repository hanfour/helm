# helm — 本機 agent CLI 艦隊看板

**日期**：2026-08-11
**狀態**：設計已核可，待實作計畫
**代號**：`helm`（掌舵 —— 同時駕馭多艘船）

---

## 1. 問題陳述

使用者同時在本機開多個 agent CLI（Claude Code、Codex）跨不同專案開發。重開機或當機造成斷點，導致工作無法延續。

實地勘查（2026-08-11，使用者本機）確認的具體痛點：

| 痛點 | 實地證據 |
|---|---|
| 不知道哪個專案做到哪 | 當下有 8 個 Claude Code session 同時存活，橫跨 5 個不同 `cwd` |
| 找不到正確的 session 可 resume | `data-svc-2.0` 專案目錄下有 59 個 session 檔；`--resume` 清單依賴的 `ai-title` **完全失效** —— 該 session 的 487 筆 `ai-title` 記錄全是同一句「Clone codebase」，那是 session 開頭定死的標題，之後從未更新 |
| 進行中的任務狀態消失 | 使用者的 session 是長壽型：`data-svc-2.0` 的 session 從 8/6 開到 8/11，transcript 累積 7679 行。當機損失極大 |
| 沒有跨專案優先順序視野 | 8 個 session 分散在 8 個終端機分頁，無彙總視圖 |
| 遠端 PR 審查狀態不明 | 無法得知哪張 PR 在等自己修改 |

**核心洞察**：Claude Code 原生的 session 標題機制對長壽 session 完全無效，這是「找不到 session」的根因。真正的語意訊號在純文字 user prompt —— 7679 行 transcript 中只有 224 筆，低頻但高濃度（例：「目前狀況？」「繼續跑最終 review」）。

## 2. 目標與非目標

### 目標

1. 一個 macOS 選單列常駐看板，顯示所有專案的 agent session 狀態
2. 明確標示「異常中斷」的 session，且判定不靠猜測
3. 為每個中斷的 session 產生結構化「交接簡報」
4. 一鍵開啟終端機並帶著簡報 resume
5. 追蹤各專案 PR 的審查狀態，回答「這張 PR 在等誰」
6. 同時支援 Claude Code 與 Codex

### 非目標

- 不做遠端／跨機器同步（純本機）
- 不做 Gemini CLI / Copilot CLI 的實作（僅保留 adapter 介面，見 §5.3）
- 不在看板內直接執行 agent 任務（看板負責追蹤與交接，不負責代跑）
- 不整合既有的 `project-alpha`（`helm` 為全新獨立專案，決策見 §3.3）

## 3. 架構

### 3.1 元件與依賴方向

依賴嚴格單向，無循環：

```
[agent CLI] ──hook──> collector ──append──> spool 檔
                                              │
                                       daemon 批次 ingest
                                              ↓
   reconciler / summarizer / remote ──read/write──> store (SQLite)
                                              ↑
                                          daemon (127.0.0.1)
                                              │
                          ┌───────────────────┼───────────────────┐
                     ui-menubar             ui-web                cli
                       (Swift)               (web)          (helm status)
```

| 單元 | 唯一職責 | 依賴 |
|---|---|---|
| `collector` | hook 事件 → append 到 spool 檔 | 檔案系統 |
| `store` | SQLite 讀寫、schema migration | 無 |
| `adapters` | 各 CLI 的狀態來源 → 統一 `AgentSession` | store |
| `reconciler` | 判定 session lifecycle（running / ended_clean / crashed） | store, `ps` |
| `summarizer` | 事件 + transcript → 結構化交接簡報 | store, `claude -p` |
| `remote` | `gh` 輪詢 PR 與 review 狀態 | store, `gh` |
| `launcher` | 開終端機 + `cd` + resume + 注入簡報 | store, `osascript` |
| `daemon` | 批次 ingest、排程、本機 HTTP API | 上述全部 |
| `cli` | `helm status` / `open` / `doctor` / `install` | daemon（可 fallback 直讀 store） |
| `ui-menubar` | 狀態圓點、下拉快覽、一鍵開 | daemon HTTP |
| `ui-web` | 交接簡報、工具呼叫時間軸、diff、PR 詳情 | daemon HTTP |

### 3.2 三個不變量

整個系統的可靠性建立在這三條上，任何實作不得違反：

**I1. `collector` 不依賴 `daemon`。**
看板未開、選單列 app 未裝、daemon 崩潰 —— 事件照樣落地到 spool 檔。這是「當機也不丟」的地基。

**I2. `collector` 絕不阻塞 agent CLI。**
它跑在每次工具呼叫的關鍵路徑上。實作限制為單次 `sh -c` + shell builtin 寫檔（見 §4.2 實測）。任何錯誤靜默吞掉並寫入 `~/.helm/collector-errors.log`。

**I3. `events` 表 append-only。**
`sessions.lifecycle` 等現況欄位是從事件推導出的投影，可隨時重建。這讓 schema 演進與除錯都安全。

### 3.3 為什麼不整合 project-alpha

使用者已有 `project-alpha` v3.2.0（42 CLI 指令、6 agent、9 MCP tool、PKB 快取），具備 repo 掃描與 PR review 能力。選擇不整合的理由：`helm` 的核心價值在「當機恢復」，其引擎必須能獨立跑、獨立測、獨立被 CLI 呼叫，不應綁定在一個已經很大的專案的生命週期上。`helm` 只依賴 `~/.claude/`、`~/.codex/`、`git`、`gh`。

## 4. 採集機制

### 4.1 三個來源，職責不重疊

| 來源 | 提供 | 成本 | 弱點 |
|---|---|---|---|
| 原生註冊表 | 誰活著、cwd、busy/idle、heartbeat、`procStart` | 零（讀既有檔） | 無語意 |
| Hook spool | 在做什麼、每次工具呼叫、每輪 heartbeat | 5.65ms/次 | 當機漏最後一筆 |
| Transcript | 完整真相（含 `tool_result`） | 高 | 僅 lazy 讀 |

任一來源失效，系統仍可降級運作。

### 4.2 Hook 設定

接收以下事件（含 `PreToolUse`，決策依據見下方實測）：

| Hook | Matcher | 記錄內容 |
|---|---|---|
| `SessionStart` | — | 建 session 列、source（startup/resume/clear）、cwd、PID |
| `UserPromptSubmit` | — | 使用者原話（最高語意密度） |
| `PreToolUse` | 全部 | 工具名、輸入摘要、時間（提供「此刻正在跑什麼」的即時性） |
| `PostToolUse` | `Edit\|Write\|NotebookEdit` | 碰過的檔案路徑 |
| `Stop` | — | 每輪結束 heartbeat + turn 計數 |
| `SessionEnd` | — | 正常結束標記 + reason |

**Hook 實作**：單一 `sh -c` 指令，使用 shell builtin `read` + `printf` 附加到 spool，**不 spawn 第二個行程、不啟動 Node**。

實測（本機 200 次穩態，2026-08-11）：

| 做法 | 每次成本 |
|---|---|
| script 檔 + `cat`（2 次 spawn） | 8.8ms |
| **`sh -c` + builtin `read`/`printf`（1 次 spawn）** | **5.65ms** |
| 純 spawn 下限 `sh -c true` | 5.52ms |

寫入本身僅佔 0.13ms，其餘為 macOS 行程 spawn 的不可壓下限。`PreToolUse` 的實際代價：以該 session 的 1451 次 `tool_use` 計，累積 8.2 秒攤在 5 天內；每 turn 約 15 次工具呼叫即 **85ms/turn**。可接受。

**Spool 位置**：`~/.helm/spool/<session_id>.jsonl`。

**Ingest 時機**：daemon 啟動時全量 ingest 一次，之後每 5 秒批次處理有變動的 spool 檔（以 mtime 判斷），並記錄各檔已處理的 byte offset 以支援增量續讀。ingest 完成後不刪除 spool 檔，改於超過 7 天且對應 session 已 `ended_clean` 時歸檔至 `~/.helm/spool/archive/`。**daemon 未執行時 spool 持續累積，不遺失** —— 這是不變量 I1 的具體體現。

**安裝方式**：往 `~/.claude/settings.json` 的 `hooks` 附加，**不覆蓋**。安裝前備份至 `~/.helm/backups/settings-<timestamp>.json`。使用者現有 hook 由 `everything-claude-code` plugin 提供，安裝程序須與之共存。

**Kill switch**：環境變數 `HELM_OFF=1` 讓 collector 整個 no-op，無需改設定檔即可脫身。

### 4.3 Claude Code 原生註冊表

`~/.claude/sessions/<PID>.json`，實測 schema：

```json
{
  "pid": 60907,
  "sessionId": "f9810d2c-4c2c-474b-9dc9-05f0707a526f",
  "cwd": "/Users/you/acme/example-service",
  "startedAt": 1785996974955,
  "procStart": "Thu Aug  6 06:16:12 2026",
  "version": "2.1.223",
  "kind": "interactive",
  "entrypoint": "cli",
  "name": "data-svc-2-0-26",
  "nameSource": "derived",
  "status": "busy",
  "updatedAt": 1786416587966,
  "statusUpdatedAt": 1786416587966
}
```

`kind` 可為 `interactive` 或 `bg`。`status` 為 `busy` / `idle`，由 Claude Code 自行維護。

### 4.4 Transcript

`~/.claude/projects/<slug>/<session_id>.jsonl`。實測 type 分布（7679 行樣本）：

```
assistant 2979 / user 1674 / last-prompt 488 / mode 488 /
permission-mode 488 / ai-title 487 / system 383 / attachment 300 /
queue-operation 246 / file-history-snapshot 120 / file-history-delta 26
```

`user` 記錄含 `timestamp`、`cwd`、`gitBranch`、`sessionId`、`version`、`slug`。純文字 prompt（`message.content` 為字串，或 list 中的 `text` block）僅 224 筆。`assistant` 記錄的 `content` 中 `tool_use` block 共 1451 筆，含完整 Bash 指令字串。

**僅 lazy 讀**：只在產生交接簡報或展開工具呼叫時間軸時讀取，並記錄 byte offset 供增量續讀。

## 5. Adapter 層

### 5.1 介面

所有 CLI 透過統一介面接入。核心不得出現任何 CLI 專屬判斷。

```ts
interface AgentAdapter {
  readonly id: 'claude-code' | 'codex' | string
  discoverSessions(): Promise<DiscoveredSession[]>   // 存活性 + 基本資訊
  readSemantics(s: DiscoveredSession, since?: Cursor): Promise<SemanticEvent[]>
  buildResumeCommand(s: DiscoveredSession, briefPath: string): ResumeCommand
}
```

### 5.2 Claude Code adapter

- 存活性：`~/.claude/sessions/*.json` + `ps` 驗證
- 語意：hook spool（即時）+ transcript（回填與 `tool_result`）
- Resume：`claude --resume <session_id>`

### 5.3 Codex adapter

**零侵入**（Codex 無 hook 機制，也不需要）：

- 語意：`~/.codex/history.jsonl`，每行 `{"session_id": "...", "ts": 1786003633, "text": "找出損耗我們 SSD 的對象"}` —— 現成的純使用者 prompt 歷史，等同 Claude Code 的 `UserPromptSubmit` 但成本為零
- 詳情：`~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`（實測 192 個檔）。首行 `type: "session_meta"`，payload 含 `session_id`、`cwd`、`originator`、`cli_version`、`model_provider`。後續為 `event_msg`（含 `task_started` 與 `turn_id`）與 `response_item`
- 補充：`~/.codex/state_5.sqlite` 有 `threads`、`thread_spawn_edges` 等表（唯讀存取，不寫入）
- 存活性：**無 PID 註冊表** —— 掃 `ps` 找 `codex` 行程並比對 cwd。此為已知的較弱環節，因此 Codex session 的 `crashed` 判定信心度標為 `low`，UI 需區分呈現
- Resume：`codex resume <session_id>`

### 5.4 未實作的 adapter

- **Gemini CLI**：`~/.gemini/` 僅存 2026-01 的 auth 檔，無 sessions 目錄。使用者實質未使用
- **Copilot CLI**：僅有 config 與 logs，指令不在 PATH

兩者保留介面不實作。日後接入只需新增一個 adapter 檔。

## 6. 資料模型

SQLite，位於 `~/.helm/helm.db`。

```sql
projects(
  id INTEGER PK, path TEXT UNIQUE, name TEXT, git_remote TEXT,
  pinned INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, first_seen_at INTEGER)

sessions(
  id TEXT PK,                    -- CLI 原生 session id
  adapter_id TEXT,               -- 'claude-code' | 'codex'
  project_id INTEGER,
  pid INTEGER, proc_start TEXT,  -- proc_start 用於偵測 PID 重用
  transcript_path TEXT, kind TEXT,
  started_at INTEGER, last_seen_at INTEGER,
  native_status TEXT,            -- 'busy' | 'idle' | NULL
  lifecycle TEXT,                -- 'running' | 'ended_clean' | 'crashed'
  lifecycle_confidence TEXT,     -- 'high' | 'low'
  ended_reason TEXT)

events(
  id INTEGER PK, session_id TEXT, ts INTEGER,
  kind TEXT, payload TEXT)       -- append-only，永不 UPDATE

handoffs(
  session_id TEXT PK, generated_at INTEGER,
  source_digest TEXT,            -- 最後 event id + transcript byte offset
  body TEXT, stale INTEGER)

pr_snapshots(
  project_id INTEGER, number INTEGER, title TEXT, state TEXT,
  review_state TEXT, unresolved_comments INTEGER, checks TEXT,
  head_sha TEXT, waiting_on TEXT, fetched_at INTEGER,
  PRIMARY KEY (project_id, number))

quarantine(
  id INTEGER PK, source TEXT, raw TEXT, error TEXT, ts INTEGER)
```

### 6.1 專案納入規則

自動納入條件（全部滿足）：

1. `cwd` 目前存在於檔案系統
2. `cwd` 或其祖先目錄含 `.git`
3. **近 14 天有活動** —— 定義為：該專案下任一 session 的 `sessions.last_seen_at` 在 14 天內，或其 transcript 檔的 mtime 在 14 天內（取兩者較新者）。判定於每次 `reconciler` 執行時重算，因此專案會隨活動自動進出看板

排除路徑前綴：`/private/tmp`、`/var/folders`、`~/Downloads`（使用者現有專案目錄中正好含這三類雜訊）。

支援手動 `pinned`（永遠置頂）與 `hidden`（永久隱藏）。

## 7. Lifecycle 判定

`reconciler` 的判定為純函式，可完整單元測試：

| 註冊表檔 | PID | `procStart` 比對 | 終止事件 | → lifecycle |
|---|---|---|---|---|
| 存在 | 活著 | 相符 | 無 | `running` |
| 存在 | 死亡 | — | 無 | `crashed` |
| 存在 | 活著 | **不符** | 無 | `crashed`（PID 已被重用） |
| 任意 | 任意 | — | 有 `SessionEnd` | `ended_clean` |
| 不存在 | — | — | 無 | `crashed` |

`procStart` 比對是防止 PID 重用誤判的關鍵。此規則讓「歷史上的當機」在重裝看板後仍驗得出來。

Codex 因無註冊表，判定規則為：`ps` 中存在 cwd 相符的 `codex` 行程 → `running`；否則若最後事件距今 **超過 30 分鐘** → `crashed`，未超過則維持 `running`（避免 `ps` 短暫抓不到就誤判）。所有 Codex session 的 `lifecycle_confidence` 一律標為 `low`。

Codex 亦無 `SessionEnd` 事件，因此**永遠不會被判為 `ended_clean`** —— 這是已知限制，UI 須以 `lifecycle_confidence` 區分呈現，不得與 Claude Code 的高信心判定混用同一視覺樣式。

## 8. 交接簡報

**輸入**（刻意不餵整份 transcript）：

- 最後 **20 則**純文字 user prompt（不含 tool_result 與系統注入內容）
- 該 session 碰過的檔案清單（去重，取最近 50 筆）
- `git diff --stat` 與 `git status --short`（未 commit 的變更）
- 最後 **3 輪**的工具呼叫（工具名 + 輸入摘要，Bash 取完整指令）

以實測樣本（7679 行、224 筆純文字 prompt）估算，此組合約 3–6k token，遠低於整份 transcript。

**輸出**：固定七欄結構化 JSON。

```
目標 / 已完成 / 進行到哪一步 / 下一步 / 卡點 / 相關檔案 / 相關 PR
```

**觸發時機**：

1. daemon 於 ingest 時發現 `SessionEnd` 事件 → 背景產生（正常結束）
2. 判定 `crashed` 的 session → **在使用者開啟看板那一刻**才產生（懶惰求值，避免為永遠不會回去的 session 燒 token）
3. 手動重新整理

注意觸發時機 1 由 **daemon** 執行而非 hook —— hook 只寫 spool（不變量 I2）。若 session 結束時 daemon 未執行，該事件留在 spool 中，於 daemon 下次啟動 ingest 時補產生。因此「daemon 沒開就沒簡報」不成立，只會延後。

**快取閘門**：`handoffs.source_digest` 記錄產生當下的「最後 event id + transcript byte offset」。下次比對未變則直接使用快取，變了才標 `stale`。這是控制 token 花費的唯一機制。

**產生方式**：headless `claude -p`，輸出強制為 JSON schema。

## 9. 一鍵 Resume

`launcher` 組出的動作：

1. 將交接簡報寫入 `~/.helm/briefs/<session_id>.md`
2. 開啟終端機新分頁（預設偵測 iTerm2，fallback `Terminal.app`，可設定）
3. `cd <cwd>`
4. 執行 adapter 提供的 resume 指令
5. 自動送出開場訊息：`讀 ~/.helm/briefs/<session_id>.md 後接續`

**不直接把長簡報貼進 prompt** —— 那會污染新 session 的第一則訊息並吃掉 context。

指令組裝與實際執行分離，前者為純函式並完整測試。

## 10. PR 追蹤

`remote` 是唯一對外發網路請求的單元，架構上完全隔離。

**資料來源**：`gh pr list --json` 與 `gh pr view --json reviews,comments,statusCheckRollup`（實測環境 `gh 2.76.2`）。

**輪詢策略**：每個 repo 快取 60 秒，僅在看板開啟時輪詢。

**「在等誰」判定**：

| 條件 | waiting_on |
|---|---|
| 有未解決的 review comment | `等你改` |
| 無 review 記錄 | `等人審` |
| CI 執行中或失敗 | `等 CI` |
| 通過且無阻擋 | `可合併` |

**四種降級**（各自顯示為卡片上一行灰字，絕不阻塞看板其餘部分）：`gh` 不存在、未登入、rate limit、repo 無 remote。

## 11. UI

### 11.1 狀態語彙

五種，無模糊地帶：

| 標記 | 意義 |
|---|---|
| ● 綠實心 | agent 正在跑（`running` + `busy`） |
| ○ 綠空心 | 活著但在等你輸入（`running` + `idle`） |
| ● 灰 | 正常結束（`ended_clean`） |
| ● 紅 | **異常中斷，有未回收的斷點**（`crashed`） |
| ● 黃 | PR 在等你改 |

選單列圖示顯示當下最需要注意的狀態；只要存在紅點，圖示即為紅色。

### 11.2 選單列（Swift, `MenuBarExtra`）

專案分組列表，每列為「專案名 + 圓點 + session 數 + 最後活動 + PR badge」。點擊展開簡報前三行與兩顆按鈕（開終端機／看詳情）。

此層僅呼叫 daemon HTTP 並 render，不含任何業務邏輯。目標 300 行以內。

### 11.3 Web 詳情頁

完整七欄簡報、工具呼叫時間軸、未 commit diff、PR 清單。所有長內容在此呈現。

### 11.4 Daemon

綁定 `127.0.0.1` 隨機 port，port 號與 PID 寫入 `~/.helm/daemon.json`。提供 read API 與 action 端點（觸發 resume、重新產生簡報、重新整理 PR）。

**生命週期**：不註冊 launchd、不開機自啟。由選單列 app 啟動時拉起，或 `helm` CLI 首次呼叫時自動拉起（若 `daemon.json` 中的 PID 已死則重啟）。選單列 app 結束時一併終止 daemon。

理由：daemon 唯一的持續性工作是 PR 輪詢，而該輪詢本來就只在看板開啟時進行；事件採集由 hook 獨立完成，不需要常駐行程。這讓「沒開看板時系統零常駐成本」成立。

**降級**：`helm status` 在 daemon 拉不起來時直接以唯讀模式開啟 SQLite 並輸出，不因 daemon 故障而完全不可用。

## 12. 錯誤處理

專案全域規則要求「絕不靜默吞錯」。此處僅有一項豁免且附帶補償：

| 單元 | 策略 |
|---|---|
| `collector` | **唯一豁免**：必須靜默（在關鍵路徑上）。錯誤寫入 `~/.helm/collector-errors.log`，`helm doctor` 主動回報 |
| `daemon` | 每個 adapter 獨立隔離，一個 adapter 失敗不影響其他 |
| `summarizer` | 逾時或失敗 → 顯示「簡報產生失敗，可重試」並**降級顯示最後 3 則原始 prompt**。永不呈現空白卡片 |
| `store` | migration 失敗 → 拒絕啟動並指出備份位置，絕不做部分遷移 |
| `remote` | 四種降級，見 §10 |

**邊界驗證**：所有外部輸入（spool、transcript、`gh` JSON、原生註冊表）皆通過 schema 驗證。解析失敗的記錄寫入 `quarantine` 表而非丟棄，供事後追查格式變更。

## 13. 測試策略

目標覆蓋率 80%。

**單元測試**
- `store`：CRUD 與 migration
- `reconciler`：§7 判定真值表的每一列
- 兩個 adapter 的解析器：餵真實 fixture
- `summarizer`：prompt 組裝與快取 digest 計算
- `launcher`：指令組裝（組而不執行）
- 專案納入規則：含三類排除路徑

**整合測試**
- spool → ingest → store → API 全鏈路，使用暫時 DB

**E2E**
- 灌入 fixture 集、啟動 daemon、驗證 API 回應與 `helm status` 輸出

**Fixture**：從本機真實的 Claude Code transcript 與 Codex rollout 匿名化擷取。這是本專案最重要的測試資產 —— 兩個 CLI 的檔案格式都會隨版本變動，fixture 是唯一的防線。

**Swift 層**不追覆蓋率（薄到僅剩 HTTP 呼叫與 render），以手動驗收替代。

## 14. 目錄結構

依功能切分，非依型別。

```
helm/
  packages/
    core/src/
      store/          # schema, migration, queries
      adapters/       # types.ts, claude-code.ts, codex.ts
      reconcile/      # lifecycle 判定純函式
      summarize/      # 簡報產生與快取
      remote/         # gh 包裝與 waiting_on 判定
      launch/         # 終端機指令組裝
    hook/             # 安裝器 + spool 寫入的 sh 片段
    daemon/           # 批次 ingest、排程、HTTP
    cli/              # helm status | open | doctor | install | uninstall
    web/              # 詳情頁
  apps/
    menubar/          # Swift package
  fixtures/
  docs/superpowers/specs/
```

單檔 200-400 行為常態，800 行為上限。

## 15. 實作分期

每期結束皆為可獨立使用的交付物。

| 期 | 交付 | 使用者得到什麼 |
|---|---|---|
| P1 | `core`（store + claude-code adapter + reconciler）+ `hook` + `helm status` | 終端機一行指令看到全部 session 與紅色斷點標記 |
| P2 | `summarizer` + `launcher` | 交接簡報 + 一鍵開 |
| P3 | `menubar` 殼 + `web` 詳情頁 | 選單列常駐看板 |
| P4 | `codex` adapter | Codex session 一併納入 |
| P5 | PR 追蹤 | 審查狀態與「在等誰」 |

## 16. 已知風險

| 風險 | 緩解 |
|---|---|
| Claude Code / Codex 檔案格式隨版本變更 | schema 驗證 + `quarantine` 表 + fixture 測試；`helm doctor` 回報格式異常 |
| 全域 hook 影響所有專案 | `HELM_OFF=1` kill switch；安裝前備份；附加而非覆蓋 |
| Codex 存活性判定較弱（無 PID 註冊表） | `lifecycle_confidence: low`，UI 區分呈現，不與 Claude Code 的高信心判定混淆 |
| 交接簡報 token 成本失控 | `source_digest` 快取閘門 + 對 `crashed` session 懶惰求值 |
| 選單列 app 需簽章／公證才能穩定常駐 | P3 才處理；先以本機 build 執行，必要時走 ad-hoc 簽章 |
