# helm

本機的 agent CLI 艦隊看板。你同時開著好幾個 Claude Code session 時，helm 告訴你**哪個在跑、哪個在等你、哪個已經斷了**——在選單列，或直接畫在桌布上。

```
⚓ 2 在跑
─────────────────────────────
● helm              剛剛
  Bash: npm test
● data-svc          剛剛
  Read: src/api/handler.ts
● report-tool       3 分鐘前
  等你回應
○ project-alpha     2 小時前
```

## 為什麼

開三個 session 之後，「剛才那個跑完了嗎」就只能靠切視窗確認。helm 把答案放在你一眼看得到的地方，並且在你回去接手時，先給你一份交接簡報。

## 需求

- macOS
- Node 24 以上（`.ts` 直接跑，沒有 build step）
- [Claude Code](https://claude.com/claude-code)
- 選單列看板：[SwiftBar](https://swiftbar.app)（`brew install --cask swiftbar`）
- 桌面看板：[Übersicht](https://tracesof.net/uebersicht/)（`brew install --cask ubersicht`）

兩個 GUI app 都是選用的。沒裝的話 `helm status` 在終端機一樣能用。

## 安裝

```sh
git clone <this-repo> ~/helm
cd ~/helm && npm install
node src/cli/main.ts install
```

`install` 會做四件事，每一件都印出來：

1. 在 `~/.claude/settings.json` 裡加一個 PreToolUse hook（**先備份**，只加一筆，其餘設定不動）
2. 建立 `~/.helm/live`
3. 寫一個 wrapper 到 `~/.local/bin/helm`
4. 把 plugin / widget 裝進 SwiftBar 與 Übersicht **實際掃描的**資料夾

隨時可以收回：

```sh
HELM_OFF=1        # 停用 hook，其他都留著
helm uninstall    # 移除 hook 與看板，還原被 helm 改過的設定
```

`uninstall` 不會刪 `~/.helm` 底下的 live 檔、快取與備份——那是你的資料。它也不會刪你改過的 widget（每個產生的檔案帶著內容雜湊，helm 認得出你動過它）。

## 指令

| 指令 | 做什麼 |
|---|---|
| `helm status [--json]` | 列出所有專案，一個專案一行 |
| `helm sessions <專案>` | 展開該專案底下的 session |
| `helm brief <專案\|id>` | 產生交接簡報：這個 session 做到哪、下一步是什麼 |
| `helm open <專案\|id>` | 開終端機接續，並把簡報寫成檔案讓它讀 |
| `helm pin\|unpin <專案>` | 釘選的專案不受 14 天活動窗口約束 |
| `helm hide\|show <專案>` | 從看板隱藏 |
| `helm doctor` | 檢查 hook、資料來源、兩個 app 的整合是否真的能運作 |
| `helm menu` | 輸出 SwiftBar 格式（由 plugin 呼叫） |

專案名可以只打一部分。對不上唯一目標時會列出候選讓你選，不會自己挑一個。

## 它怎麼知道發生了什麼

**探索以 transcript 為主。** Claude Code 的 session 註冊表（`~/.claude/sessions/<pid>.json`）在乾淨結束時會被刪掉，所以只靠它會看不到剛結束的 session。helm 以 `~/.claude/projects/` 底下的 transcript 為主要來源，註冊表只用來補上「還活著嗎」。

**「此刻正在跑什麼」來自一個 PreToolUse hook。** 它是一個沒有任何 import 的 `.mjs`（type stripping 每次要 ~21 ms，而這東西在你每一次工具呼叫前都會跑），寫一行 JSON 到 `~/.helm/live/<session-id>.json`，然後結束。它以 `async` 安裝，永遠不會擋住工具呼叫；任何路徑都 exit 0；寫入是 temp + rename。

**`helm doctor` 檢查的是「能不能運作」，不是「檔案在不在」。** 包括釘住的 Node 路徑還在不在、plugin 呼叫的 wrapper 還在不在、以及 app 掃描的資料夾是不是 helm 寫進去的那一個——那些是會讓看板靜默死掉、而每個檔案都還在原地的失敗。

## 開發

```sh
npm test          # node --test，684 個
npm run check     # typecheck + 測試 + 覆蓋率
```

沒有 build step、沒有 bundler、沒有 transpiler 設定。TypeScript 只用來做型別檢查，Node 直接跑 `.ts`。

測試絕不碰真實的 `defaults` 資料庫（`HELM_NO_REAL_PREFS=1` 會讓任何嘗試直接丟例外）、不留暫存目錄、不寫 `~/.claude`。這幾條都是踩過才加的。

## 授權

MIT
