# 心動小鎮五星圖鑑：網站原始碼說明

這份網站原本是「一個 955 KB 的 HTML」，現在拆成 HTML、樣式、程式、資料四個部分。
**畫面與功能與原本完全相同**，只是改成好閱讀、好維護的結構。

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
  bugs.json             蟲類
  birds.json            鳥類
  flowers.json          花朵
  dishes.json           料理
  shared.json           重複出現的長文字（活動檔期、匯入備註、五星來源）
  activity-schedules.json   活動檔期（開始／結束時間、代幣名稱）
  material-catalog.json     食材價格目錄、限時食材
  retired-ids.json          已下架項目的 ID（讓舊收藏紀錄仍能對得上）
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
