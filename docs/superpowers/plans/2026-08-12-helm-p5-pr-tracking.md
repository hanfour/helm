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

- [x] 測試：四種狀態各一、`SKIPPED` 不算失敗、空的 `statusCheckRollup`（沒有 CI 的 repo）不該被當成「等 CI」、草稿優先於一切
- [x] 紅 → 實作 → 綠 → commit
- [x] **真實資料驗證**——`cli/cli` 的 12 個 PR：6 草稿 / 5 等人審 / 1 等你改。`SKIPPED` 沒有被誤判成等 CI

**實作時補進去的三件事**（測試都先紅過）：

- `SKIPPED` 與 `NEUTRAL` 不算失敗。GitHub Actions 的條件式 job 大量產生
  `SKIPPED`，當成失敗的話幾乎每個 PR 都會顯示「等 CI」——真實樣本裡 12 個
  PR 全部都有 SKIPPED。
- `CANCELLED` / `TIMED_OUT` / `ACTION_REQUIRED` / `STARTUP_FAILURE` / `STALE`
  算失敗，那些都是需要人去看的狀態。
- 認不得的 `reviewDecision`（`gh` 明天可能多回一個值）當成「還沒審」，不猜。

### Task 2：`gh` 的兩個查詢與四種降級

- [x] 測試（注入假的 exec）：`gh` 不存在、未登入（exit 4）、rate limit、`--json` 欄位不支援、輸出不是 JSON
- [x] 四種降級各自產生一句**帶下一步**的訊息，而不是一個空陣列
- [x] 紅 → 實作 → 綠 → commit
- [x] **真實 `gh` 端到端**：`searchMyPrs` 806 ms → 1 個 PR；`prDetail` 889 ms → 判定「等 CI」。三種降級各自用真的失敗觸發過

**實測補上的第五種降級**：憑證失效（HTTP 401）跟「沒登入」（exit 4）要
分開講——前者要重新登入，後者是從沒登入過，使用者要做的事不一樣。
規格 §10 把它們算成同一種。

認不得的失敗**照原樣把 stderr 的第一行說出來**。helm 沒見過的訊息，
正是使用者最需要逐字讀到的那一則。

### Task 3：60 秒快取與 stale-while-revalidate

- [x] 測試：過期時仍回舊資料、同時標記需要更新、快取檔壞掉當空的、原子寫、**同一時間只有一個更新行程**（用 lock 檔，否則每 5 秒 fork 一次）
- [x] 紅 → 實作 → 綠 → commit

**實作時想清楚的兩件事**：

- **降級也要進快取**，而且也遵守 TTL。否則一個沒登入的 `gh` 會每 5 秒被
  問一次，每次付 0.8 秒。
- **鎖必須會過期**。持有者可能被 kill -9、或機器在請求中途休眠 ——
  沒有過期的話那個檔案會永遠擋著，而使用者只會看到 PR 狀態再也不更新，
  看板本身還一片健康。五分鐘，遠大於一次 `gh` 的幾秒。
  用 `openSync(file, 'wx')` 取得原子性：檢查與建立是同一個 syscall，
  兩個行程同時到達也只有一個贏。

### Task 4：`helm pr-refresh` 與背景 fork

- [x] 測試：失敗不影響呼叫端、鎖被持有時不 spawn、過期時仍回舊資料
- [x] 紅 → 實作 → 綠 → commit
- [x] **真機端到端**：`helm pr-refresh` 1.87 秒，抓到 `onead/erp#4853`，判定「等 CI」

**實作時想清楚的一件事**：鎖在 `kickRefreshIfStale` 裡先探一次再 spawn。
只為了讓子行程立刻退出而 fork 一個 Node，在每 5 秒的路徑上要付約 40 ms。

**還沒接的**：`helm menu` 目前還沒呼叫 `kickRefreshIfStale`，也還沒畫出來 ——
那是 Task 5 連同兩個呈現面一起做，因為 detached spawn 的驗證要跟真正的
渲染路徑一起才有意義。

### Task 5：畫進兩個呈現面

**修正（實作時發現）：PR 獨立一區，不掛在專案底下。**

原本寫的是「每個專案底下多一行 PR」。那需要把 GitHub 的 `owner/repo`
對應回本機路徑——只能靠讀每個專案的 git remote（又是 I/O），而且對不上的
就消失了。實測：這台機器唯一開啟中的 PR 屬於 `onead/erp`，而看板上根本
沒有那個專案，掛在專案底下就等於畫不出來。

獨立一區也更貼近這個功能要回答的問題：「有哪些 PR 在等我」，而不是
「這個專案有哪些 PR」。

- [x] 選單列：獨立一區 `PR`，每行 `owner/repo#142  等人審`，可點開瀏覽器；四種降級一行灰字
- [x] 桌面 widget：同一份 `viewOf` 資料結構，測試走 `helm:logic` 區塊
- [x] 兩邊的文案與計數單位一致（P3 的教訓：一邊寫 3 一邊寫 1）
- [x] 紅 → 實作 → 綠 → commit
- [x] **真機驗證**：選單列出現 `onead/erp#4853  等 CI`，可點開瀏覽器
- [x] **不阻塞的證明**：清空快取後跑 `helm menu` → **0.128 秒**（149% CPU），
  完全沒等那 1.87 秒的 `gh`；3 秒後快取自己到位，鎖已放開
- [x] **成本沒有增加**：`runMenu` 94–123 ms（P4 後是 107 ms）

---

## 已知的取捨

**只查 `--author @me`。** 別人開的、指派給我審的 PR 不會出現。規格 §10 的
「等人審」是站在作者視角寫的，先做到那個範圍；`--review-requested @me` 是
之後另一條查詢，成本再加 1.3 秒。

**沒有開啟中的 PR 時看不到任何東西。** 這台機器目前只有 1 個
（`onead/erp #4853`，2026-04 更新）。功能做完的驗證會很薄——這是選這一塊
時就知道的。
