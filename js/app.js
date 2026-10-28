/* =====================================================================
 * app.js ── 畫面與互動（渲染表格、按鈕事件、成本計算機、備份還原）
 *
 * 啟動流程：
 *   1. 呼叫 AtlasData.loadOrShowError() 讀取 data/ 資料夾（見 data-loader.js）
 *   2. 用 JournalCore（journal-core.js）做篩選、排序、活動判斷
 *   3. 把結果渲染成畫面，並綁定使用者操作
 *
 * 載入順序（index.html 底部）：journal-core.js → data-loader.js → app.js
 * ===================================================================== */
(async () => {
  'use strict';
  const DATA = await AtlasData.loadOrShowError();
  if (!DATA) return;
  document.body.classList.add('is-ready');
  // 活動暫時不顯示；完整資料用於保存與還原收藏紀錄。
  /* ----------------------------------------------------------------
   * 網站更新時間：頁尾顯示的「最後更新」
   * ---------------------------------------------------------------- */
  async function updateSiteTimestamp() {
    const label = document.getElementById('site-last-updated');
    const fallback = document.querySelector('meta[name="atlas-updated-at"]')?.content;
    const show = value => {
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return;
      label.dateTime = date.toISOString();
      label.textContent = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .format(date)
        .replaceAll('-', '/');
    };
    show(fallback);
    if (location.protocol === 'file:') {
      show(document.lastModified);
      return;
    }
    if (!['http:', 'https:'].includes(location.protocol)) return;
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(location.href.split('#')[0], {
        method: 'HEAD',
        cache: 'no-cache',
        signal: controller.signal,
      });
      const modified = response.headers.get('Last-Modified');
      if (response.ok && modified) show(modified);
    } catch {
      // Keep the saved update time when the host has no metadata or the request fails.
    } finally {
      clearTimeout(timeout);
    }
  }
  updateSiteTimestamp();
  /* ----------------------------------------------------------------
   * 資料整理：套用活動檔期、食材目錄、已下架項目
   * ---------------------------------------------------------------- */
  const ALL_ITEMS = DATA.items.map(i =>
    JournalCore.applyEventSchedule(i, Date.now(), DATA.activitySchedules),
  );
  const ITEMS = ALL_ITEMS;
  const RETIRED_ITEM_IDS = DATA.retiredItemIds || [];
  // 限時材料需要明確的來源標記；活動菜餚或活動關聯本身不代表食材限時。
  const LIMITED_MATERIALS = new Set(DATA.limitedMaterials || []);
  const MATERIALS = DATA.materials;
  const MATERIAL_BY_NAME = new Map();
  for (const m of MATERIALS) {
    MATERIAL_BY_NAME.set(m.name, m);
    for (const a of m.aliases || []) MATERIAL_BY_NAME.set(a, m);
  }
  /* ----------------------------------------------------------------
   * 成本計算機：選料理 → 算食材成本與利潤
   * ---------------------------------------------------------------- */
  const calcPriceOverrides = new Map(),
    calcQtyOverrides = new Map(),
    calcExtraRows = new Map(),
    calcDishOptions = new Map(),
    calcCustomDishes = new Map();
  function calcMoney(v) {
    return v === 'X' ? 'X' : Number.isFinite(v) ? Math.round(v).toLocaleString('zh-TW') + ' 金幣' : '待補';
  }
  function calcSale(st) {
    return st?.price == null || st.price === '' ? NaN : Number(st.price);
  }
  function calcPrice(name) {
    if (calcPriceOverrides.has(name)) return calcPriceOverrides.get(name);
    return MATERIAL_BY_NAME.get(name)?.cost ?? 0;
  }
  function calcQty(item, name, base) {
    const key = item.id + '|' + name,
      value = calcQtyOverrides.has(key) ? calcQtyOverrides.get(key) : Number(base) || 0;
    return Math.max(0, Math.min(4, Math.floor(Number(value) || 0)));
  }
  function calcIngredients(item) {
    const list = Object.entries(item?.ingredients || {}).map(([name, qty]) => ({
      name,
      qty: calcQty(item, name, qty),
      custom: false,
    }));
    for (const row of calcExtraRows.get(item.id) || [])
      list.push({ ...row, qty: calcQty(item, row.name, row.qty), custom: true });
    return list;
  }
  function calcStats(item) {
    let total = 0,
      missing = [];
    const rows = calcIngredients(item).map(row => {
      const price = calcPrice(row.name),
        valid = price !== '' && Number.isFinite(Number(price)),
        subtotal = valid ? row.qty * Number(price) : NaN;
      if (!valid) missing.push(row.name);
      else total += subtotal;
      return {
        ...row,
        price,
        subtotal,
        valid,
        limited: MATERIAL_BY_NAME.get(row.name)?.limited === true || LIMITED_MATERIALS.has(row.name),
      };
    });
    return { rows, total, missing: [...new Set(missing)], complete: missing.length === 0 };
  }
  function calcRenderMaterials(item, slot) {
    const host = $('calc-materials-' + slot);
    if (!item) {
      host.innerHTML = '';
      return;
    }
    const stats = calcStats(item);
    if (!stats.rows.length) {
      host.innerHTML =
        '<p class="calc-empty-materials">\u8acb\u8f38\u5165\u6750\u6599\u540d\u7a31\uff0c\u6309\u300c\u52a0\u5165\u300d\u65b0\u589e\u6750\u6599\u3002</p>';
      return;
    }
    host.innerHTML = `<div class="calc-table-scroll"><table class="calc-material-table"><thead><tr><th>原材料</th><th>每份用量</th><th>單價</th><th>材料小計</th></tr></thead><tbody>${stats.rows.map((r, n) => `<tr><td class="calc-row-name">${esc(r.name)}${r.limited ? '<small>限時材料</small>' : ''}</td><td><input type="number" min="0" max="4" step="1" data-calc-field="qty" data-calc-slot="${slot}" data-calc-dish="${esc(item.id)}" data-calc-name="${esc(r.name)}" value="${esc(r.qty)}" aria-label="${esc(r.name)}每份用量"></td><td><input type="number" min="0" step="1" data-calc-field="price" data-calc-name="${esc(r.name)}" value="${r.price ?? ''}" placeholder="待補" aria-label="${esc(r.name)}單價"></td><td><span data-calc-subtotal="${slot}-${n}">${r.valid ? calcMoney(r.subtotal) : '待補'}</span>${r.custom ? ` <button class="button calc-add-remove" type="button" data-calc-remove="${esc(r.name)}" data-calc-dish="${esc(item.id)}" aria-label="移除${esc(r.name)}">×</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function calcProfit(item, st, stats) {
    return item.custom || JournalCore.excludesProfit(item)
      ? 'X'
      : st && stats.complete
        ? calcSale(st) - stats.total
        : NaN;
  }
  function calcStarPrices(item) {
    return item?.economics?.stars || [];
  }
  function calcRenderCard(item, slot, index) {
    const letter = String.fromCharCode(65 + index),
      card = document.createElement('section');
    card.className = 'calc-card calc-card-dynamic';
    card.dataset.calcDishId = item.id;
    const emptyCustom = item.custom && !calcIngredients(item).length;
    const entry = emptyCustom
      ? `<div class="calc-empty-material-entry"><label>材料名稱<input type="text" class="calc-add-material" list="calc-material-list-${slot}" placeholder="輸入材料名稱"></label><datalist id="calc-material-list-${slot}">${MATERIALS.map(m => `<option value="${esc(m.name)}">`).join('')}</datalist><label>每份用量<input type="number" class="calc-new-material-qty" min="1" max="4" step="1" value="1" aria-label="每份用量"></label><label>單價<input type="number" class="calc-new-material-price" min="0" step="1" value="0" aria-label="材料單價"></label><button class="button calc-add-material-button" type="button" data-calc-add-material>加入材料</button></div>`
      : `<div class="calc-actions"><label>新增材料至料理 ${letter}<input type="text" class="calc-add-material" list="calc-material-list-${slot}" placeholder="輸入材料名稱"></label><datalist id="calc-material-list-${slot}">${MATERIALS.map(m => `<option value="${esc(m.name)}">`).join('')}</datalist><button class="button calc-add-material-button" type="button" data-calc-add-material>加入</button></div>`;
    card.innerHTML = `<header class="calc-card-heading"><span class="calc-recipe-badge ${index ? 'calc-recipe-badge-b' : ''}">${letter} · 料理</span><h2>${esc(item.name)}</h2></header><div id="calc-materials-${slot}"></div>${entry}<div id="calc-summary-${slot}"></div><div id="calc-stars-${slot}"></div>`;
    const grid = $('calc-recipe-grid');
    grid.appendChild(card);
    calcRenderMaterials(item, slot);
    const stats = calcStats(item);
    $(`calc-summary-${slot}`).innerHTML =
      `<div class="calc-recipe-summary"><div><span>每份材料成本</span><br><strong>${stats.complete ? calcMoney(stats.total) : '待補'}</strong></div></div>`;
    $(`calc-stars-${slot}`).innerHTML =
      `<div class="calc-table-scroll"><table class="calc-star-table"><thead><tr><th>星級</th><th>料理售價</th><th>每份利潤</th></tr></thead><tbody>${calcStarPrices(
        item,
      )
        .map(st => {
          const profit = calcProfit(item, st, stats);
          return `<tr><th>${st.star} 星</th><td>${calcMoney(calcSale(st))}</td><td class="${profit === 'X' ? '' : profit >= 0 ? 'calc-positive' : 'calc-negative'}">${calcMoney(profit)}</td></tr>`;
        })
        .join('')}</tbody></table></div>`;
  }
  function calcUpdate() {
    const selected = [...document.querySelectorAll('.calc-dish-select')]
        .map(s => ITEMS.find(x => x.id === s.dataset.dishId) || calcCustomDishes.get(s.dataset.dishId))
        .filter(Boolean),
      grid = $('calc-recipe-grid');
    grid.innerHTML = '';
    grid.classList.toggle('compare-active', selected.length > 1);
    selected.forEach((item, i) => calcRenderCard(item, 'slot' + i, i));
    $('calc-add-dish').disabled = calcDishOptions.size >= 6;
    $('calc-add-dish').textContent = calcDishOptions.size >= 6 ? '已達 6 道上限' : '＋ 新增料理';
    $('calc-compare-section').hidden = selected.length < 2;
    if (selected.length > 1) {
      const prices = selected.map(item => ({ item, stats: calcStats(item) }));
      $('calc-comparison').innerHTML =
        `<div class="calc-table-scroll"><table class="calc-comparison-table"><thead><tr><th>料理</th><th>每份成本</th>${[1, 2, 3, 4, 5].map(star => `<th>${star}星利潤</th>`).join('')}</tr></thead><tbody>${prices
          .map(
            ({ item, stats }) =>
              `<tr><th>${esc(item.name)}</th><td>${stats.complete ? calcMoney(stats.total) : '待補'}</td>${[
                1, 2, 3, 4, 5,
              ]
                .map(star => {
                  const st = calcStarPrices(item).find(x => x.star === star),
                    profit = calcProfit(item, st, stats);
                  return `<td class="${profit === 'X' ? '' : profit >= 0 ? 'calc-positive' : 'calc-negative'}">${calcMoney(profit)}</td>`;
                })
                .join('')}</tr>`,
          )
          .join(
            '',
          )}</tbody></table></div><p class="calc-note">比較每道料理的每份成本與各星級利潤。售價明細請見上方料理卡片。</p>`;
    }
    const missing = [...new Set(selected.flatMap(item => calcStats(item).missing))];
    $('calc-missing').textContent = missing.length
      ? '這些材料尚無維護表單價，請輸入單價後查看利潤：' + missing.join('、')
      : '利潤＝對應星級售價－每份材料成本。修改一種材料單價時，所有料理會同步更新。';
  }
  function calcShowDishOptions(input, query = input.value) {
    document.querySelectorAll('.calc-dish-results').forEach(x => (x.hidden = true));
    const list = input.closest('.calc-dish-picker').querySelector('.calc-dish-results'),
      q = query.trim().toLocaleLowerCase();
    const matches = ITEMS.filter(
      x => x.category === 'dishes' && (!q || x.name.toLocaleLowerCase().includes(q)),
    ).sort((a, b) => JournalCore.compareItems(a, b, { sort: 'number' }));
    list.innerHTML =
      `<button type="button" class="calc-dish-option calc-custom-option" data-custom-dish="1">＋ ${q ? '使用「' + esc(query.trim()) + '」建立料理' : '自訂料理'}</button>` +
      (matches
        .map(
          x =>
            `<button type="button" class="calc-dish-option" role="option" data-dish-id="${esc(x.id)}">${esc(x.name)}</button>`,
        )
        .join('') || '<div class="calc-dish-empty">找不到相關料理</div>');
    list.hidden = false;
  }
  function calcAddDish() {
    if (calcDishOptions.size >= 6) return;
    const key = 'calc-slot-' + calcDishOptions.size,
      index = calcDishOptions.size,
      input = document.createElement('input');
    input.type = 'search';
    input.className = 'calc-dish-select';
    input.autocomplete = 'off';
    input.placeholder = '搜尋料理或自訂料理';
    input.dataset.slot = key;
    input.setAttribute('aria-label', '料理 ' + String.fromCharCode(65 + index));
    const picker = document.createElement('div');
    picker.className = 'calc-dish-picker';
    const label = document.createElement('label'),
      caption = document.createElement('span');
    caption.textContent = '料理 ' + String.fromCharCode(65 + index);
    label.append(caption, input);
    const results = document.createElement('div');
    results.className = 'calc-dish-results';
    results.setAttribute('role', 'listbox');
    results.hidden = true;
    picker.append(label, results);
    picker.style.gridColumn = index === 0 ? '1' : '1 / -1';
    picker.style.gridRow = index === 0 ? '1' : 'auto';
    $('calc-dish-slots').insertBefore(picker, $('calc-add-dish'));
    calcDishOptions.set(key, input);
    calcUpdate();
  }

  function calcSyncMaterialPrice(field) {
    const priceField = field.closest('.calc-card')?.querySelector('.calc-new-material-price');
    if (!priceField) return;
    const name = field.value.trim();
    if (priceField.dataset.materialName === name) return;
    priceField.value = String(calcPrice(name));
    priceField.dataset.materialName = name;
  }
  function calcInit() {
    for (const event of ['input', 'change'])
      $('calculator-view').addEventListener(event, e => {
        if (e.target.matches('.calc-add-material')) calcSyncMaterialPrice(e.target);
      });
    calcAddDish();
    $('calc-add-dish').addEventListener('click', calcAddDish);
    $('calc-dish-slots').addEventListener('focusin', e => {
      if (e.target.matches('.calc-dish-select')) {
        e.target.select();
        calcShowDishOptions(e.target, '');
      }
    });
    $('calc-dish-slots').addEventListener('input', e => {
      if (!e.target.matches('.calc-dish-select')) return;
      e.target.dataset.dishId = '';
      calcShowDishOptions(e.target);
      calcUpdate();
    });
    $('calc-dish-slots').addEventListener('click', e => {
      const option = e.target.closest('.calc-dish-option');
      if (!option) return;
      const input = option.closest('.calc-dish-picker').querySelector('.calc-dish-select');
      let item;
      if (option.dataset.customDish) {
        const id = 'custom-' + input.dataset.slot,
          name = input.value.trim() || '自訂料理';
        item = { id, name, category: 'dishes', ingredients: {}, economics: { stars: [] }, custom: true };
        calcCustomDishes.set(id, item);
      } else item = ITEMS.find(x => x.id === option.dataset.dishId);
      if (!item) return;
      input.value = item.name;
      input.dataset.dishId = item.id;
      option.closest('.calc-dish-results').hidden = true;
      calcUpdate();
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('.calc-dish-picker'))
        document.querySelectorAll('.calc-dish-results').forEach(x => (x.hidden = true));
    });
    $('calculator-view').addEventListener('change', e => {
      const field = e.target.dataset.calcField;
      if (field === 'price')
        calcPriceOverrides.set(e.target.dataset.calcName, e.target.value === '' ? 0 : Number(e.target.value));
      if (field === 'qty') {
        const item =
          ITEMS.find(x => x.id === e.target.dataset.calcDish) ||
          calcCustomDishes.get(e.target.dataset.calcDish);
        if (item)
          calcQtyOverrides.set(
            item.id + '|' + e.target.dataset.calcName,
            Math.max(0, Math.min(4, Math.floor(Number(e.target.value) || 0))),
          );
      }
      if (field) {
        calcUpdate();
        return;
      }
    });
    $('calculator-view').addEventListener('click', e => {
      if (e.target.closest('#calc-add-dish')) return;
      const add = e.target.closest('[data-calc-add-material]');
      if (add) {
        const card = add.closest('.calc-card'),
          item =
            ITEMS.find(x => x.id === card.dataset.calcDishId) ||
            calcCustomDishes.get(card.dataset.calcDishId),
          field = card.querySelector('.calc-add-material'),
          name = field.value.trim();
        if (item && name) {
          calcSyncMaterialPrice(field);
          const qtyField = card.querySelector('.calc-new-material-qty'),
            priceField = card.querySelector('.calc-new-material-price'),
            qty = qtyField ? Math.max(1, Math.min(4, Math.floor(Number(qtyField.value) || 1))) : 1;
          if (priceField) calcPriceOverrides.set(name, Math.max(0, Number(priceField.value) || 0));
          if (!calcExtraRows.has(item.id)) calcExtraRows.set(item.id, []);
          calcExtraRows.get(item.id).push({ name, qty });
          calcQtyOverrides.set(item.id + '|' + name, qty);
          calcUpdate();
        }
        return;
      }
      const name = e.target.dataset.calcRemove;
      if (!name) return;
      const item =
        ITEMS.find(x => x.id === e.target.dataset.calcDish) ||
        calcCustomDishes.get(e.target.dataset.calcDish);
      if (item)
        calcExtraRows.set(
          item.id,
          (calcExtraRows.get(item.id) || []).filter(row => row.name !== name),
        );
      calcUpdate();
    });
  }
  function showCalculator() {
    homeVisible = false;
    $('home-view').hidden = true;
    document.querySelector('.hero').hidden = true;
    document.querySelector('.collection').hidden = true;
    $('release-log').hidden = true;
    $('calculator-view').hidden = false;
    $('nav-home').classList.remove('active');
    $('nav-home').removeAttribute('aria-current');
    for (const c of JournalCore.categories) {
      const b = $('nav-' + c);
      b.classList.remove('active');
      b.removeAttribute('aria-current');
    }
    const b = $('nav-calculator');
    b.classList.add('active');
    b.setAttribute('aria-current', 'page');
    rememberPage();
  }
  /* ----------------------------------------------------------------
   * 共用工具與畫面狀態：存檔鍵名、圖示、目前頁面、收藏紀錄
   * ---------------------------------------------------------------- */
  const KEY = 'heartopia-five-star-atlas.v1';
  const $ = id => document.getElementById(id);
  const esc = v =>
    String(v ?? '').replace(
      /[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const paths = {
    fish: '<path d="M4 12C8 4 15 4 19 12C15 20 8 20 4 12Z"/><path d="m4 12-3-5v10l3-5ZM10 6l3-3 2 3M10 18l3 3 2-3"/><circle cx="15" cy="10.5" r=".7"/>',
    bugs: '<path d="M12 9C4-1 0 7 5 12C0 17 6 24 12 15C18 24 24 17 19 12C24 7 20-1 12 9Z"/><path d="M12 8v10m0-10-2-4m2 4 2-4"/>',
    birds:
      '<path d="M4 17C9 20 19 19 19 10c0-5-6-6-7-1L4 8l4 6-5 4m16-9 3 1-3 1M10 18v3m4-3v3M9 12l5 2 2-3"/><circle cx="16" cy="8" r=".5"/>',
    flowers:
      '<path d="M12 9C4-2 0 10 8 12C-2 19 11 24 12 16C15 25 25 16 17 12C26 7 14-2 12 9Z"/><circle cx="12" cy="12" r="3"/>',
    dishes:
      '<path d="M4 12h16c0 5-3 8-8 8s-8-3-8-8ZM2 12h20M8 8c-3-3 3-3 0-6m5 6c-3-3 3-3 0-6m5 6c-3-3 3-3 0-6M8 22h8"/>',
  };
  const icon = c =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[c]}</svg>`;
  const meta = {
    fish: { name: '魚類', desc: '河流、湖泊與海洋裡，等待上鉤的五星。' },
    bugs: { name: '蟲類', desc: '走進花田與森林，尋找小小的五星蹤跡。' },
    birds: { name: '鳥類', desc: '抬頭看一看，記錄最美的五星身影。' },
    flowers: { name: '園藝', desc: '紀錄作物與花卉，每種花的所有已知花色分別勾選。' },
    dishes: { name: '料理', desc: '把喜歡的食譜，做成一道道五星料理。' },
  };
  let state = JournalCore.sanitizeState({}, ALL_ITEMS, RETIRED_ITEM_IDS),
    storageAvailable = true,
    startupWarning = '',
    pendingImport = null;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) state = JournalCore.sanitizeState(JSON.parse(saved), ALL_ITEMS, RETIRED_ITEM_IDS);
  } catch (e) {
    storageAvailable = false;
    startupWarning = '無法讀取本機進度。請匯入備份，並確認瀏覽器允許儲存。';
  }
  // 收錄類型沿用本機保存的篩選設定。
  let homeVisible = true,
    restoreCalculator = false;
  // 僅重新整理時還原同一分頁的位置；新進網站仍顯示首頁。
  try {
    const page = JSON.parse(sessionStorage.getItem(KEY + '.page') || 'null');
    if (performance.getEntriesByType('navigation')[0]?.type === 'reload' && page) {
      homeVisible = page.view !== 'collection';
      restoreCalculator = page.view === 'calculator';
      if (JournalCore.categories.includes(page.active)) state.active = page.active;
    }
  } catch {}
  function rememberPage() {
    try {
      const calculatorOpen = !$('calculator-view').hidden;
      sessionStorage.setItem(
        KEY + '.page',
        JSON.stringify({
          view: calculatorOpen ? 'calculator' : homeVisible ? 'home' : 'collection',
          active: state.active,
        }),
      );
    } catch {}
  }
  window.addEventListener('pagehide', rememberPage);
  const openFlowers = new Set();
  let toastTimer;
  /* ----------------------------------------------------------------
   * 提示訊息、自動存檔、切換頁面
   * ---------------------------------------------------------------- */
  function toast(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($('toast').hidden = true), 4800);
  }
  function save() {
    updateBackupStatus();
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      storageAvailable = true;
      $('save-state').textContent = '✓ 已儲存在本機';
    } catch (e) {
      storageAvailable = false;
      $('save-state').textContent = '⚠ 未儲存，請匯出備份';
      toast('瀏覽器無法保存進度；請按「匯出備份」保留這次勾選。');
    }
  }
  function showView(home, remember = true) {
    homeVisible = home;
    $('calculator-view').hidden = true;
    $('nav-calculator').classList.remove('active');
    $('nav-calculator').removeAttribute('aria-current');
    $('home-view').hidden = !home;
    document.querySelector('.hero').hidden = home;
    document.querySelector('.collection').hidden = home;
    $('release-log').hidden = !home;
    $('nav-home').classList.toggle('active', home);
    if (home) $('nav-home').setAttribute('aria-current', 'page');
    else $('nav-home').removeAttribute('aria-current');
    for (const c of JournalCore.categories) {
      const b = $('nav-' + c),
        active = !home && state.active === c;
      b.classList.toggle('active', active);
      if (active) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    if (remember) rememberPage();
  }
  /* ----------------------------------------------------------------
   * 首頁與整體進度
   * ---------------------------------------------------------------- */
  function renderHome(trackable, isComplete, total, done, pct) {
    $('home-percent').textContent = Number((total ? (done / total) * 100 : 0).toFixed(1)) + '%';
    $('home-count').textContent = done + ' / ' + total + ' 項五星達成';
    $('home-bar').style.width = pct + '%';
    $('home-continue').textContent =
      '繼續收集 · ' +
      { fish: '釣魚', bugs: '捕蟲', birds: '觀鳥', flowers: '園藝', dishes: '烹飪' }[state.active];
    $('home-cards').innerHTML = JournalCore.categories
      .map(c => {
        const all = trackable.filter(i => i.category === c),
          n = all.filter(isComplete).length,
          p = all.length ? Math.round((n / all.length) * 100) : 0;
        return (
          '<button class="home-card" data-home-category="' +
          c +
          '"><span class="home-card-title">' +
          icon(c) +
          { fish: '釣魚', bugs: '捕蟲', birds: '觀鳥', flowers: '園藝', dishes: '烹飪' }[c] +
          '</span><strong>' +
          n +
          '</strong><small> / ' +
          all.length +
          ' · ' +
          p +
          '%</small><div class="bar"><i style="width:' +
          p +
          '%"></i></div></button>'
        );
      })
      .join('');
    if (!$('calculator-view').hidden) showCalculator();
    else showView(homeVisible, false);
  }
  function updateProgress() {
    const trackable = [
        ...ITEMS.filter(i => i.category !== 'flowers' && i.trackable),
        ...JournalCore.flowerGroups(ITEMS, state.done).filter(i => i.trackable),
      ],
      isComplete = i => (i.category === 'flowers' ? i.complete : !!state.done[i.id]),
      total = trackable.length,
      done = trackable.filter(isComplete).length,
      pct = Math.round((done / total) * 100);
    $('total-done').textContent = done;
    $('total-count').textContent = `/ ${total}`;
    $('total-percent').textContent = pct + '%';
    $('total-ring').style.setProperty('--progress', pct + '%');
    for (const c of JournalCore.categories) {
      const all = trackable.filter(i => i.category === c),
        n = all.filter(isComplete).length;
      const b = $('nav-' + c);
      b.classList.toggle('active', state.active === c);
      if (state.active === c) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
      b.querySelector('.nav-count').textContent = `${n} / ${all.length}`;
      if (c === state.active) {
        $('category-count').textContent =
          `${n} / ${all.length} ${c === 'flowers' ? '種已完成' : '已完成'} · ${Math.round((n / all.length) * 100)}%`;
        $('category-bar').style.width = `${(n / all.length) * 100}%`;
      }
    }
    renderHome(trackable, isComplete, total, done, pct);
  }
  /* ----------------------------------------------------------------
   * 各分類頁面的標題與篩選器設定
   * ---------------------------------------------------------------- */
  function configureCategory() {
    const c = state.active,
      f = state.filters[c],
      group = ITEMS.filter(i => i.category === c);
    $('category-title').textContent =
      { fish: '釣魚', bugs: '捕蟲', birds: '觀鳥', flowers: '園藝', dishes: '烹飪' }[c] + '圖鑑';
    $('category-icon').innerHTML = icon(c);
    const places = JournalCore.locationChoices(group);
    $('location').innerHTML =
      '<option value="all">所有地點</option>' +
      places.groups
        .map(
          x =>
            `<option value="${esc('group:' + x)}">${esc(c === 'bugs' && x === '事件' ? '引蟲出洞（事件）' : x)}</option>`,
        )
        .join('') +
      places.exact.map(x => `<option value="${esc('exact:' + x)}">${esc(x)}</option>`).join('');
    $('time-label').textContent = '時段';
    for (const key of ['search', 'level', 'weather', 'time', 'location', 'profitStar', 'plantType'])
      $(key).value = f[key];
    document
      .querySelectorAll('[data-kind-option]')
      .forEach(box => (box.checked = f.kind.includes(box.value)));
    updateKindDropdown();
    $('plant-type-label').hidden = c !== 'flowers';
    $('profit-star-label').hidden = c !== 'dishes';
    $('dish-number-sort').hidden = c !== 'dishes';
    document.querySelector('.list').classList.toggle('dish-list', c === 'dishes');
    document.querySelector('.list').classList.toggle('flower-list', c === 'flowers');
    $('cookable-only').checked = f.cookableOnly;
    $('bird-five-star').hidden = c !== 'birds';
    $('bird-five-star-note').hidden = c !== 'birds';
    $('five-star-only').checked = f.fiveStarOnly;
    const habitat = ['fish', 'bugs', 'birds'].includes(c);
    document.querySelectorAll('[data-habitat]').forEach(el => (el.hidden = !habitat));
    renderRows();
  }
  /* ----------------------------------------------------------------
   * 資料欄位的文字組合：地點、活動、代幣、售價等
   * ---------------------------------------------------------------- */
  function line(text) {
    return `<div class="info-text">${esc(text)}</div>`;
  }
  function eventStage(item) {
    return (
      item.eventStage ||
      String(item.importNote || item.raw?.['特殊事件'] || '').match(/(第一|第二|第三|額外)階段/)?.[0] ||
      ''
    );
  }
  function birdLocationSummary(item) {
    const locations = [...(item.locations || [])];
    for (const raw of item.fiveStar?.locations || []) {
      for (let place of String(raw)
        .split(/[／/]/)
        .map(value => value.trim())
        .filter(Boolean)) {
        if (!place.includes('事件')) continue;
        const phase = place.match(/[－-](第一|第二|第三|額外)階段$/)?.[1];
        place = place.replace(/[－-](?:第一|第二|第三|額外)階段$/, '');
        const stage = phase ? phase + '階段' : item.fiveStar?.eventStage || '';
        const roots = new Set(JournalCore.locationRegions(place, 'birds'));
        const existing = locations.findIndex(
          value =>
            value.includes('事件') &&
            JournalCore.locationRegions(value, 'birds').some(root => roots.has(root)),
        );
        const formatted = stage ? place + ' - ' + stage : place;
        if (existing >= 0) {
          if (stage && !roots.has('百鳥歸巢（事件）')) locations[existing] = formatted;
        } else locations.push(formatted);
      }
    }
    return [...new Set(locations)].join(' / ') || '來源未提供';
  }
  function locationSummary(item) {
    if (item.category === 'birds') return birdLocationSummary(item);
    const stage = ['fish', 'bugs'].includes(item.category) ? eventStage(item) : '';
    return (
      (item.locations || [])
        .map(value => (stage && value.includes('事件') ? value + ' - ' + stage : value))
        .join(' / ') || '來源未提供'
    );
  }
  function locationDetails(item) {
    const locations = locationSummary(item)
      .split(/[／/]/)
      .map(value => value.trim())
      .filter(Boolean);
    return '<h4>出沒地點</h4><div class="info-text">' + locations.map(esc).join('<br>') + '</div>';
  }
  function bugLocationLines(item) {
    const places = locationSummary(item)
      .split(/[／/]/)
      .map(value => value.trim())
      .filter(Boolean);
    return places.map((place, index) => line(place + (index < places.length - 1 ? ' /' : ''))).join('');
  }
  function activityToken(i, star) {
    const schedule = DATA.activitySchedules?.[i.eventName] || i.eventSchedule || {};
    const configured = String(schedule.tokenName || '').trim();
    const label = configured && configured !== '待補' ? configured : '活動代幣';
    const raw = i.raw || {},
      key = star + '星活動代幣';
    const value = Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : raw[star + '星慶典幣'];
    const known =
      value !== null && value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value));
    const hasAny = [1, 2, 3, 4, 5].some(s =>
      [raw[s + '星活動代幣'], raw[s + '星慶典幣']].some(v => v !== undefined && v !== null && v !== ''),
    );
    return {
      label,
      amount: known ? Number(value) : null,
      applicable: Boolean(i.eventName || configured || hasAny),
    };
  }
  function dishCurrencySummary(i, star) {
    const sale = i.economics?.stars?.find(s => s.star === star)?.price;
    return (
      '<span class="dish-currency-compact">' + esc(Number.isFinite(sale) ? String(sale) : '待補') + '</span>'
    );
  }
  function eventDetails(i) {
    const stars = [1, 2, 3, 4, 5],
      tokens = stars.map(s => activityToken(i, s));
    const raw = i.raw || {},
      hasCoins = stars.some(s =>
        [raw[s + '星活動代幣'], raw[s + '星慶典幣']].some(v => v !== undefined && v !== null && v !== ''),
      );
    return hasCoins
      ? '<h4>' +
          esc(tokens[0].label) +
          '</h4><dl class="raw-grid fish-prices">' +
          tokens
            .map(
              (t, n) =>
                '<div class="raw-pair"><dt>' +
                esc(n + 1 + '星' + t.label) +
                '</dt><dd>' +
                esc(t.amount === null ? '待補' : money(t.amount)) +
                '</dd></div>',
            )
            .join('') +
          '</dl>'
      : '';
  }
  function dropDetails(i) {
    if (!i.drops) return '';
    return (
      '<h4>掉落物</h4><dl class="raw-grid fish-prices"><div class="raw-pair"><dt>掉落</dt><dd>' +
      esc([].concat(i.drops).join('、')) +
      '</dd></div></dl>'
    );
  }
  /* ----------------------------------------------------------------
   * 花朵與作物表格（含展開的詳細資料）
   * ---------------------------------------------------------------- */
  function gardenPriceRow(raw, keys = ['1星', '2星', '3星', '4星', '5星']) {
    return `<dl class="raw-grid fish-prices">${keys
      .map(key => {
        const value = raw[key];
        return `<div class="raw-pair"><dt>${esc(key === '種子價格' ? key : key + '售價')}</dt><dd>${esc(value === '' || value === 'N/A' ? 'N/A' : (value ?? '待確認'))}</dd></div>`;
      })
      .join('')}</dl>`;
  }
  function renderCrop(g) {
    const open = openFlowers.has(g.id),
      panel = 'flower-' + g.id;
    return `<tr class="item ${g.complete ? 'complete' : ''}" data-item="${g.id}"><td><label class="check-label"><input type="checkbox" data-check="${g.id}" aria-label="${esc(g.name)} 已取得五星" ${g.complete ? 'checked' : ''}><span aria-hidden="true">✓</span></label></td><td><button class="flower-toggle item-name" data-flower="${g.id}" aria-expanded="${open}" aria-controls="${panel}">${esc(g.name)}</button><div class="item-meta"><span class="badge">作物</span> <span class="badge ${JournalCore.kindClass(g)}">${esc(JournalCore.kindLabel(g))}</span></div></td><td><span class="level-badge">${g.level === null ? '未知' : 'Lv. ' + g.level}</span></td><td>${line(g.complete ? '五星已完成' : '五星未完成')}</td><td>${line(g.raw['生長週期'] || '未知')}</td><td><button class="row-detail" data-flower="${g.id}" aria-expanded="${open}" aria-controls="${panel}" aria-label="${open ? '收起' : '展開'}${esc(g.name)}價格">${open ? '收起 −' : '展開 ＋'}</button></td></tr><tr class="detail-row" id="${panel}" ${open ? '' : 'hidden'}><td colspan="6"><h4>成本</h4>${gardenPriceRow(g.raw, ['種子價格'])}<h4>星級售價</h4>${gardenPriceRow(g.raw)}${eventDetails(g)}</td></tr>`;
  }
  function sortHeader(label, key, prefix = '') {
    const value = state.filters[state.active].sort,
      active = value === key || value === key + '-asc' || value === key + '-desc',
      desc = active && value.endsWith('-desc');
    const next = active && !desc ? '降冪' : '升冪';
    return `<th aria-sort="${active ? (desc ? 'descending' : 'ascending') : 'none'}">${esc(prefix)}<button type="button" class="column-sort" data-sort="${key}" aria-label="${esc(label)}：點選以${next}排序">${esc(label)}<span aria-hidden="true">${active ? (desc ? '↓' : '↑') : '↕'}</span></button></th>`;
  }
  function renderFlowers() {
    const visible = JournalCore.visibleFlowers(
      ITEMS.filter(i => i.category === 'flowers'),
      state.filters.flowers,
      state.done,
    );
    $('result-count').textContent = `顯示 ${visible.length} 種`;
    $('result-note').textContent =
      `${visible.filter(g => g.complete).length} 種已完成 · 花卉收齊全部花色，作物取得五星`;
    $('thead').innerHTML =
      `<tr><th>完成</th>${sortHeader('花卉／作物名稱', 'name')}${sortHeader('等級', 'level')}<th>收集進度</th>${sortHeader('生長週期', 'growth')}<th>詳情</th></tr>`;
    $('rows').innerHTML = visible
      .map(g => {
        if (g.plantType === 'crop') return renderCrop(g);
        const open = openFlowers.has(g.id),
          panel = 'flower-' + g.id;
        return `<tr class="item ${g.complete ? 'complete' : ''}" data-item="${g.id}"><td><label class="check-label" title="勾選或取消${esc(g.name)}的全部花色"><input type="checkbox" data-complete-flower="${g.id}" aria-label="${esc(g.name)}全部花色" ${g.complete ? 'checked' : ''} ${g.trackable ? '' : 'disabled'}><span aria-hidden="true">✓</span></label></td><td><button class="flower-toggle item-name" data-flower="${g.id}" aria-expanded="${open}" aria-controls="${panel}">${esc(g.name)}</button><div class="item-meta"><span class="badge">花卉</span> <span class="badge ${JournalCore.kindClass(g)}">${esc(JournalCore.kindLabel(g))}</span></div></td><td><span class="level-badge">${g.level === null ? '未知' : 'Lv. ' + g.level}</span></td><td>${line(g.trackable ? `${g.collected} / ${g.colors.length} 花色${g.complete ? ' · 已完成' : ''}` : '花色待確認')}</td><td>${line(g.raw['生長週期'] || '未知')}</td><td><button class="row-detail" data-flower="${g.id}" aria-expanded="${open}" aria-controls="${panel}" aria-label="${open ? '收起' : '展開'}${esc(g.name)}花色">${open ? '收起 −' : '展開 ＋'}</button></td></tr>
      <tr class="detail-row" id="${panel}" ${open ? '' : 'hidden'}><td colspan="6"><strong>${esc(g.name)} · 花色收集</strong><div class="flower-colors">${g.colors.map(i => `<div class="flower-color ${state.done[i.id] ? 'collected' : ''}"><label><input type="checkbox" data-check="${i.id}" aria-label="${esc(i.name + '・' + i.color)} 已收集此花色" ${state.done[i.id] ? 'checked' : ''} ${i.trackable ? '' : 'disabled'}><span><b>${esc(i.color)}</b><small>${i.stars?.length ? i.stars.map(s => s + ' 星').join(' / ') : '星數待確認'}</small></span></label><div class="info-text">${(i.stars || []).map(s => `${s} 星售價：${esc(i.raw[s + '星'] === 'N/A' ? '未知' : (i.raw[s + '星'] ?? '未知'))}`).join('<br>')}</div></div>`).join('')}</div>${g.trackable ? '' : '<span class="info-text">來源尚未提供花色，暫不列入完成統計。</span>'}<h4>星級售價</h4>${gardenPriceRow(g.raw)}${eventDetails(g)}</td></tr>`;
      })
      .join('');
    $('empty').hidden = visible.length > 0;
    $('thead').hidden = visible.length === 0;
    updateProgress();
  }
  /* ----------------------------------------------------------------
   * 鳥類與料理的詳細資訊、成本利潤顯示
   * ---------------------------------------------------------------- */
  function birdWhistleNote(i) {
    const note = i.fiveStar?.note?.trim() || '';
    return /\d{1,2}(?:[:：]\d{2})?\s*(?:點|時)?\s*(?:～|~|－|-|–|—|至|到)\s*\d{1,2}(?:[:：]\d{2})?\s*(?:點|時)?/.test(
      note,
    )
      ? note
      : '';
  }
  function birdDetails(i, compact = false) {
    const s = i.fiveStar;
    let text = compact ? '' : '<div class="bird-five-info"><strong>五星條件（舒展時間）</strong>';
    if (!compact) {
      const events = i.locations.filter(x => /^事件-(冬令採錄|特殊積木鳥|紳士鴿)$/.test(x));
      if (events.length) text += line('過往事件：' + events.map(x => x.slice(3)).join('／'));
    }
    if (s?.weather) {
      text += line('五星天氣：' + s.weatherLabel);
      text += line('五星時段：' + (s.times.length === 4 ? '全天（00:00～24:00）' : s.timeLabel));
      if (!compact && birdWhistleNote(i)) text += line('鳥哨：' + birdWhistleNote(i));
      if (!compact && s.name !== i.name) text += line('圖表名稱：' + s.name);
    } else text += line('本次 77 種總表未收錄五星條件。');
    return text + (compact ? '' : '</div>');
  }
  const money = v =>
    Number.isFinite(v) ? v.toLocaleString('zh-TW', { maximumFractionDigits: 2 }) : '待確認';
  function dishEconomics(i) {
    const e = i.economics;
    if (!e) return line('成本待確認');
    return `<div class="dish-price-wrap"><table class="dish-price-table" aria-label="${esc(i.name)}各星級成本、售價與利潤"><thead><tr><th scope="col">星級</th><th scope="col">成本</th><th scope="col">售價</th><th scope="col">利潤</th></tr></thead><tbody>${e.stars.map(s => `<tr><th scope="row">${s.star} 星</th><td>${money(e.cost)}</td><td>${money(s.price)}</td><td class="${JournalCore.excludesProfit(i) ? '' : Number.isFinite(s.profit) && s.profit < 0 ? 'loss' : 'gain'}">${JournalCore.excludesProfit(i) ? 'X' : (Number.isFinite(s.profit) && s.profit > 0 ? '+' : '') + money(s.profit)}</td></tr>`).join('')}</tbody></table></div>${e.costNote ? `<p class="dish-cost-note">${esc(e.costNote)}</p>` : ''}${e.missing.length ? `<p class="dish-cost-note">缺少單價：${esc(e.missing.join('、'))}</p>` : ''}`;
  }
  /* ----------------------------------------------------------------
   * 主要列表：魚、蟲、鳥、料理的表格渲染
   * ---------------------------------------------------------------- */
  function renderRows() {
    $('dish-number-sort').setAttribute(
      'aria-pressed',
      String(state.active === 'dishes' && state.filters.dishes.sort === 'number'),
    );
    renderFilterSummary();
    document.querySelectorAll('[data-status]').forEach(b => {
      const active = b.dataset.status === state.filters[state.active].status;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    if (state.active === 'flowers') {
      renderFlowers();
      return;
    }
    const c = state.active,
      f = state.filters[c],
      group = ITEMS.filter(i => i.category === c),
      visible = JournalCore.filterItems(group, f, state.done, LIMITED_MATERIALS);
    const habitat = ['fish', 'bugs', 'birds'].includes(c),
      pending = visible.filter(i => !i.trackable).length;
    document.querySelectorAll('[data-status]').forEach(b => {
      b.classList.toggle('active', b.dataset.status === f.status);
      b.setAttribute('aria-pressed', String(b.dataset.status === f.status));
    });
    $('result-count').textContent = `顯示 ${visible.length} 項`;
    $('result-note').textContent =
      `${visible.filter(i => state.done[i.id]).length} 項已完成${pending ? ' · ' + pending + ' 項資料待確認' : ''}`;
    $('thead').innerHTML =
      `<tr><th>${c === 'flowers' ? '收集' : '五星'}</th>${sortHeader(meta[c].name + '名稱', 'name')}${sortHeader('等級', 'level')}${habitat ? sortHeader('出沒地點', 'location') : `<th>${c === 'flowers' ? '花色・生長' : '所需食材'}</th>`}${c === 'dishes' ? sortHeader(`${Number(f.profitStar || 1)} 星利潤`, 'profit') + sortHeader('金額', 'price') : `<th>${habitat ? '時段・天氣' : '花色資料'}</th>`}<th>詳情</th></tr>`;
    $('rows').innerHTML = visible
      .map(i => {
        let info = '',
          extra = '';
        if (habitat) {
          info = c === 'bugs' ? bugLocationLines(i) : line(locationSummary(i));
          if (c === 'fish') {
            info += `<span class="number">魚影：${esc(i.raw['魚影大小'] || '未知')}</span>`;
          }
          if (c === 'birds')
            info += `<span class="number">完美距離：${esc(i.raw['完美距離'] || '未知')}</span>`;
          extra =
            line(i.times.length === 4 ? '全天' : i.times.join(' / ') || '時段未知') +
            `<div class="weather-symbols">${i.weather.map(w => `<span class="${w === '彩虹' ? 'rainbow' : ''}">${{ 晴: '☀ 晴', 雨: '☂ 雨', 彩虹: '🌈 彩虹日' }[w]}</span>`).join('') || '天氣未知'}</div>`;
        } else if (c === 'flowers') {
          info =
            line(i.color === '待確認' ? '花色待確認' : i.color + ' · ' + i.stars.join('/') + '星') +
            `<span class="number">生長：${esc(i.raw['生長週期'] || '未知')}</span>`;
          extra = line(
            '售價：' +
              (i.raw[(i.stars?.[0] || 5) + '星'] === 'N/A'
                ? '未知'
                : (i.raw[(i.stars?.[0] || 5) + '星'] ?? '未知')),
          );
        } else {
          info =
            Object.entries(i.ingredients)
              .map(([name, n]) => line(name + ' × ' + n))
              .join('') || line('來源未提供');
          info += `<span class="number">解鎖：${esc(i.raw['解鎖方式'] || '未知')}</span>`;
          const star = Number(f.profitStar || 1),
            values = i.economics?.stars.find(s => s.star === star),
            profit = values?.profit;
          extra = `<strong class="${JournalCore.excludesProfit(i) ? '' : Number.isFinite(profit) && profit < 0 ? 'loss' : 'gain'}">${JournalCore.excludesProfit(i) ? 'X' : money(profit)}</strong>`;
        }
        if (c === 'birds')
          info =
            line(locationSummary(i)) +
            `<span class="number">完美距離：${esc(i.raw['完美距離'] || '未知')}</span>`;
        if (c === 'birds')
          extra =
            '<div class="bird-general-conditions"><strong>一般出沒時段・天氣</strong>' +
            extra +
            '</div><div class="bird-five-info bird-five-conditions"><strong>五星時段・天氣</strong>' +
            birdDetails(i, true) +
            '</div>' +
            (birdWhistleNote(i)
              ? '<div class="bird-whistle-info"><strong>鳥哨</strong>' + line(birdWhistleNote(i)) + '</div>'
              : '');
        const fullname = i.name + (i.color ? '・' + i.color : '');
        return `<tr class="item ${state.done[i.id] ? 'complete' : ''}" data-item="${i.id}"><td><label class="check-label"><input type="checkbox" data-check="${i.id}" aria-label="${esc(fullname)} ${c === 'flowers' ? '已收集此花色' : '已取得五星'}" ${state.done[i.id] ? 'checked' : ''} ${i.trackable ? '' : 'disabled title="來源花色尚待確認"'}><span aria-hidden="true">✓</span></label></td><td><span class="item-name">${esc(i.name)}</span><div class="item-meta"><span class="badge ${JournalCore.kindClass(i)}">${esc(JournalCore.kindLabel(i))}</span>${c === 'dishes' && JournalCore.limitedIngredients(i, LIMITED_MATERIALS).length ? '<span class="badge limited">限時材料</span>' : ''}${c === 'dishes' && i.eventSchedule?.requiresActivityStation === true ? '<span class="badge station" title="需要活動限定料理台，活動結束後無法製作">限時料理台</span>' : ''}${i.color ? `<span class="badge ${i.trackable ? 'color' : 'unknown'}">${esc(i.color)}</span>` : ''}</div></td><td><span class="level-badge">${i.level === null ? '未知' : 'Lv. ' + i.level}</span></td><td>${info}</td><td>${extra}</td>${c === 'dishes' ? `<td class="dish-currency-cell">${dishCurrencySummary(i, Number(f.profitStar || 1))}</td>` : ''}<td><button class="row-detail" data-detail="${i.id}" aria-label="查看${esc(fullname)}資料" aria-expanded="false">${c === 'dishes' ? '詳情 ＋' : '資料 ＋'}</button></td></tr>`;
      })
      .join('');
    $('empty').hidden = visible.length > 0;
    $('thead').hidden = visible.length === 0;
    updateProgress();
  }
  $('categories').innerHTML = JournalCore.categories
    .map(
      c =>
        `<button id="nav-${c}" class="nav-item" data-category="${c}"><span class="nav-icon">${icon(c)}</span><span class="nav-name">${{ fish: '釣魚', bugs: '捕蟲', birds: '觀鳥', flowers: '園藝', dishes: '烹飪' }[c]}</span><span class="nav-count"></span></button>`,
    )
    .join('');
  $('level').innerHTML =
    '<option value="all">不限等級</option>' +
    Array.from({ length: 14 }, (_, i) => `<option value="${i + 1}">Lv. ${i + 1}</option>`).join('');
  $('dish-number-sort').addEventListener('click', () => {
    state.filters.dishes.sort = 'number';
    save();
    renderRows();
  });
  $('thead').addEventListener('click', e => {
    const button = e.target.closest('[data-sort]');
    if (!button) return;
    const key = button.dataset.sort,
      f = state.filters[state.active];
    if (
      !['name', 'level', 'profit', 'price', 'location', 'growth'].includes(key) ||
      (key === 'growth' && state.active !== 'flowers') ||
      (['profit', 'price'].includes(key) && state.active !== 'dishes') ||
      (key === 'location' && !['fish', 'bugs', 'birds'].includes(state.active))
    )
      return;
    const ascending = ['profit', 'price'].includes(key) ? key + '-asc' : key;
    f.sort = f.sort === ascending ? key + '-desc' : ascending;
    save();
    renderRows();
    $('thead')
      .querySelector('[data-sort="' + key + '"]')
      ?.focus({ preventScroll: true });
  });

  $('categories').addEventListener('click', e => {
    const b = e.target.closest('[data-category]');
    if (!b) return;
    state.active = b.dataset.category;
    showView(false);
    save();
    configureCategory();
  });
  for (const key of ['level', 'weather', 'time', 'location', 'profitStar', 'plantType'])
    $(key).addEventListener('change', () => {
      state.filters[state.active][key] = $(key).value;
      if (key === 'weather' || key === 'time') JournalCore.syncHabitatFilters(state, state.active);
      save();
      renderRows();
    });
  /* ----------------------------------------------------------------
   * 篩選器：下拉選單、清除條件、篩選摘要
   * ---------------------------------------------------------------- */
  function updateKindDropdown() {
    const selected = [...document.querySelectorAll('[data-kind-option]:checked')];
    $('kind-all').checked = selected.length === 3;
    $('kind-toggle').textContent =
      (selected.length === 3 ? '全部' : selected.length ? selected.map(x => x.value).join('、') : '未選擇') +
      ' ▾';
  }
  $('kind-toggle').addEventListener('click', () => {
    const menu = $('kind-menu'),
      open = menu.hidden;
    menu.hidden = !open;
    $('kind-toggle').setAttribute('aria-expanded', String(open));
    if (open) {
      const r = $('kind-toggle').getBoundingClientRect(),
        menuHeight = Math.min(menu.scrollHeight, 280),
        top =
          window.innerHeight - r.bottom < menuHeight + 12
            ? Math.max(8, r.top - menuHeight - 4)
            : r.bottom + 4;
      menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
      menu.style.top = top + 'px';
    }
  });
  $('kind-filter').addEventListener('change', e => {
    if (e.target.id === 'kind-all')
      document.querySelectorAll('[data-kind-option]').forEach(box => (box.checked = e.target.checked));
    updateKindDropdown();
    state.filters[state.active].kind = [...document.querySelectorAll('[data-kind-option]:checked')].map(
      box => box.value,
    );
    save();
    renderRows();
  });
  document.addEventListener('click', e => {
    if (!$('kind-filter').contains(e.target)) {
      $('kind-menu').hidden = true;
      $('kind-toggle').setAttribute('aria-expanded', 'false');
    }
  });
  $('kind-filter').addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      $('kind-menu').hidden = true;
      $('kind-toggle').setAttribute('aria-expanded', 'false');
      $('kind-toggle').focus();
    }
  });
  $('five-star-only').addEventListener('change', () => {
    state.filters.birds.fiveStarOnly = $('five-star-only').checked;
    save();
    configureCategory();
  });
  $('cookable-only').addEventListener('change', () => {
    state.filters[state.active].cookableOnly = $('cookable-only').checked;
    save();
    renderRows();
  });
  $('search').addEventListener('input', () => {
    state.filters[state.active].search = $('search').value;
    save();
    renderRows();
  });
  $('status-tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-status]');
    if (b) {
      state.filters[state.active].status = b.dataset.status;
      save();
      renderRows();
    }
  });
  function clearFilters() {
    Object.assign(state.filters[state.active], {
      search: '',
      level: 'all',
      kind: ['日常', '當前活動', '過往活動'],
      location: 'all',
      status: 'all',
      plantType: 'all',
      fiveStarOnly: false,
      cookableOnly: false,
    });
    JournalCore.syncHabitatFilters(state, state.active);
    save();
    configureCategory();
  }
  function renderFilterSummary() {
    const c = state.active,
      f = state.filters[c],
      habitat = ['fish', 'bugs', 'birds'].includes(c),
      parts = [];
    parts.push(
      f.level === 'all' ? '不限等級' : f.level + ' 級以下',
      f.kind.length === 3 ? '全部收錄類型' : f.kind.length ? f.kind.join('、') : '未選擇收錄類型',
      { all: '全部完成狀態', todo: '未完成', done: '已完成' }[f.status],
    );
    if (f.search) parts.push('搜尋：' + f.search);
    if (habitat) {
      parts.push(
        $('weather').selectedOptions[0]?.textContent || f.weather,
        $('time').selectedOptions[0]?.textContent || f.time,
        $('location').selectedOptions[0]?.textContent || f.location,
      );
      if (c === 'birds') parts.push(f.fiveStarOnly ? '五星條件' : '一般出沒條件');
    }
    if (c === 'flowers') parts.push({ all: '花卉與作物', flower: '花卉', crop: '作物' }[f.plantType]);
    if (c === 'dishes') parts.push(f.profitStar + ' 星利潤');
    if (f.cookableOnly) parts.push('僅顯示當前可獲取');
    $('filter-summary').textContent = '目前篩選：' + parts.join(' · ');
    $('use-current-time').hidden = !habitat;
    if (habitat)
      $('time-context').textContent =
        '本機現在：' +
        JournalCore.currentTimeSlot() +
        '；' +
        (f.time === 'all'
          ? '目前顯示全部時段'
          : f.time === JournalCore.currentTimeSlot()
            ? '篩選與目前時段一致'
            : '篩選未跟隨目前時段') +
        '（手動切換）';
  }
  /* ----------------------------------------------------------------
   * 備份與還原：匯出、匯入、本機儲存狀態
   * ---------------------------------------------------------------- */
  let backupMeta = {};
  try {
    const value = JSON.parse(localStorage.getItem(KEY + '.backup') || '{}');
    if (value && typeof value === 'object') backupMeta = value;
  } catch {}
  function updateBackupStatus() {
    const baseline = backupMeta.done && typeof backupMeta.done === 'object' ? backupMeta.done : {},
      ids = new Set([...Object.keys(baseline), ...Object.keys(state.done)]);
    const changes = [...ids].filter(id => Boolean(baseline[id]) !== Boolean(state.done[id])).length;
    const date = new Date(backupMeta.exportedAt),
      valid = Number.isFinite(date.getTime());
    $('backup-status').textContent =
      (valid ? '上次送出備份下載：' + date.toLocaleString('zh-TW') : '尚無匯出備份紀錄') +
      (changes >= 10 ? ' · 已有 ' + changes + ' 筆進度變更，建議匯出備份。' : ' · 請確認下載檔案已保存。');
    $('backup-status').classList.toggle('backup-due', changes >= 10);
  }
  setInterval(renderFilterSummary, 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) renderFilterSummary();
  });
  $('report-issue').addEventListener('click', () => {
    $('report-text').value =
      '心動小鎮五星圖鑑 v1.2.0（2026/10/12 更新）\n分類：' +
      meta[state.active].name +
      '\n' +
      $('filter-summary').textContent +
      '\n\n項目名稱：\n遇到的問題：\n預期資料：\n可核對的來源與日期：\n裝置與瀏覽器：';
    $('report-dialog').showModal();
  });
  $('download-report').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([$('report-text').value], { type: 'text/plain;charset=utf-8' })),
      a = document.createElement('a');
    a.href = url;
    a.download = '圖鑑問題紀錄-v1.0.0.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('已送出問題紀錄下載；請自行提供給維護者。');
  });
  function resetFilters() {
    state.filters[state.active] = JournalCore.defaults(state.active);
    JournalCore.syncHabitatFilters(state, state.active);
    save();
    configureCategory();
  }
  $('reset-filters').addEventListener('click', resetFilters);
  $('empty-reset').addEventListener('click', clearFilters);
  $('clear-filters').addEventListener('click', clearFilters);
  $('use-current-time').addEventListener('click', () => {
    state.filters[state.active].time = JournalCore.currentTimeSlot();
    JournalCore.syncHabitatFilters(state, state.active);
    save();
    configureCategory();
  });
  $('rows').addEventListener('change', e => {
    const complete = e.target.closest('[data-complete-flower]');
    if (complete) {
      const group = JournalCore.flowerGroups(ITEMS, state.done).find(
        g => g.id === complete.dataset.completeFlower,
      );
      if (!group || !group.trackable) return;
      const checked = complete.checked;
      for (const color of group.colors) {
        if (checked) state.done[color.id] = true;
        else delete state.done[color.id];
      }
      save();
      renderRows();
      const next =
        document.querySelector('[data-complete-flower="' + group.id + '"]') ||
        document.querySelector('[data-complete-flower]:not(:disabled)') ||
        $('result-count');
      if (next === $('result-count')) next.setAttribute('tabindex', '-1');
      next.focus({ preventScroll: true });
      toast(
        group.name +
          (checked ? '的全部花色已勾選。' : '的全部花色已取消勾選。') +
          (storageAvailable ? '' : '本機未儲存，請匯出備份。'),
      );
      return;
    }
    const id = e.target.dataset.check;
    if (!id) return;
    const i = ITEMS.find(i => i.id === id);
    if (!i?.trackable) return;
    if (e.target.checked) state.done[id] = true;
    else delete state.done[id];
    save();
    if (i.category === 'flowers') {
      renderRows();
      const next = document.querySelector('input[data-check="' + id + '"]');
      if (next) next.focus({ preventScroll: true });
      return;
    }
    if (state.filters[state.active].status !== 'all') {
      renderRows();
    } else {
      e.target.closest('tr').classList.toggle('complete', !!state.done[id]);
      updateProgress();
      const group = ITEMS.filter(i => i.category === state.active),
        visible = JournalCore.filterItems(group, state.filters[state.active], state.done),
        pending = visible.filter(i => !i.trackable).length;
      $('result-note').textContent =
        `${visible.filter(i => state.done[i.id]).length} 項已完成${pending ? ' · ' + pending + ' 項資料待確認' : ''}`;
    }
  });
  $('rows').addEventListener('click', e => {
    const flower = e.target.closest('[data-flower]');
    if (flower) {
      const id = flower.dataset.flower;
      if (openFlowers.has(id)) openFlowers.delete(id);
      else openFlowers.add(id);
      renderRows();
      document.querySelector('[data-flower="' + id + '"]')?.focus({ preventScroll: true });
      return;
    }
    const b = e.target.closest('[data-detail]');
    if (!b) return;
    const row = b.closest('tr');
    if (b.getAttribute('aria-expanded') === 'true') {
      row.nextElementSibling.remove();
      b.setAttribute('aria-expanded', 'false');
      b.textContent =
        ITEMS.find(i => i.id === b.dataset.detail)?.category === 'dishes' ? '詳情 ＋' : '資料 ＋';
      return;
    }
    const i = ITEMS.find(i => i.id === b.dataset.detail),
      tr = document.createElement('tr');
    tr.className = 'detail-row';
    tr.innerHTML = `<td colspan="${i.category === 'dishes' ? 7 : 6}">${eventDetails(i)}${
      i.category === 'dishes'
        ? '<section class="dish-economics-detail"><h4>成本・售價・利潤</h4>' +
          dishEconomics(i) +
          '</section><section class="dish-ingredients"><h4>食材</h4>' +
          (Object.keys(i.ingredients || {}).length
            ? '<ul>' +
              Object.entries(i.ingredients)
                .map(
                  ([name, n]) =>
                    '<li' +
                    (LIMITED_MATERIALS.has(name) ? ' class="limited-material"' : '') +
                    '>' +
                    esc(name) +
                    ' <b>× ' +
                    esc(n) +
                    '</b></li>',
                )
                .join('') +
              '</ul>'
            : line('來源未提供')) +
          '</section>'
        : ''
    }${i.category === 'birds' ? birdDetails(i) + (i.id.startsWith('trial-') ? '' : '<h4>一般出沒條件（百科）</h4>' + line('時段：' + (i.times.length === 4 ? '全天' : i.times.join(' / '))) + line('天氣：' + i.weather.join('／'))) : ''}${['fish', 'bugs', 'birds'].includes(i.category) ? '<h4>星級售價</h4>' : ''}<dl ${i.category === 'dishes' ? 'hidden' : ''} class="raw-grid${['fish', 'bugs', 'birds'].includes(i.category) ? ' fish-prices' : ''}">${Object.entries(
      i.raw,
    )
      .filter(
        ([key]) =>
          key !== '編號' &&
          i.category !== 'dishes' &&
          (!['fish', 'bugs', 'birds'].includes(i.category) || /^[1-5]星$/.test(key)),
      )
      .map(
        ([key, value]) =>
          `<div class="raw-pair"><dt>${esc(['fish', 'bugs', 'birds'].includes(i.category) ? key + '售價' : key)}</dt><dd>${esc(value === '' || value === 'N/A' ? 'N/A' : value)}</dd></div>`,
      )
      .join(
        '',
      )}</dl>${dropDetails(i)}${['fish', 'bugs', 'birds', 'dishes'].includes(i.category) ? '' : `<div class="detail-source">來源原始欄位 · O 表示來源勾選；來源空白或 N/A 皆顯示為 N/A。花卉依所有花色分開記錄，全部花色收齊才算完成；不確定資訊標示待確認。</div>`}</td>`;
    row.after(tr);
    b.setAttribute('aria-expanded', 'true');
    b.textContent = '收起 −';
  });
  $('help').addEventListener('click', () => $('help-dialog').showModal());
  $('calc-help').addEventListener('click', () => $('calc-help-dialog').showModal());
  document
    .querySelectorAll('[data-close]')
    .forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  $('export').addEventListener('click', () => {
    const backup = {
      app: 'heartopia-five-star-journal',
      version: 1,
      exportedAt: new Date().toISOString(),
      sourceFetchedAt: DATA.fetchedAt,
      state,
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }),
      url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = `心動小鎮五星進度-${new Date().toLocaleDateString('sv-SE')}.json`;
    a.click();
    backupMeta = { exportedAt: backup.exportedAt, done: { ...state.done } };
    try {
      localStorage.setItem(KEY + '.backup', JSON.stringify(backupMeta));
    } catch {}
    updateBackupStatus();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('已送出備份下載，請保留 JSON 檔案。');
  });
  $('import').addEventListener('click', () => {
    $('file').value = '';
    $('file').click();
  });
  $('file').addEventListener('change', async () => {
    const file = $('file').files[0];
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('檔案過大，請選擇圖鑑匯出的進度備份。');
      pendingImport = JournalCore.readBackup(JSON.parse(await file.text()), ALL_ITEMS, RETIRED_ITEM_IDS);
      const before = Object.keys(state.done).length,
        after = Object.keys(pendingImport.state.done).length;
      $('import-summary').textContent =
        `目前有 ${before} 筆勾選，備份含 ${after} 筆可還原勾選（花卉按花色記錄；完成率按整種花計算）。${pendingImport.skipped ? '另有 ' + pendingImport.skipped + ' 項無法對應目前圖鑑，將略過。' : ''}`;
      $('import-dialog').showModal();
    } catch (e) {
      pendingImport = null;
      toast(e instanceof SyntaxError ? '檔案不是有效的 JSON 備份。' : e.message);
    }
  });
  function restore(merge) {
    if (!pendingImport) return;
    if (merge) state.done = { ...state.done, ...pendingImport.state.done };
    else state = pendingImport.state;
    pendingImport = null;
    save();
    configureCategory();
    $('import-dialog').close();
    toast(storageAvailable ? '進度已還原並保存。' : '進度已還原，但未能寫入瀏覽器，請匯出備份。');
  }
  $('merge-backup').addEventListener('click', () => restore(true));
  $('replace-backup').addEventListener('click', () => restore(false));
  window.addEventListener('storage', e => {
    if (e.key === KEY + '.backup') {
      try {
        backupMeta = JSON.parse(e.newValue || '{}') || {};
        updateBackupStatus();
      } catch {}
      return;
    }
    if (e.key !== KEY) return;
    try {
      state = JournalCore.sanitizeState(
        e.newValue ? JSON.parse(e.newValue) : {},
        ALL_ITEMS,
        RETIRED_ITEM_IDS,
      );
      configureCategory();
      updateBackupStatus();
      $('save-state').textContent = '✓ 已同步其他分頁';
    } catch {
      toast('其他分頁的進度格式有誤，保留目前畫面。');
    }
  });
  const releaseBatches = [...document.querySelectorAll('#release-batches .release-batch')];
  let releasePage = 0;
  function showReleasePage(index) {
    releasePage = Math.max(0, Math.min(index, releaseBatches.length - 1));
    releaseBatches.forEach((batch, i) => (batch.hidden = i !== releasePage));
    $('release-newer').disabled = releasePage === 0;
    $('release-older').disabled = releasePage === releaseBatches.length - 1;
    $('release-page-status').textContent = releasePage + 1 + ' / ' + releaseBatches.length;
  }
  function changeReleasePage(direction) {
    showReleasePage(releasePage + direction);
  }
  $('release-newer').addEventListener('click', () => changeReleasePage(-1));
  $('release-older').addEventListener('click', () => changeReleasePage(1));
  showReleasePage(0);
  $('nav-home').addEventListener('click', () => {
    showReleasePage(0);
    showView(true);
  });
  calcInit();
  $('nav-calculator').addEventListener('click', showCalculator);
  document.querySelector('.brand').addEventListener('click', e => {
    e.preventDefault();
    showView(true);
  });
  $('home-cards').addEventListener('click', e => {
    const b = e.target.closest('[data-home-category]');
    if (!b) return;
    state.active = b.dataset.homeCategory;
    showView(false);
    save();
    configureCategory();
  });
  $('home-continue').addEventListener('click', () => {
    showView(false);
    configureCategory();
  });
  for (const action of ['help', 'export', 'import'])
    $('home-' + action).addEventListener('click', () => $(action).click());
  document.querySelector('#help-dialog .release-notice a').addEventListener('click', e => {
    e.preventDefault();
    $('help-dialog').close();
    showView(true);
    showReleasePage(0);
    $('release-log').scrollIntoView({ behavior: 'smooth' });
  });
  let eventTimer;
  function refreshEventSchedule() {
    clearTimeout(eventTimer);
    const now = Date.now();
    let changed = false;
    DATA.items.forEach((source, index) => {
      const updated = JournalCore.applyEventSchedule(source, now, DATA.activitySchedules),
        current = ALL_ITEMS[index];
      if (
        current.kind !== updated.kind ||
        current.eventStatus !== updated.eventStatus ||
        current.eventAvailable !== updated.eventAvailable
      )
        changed = true;
      Object.assign(current, updated);
    });
    if (changed) configureCategory();
    const next = [...DATA.items.map(i => i.eventSchedule), ...Object.values(DATA.activitySchedules || {})]
      .flatMap(s => [s?.startsAt, s?.endsAt])
      .filter(Boolean)
      .map(Date.parse)
      .filter(t => t > now);
    if (next.length)
      eventTimer = setTimeout(
        refreshEventSchedule,
        Math.min(Math.max(1, Math.min(...next) - now), 2147483647),
      );
  }
  window.addEventListener('focus', refreshEventSchedule);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshEventSchedule();
  });
  refreshEventSchedule();
  configureCategory();
  if (restoreCalculator) showCalculator();
  rememberPage();
  updateBackupStatus();
  // Check whether this browser permits persistence without overwriting existing progress.
  try {
    localStorage.setItem(KEY + '.probe', '1');
    localStorage.removeItem(KEY + '.probe');
    $('save-state').textContent = startupWarning ? '⚠ 進度讀取異常' : '✓ 本機保存已就緒';
  } catch {
    storageAvailable = false;
    $('save-state').textContent = '⚠ 無法保存，請匯出備份';
    startupWarning = '此瀏覽器無法儲存進度，請使用一般視窗，並匯出備份。';
  }
  if (startupWarning) toast(startupWarning);
})();
