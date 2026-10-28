/* =====================================================================
 * data-loader.js ── 資料載入器
 *
 * 作用：把 data/ 資料夾裡的 JSON 檔讀進來，還原成 app.js 使用的資料格式。
 * 使用：const DATA = await AtlasData.load();
 *
 * 為了讓檔案變小，JSON 裡省略了「空值」與「重複的長文字」，
 * 這裡的 restoreItem() 會把它們補回去，所以 app.js 完全不用知道差別。
 * 省略規則請看 README.md 的「資料格式說明」。
 * ===================================================================== */
const AtlasData = (() => {
  'use strict';

  /* ---------- 設定 ---------- */

  const DATA_DIR = 'data/';
  // 圖鑑分類：同時也是 data/ 底下的檔名，順序即畫面上的預設順序
  const CATEGORY_NAMES = ['fish', 'bugs', 'birds', 'flowers', 'dishes'];
  // JSON 裡寫 "all" 時，代表「全時段」或「全天氣」
  const ALL_TIMES = ['0-6時', '6-12時', '12-18時', '18-24時'];
  const ALL_WEATHER = ['晴', '雨', '彩虹'];

  /* ---------- 讀檔 ---------- */

  async function fetchJson(fileName, version) {
    // 加上 ?v=版本號：資料更新後，瀏覽器就不會繼續用舊的快取
    const url = DATA_DIR + fileName + (version ? '?v=' + encodeURIComponent(version) : '');
    const response = await fetch(url, version ? undefined : { cache: 'no-cache' });
    if (!response.ok) throw new Error('讀取失敗：' + fileName + '（HTTP ' + response.status + '）');
    return response.json();
  }

  /* ---------- 還原單筆資料 ---------- */

  // 沒有寫的欄位，一律補成這些預設值（每次都產生新物件，避免互相影響）
  function emptyFields() {
    return {
      color: '', eventStatus: '', eventName: '', dataSource: '', importNote: '', plantType: '',
      times: [], weather: [], locations: [], ingredients: {},
    };
  }

  // "all" → 完整陣列；沒寫或已是陣列 → 原樣保留
  function expandAll(value, fullList) {
    return value === 'all' ? fullList.slice() : value;
  }

  // 料理成本精簡格式 { cost, prices:[1星..5星] } → 還原成 { cost, missing, stars:[{star,price,profit}], costNote }
  function restoreEconomics(economics) {
    if (economics.stars) return economics; // 已經是完整格式就直接使用
    const cost = economics.cost;
    return {
      cost,
      missing: economics.missing || [],
      stars: economics.prices.map((price, index) => ({
        star: index + 1,
        price,
        // 利潤 = 售價 − 成本；任一項未知就是 null
        profit: price == null || cost == null ? null : price - cost,
      })),
      costNote: economics.costNote || '',
    };
  }

  function restoreItem(entry, category, shared) {
    const item = { ...emptyFields(), ...entry, category };

    item.times = expandAll(item.times, ALL_TIMES);
    item.weather = expandAll(item.weather, ALL_WEATHER);

    // xxxRef：從 shared.json 取回重複使用的長文字
    if (entry.eventScheduleRef) item.eventSchedule = shared.eventSchedules[entry.eventScheduleRef];
    if (entry.importNoteRef) item.importNote = shared.importNotes[entry.importNoteRef];
    delete item.eventScheduleRef;
    delete item.importNoteRef;

    if (entry.fiveStar) {
      item.fiveStar = { ...entry.fiveStar };
      if (item.fiveStar.sourceRef) item.fiveStar.source = shared.fiveStarSources[item.fiveStar.sourceRef];
      delete item.fiveStar.sourceRef;
    }
    if (entry.economics) item.economics = restoreEconomics(entry.economics);
    if (!item.raw) item.raw = {};
    return item;
  }

  /* ---------- 對外功能 ---------- */

  // 讀取全部資料，回傳 app.js 需要的 DATA 物件
  async function load() {
    // 先讀 meta.json（永遠不快取），取得資料版本號，其餘檔案用版本號當快取key
    const meta = await fetchJson('meta.json');
    const version = meta.dataVersion;

    const [shared, activitySchedules, retiredItemIds, materialFile, ...categoryLists] = await Promise.all([
      fetchJson('shared.json', version),
      fetchJson('activity-schedules.json', version),
      fetchJson('retired-ids.json', version),
      fetchJson('material-catalog.json', version),
      ...CATEGORY_NAMES.map(name => fetchJson(name + '.json', version)),
    ]);

    const items = CATEGORY_NAMES.flatMap((category, index) =>
      categoryLists[index].map(entry => restoreItem(entry, category, shared)));

    return {
      ...meta,
      items,
      activitySchedules,
      retiredItemIds,
      materials: materialFile.materials,
      limitedMaterials: materialFile.limitedMaterials,
    };
  }

  // 載入失敗時，在頁面頂端顯示說明（而不是一片空白）
  function showLoadError(error) {
    console.error(error);
    const isLocalFile = location.protocol === 'file:';
    const box = document.createElement('div');
    box.className = 'load-error';
    box.setAttribute('role', 'alert');
    box.innerHTML = '<strong>圖鑑資料載入失敗</strong><p></p>';
    box.querySelector('p').textContent = isLocalFile
      ? '直接雙擊開啟 index.html 時，瀏覽器不允許讀取 data 資料夾。請改用本機伺服器預覽（例如 VS Code 的 Live Server，或在此資料夾執行 python -m http.server），或直接上傳到網站空間後再開啟。'
      : '請檢查網路連線後重新整理頁面。若持續發生，請回報給站長。（' + error.message + '）';
    document.body.prepend(box);
  }

  // 載入成功回傳資料；失敗則顯示說明並回傳 null
  async function loadOrShowError() {
    try {
      return await load();
    } catch (error) {
      showLoadError(error);
      return null;
    }
  }

  return { load, loadOrShowError, showLoadError };
})();
