# helm — 本機 agent CLI 艦隊看板

**日期**：2026-08-11
**狀態**：設計已核可，待實作計畫
**代號**：`helm`（掌舵 —— 同時駕馭多艘船）
**架構**：掃描式（scan-based）。無 daemon、無資料庫、單一 hook。

---

## 1. 問題陳述

使用者同時在本機開多個 agent CLI（Claude Code、Codex）跨不同專案開發。重開機或當機造成斷點，導致工作無法延續。

實地勘查（2026-08-11，使用者本機）確認的具體痛點：

| 痛點 | 實地證據 |
|---|---|
| 不知道哪個專案做到哪 | 當下有 8 個 Claude Code session 同時存活，橫跨 5 個不同 `cwd` |
| 找不到正確的 session 可 resume | `example-service` 專案目錄下有 59 個 session 檔；`--resume` 清單依賴的 `ai-title` **完全失效** —— 該 session 的 487 筆 `ai-title` 記錄全是同一句「Clone codebase」，那是 session 開頭定死的標題，之後從未更新 |
| 進行中的任務狀態消失 | 使用者的 session 是長壽型：`example-service` 的 session 從 8/6 開到 8/11，transcript 累積 7679 行。當機損失極大 |
| 沒有跨專案優先順序視野 | 8 個 session 分散在 8 個終端機分頁，無彙總視圖 |
| 遠端 PR 審查狀態不明 | 無法得知哪張 PR 在等自己修改 |

**核心洞察一**：Claude Code 原生的 session 標題機制對長壽 session 完全無效，這是「找不到 session」的根因。真正的語意訊號在純文字 user prompt —— 7679 行 transcript 中只有 224 筆，低頻但高濃度（例：「目前狀況？」「繼續跑最終 review」）。

**核心洞察二**：這個系統需要的資料，**幾乎全部已經在磁碟上**。Claude Code 與 Codex 都持續寫出結構化的 session 狀態與完整 transcript。因此本設計不建立自己的資料管線，改為直接讀取既有檔案，僅在單一無法從檔案取得的資訊上使用 hook（見 §4.3）。

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
- 不做 Gemini CLI / Copilot CLI 的實作（僅保留 adapter 介面，見 §5.4）
- 不在看板內直接執行 agent 任務（看板負責追蹤與交接，不負責代跑）
- 不整合既有的 `project-alpha`（`helm` 為全新獨立專案，決策見 §3.4）
- **不建立事件歷史資料庫** —— transcript 即是歷史（決策見 §3.3）

## 3. 架構

### 3.1 形狀

```
      既有檔案（不由 helm 產生）
      ├── ~/.claude/sessions/<PID>.json      活躍註冊表
      ├── ~/.claude/projects/*/*.jsonl       transcript
      ├── ~/.codex/history.jsonl             prompt 歷史
      └── ~/.codex/sessions/**/rollout-*.jsonl
                    │
      PreToolUse hook ──覆寫──> ~/.helm/live/<session_id>.json   （單行，見 §4.3）
                    │
                    ↓
          helm CLI（無常駐行程）
          ├── scan    讀上述檔案 → 統一模型
          ├── menu    輸出 SwiftBar 格式（純快取路徑，毫秒級）
          ├── brief   產生交接簡報
          ├── open    開終端機 resume
          └── doctor  健檢
                    │
                    ├──> ~/.helm/cache.json    （可隨時刪除重建）
                    │
                    └──> SwiftBar plugin `helm.5s.sh`  →  選單列
```

沒有 daemon。沒有 HTTP。沒有資料庫。沒有 migration。

### 3.2 元件

| 單元 | 唯一職責 | 依賴 |
|---|---|---|
| `adapters` | 各 CLI 的既有檔案 → 統一 `AgentSession` | 檔案系統 |
| `reconcile` | 判定 session lifecycle（running / ended_clean / crashed） | adapters, `ps` |
| `cache` | 讀寫 `~/.helm/cache.json`，含 stale-while-revalidate | 檔案系統 |
| `summarize` | 事件 + transcript → 結構化交接簡報 | adapters, `claude -p` |
| `remote` | `gh` 查詢 PR 與 review 狀態 | `gh` |
| `launch` | 組出終端機指令 + 注入簡報 | adapters, `osascript` |
| `render` | 統一模型 → SwiftBar 格式／終端機表格／markdown | 無 |
| `cli` | 指令進入點與旗標解析 | 上述全部 |
| `hook` | `PreToolUse` 的單行覆寫寫入 + 安裝器 | 檔案系統 |

`render` 不依賴任何 I/O，是純函式 —— 這讓所有輸出格式都能完整單元測試。

### 3.3 為什麼不要資料庫

原設計包含 hook spool → 批次 ingest → SQLite（events / handoffs / quarantine 表）+ daemon。捨棄的理由：

1. **八成的採集是在複製已存在的資料。** transcript 已含完整的 1451 筆 `tool_use`（Bash 811 次，含完整指令字串與 `tool_result`）、全部 user prompt、`cwd`、`gitBranch`、時間戳
2. **歷史保存不急。** 使用者設定 `cleanupPeriodDays: 100`，transcript 保留 100 天
3. **資料庫帶來的成本是真實的**：schema migration、格式異常隔離、ingest 排程、daemon 生命週期管理、以及一個必須常駐的行程
4. **可逆。** CLI 介面不變，日後若真需要事件歷史，加一層儲存不需重寫任何上層

唯一無法從既有檔案取得的資訊是「此刻正在執行哪個工具呼叫」（見 §4.3 的實測依據），該項以單一 hook 解決，不需要資料庫。

### 3.4 為什麼不整合 project-alpha

使用者已有 `project-alpha` v3.2.0（42 CLI 指令、6 agent、9 MCP tool、PKB 快取）。選擇不整合的理由：`helm` 的核心價值在「當機恢復」，其引擎必須能獨立跑、獨立測、獨立被 CLI 呼叫，不應綁定在一個已經很大的專案的生命週期上。`helm` 只依賴 `~/.claude/`、`~/.codex/`、`git`、`gh`。

## 4. 資料來源

### 4.1 Claude Code 原生註冊表

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
  "name": "example-service-26",
  "nameSource": "derived",
  "status": "busy",
  "updatedAt": 1786416587966,
  "statusUpdatedAt": 1786416587966
}
```

`kind` 為 `interactive` 或 `bg`。**`status` 為 `busy` / `idle`，由 Claude Code 自行維護** —— 這直接回答了「哪個專案正在跑、哪個在等我輸入」，無需任何採集。

**實測確立的關鍵行為**（2026-08-11，以 headless session 驗證）：session 啟動時建立此檔，**正常結束時刪除此檔**。因此「檔案殘留 + PID 已死」即為當機的直接證據，不需要 `SessionEnd` hook 來標記正常結束。

此為**快速路徑**的主要資料源：檔案小、數量少（當下 8 個），可在每次選單列刷新時全量讀取。

### 4.2 Transcript

`~/.claude/projects/<slug>/<session_id>.jsonl`。實測 type 分布（7679 行樣本）：

```
assistant 2979 / user 1674 / last-prompt 488 / mode 488 /
permission-mode 488 / ai-title 487 / system 383 / attachment 300 /
queue-operation 246 / file-history-snapshot 120 / file-history-delta 26
```

`user` 記錄含 `timestamp`、`cwd`、`gitBranch`、`sessionId`、`version`、`slug`。純文字 prompt 僅 224 筆。`assistant` 記錄中的 `tool_use` block 共 1451 筆，含完整 Bash 指令字串。

**僅慢速路徑讀取**：只在產生交接簡報、展開工具呼叫時間軸時讀，並以 byte offset 支援增量續讀。選單列刷新**絕不**掃 transcript。

**實測確立**：transcript **不含任何 session 結束標記** —— 已結束 session 的檔案末尾就只是一筆普通的 `assistant` 記錄。因此 lifecycle 判定不得依賴 transcript 內容，只能依賴 §4.1 的註冊表行為與 §4.3 的 live 檔（見 §6）。

### 4.3 PreToolUse hook — 唯一的採集

**必要性依據**（2026-08-11 實測）：在一個工具執行的當下，回頭檢查自己的 transcript，找不到本次呼叫的 `tool_use` 記錄。**`tool_use` 是在工具執行完畢後才寫入 transcript**。因此「此刻正卡在哪個指令」是唯一無法從既有檔案取得的資訊。

**覆寫式單行設計**：

```
~/.helm/live/<session_id>.json     # 永遠只有一行，每次 PreToolUse 覆寫
```

因為只需要「此刻」而不需要歷史（歷史 transcript 有），hook 使用 `>` 覆寫而非 `>>` 附加。由此得到三個性質：

- 檔案永不成長，**無需清理、無需歸檔、無需 ingest**
- 讀取只需讀一行
- 沒有任何批次處理，因此不需要 daemon

**hook 實作**：單一 `sh -c` 指令，使用 shell builtin `read` + `printf` 寫入，**不 spawn 第二個行程、不啟動 Node**。

實測（本機 200 次穩態）：

| 做法 | 每次成本 |
|---|---|
| script 檔 + `cat`（2 次 spawn） | 8.8ms |
| **`sh -c` + builtin `read`/`printf`（1 次 spawn）** | **5.65ms** |
| 純 spawn 下限 `sh -c true` | 5.52ms |

寫入本身僅佔 0.13ms，其餘為 macOS 行程 spawn 的不可壓下限。實際代價約 **85ms/turn**（以每 turn 15 次工具呼叫計）。

**過時判定**：`live/<id>.json` 中的記錄，在對應 session 的註冊表 `status` 為 `idle` 時視為過時並忽略。無需 `PostToolUse` hook，因此不付第二次 spawn 成本。

**第二個用途：不會被上游抹除的當機證據。** `~/.claude/sessions/<PID>.json` 由 Claude Code 管理，可能在其啟動時被清理，導致當機證據消失。`~/.helm/live/*.json` 由 helm 自己管理，上游不會動它。因此當註冊表已無某 session、但其 live 檔的時間戳晚於該 session transcript 的最後一筆記錄時，即可判定「當機於某個工具呼叫執行中」，並直接得知當時卡在哪個指令。此判定納入 §6。

**清理**：`live/*.json` 在對應 session 判定為 `ended_clean`、或檔案超過 30 天時，由 `helm doctor` 或任一次 `helm scan` 順手刪除。單一 session 僅一個檔且永不成長，因此清理非關鍵路徑。

**安裝方式**：往 `~/.claude/settings.json` 的 `hooks` 附加，**不覆蓋**。安裝前備份至 `~/.helm/backups/settings-<timestamp>.json`。使用者現有 hook 由 `everything-claude-code` plugin 提供，安裝程序須與之共存。

**Kill switch**：環境變數 `HELM_OFF=1` 讓 hook 整個 no-op。錯誤一律靜默（它跑在關鍵路徑上），但寫入 `~/.helm/hook-errors.log`，由 `helm doctor` 主動回報。這是本專案「絕不靜默吞錯」原則的唯一豁免，且附帶此補償。

**解除安裝**：`helm uninstall` 移除 hook 設定並還原備份。使用者必須能在 30 秒內完全脫身。

### 4.4 快取

`~/.helm/cache.json`，單一檔案，**可隨時刪除重建**。內容：

```jsonc
{
  "version": 1,
  "briefs":  { "<session_id>": { "digest": "<size>:<mtime>", "generatedAt": 0, "body": {} } },
  "prs":     { "<repo>": { "fetchedAt": 0, "items": [] } },
  "projects":{ "<path>":  { "name": "", "gitRemote": "" } }
}
```

`briefs.digest` 為 transcript 的「byte size + mtime」。不符即視為 stale。這是控制 token 花費的唯一機制。

**Stale-while-revalidate**：`helm menu` 偵測到某項快取過期時，**fork 一個背景行程去更新，自己立即回傳既有值**。下一次刷新（5 秒後）即為新值。這是無 daemon 也能有背景更新的關鍵，也是選單列不會因為等 `gh` 或 `claude -p` 而卡住的原因。

**單一真實來源**：`cache.json` 中所有內容皆為可重建的衍生資料。使用者意圖（`pinned` / `hidden`）不存於此，而是獨立存放於 `~/.helm/projects.json` —— 該檔是使用者設定的唯一真實來源，永不自動刪除。`cache.json` 的 `projects` 區塊僅快取衍生欄位（`name`、`gitRemote`）。刪除 `cache.json` 不會遺失任何使用者意圖。

## 5. Adapter 層

### 5.1 介面

所有 CLI 透過統一介面接入。核心不得出現任何 CLI 專屬判斷。

```ts
interface AgentAdapter {
  readonly id: 'claude-code' | 'codex' | string
  discoverSessions(): Promise<DiscoveredSession[]>          // 快速路徑，不讀 transcript
  readSemantics(s: DiscoveredSession, since?: Cursor): Promise<SemanticEvent[]>  // 慢速路徑
  buildResumeCommand(s: DiscoveredSession, briefPath: string): ResumeCommand
}
```

`discoverSessions` 有效能契約：**不得讀取 transcript，不得發網路請求**。選單列每 5 秒呼叫它。

### 5.2 Claude Code adapter

- 快速路徑：`~/.claude/sessions/*.json` + `ps` 驗證 + `~/.helm/live/*.json`
- 慢速路徑：transcript（§4.2）
- Resume：`claude --resume <session_id>`

### 5.3 Codex adapter

**零 hook**（Codex 無 hook 機制，也不需要）：

- 語意：`~/.codex/history.jsonl`，每行 `{"session_id": "...", "ts": 1786003633, "text": "找出損耗我們 SSD 的對象"}` —— 現成的純使用者 prompt 歷史，等同 Claude Code 的 `UserPromptSubmit` 但成本為零
- 詳情：`~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`（實測 192 個檔）。首行 `type: "session_meta"`，payload 含 `session_id`、`cwd`、`originator`、`cli_version`、`model_provider`。後續為 `event_msg`（含 `task_started` 與 `turn_id`）與 `response_item`
- 補充：`~/.codex/state_5.sqlite` 有 `threads`、`thread_spawn_edges` 等表（**唯讀**存取，絕不寫入）
- 存活性：**無 PID 註冊表** —— 掃 `ps` 找 `codex` 行程並比對 cwd
- Resume：`codex resume <session_id>`

### 5.4 未實作的 adapter

- **Gemini CLI**：`~/.gemini/` 僅存 2026-01 的 auth 檔，無 sessions 目錄。使用者實質未使用
- **Copilot CLI**：僅有 config 與 logs，指令不在 PATH

兩者保留介面不實作。日後接入只需新增一個 adapter 檔。

## 6. Lifecycle 判定

`reconcile` 為純函式，可完整單元測試。

**Claude Code**（依 §4.1 與 §4.2 的實測行為推導）：

| 註冊表檔 | PID | `procStart` 比對 | live 檔 | → lifecycle |
|---|---|---|---|---|
| 存在 | 活著 | 相符 | — | `running` |
| 存在 | 死亡 | — | — | `crashed` —— 來不及刪檔 |
| 存在 | 活著 | **不符** | — | `crashed` —— PID 已被重用 |
| 不存在 | — | — | 存在且時間戳晚於 transcript 末筆 | `crashed` —— 當機於工具執行中 |
| 不存在 | — | — | 無，或早於 transcript 末筆 | `ended_clean` |

三條規則的依據：

1. **正常結束會刪除註冊表檔**（§4.1 實測），所以檔案殘留即異常
2. **`procStart` 比對**防止 PID 被新行程重用時誤判為存活
3. **live 檔晚於 transcript 末筆**表示最後一個工具呼叫發出後沒能寫回結果 —— 這正是當機的形狀，且能直接告訴使用者當時卡在哪個指令

transcript 不含結束標記（§4.2 實測），因此完全不參與此判定，只用於取時間戳比對。

**Codex**（2026-08-14 依實測再修訂）：

| 條件 | lifecycle |
|---|---|
| `ps` 中有 cwd 相符的 `codex` 行程 | `running` |
| 無行程，rollout 結尾是 `task_complete` / `turn_aborted` | `ended_clean` |
| 無行程，結尾在半途，最後事件 ≤ 30 分鐘 | `running` —— 避免 `ps` 短暫抓不到就誤判 |
| 無行程，結尾在半途，最後事件 30 分鐘 – 6 小時 | `crashed` |
| 無行程，結尾在半途，最後事件 > 6 小時 | `ended_clean` |
| 無行程，結尾讀不到 | 退回上面三列的純計時器規則 |

**「Codex 沒有結束訊號」這個前提是錯的（2026-08-14 實測推翻）。** 先前這裡
只有計時器，理由是 Codex 不寫終止事件。實測本機 194 個 rollout：**192 個的
最後一行就是 `task_complete` 或 `turn_aborted`，只有 2 個停在半途。**

計時器因此把做完的工作叫成中斷。使用者回報「出現 1 中斷但找不到誰被中斷」，
查出來是兩個跑完的 `codex exec` 批次工作——exec 一定會正常結束，實測 13 個
exec session **沒有一個**停了又繼續。而純看時間的話，26% 的 session（23/88）
都曾經停超過 30 分鐘再繼續，且不同門檻之間沒有明顯轉折點（60 分鐘 18 個、
180 分鐘仍有 12 個）——**時間本來就分不開「放棄了」和「去吃飯了」。**

只看最後一行，不往回掃：往回掃會把「第一輪做完、第二輪半途死掉」誤判成做完，
而它買不到什麼——完成事件在 192/194 的檔案裡就是最後一行，另外 2 個則完全沒有。

`CODEX_ABANDON_MS`（30 分鐘）保留，但降級成「半途結尾」那條的防抖動，不再是
主要依據。上界 `CODEX_UNKNOWN_MS`（6 小時）同理。

超過 6 小時、或結尾讀不到時，helm 其實**不知道**那個 session 是當機還是正常
結束。這裡用 `ended_clean` 是因為它在 UI 上的效果是「不畫點」，也就是不宣稱
任何事——而不是因為 helm 認定它乾淨結束了。`lifecycleConfidence` 一律 `low`
正是為此存在，**結尾讀得到也一樣**：Codex 說的是「這一輪做完了」，不是
「這個 session 結束了」，兩者之間的推論仍然是 helm 自己做的。

所有 Codex session 的 `lifecycleConfidence` 一律標為 `low`，UI 須區分呈現，不得與 Claude Code 的高信心判定混用同一視覺樣式。

## 7. 專案納入規則

自動納入條件（全部滿足）：

1. `cwd` 目前存在於檔案系統
2. `cwd` 或其祖先目錄含 `.git`
3. **近 14 天有活動** —— 定義為：該專案下任一 session 的註冊表 `updatedAt`，或其 transcript 檔的 mtime，兩者取較新者在 14 天內

排除路徑前綴：`/private/tmp`、`/var/folders`、`~/Downloads`（使用者現有的 26 個專案目錄中正好含這三類雜訊）。

支援手動 `pinned`（永遠置頂）與 `hidden`（永久隱藏），存於 `~/.helm/projects.json`（使用者設定的唯一真實來源，見 §4.4）。被 `pinned` 的專案不受 14 天規則約束，永遠顯示。

## 8. 交接簡報

**輸入**（刻意不餵整份 transcript）：

- 最後 **20 則**純文字 user prompt（不含 tool_result 與系統注入內容）
- 該 session 碰過的檔案清單（去重，取最近 50 筆）
- `git diff --stat` 與 `git status --short`
- 最後 **3 輪**的工具呼叫（工具名 + 輸入摘要，Bash 取完整指令）

以實測樣本（7679 行、224 筆純文字 prompt）估算，此組合約 3–6k token。

**輸出**：固定七欄結構化 JSON。

```
目標 / 已完成 / 進行到哪一步 / 下一步 / 卡點 / 相關檔案 / 相關 PR
```

| 欄位 | 說明 |
|---|---|
| `taskStatus` | `done` / `in_progress` / `blocked`；模型判斷這件事做完了沒。缺少或非法時視為未知，看板不顯示 |

**觸發時機**：

1. 使用者在選單列展開某張卡片，或執行 `helm brief <id>`
2. `helm menu` 發現 `crashed` 的 session 尚無簡報時，**以 stale-while-revalidate 在背景產生**（見 §4.4），當次仍顯示降級內容

**永不主動為所有 session 產生簡報。** 這是懶惰求值，避免為永遠不會回去的 session 燒 token。

**產生方式**：headless `claude -p`，輸出強制為 JSON schema。

## 9. 一鍵 Resume

`launch` 組出的動作：

1. 將交接簡報寫入 `~/.helm/briefs/<session_id>.md`
2. 開啟終端機新分頁（預設偵測 iTerm2 —— 使用者已安裝，fallback `Terminal.app`，可設定）
3. `cd <cwd>`
4. 執行 adapter 提供的 resume 指令
5. 自動送出開場訊息：`讀 ~/.helm/briefs/<session_id>.md 後接續`

**不直接把長簡報貼進 prompt** —— 那會污染新 session 的第一則訊息並吃掉 context。

指令組裝與實際執行分離，前者為純函式並完整測試。

## 10. PR 追蹤

`remote` 是唯一對外發網路請求的單元。它**只在慢速路徑執行**，透過 stale-while-revalidate 更新，絕不阻塞選單列刷新。

**資料來源**：`gh pr list --json` 與 `gh pr view --json reviews,comments,statusCheckRollup`（實測環境 `gh 2.76.2`）。

**快取 TTL**：60 秒。

**「在等誰」判定**：

| 條件 | waitingOn |
|---|---|
| 有未解決的 review comment | `等你改` |
| 無 review 記錄 | `等人審` |
| CI 執行中或失敗 | `等 CI` |
| 通過且無阻擋 | `可合併` |

**四種降級**（各自顯示為一行灰字，絕不阻塞其餘部分）：`gh` 不存在、未登入、rate limit、repo 無 remote。

## 11. UI

### 11.1 狀態語彙

五種，無模糊地帶：

| 標記 | 意義 | 來源 |
|---|---|---|
| ● 綠實心 | agent 正在跑 | 註冊表 `status: busy` |
| ○ 綠空心 | 活著但在等你輸入 | 註冊表 `status: idle` |
| ● 灰 | 正常結束 | `ended_clean` |
| ● 紅 | **異常中斷，有未回收的斷點** | `crashed` |
| ● 黃 | PR 在等你改 | `waitingOn: 等你改` |

選單列標題顯示當下最需要注意的狀態；只要存在紅點，標題即為紅色。`lifecycleConfidence: low`（Codex）的項目在圓點後加註 `?`。

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

### 11.2 選單列宿主：SwiftBar

不自行開發原生 app。以 SwiftBar（`brew install --cask swiftbar`，2.0.1，使用者目前未安裝）作為宿主。

Plugin 檔 `~/Library/Application Support/SwiftBar/helm.5s.sh`，內容為單行呼叫：

```sh
#!/bin/sh
exec helm menu
```

`helm menu` 輸出 SwiftBar 格式：選單列標題、專案分組、每個 session 一列（圓點 + 名稱 + 最後活動 + PR badge），子選單含「開終端機」「看簡報」「隱藏此專案」等可點擊項目（SwiftBar 的 `bash=` 參數直接回呼 `helm open <id>`）。

**效能契約**：`helm menu` 每 5 秒執行一次，必須在 **200ms 內**完成。因此它只走快速路徑（讀註冊表、`live/*.json`、`cache.json`），**絕不讀 transcript、絕不發網路請求、絕不呼叫 LLM**。所有慢速工作透過 §4.4 的背景 fork 完成。

此契約以自動化測試強制：`helm menu` 在 fixture 環境下的執行時間納入 CI 斷言。

### 11.3 詳情呈現

`helm brief <id>` 產生 markdown（七欄簡報 + 工具呼叫時間軸 + 未 commit diff + 相關 PR），預設以 `$PAGER` 顯示，`--open` 旗標則寫入暫存 HTML 並以瀏覽器開啟。

不開發 web 前端。

### 11.4 終端機視圖

`helm status` 輸出彩色表格，內容與選單列一致。這是 P1 的交付物，也是選單列故障時的完整備援。

## 12. 錯誤處理

專案全域規則要求「絕不靜默吞錯」。此處僅有一項豁免且附帶補償：

| 單元 | 策略 |
|---|---|
| `hook` | **唯一豁免**：必須靜默（在關鍵路徑上）。錯誤寫入 `~/.helm/hook-errors.log`，`helm doctor` 主動回報 |
| `adapters` | 每個 adapter 獨立隔離，Codex adapter 失敗不影響 Claude Code 那半邊 |
| `summarize` | 逾時或失敗 → 顯示「簡報產生失敗，可重試」並**降級顯示最後 3 則原始 prompt**。永不呈現空白卡片 |
| `cache` | 解析失敗 → 視為空快取重建，並將損壞檔移至 `~/.helm/cache.corrupt.json` 供追查。快取毀損絕不導致 CLI 無法執行 |
| `remote` | 四種降級，見 §10 |
| `render` | 純函式、無 I/O。輸入已於邊界驗證，故不做二次防禦；任何未預期輸入應在驗證層攔下並計數 |

**邊界驗證**：所有外部輸入（`live/*.json`、註冊表、transcript、`gh` JSON、`cache.json`）皆通過 schema 驗證。解析失敗的記錄計數並由 `helm doctor` 回報 —— 這是偵測「上游 CLI 改了格式」的機制。

## 13. 測試策略

目標覆蓋率 80%。

**單元測試**
- `reconcile`：§6 判定真值表的每一列（Claude Code 5 列 + Codex 3 種情境）
- 兩個 adapter 的解析器：餵真實 fixture
- `render`：純函式，三種輸出格式的快照測試
- `summarize`：輸入組裝與 digest 計算
- `launch`：指令組裝（組而不執行）
- `remote`：`waitingOn` 判定的四種條件 + 四種降級
- 專案納入規則：含三類排除路徑

**整合測試**
- fixture 目錄 → `helm scan` → `helm menu` 全鏈路
- stale-while-revalidate：驗證背景 fork 不阻塞主輸出

**效能測試**
- `helm menu` 在 fixture 環境下 < 200ms（CI 斷言，見 §11.2）

**Fixture**：從本機真實的 Claude Code transcript 與 Codex rollout 匿名化擷取。這是本專案最重要的測試資產 —— 兩個 CLI 的檔案格式都會隨版本變動，fixture 是唯一的防線。

## 14. 目錄結構

依功能切分，非依型別。單一 TypeScript 專案。

```
helm/
  src/
    adapters/       # types.ts, claude-code.ts, codex.ts
    reconcile/      # lifecycle 判定純函式
    cache/          # cache.json 讀寫 + stale-while-revalidate
    summarize/      # 簡報產生
    remote/         # gh 包裝與 waitingOn 判定
    launch/         # 終端機指令組裝
    render/         # swiftbar.ts, table.ts, markdown.ts（純函式）
    cli/            # 指令進入點
    hook/           # PreToolUse 片段 + 安裝／解除安裝器
  fixtures/
  docs/superpowers/specs/
```

單檔 200-400 行為常態，800 行為上限。

## 15. 實作分期

| 期 | 交付 | 使用者得到什麼 |
|---|---|---|
| P1 | `adapters/claude-code` + `reconcile` + `render/table` + `helm status` / `helm scan --json` | 終端機一行指令看到全部 session 與紅色斷點標記；`--json` 供其他工具串接 |
| P2 | `summarize` + `launch` + `cache` | 交接簡報 + 一鍵開 |
| P3 | `render/swiftbar` + `helm menu` + hook + 安裝器 | 選單列常駐看板，含「此刻正在跑什麼」 |
| P4 | `adapters/codex` | Codex session 一併納入 |
| P5 | `remote` | PR 審查狀態與「在等誰」 |

P1 即為可用交付物。P3 完成即滿足原始需求全貌。

## 16. 已知風險

| 風險 | 緩解 |
|---|---|
| Claude Code / Codex 檔案格式隨版本變更 | schema 驗證 + fixture 測試；`helm doctor` 回報解析失敗計數 |
| 全域 hook 影響所有專案 | 只有一個 hook；`HELM_OFF=1` kill switch；安裝前備份；附加而非覆蓋；`helm uninstall` 30 秒完全脫身 |
| SwiftBar 為第三方相依 | `helm status` 提供完整的終端機備援（§11.4），SwiftBar 只是宿主不是必要條件 |
| `helm menu` 每 5 秒執行，Node 冷啟動約 60ms | 佔用約 1.2% CPU，可接受；若不足則調整 plugin 檔名間隔（SwiftBar 以檔名決定） |
| Codex 存活性判定較弱（無 PID 註冊表） | `lifecycleConfidence: low`，UI 區分呈現 |
| 交接簡報 token 成本失控 | digest 快取閘門 + 僅對展開的卡片懶惰求值 |
| 無事件歷史，transcript 遭清理即失去過往 | 使用者設定 `cleanupPeriodDays: 100`；若日後成為問題，加儲存層不需重寫上層（§3.3） |
| **Claude Code 可能於啟動時清理他人殘留的註冊表檔**，抹除當機證據 | 未經實測證實，屬殘餘不確定性。緩解：`~/.helm/live/*.json` 由 helm 自行管理、上游不會清（§4.3），提供獨立的當機證據來源。P3 完成後此風險大幅降低；P1/P2 期間若遇證據遺失，屬已知限制 |
