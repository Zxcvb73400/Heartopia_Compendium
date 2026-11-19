# 心動小鎮五星圖鑑：網站原始碼說明

## 線上網站

網站網址：[心動小鎮五星圖鑑](https://heartopia-atlas.zxcvb7340-0.workers.dev/)

## 資料夾結構

```
index.html              網頁骨架（文字內容、按鈕、對話視窗）
css/
  style.css             所有樣式，依功能分區，每區都有標題
js/
  journal-core.js       核心邏輯：篩選、排序、活動檔期、存檔檢查（不碰畫面）
  data-loader.js        資料載入器：讀取 data/ 並還原成程式用的格式
  app.js                畫面與互動：表格渲染、按鈕、成本計算機、備份還原
data/
  meta.json             資料版本號、來源、更新紀錄
  fish.json             魚類
  bugs.json             捕蟲
  birds.json            鳥類
  flowers.json          花朵
  dishes.json           料理
  shared.json           重複出現的長文字（活動檔期、匯入備註、五星來源）
  activity-schedules.json   活動檔期（開始／結束時間、代幣名稱）
  material-catalog.json     食材價格目錄、限時食材
  retired-ids.json          已下架項目的 ID（讓舊收藏紀錄仍能對得上）
  changelog.json            首頁「更新紀錄」與說明視窗「版本告示」的內容
tools/
  gen-missing.js          依 data/ 重新產生「缺漏資料表.md」（維護用，不需上傳網站）
```

## 如何預覽

**不能直接雙擊 index.html。** 資料改成獨立檔案後，瀏覽器基於安全限制，
不允許網頁在「本機檔案」模式下讀取 data 資料夾。請擇一：

- **VS Code**：安裝 Live Server 外掛，對 index.html 按右鍵 →「Open with Live Server」
- **Python**：在此資料夾開啟終端機，執行 `python -m http.server 8000`，然後開 http://localhost:8000
- **直接上傳**到網站空間（GitHub Pages、Netlify 等）後用網址開啟

如果誤用雙擊開啟，頁面頂端會出現說明，而不是一片空白。

## 如何更新資料

1. 修改 `data/` 底下對應的 JSON 檔（例如新增一隻魚就改 `fish.json`）。
2. **把 `data/meta.json` 的 `dataVersion` 改成新的日期**（例如 `"2026-11-02"`）。
   這個值會附在檔案網址後面，瀏覽器看到版本變了就會抓新資料，不會一直用舊快取。
3. 整個資料夾重新上傳即可。HTML、CSS、JS 通常不用動。
4. **有改 `css/` 或 `js/` 時**，把 `index.html` 裡 `style.css?v=…`、`journal-core.js?v=…`、`data-loader.js?v=…`、`app.js?v=…`
   的版本號一起改掉（例如 `?v=2026-11-18` → `?v=2026-11-25`），避免玩家瀏覽器混用新舊程式。

### 安全設定（CSP）

`index.html` 的 `<meta http-equiv="Content-Security-Policy">` 只允許載入本站的程式、樣式與資料。
因此：**不要在 HTML 裡寫內嵌 `<script>` 或 `onclick=`**（程式一律寫進 `js/`）；
要加入外部字型、圖片或統計程式時，必須同步把對應網域加進 CSP，否則會被瀏覽器擋下。
維護文件（README、缺漏資料表、`.claude/`、`.github/`）已在 `robots.txt` 排除收錄，上傳時最好也不要放上網站。

### 新增一則更新紀錄

在 `data/changelog.json` 的**最前面**加一筆（最新的放第一筆），並更新 `dataVersion`：

```json
{
  "version": "1.2.4",
  "date": "2026-11-25",
  "label": "更新",
  "summary": "圖鑑共 <strong>669 筆</strong> · 本批新增 <strong>0 筆</strong> · 修改 <strong>10 筆</strong>",
  "items": [
    { "title": "資料修正", "text": "修正……" },
    { "text": "沒有小標題的項目只寫 text" }
  ]
}
```

| 欄位 | 中文 | 說明 |
|---|---|---|
| `version` | 版本號 | 不含 `v`，畫面會自動加 |
| `date` | 日期 | `YYYY-MM-DD`，畫面顯示成 `YYYY/MM/DD` |
| `label` | 類別 | 通常是 `更新`，初版是 `初版` |
| `summary` | 摘要行 | 可用 `<strong>` 加粗數字 |
| `items` | 項目清單 | `title` 是粗體小標題（可省略），`text` 是內容 |

首頁分頁與說明視窗的「版本告示 · vX.X.X」和更新日期，都會自動採用第一筆。

**撰寫原則**：只寫類別與數量（例如「收錄 11–14 級魚類 13 種」），**不要列出各項目的詳細名稱**；
只有這次只修改單一、特定項目時，才寫出該項目名稱。
`summary`、`text` 會直接當 HTML 顯示，只放自己寫的內容，不要貼外部來源的 HTML。

> 頁尾「最後更新」的時間，和原本一樣是讀取 `index.html` 的伺服器修改時間
> （讀不到時用 `index.html` 裡 `<meta name="atlas-updated-at">` 的值）。
> **只更新 data 資料夾時，這個時間不會跟著變**，請一併重新上傳 `index.html`，或修改該 meta 的日期。

## 資料格式說明

每個分類檔是一個陣列，**一行一筆資料**，方便閱讀與比對差異。
為了縮小檔案，下列內容會被省略，載入時由 `data-loader.js` 自動補回：

| 寫法 | 載入後的意思 |
|---|---|
| 欄位沒寫（`color`、`eventStatus`、`eventName`、`dataSource`、`importNote`、`plantType`） | 空字串 `""` |
| `times`、`weather`、`locations`、`ingredients` 沒寫 | 空陣列／空物件 |
| `"times": "all"` | `["0-6時","6-12時","12-18時","18-24時"]` |
| `"weather": "all"` | `["晴","雨","彩虹"]` |
| `"category"` 欄位沒有 | 由檔名決定（`fish.json` → `fish`） |
| `"eventScheduleRef": "schedule-2"` | 到 `shared.json` 的 `eventSchedules` 找 `schedule-2` |
| `"importNoteRef": "note-5"` | 到 `shared.json` 的 `importNotes` 找 `note-5` |
| `fiveStar.sourceRef` | 到 `shared.json` 的 `fiveStarSources` 找 |
| 料理 `economics: {cost, prices:[…5個]}` | 補成每個星級的 `{star, price, profit}`；利潤 = 售價 − 成本，任一項未知則為 `null` |

新增資料時，**直接寫完整格式也可以**（例如自己寫 `"times":["6-12時"]` 或直接寫 `importNote` 全文），
載入器兩種寫法都接受，不必一定要用省略寫法。

### 掉落資訊（`drops`）
需要在詳細列顯示掉落物的項目，在資料裡加上 `"drops": "蘑菇×3"` 即可
（目前 `bugs.json` 的 5 隻金龜子與 `birds.json` 的 5 隻渡鴉有）。展開該項目的「資料」列時，
會在「星級售價」下方顯示「掉落物」區塊。要顯示多個掉落物可以寫成陣列：`"drops": ["蘑菇×3", "橘子×2"]`。

### 缺漏資料

目前資料檔中寫 `N/A` 或空白的項目（售價、活動幣、種植欄位、檔期待確認…）整理在 [`缺漏資料表.md`](缺漏資料表.md)，
其中只缺部分星級的售價，表內已附依倍率推算的建議值。

更新方式：在專案根目錄執行 `node tools/gen-missing.js`，會依 `data/` 重新產生整張表。
**如果有在表上手動補數字或等級，請先把它們寫進 `data/` 的 JSON 再執行**，否則會被覆蓋。

### 篩選與排序的固定行為

- **換分類頁**：收錄類型、僅顯示當前可獲取、等級、完成狀態會沿用上一頁；天氣與時段只在釣魚、捕蟲、觀鳥之間同步；搜尋文字會清空，不跨頁保留。
- **開啟或重新整理網頁**：一律回到首頁，所有篩選恢復預設（10 級以下、現在的時段等）；勾選進度保留。之後手動改的篩選會記住，直到下次重新載入。
- **只勾選「過往活動」**（收錄類型沒有全選）時，即使勾著「僅顯示當前可獲取」，已結束的活動項目也會顯示。
- **地點選單**：活動限定的事件（雀鱔魚、幽光魚潮、冰晶魚、積木魚、戴勝鳥、糞金龜異變…）統一歸在「活動特殊事件」一個選項；
  常駐事件（海釣、百鳥歸巢、引蟲出洞）維持各自的選項。新增常駐事件時，要把名稱加進 `js/journal-core.js` 的 `DAILY_EVENTS`。
- **園藝依編號排序**：日常在前（依等級再依編號）；活動項目依活動開始時間分組，同一活動內作物在前、花卉在後。
- **料理「製作方式」**：`raw.製作方式` 有值時，展開詳情會多一段「製作方式」（例如溫泉蛋）。

### 項目 ID（`id`）規則

- 所有分類統一使用 **20 位小寫十六進位亂碼**（`0-9a-f`），不加前綴。
  產生方式：`node -e "console.log(require('crypto').randomBytes(10).toString('hex'))"`。
- 新 ID 不可與現有 `id`、任何 `legacyIds`、`retired-ids.json` 重複。
- 玩家的勾選進度與匯出備份都以 ID 記錄，所以 **ID 一經使用不要更改**。
  必須更改時，把舊 ID 放進該筆的 `"legacyIds": ["舊ID"]`，讀取本機存檔與匯入備份時會自動轉到新 ID。
- 程式不可依 ID 格式判斷任何事：分類看檔名，活動與否看 `eventName`。
- 2026-11-18 已把 119 筆舊格式 ID（`trial-`、`crop-`、`pending-`、`dish-bk-…`、`trial-pumpkin-…`）統一成 20 位，
  舊 ID 都保留在各筆的 `legacyIds`，玩家既有進度不受影響。

### 活動資料與檔期

- 活動項目的 `eventName` 必須等於 `activity-schedules.json` 的活動名稱鍵。
  進行中／已結束、限時料理台、活動外可製作、特殊幣，都由檔期表依目前時間計算，不用手動維護 `eventStatus`。
- `shared.json` 的 `eventSchedules`（`eventScheduleRef`）是舊格式，只當備援，新資料不要再用。
- 依活動類型固定設定：

| 活動類型 | 限時料理台 `requiresActivityStation` | 結束後可製作 `outsideAvailable` | 特殊幣 `tokenName` |
|---|---|---|---|
| 潮流季 | `true` | `false` | 潮流幣 |
| 慶典 | `true` | `false` | 慶典幣 |
| 活動 | `false` | `true` | 無 |
| 聯動 | `false` | `true` | 無 |

- 畫面上的活動徽章顯示為「當前／過往 + 活動類型 - 活動名稱」，例如 `過往潮流季-冰雪季`、`當前慶典-近幽集`。
- 活動料理的 `raw.解鎖方式` 寫成 `活動類型-活動名稱`（例如 `慶典-遠古召喚`）；若解鎖方式是取得途徑（`快閃食譜`、`特殊商店購買`…）則保留原文字。
- 活動／聯動料理用到 `material-catalog.json` 中 `limited: true` 的材料時，會顯示「限時材料」；
  `limited` 與檔案頂層的 `limitedMaterials` 清單要同步。
- 價格分兩種用途：作為**料理材料**時，`material-catalog.json` 的單價用售出價格（作物、魚類、子料理都取 1 星售價）；
  作為**種子**時，園藝頁的種植成本用 `flowers.json` 的 `raw.種子價格`（原始價格），兩者不要互相覆蓋。
- 子料理（材料本身是一道料理，`material-catalog.json` 標 `"subDish": true`）一律以該料理的 **1 星售價**計入成本；
  用到子料理的套餐，`economics.cost` 依此加總，畫面的詳情與成本計算機會標示「子料理以 1 星售價計入成本」。
  「任意」子料理（材料目錄有 `options`）取該系列最低 1 星售價；詳情裡可展開「子料理材料明細」，看每道子料理用材料目錄單價統計的材料成本（僅供參考，不計入成本）。
- 料理成本在載入時依材料目錄自動計算（食材都有單價時），資料檔的 `economics.cost` 只在缺價時使用；兩者不同時主控台會出現 `[資料檢查]` 警告。
- `"displayOnly": true`（搭配 `"trackable": false`）：只展示、不能勾選，例如製作失敗的「詭異的食物／飲料」。
- 「任意xxx」材料（任意水果、任意蔬菜、任意湖魚…）的單價，以 xxx 同類中最低的售出價格（1 星售價）為準；對照表見 `.github/agents/data-templates.agent.md`。
- 新增材料前先查名稱與別名（`aliases`），避免重複，例如 `奶油` 已是 `黃油` 的別名。
- 各資料檔的新增模板與欄位中文對照，見 `.github/agents/data-templates.agent.md`。

### 關於 `raw` 欄位
`raw` 是匯入時保留的原始表格欄位（備註、掉落、位置、經驗…都在這裡）。
**所有有內容的欄位都完整保留**，只省略「空字串」的欄位，所以不會遺失任何資訊。
（注意：目前頁面只顯示其中一部分欄位，例如「備註」中的掉落資訊雖然保存在資料裡，畫面上沒有顯示，原本單檔版也是如此。）

## 程式碼閱讀指南

- `journal-core.js` 與 `app.js` 內都有 `/* ---- 標題 ---- */` 形式的分區標題，
  用編輯器搜尋「/\*」或看大綱即可快速跳到想看的區塊。
- 想改「篩選／排序規則」→ `journal-core.js`
- 想改「畫面怎麼顯示」→ `app.js`
- 想改「顏色、間距」→ `css/style.css`
- 想改「資料怎麼讀進來」→ `data-loader.js`

## 這次改了什麼（與原本單檔版的差異）

- 資料從 HTML 內嵌改成獨立 JSON，總資料量約 800 KB → 約 520 KB（所有資料內容都保留，沒有刪除有內容的欄位）。
- 移除沒有被程式使用的 `referenceFlowerColors`（約 70 KB，且 ID 全部重複）。
- 程式邏輯本身沒有改動；`app.js` 只有調整資料來源：資料改由載入器取得、食材目錄改讀 `DATA.materials`，
  並在資料載入完成後替 `<body>` 加上 `is-ready`。
- 資料載入完成前，畫面會先隱藏（`css/style.css` 的 `body:not(.is-ready)`），
  避免先看到沒有分類導覽的空殼再跳成完整畫面。載入失敗時只會顯示錯誤說明。
- 收藏紀錄（localStorage）使用的鍵名與項目 ID 完全沒變，使用者既有進度不受影響。
