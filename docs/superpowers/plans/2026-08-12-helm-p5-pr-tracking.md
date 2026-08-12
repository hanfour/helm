# P5：PR 追蹤實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 看板上看得到「哪個 PR 在等我、哪個在等別人」，而且絕不拖慢刷新。

**Architecture:** `remote` 是唯一對外發網路請求的單元。它**不在 `helm menu` 的路徑上執行**——看板只讀快取，過期時 fork 一個 detached 行程去更新，自己立刻用舊資料渲染（stale-while-revalidate，規格 §10）。

**Tech Stack:** `gh` CLI（實測 2.76.2）。無新增相依。

## Global Constraints

- **絕不阻塞選單列。** 讀快取以外的任何事都不得發生在 `helm menu` 的同步路徑上。
- 四種降級各自顯示為一行灰字（規格 §10）：`gh` 不存在、未登入、rate limit、無 remote。
- 快取 TTL 60 秒（規格 §10）。過期的資料照樣顯示，只是同時去更新。

---

## 實測資料（2026-08-12，gh 2.76.2）

**先驗證資料才寫計畫**——P4 的教訓是反過來做會讓計畫的核心假設是錯的。

```
gh pr list（單一 repo，20 筆）        3,023 ms
gh pr view（單筆）                     906 ms
gh pr list（目錄無 remote）            789 ms   ← 失敗也要付
gh search prs --author @me（跨 repo） 1,330 ms   ← 一次涵蓋全部
```

**規格 §10 說的「`gh pr list --json`」要對每個 repo 跑一次。** 這台機器有 8+ 個帶
remote 的專案，逐一查就是 **24 秒**。而 `gh search prs --author @me` 一次
1.3 秒就涵蓋所有 repo——包括我逐一查時漏掉的那個（`onead/erp #4853`，
唯一一個真正開啟中的 PR）。

但 `search` **不支援** `reviewDecision` 與 `statusCheckRollup`：

```
$ gh search prs --json reviewDecision
Unknown JSON field: "reviewDecision"
```

所以是兩階段：`search` 找出有哪些 PR（1.3 秒，一次），再對每個 PR
`gh pr view --json reviewDecision,statusCheckRollup`（0.9 秒/個）。
使用者目前有 1 個 PR → 約 2.2 秒；10 個 PR → 約 10 秒。都只在慢速路徑。

**`reviewDecision` 的實際值**（取自 `cli/cli`）：`REVIEW_REQUIRED`、
`APPROVED`、`CHANGES_REQUESTED`、`null`。
**`statusCheckRollup`** 是陣列，每筆帶 `__typename`（`CheckRun` / `StatusContext`）、
`conclusion`（`SUCCESS` / `FAILURE` / `SKIPPED` / …）、`status`。

## File Structure

| 檔案 | 責任 |
|---|---|
| `src/remote/search.ts` | `gh search prs --author @me`，回 `{repo, number, url, title, isDraft}` |
| `src/remote/detail.ts` | `gh pr view --json reviewDecision,statusCheckRollup` |
| `src/remote/waiting.ts` | 純函式：兩份資料 → `waitingOn`（規格 §10 的表） |
| `src/remote/cache.ts` | 60 秒 TTL，原子寫，讀不到就當空的 |
| `src/remote/refresh.ts` | `helm pr-refresh`：整條慢速路徑，由背景行程呼叫 |
| `src/render/*` | 每個專案底下多一行 PR，四種降級各一行灰字 |

---

### Task 1：`waitingOn` 的判定（純函式，先做，不碰網路）

**Interfaces:** `waitingOn(pr: { reviewDecision, checks }): 'changes' | 'review' | 'ci' | 'mergeable'`

規格 §10 的表，加上實測補的兩件事：

| 條件 | waitingOn |
|---|---|
| `CHANGES_REQUESTED` | 等你改 |
| `REVIEW_REQUIRED` 或 `null` | 等人審 |
| 任一 check `FAILURE` / 執行中 | 等 CI |
| `APPROVED` 且 checks 全過 | 可合併 |
| `isDraft` | 草稿（不催任何人） |

- [ ] 測試：四種狀態各一、`SKIPPED` 不算失敗、空的 `statusCheckRollup`（沒有 CI 的 repo）不該被當成「等 CI」、草稿優先於一切
- [ ] 紅 → 實作 → 綠 → commit

### Task 2：`gh` 的兩個查詢與四種降級

- [ ] 測試（注入假的 exec）：`gh` 不存在、未登入（exit 4）、rate limit、`--json` 欄位不支援、輸出不是 JSON
- [ ] 四種降級各自產生一句**帶下一步**的訊息，而不是一個空陣列
- [ ] 紅 → 實作 → 綠 → commit

### Task 3：60 秒快取與 stale-while-revalidate

- [ ] 測試：過期時仍回舊資料、同時標記需要更新、快取檔壞掉當空的、原子寫、**同一時間只有一個更新行程**（用 lock 檔，否則每 5 秒 fork 一次）
- [ ] 紅 → 實作 → 綠 → commit

### Task 4：`helm pr-refresh` 與背景 fork

- [ ] 測試：fork 出去的行程 detached 且不繼承 stdio（否則 SwiftBar 會等它）、失敗不影響呼叫端
- [ ] **效能驗證**：`helm menu` 的行程內部耗時不得增加超過 5 ms
- [ ] 紅 → 實作 → 綠 → commit

### Task 5：畫進兩個呈現面

- [ ] 選單列：專案底下一行 `PR #142 等人審`，四種降級一行灰字
- [ ] 桌面 widget：同一份 `viewOf` 資料結構，測試走 `helm:logic` 區塊
- [ ] 兩邊的文案與計數單位一致（P3 的教訓：一邊寫 3 一邊寫 1）
- [ ] 紅 → 實作 → 綠 → commit

---

## 已知的取捨

**只查 `--author @me`。** 別人開的、指派給我審的 PR 不會出現。規格 §10 的
「等人審」是站在作者視角寫的，先做到那個範圍；`--review-requested @me` 是
之後另一條查詢，成本再加 1.3 秒。

**沒有開啟中的 PR 時看不到任何東西。** 這台機器目前只有 1 個
（`onead/erp #4853`，2026-04 更新）。功能做完的驗證會很薄——這是選這一塊
時就知道的。
