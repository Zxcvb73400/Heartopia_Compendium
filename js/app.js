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
// 手機版漢堡選單：不等資料載入就先綁定（原本是 index.html 的內嵌程式，搬到這裡以符合 CSP）
(() => {
  const button = document.querySelector('.menu-toggle'),
    sidebar = document.getElementById('sidebar');
  if (!button || !sidebar) return;
  button.addEventListener('click', () => {
    const open = sidebar.classList.toggle('open');
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  sidebar.addEventListener('click', e => {
    if (e.target.closest('.nav-item') && window.innerWidth <= 800) {
      sidebar.classList.remove('open');
      button.setAttribute('aria-expanded', 'false');
    }
  });
})();
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
  // 料理成本以材料目錄即時計算（單一來源，避免資料檔成本與目錄單價對不上）。
  // 有任何食材缺單價時，沿用資料檔 economics.cost。
  const DISH_BY_NAME = new Map(ALL_ITEMS.filter(i => i.category === 'dishes').map(i => [i.name, i]));
  for (const i of DISH_BY_NAME.values()) {
    const e = i.economics,
      ingredients = Object.entries(i.ingredients || {});
    if (!e || !ingredients.length || !ingredients.every(([n]) => Number.isFinite(MATERIAL_BY_NAME.get(n)?.cost))) continue;
    const cost = ingredients.reduce((sum, [n, q]) => sum + MATERIAL_BY_NAME.get(n).cost * q, 0);
    if (cost !== e.cost) console.warn(`[資料檢查] ${i.name} 資料檔成本 ${e.cost}，依材料目錄為 ${cost}，已採用材料目錄。`);
    e.cost = cost;
    e.stars.forEach(s => (s.profit = Number.isFinite(s.price) ? s.price - cost : null));
  }
  // 子料理：材料目錄 subDish:true。「任意」子料理有 options，取系列中 1 星售價最低的那道。
  function subDishSource(name) {
    const m = MATERIAL_BY_NAME.get(name);
    if (!m?.subDish) return null;
    const candidates = (m.options || [m.name]).map(n => DISH_BY_NAME.get(n)).filter(Boolean);
    return candidates.sort((a, b) => (a.economics?.stars?.[0]?.price ?? Infinity) - (b.economics?.stars?.[0]?.price ?? Infinity))[0] || null;
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
        subDish: MATERIAL_BY_NAME.get(row.name)?.subDish === true,
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
    host.innerHTML =
      '<div class="calc-table-scroll"><table class="calc-material-table">' +
      '<thead><tr><th>原材料</th><th>每份用量</th><th>單價</th><th>材料小計</th></tr></thead>' +
      `<tbody>${stats.rows.map((r, n) => calcMaterialRow(item, slot, r, n)).join('')}</tbody></table></div>`;
  }
  // 計算機材料表的一列：名稱（含限時／子料理標記）、用量、單價、小計
  function calcMaterialRow(item, slot, r, n) {
    const tags = (r.limited ? '<small>限時材料</small>' : '') + (r.subDish ? '<small>子料理・以1星售價計</small>' : '');
    const qty = `<input type="number" min="0" max="4" step="1" data-calc-field="qty" data-calc-slot="${slot}" data-calc-dish="${esc(item.id)}" data-calc-name="${esc(r.name)}" value="${esc(r.qty)}" aria-label="${esc(r.name)}每份用量">`;
    const price = `<input type="number" min="0" step="1" data-calc-field="price" data-calc-name="${esc(r.name)}" value="${r.price ?? ''}" placeholder="待補" aria-label="${esc(r.name)}單價">`;
    const remove = r.custom
      ? ` <button class="button calc-add-remove" type="button" data-calc-remove="${esc(r.name)}" data-calc-dish="${esc(item.id)}" aria-label="移除${esc(r.name)}">×</button>`
      : '';
    return (
      `<tr><td class="calc-row-name">${esc(r.name)}${tags}</td><td>${qty}</td><td>${price}</td>` +
      `<td><span data-calc-subtotal="${slot}-${n}">${r.valid ? calcMoney(r.subtotal) : '待補'}</span>${remove}</td></tr>`
    );
  }
  // 計算機「新增材料」輸入框：材料名稱輸入＋材料清單
  function calcMaterialInput(slot) {
    return (
      `<input type="text" class="calc-add-material" list="calc-material-list-${slot}" placeholder="輸入材料名稱"></label>` +
      `<datalist id="calc-material-list-${slot}">${MATERIALS.map(m => `<option value="${esc(m.name)}">`).join('')}</datalist>`
    );
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
    // 自訂料理還沒有材料時，顯示完整的材料輸入列（名稱、用量、單價）
    const entry = emptyCustom
      ? `<div class="calc-empty-material-entry"><label>材料名稱${calcMaterialInput(slot)}` +
        '<label>每份用量<input type="number" class="calc-new-material-qty" min="1" max="4" step="1" value="1" aria-label="每份用量"></label>' +
        '<label>單價<input type="number" class="calc-new-material-price" min="0" step="1" value="0" aria-label="材料單價"></label>' +
        '<button class="button calc-add-material-button" type="button" data-calc-add-material>加入材料</button></div>'
      : `<div class="calc-actions"><label>新增材料至料理 ${letter}${calcMaterialInput(slot)}` +
        '<button class="button calc-add-material-button" type="button" data-calc-add-material>加入</button></div>';
    card.innerHTML =
      `<header class="calc-card-heading"><span class="calc-recipe-badge ${index ? 'calc-recipe-badge-b' : ''}">${letter} · 料理</span>` +
      `<h2>${esc(item.name)}</h2></header><div id="calc-materials-${slot}"></div>${entry}` +
      `<div id="calc-summary-${slot}"></div><div id="calc-stars-${slot}"></div>`;
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
  /* ----------------------------------------------------------------
   * 獨立頁面（成本計算機、成就、寵物）：與圖鑑表格分開顯示
   * ---------------------------------------------------------------- */
  const PANELS = ['calculator', 'achievements', 'pets'];
  function setNavActive(button, active) {
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  function openPanel() {
    return PANELS.find(p => !$(p + '-view').hidden);
  }
  function showPanel(name) {
    homeVisible = false;
    $('home-view').hidden = true;
    document.querySelector('.hero').hidden = !['achievements', 'pets'].includes(name);
    document.querySelector('.collection').hidden = true;
    $('collection-heading').hidden = true;
    $('release-log').hidden = true;
    setNavActive($('nav-home'), false);
    for (const c of JournalCore.categories) setNavActive($('nav-' + c), false);
    for (const p of PANELS) {
      $(p + '-view').hidden = p !== name;
      setNavActive($('nav-' + p), p === name);
    }
    if (name === 'achievements') renderAchievements();
    if (name === 'pets') renderPets();
    rememberView(name);
  }
  function showCalculator() {
    showPanel('calculator');
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
    // 園藝：土地上長出兩片葉子的新苗（原本的花形和捕蟲圖示太像）
    plants:
      '<path d="M2.5 20.5h19M4.5 20.5c1.5-2.6 4.4-4 7.5-4s6 1.4 7.5 4"/><path d="M12 16.5V9.5"/><path d="M12 13C9 13 6.5 11 6.5 7.5 9.5 7.5 12 9.5 12 13Z"/><path d="M12 10.5c0-3 2.2-5 5.5-5 0 3-2.2 5-5.5 5Z"/>',
    dishes:
      '<path d="M4 12h16c0 5-3 8-8 8s-8-3-8-8ZM2 12h20M8 8c-3-3 3-3 0-6m5 6c-3-3 3-3 0-6m5 6c-3-3 3-3 0-6M8 22h8"/>',
  };
  // 成本計算機：計算機外框＋螢幕＋按鍵
  paths.calculator =
    '<rect x="5" y="2.5" width="14" height="19" rx="2.5"/><path d="M8 6h8v3.5H8Z"/><path d="M8.5 13h.01M12 13h.01M15.5 13h.01M8.5 17h.01M12 17h.01M15.5 13v4"/>';
  const icon = c =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[c]}</svg>`;
  $('nav-calculator').querySelector('.nav-icon').innerHTML = icon('calculator');
  // 首頁：房屋外框＋門
  paths.home = '<path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/>';
  $('nav-home').querySelector('.nav-icon').innerHTML = icon('home');
  // 成就：獎盃；寵物：腳掌
  paths.achievements =
    '<path d="M8 4h8v5a4 4 0 0 1-8 0Z"/><path d="M8 6H5a3 3 0 0 0 3 4m8-4h3a3 3 0 0 1-3 4M12 13v4m-4 3h8l-1-3H9Z"/>';
  paths.pets =
    '<ellipse cx="12" cy="16" rx="4.5" ry="3.8"/><circle cx="6" cy="10.5" r="1.8"/><circle cx="18" cy="10.5" r="1.8"/><circle cx="9.3" cy="6.5" r="1.8"/><circle cx="14.7" cy="6.5" r="1.8"/>';
  for (const p of ['achievements', 'pets']) {
    $('nav-' + p).querySelector('.nav-icon').innerHTML = icon(p);
    $(p + '-icon').innerHTML = icon(p);
  }
  const meta = {
    fish: { name: '魚類', desc: '河流、湖泊與海洋裡，等待上鉤的五星。' },
    bugs: { name: '蟲類', desc: '走進花田與森林，尋找小小的五星蹤跡。' },
    birds: { name: '鳥類', desc: '抬頭看一看，記錄最美的五星身影。' },
    plants: { name: '園藝', desc: '紀錄作物與花卉，每種花的所有已知花色分別勾選。' },
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
  // 開啟或重新整理時回到上次瀏覽的頁面；篩選沿用上次的設定，
  // 只有時段改回現在的時段、搜尋文字清空。勾選進度（state.done）不受影響。
  for (const c of JournalCore.categories)
    state.filters[c] = { ...state.filters[c], time: JournalCore.defaults(c).time, search: '' };
  let initialView = 'home';
  try {
    const savedView = localStorage.getItem(KEY + '.view');
    if (PANELS.includes(savedView) || JournalCore.categories.includes(savedView))
      initialView = savedView;
  } catch {
    // 瀏覽器不允許本機儲存時，仍可正常使用網站並從首頁開始。
  }
  if (JournalCore.categories.includes(initialView)) state.active = initialView;
  let homeVisible = initialView === 'home';
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
  function rememberView(view) {
    try {
      localStorage.setItem(KEY + '.view', view);
    } catch {
      // 頁面記憶失敗不影響切換頁面或收藏進度的保存。
    }
  }
  function showView(home) {
    homeVisible = home;
    for (const p of PANELS) {
      $(p + '-view').hidden = true;
      setNavActive($('nav-' + p), false);
    }
    $('home-view').hidden = !home;
    document.querySelector('.hero').hidden = home;
    document.querySelector('.collection').hidden = home;
    $('collection-heading').hidden = home;
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
    rememberView(home ? 'home' : state.active);
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
      { fish: '釣魚', bugs: '捕蟲', birds: '觀鳥', plants: '園藝', dishes: '烹飪' }[state.active];
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
          { fish: '釣魚', bugs: '捕蟲', birds: '觀鳥', plants: '園藝', dishes: '烹飪' }[c] +
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
      .join('') +
      // 成就與寵物：各自計算，不列入上方的全圖鑑進度
      `<button class="home-card home-card-panel" data-home-panel="achievements"><span class="home-card-title">${icon('achievements')}成就</span><strong>${achievementStats().done}</strong><small> / ${achievementStats().total} · 不計入總進度</small></button>` +
      `<button class="home-card home-card-panel" data-home-panel="pets"><span class="home-card-title">${icon('pets')}寵物</span><strong>${state.pets.length}</strong><small> 隻 · 飲食紀錄</small></button>` +
      // 成本計算機入口固定放在最後
      `<button class="home-card home-card-calculator" data-home-panel="calculator"><span class="home-card-title">${icon('calculator')}成本計算機</span><strong>試算</strong><small> · 料理材料與利潤</small></button>`;
    const panel = openPanel();
    if (panel) showPanel(panel);
    else showView(homeVisible);
  }
  function updateProgress() {
    const trackable = [
        ...ITEMS.filter(i => i.category !== 'plants' && i.trackable),
        ...JournalCore.flowerGroups(ITEMS, state.done).filter(i => i.trackable),
      ],
      isComplete = i => (i.category === 'plants' ? i.complete : !!state.done[i.id]),
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
          `${n} / ${all.length} ${c === 'plants' ? '種已完成' : '已完成'} · ${Math.round((n / all.length) * 100)}%`;
        $('category-bar').style.width = `${(n / all.length) * 100}%`;
      }
    }
    renderHome(trackable, isComplete, total, done, pct);
    updatePanelCounts(); // 匯入備份等變動後，側欄成就／寵物數字一起更新
  }
  /* ----------------------------------------------------------------
   * 各分類頁面的標題與篩選器設定
   * ---------------------------------------------------------------- */
  function configureCategory() {
    const c = state.active,
      f = state.filters[c],
      group = ITEMS.filter(i => i.category === c);
    $('category-title').textContent =
      { fish: '釣魚', bugs: '捕蟲', birds: '觀鳥', plants: '園藝', dishes: '烹飪' }[c] + '圖鑑';
    $('category-icon').innerHTML = icon(c);
    const places = JournalCore.locationChoices(group);
    $('location').innerHTML =
      '<option value="all">所有地點</option>' +
      places.groups
        .map(
          x =>
            `<option value="${esc('group:' + x)}">${esc(c === 'bugs' && x === '事件' ? '引蟲出洞（事件）' : placeLabel(x))}</option>`,
        )
        .join('') +
      places.exact.map(x => `<option value="${esc('exact:' + x)}">${esc(placeLabel(x))}</option>`).join('');
    $('time-label').textContent = '時段';
    for (const key of ['search', 'level', 'weather', 'time', 'location', 'profitStar', 'plantType'])
      $(key).value = f[key];
    document
      .querySelectorAll('[data-kind-option]')
      .forEach(box => (box.checked = f.kind.includes(box.value)));
    updateKindDropdown();
    $('plant-type-label').hidden = c !== 'plants';
    $('profit-star-label').hidden = c !== 'dishes';
    $('dish-number-sort').hidden = c !== 'dishes';
    document.querySelector('.list').classList.toggle('dish-list', c === 'dishes');
    document.querySelector('.list').classList.toggle('flower-list', c === 'plants');
    $('cookable-only').checked = f.cookableOnly;
    $('craftable-filter').hidden = c !== 'dishes';
    syncCraftableBox(f);
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
  // 地點名稱「X事件（事件）」顯示時只寫「X事件」；資料、搜尋與篩選仍用原本的名稱
  const placeLabel = text => String(text).replace(/事件（事件）/g, '事件');
  // 地點細節（例如「緩風海（礁石上）」）只用於顯示；搜尋與篩選仍使用原本的 locations
  const withLocationNote = (item, value) =>
    item.locationNotes?.[value] ? `${value}（${item.locationNotes[value]}）` : value;
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
    return [...new Set(locations.map(value => withLocationNote(item, value)))].join(' / ') || '來源未提供';
  }
  function locationSummary(item) {
    if (item.category === 'birds') return placeLabel(birdLocationSummary(item));
    const stage = ['fish', 'bugs'].includes(item.category) ? eventStage(item) : '';
    return placeLabel(
      (item.locations || [])
        .map(value => {
          if (!stage || !value.includes('事件')) return withLocationNote(item, value);
          // 有些地點本身已寫「－第二階段」，先去掉再統一加上，避免階段重複
          const base = value.replace(/\s*[－-]\s*(?:第一|第二|第三|額外)階段$/, '');
          const note = item.locationNotes?.[value];
          return (note ? `${base}（${note}）` : base) + ' - ' + stage;
        })
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
    const activityType = String(schedule.activityType || '').trim();
    if (activityType === '聯動')
      return { label: '', amount: null, applicable: false };

    const configured = String(schedule.tokenName || '').trim();
    const defaultLabel = activityType === '潮流季' ? '潮流幣' : '慶典幣';
    const label = configured && configured !== '待補' ? configured : defaultLabel;
    const raw = i.raw || {};
    const keys = [star + '星活動代幣', star + '星' + label, star + '星慶典幣', star + '星潮流幣'];
    const key = keys.find(name => Object.prototype.hasOwnProperty.call(raw, name));
    const value = key ? raw[key] : undefined;
    const known =
      value !== null && value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value));
    const hasAny = [1, 2, 3, 4, 5].some(s =>
      ['活動代幣', label, '慶典幣', '潮流幣'].some(token => {
        const value = raw[s + '星' + token];
        return value !== undefined && value !== null && value !== '';
      }),
    );
    return {
      label,
      amount: known ? Number(value) : null,
      notApplicable: value === 'N/A',
      applicable: Boolean(i.eventName || configured || activityType || hasAny),
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
    const schedule = DATA.activitySchedules?.[i.eventName] || i.eventSchedule || {};
    const raw = i.raw || {},
      hasCoins = String(schedule.activityType || '') !== '聯動' && stars.some(s =>
        [raw[s + '星活動代幣'], raw[s + '星慶典幣'], raw[s + '星潮流幣']]
          .some(v => v !== undefined && v !== null && v !== ''),
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
                esc(t.amount === null ? (t.notApplicable ? 'N/A' : '待補') : money(t.amount)) +
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
  // 園藝列共用的欄位：名稱（含分類與活動徽章）、等級、展開按鈕
  function gardenNameCell(g, open, panel, typeLabel) {
    return (
      `<td><button class="flower-toggle item-name" data-flower="${g.id}" aria-expanded="${open}" aria-controls="${panel}">${esc(g.name)}</button>` +
      `<div class="item-meta"><span class="badge ${typeLabel === '花卉' ? 'type-flower' : 'type-crop'}">${typeLabel}</span> <span class="badge ${JournalCore.kindClass(g)}">${esc(JournalCore.kindLabel(g))}</span></div></td>`
    );
  }
  function levelCell(item) {
    return `<td><span class="level-badge">${item.level === null ? '未知' : 'Lv. ' + item.level}</span></td>`;
  }
  function gardenToggleCell(g, open, panel, what) {
    return `<td><button class="row-detail" data-flower="${g.id}" aria-expanded="${open}" aria-controls="${panel}" aria-label="${open ? '收起' : '展開'}${esc(g.name)}${what}">${open ? '收起 −' : '展開 ＋'}</button></td>`;
  }
  function renderCrop(g) {
    const open = openFlowers.has(g.id),
      panel = 'flower-' + g.id;
    const check = `<td><label class="check-label"><input type="checkbox" data-check="${g.id}" aria-label="${esc(g.name)} 已取得五星" ${g.complete ? 'checked' : ''}><span aria-hidden="true">✓</span></label></td>`;
    const row =
      `<tr class="item ${g.complete ? 'complete' : ''}" data-item="${g.id}">${check}${gardenNameCell(g, open, panel, '作物')}${levelCell(g)}` +
      `<td>${line(g.complete ? '五星已完成' : '五星未完成')}</td><td>${line(g.raw['生長週期'] || '未知')}</td>${gardenToggleCell(g, open, panel, '價格')}</tr>`;
    const detail =
      `<tr class="detail-row" id="${panel}" ${open ? '' : 'hidden'}><td colspan="6">` +
      `<h4>成本</h4>${gardenPriceRow(g.raw, ['種子價格'])}<h4>星級售價</h4>${gardenPriceRow(g.raw)}${eventDetails(g)}</td></tr>`;
    return row + detail;
  }
  // 花卉的一個花色：勾選框、星級、各星售價
  function flowerColorCard(i) {
    const stars = i.stars?.length ? i.stars.map(s => s + ' 星').join(' / ') : '星數待確認';
    // 上面已寫星數；只有一個星數時不再重複「N 星」
    const single = (i.stars || []).length === 1;
    const prices = (i.stars || [])
      .map(s => `${single ? '' : s + ' 星'}售價：${esc(i.raw[s + '星'] === 'N/A' ? '未知' : (i.raw[s + '星'] ?? '未知'))}`)
      .join('<br>');
    return (
      `<div class="flower-color ${state.done[i.id] ? 'collected' : ''}"><label>` +
      `<input type="checkbox" data-check="${i.id}" aria-label="${esc(i.name + '・' + i.color)} 已收集此花色" ${state.done[i.id] ? 'checked' : ''} ${i.trackable ? '' : 'disabled'}>` +
      `<span><b>${esc(i.color)}</b><small>${stars}</small></span></label><div class="info-text">${prices}</div></div>`
    );
  }
  function renderFlower(g) {
    const open = openFlowers.has(g.id),
      panel = 'flower-' + g.id;
    const check =
      `<td><label class="check-label" title="勾選或取消${esc(g.name)}的全部花色">` +
      `<input type="checkbox" data-complete-flower="${g.id}" aria-label="${esc(g.name)}全部花色" ${g.complete ? 'checked' : ''} ${g.trackable ? '' : 'disabled'}>` +
      '<span aria-hidden="true">✓</span></label></td>';
    const progress = g.trackable ? `${g.collected} / ${g.colors.length} 花色${g.complete ? ' · 已完成' : ''}` : '花色待確認';
    const row =
      `<tr class="item ${g.complete ? 'complete' : ''}" data-item="${g.id}">${check}${gardenNameCell(g, open, panel, '花卉')}${levelCell(g)}` +
      `<td>${line(progress)}</td><td>${line(g.raw['生長週期'] || '未知')}</td>${gardenToggleCell(g, open, panel, '花色')}</tr>`;
    const seedCost = g.raw['種子價格'] !== '' && g.raw['種子價格'] != null ? `<h4>成本</h4>${gardenPriceRow(g.raw, ['種子價格'])}` : '';
    const detail =
      `<tr class="detail-row" id="${panel}" ${open ? '' : 'hidden'}><td colspan="6"><strong>${esc(g.name)} · 花色收集</strong>` +
      `<div class="flower-colors">${g.colors.map(flowerColorCard).join('')}</div>` +
      `${g.trackable ? '' : '<span class="info-text">來源尚未提供花色，暫不列入完成統計。</span>'}` +
      `${seedCost}<h4>星級售價</h4>${gardenPriceRow(g.raw)}${eventDetails(g)}</td></tr>`;
    // 兩列之間保留原本的換行與縮排（畫面輸出與拆分前完全相同）
    return row + '\n      ' + detail;
  }
  function sortHeader(label, key, prefix = '') {
    const value = state.filters[state.active].sort,
      active = value === key || value === key + '-asc' || value === key + '-desc',
      desc = active && value.endsWith('-desc');
    const next = active && !desc ? '降冪' : '升冪';
    const ariaSort = active ? (desc ? 'descending' : 'ascending') : 'none',
      arrow = active ? (desc ? '↓' : '↑') : '↕';
    return (
      `<th aria-sort="${ariaSort}">${esc(prefix)}` +
      `<button type="button" class="column-sort" data-sort="${key}" aria-label="${esc(label)}：點選以${next}排序">${esc(label)}<span aria-hidden="true">${arrow}</span></button></th>`
    );
  }
  function renderFlowers() {
    const visible = JournalCore.visibleFlowers(
      ITEMS.filter(i => i.category === 'plants'),
      state.filters.plants,
      state.done,
    );
    $('result-count').textContent = `顯示 ${visible.length} 種`;
    $('result-note').textContent =
      `${visible.filter(g => g.complete).length} 種已完成 · 花卉收齊全部花色，作物取得五星`;
    $('thead').innerHTML =
      `<tr><th>完成</th>${sortHeader('花卉／作物名稱', 'name')}${sortHeader('等級', 'level')}<th>收集進度</th>${sortHeader('生長週期', 'growth')}<th>詳情</th></tr>`;
    $('rows').innerHTML = visible.map(g => (g.plantType === 'crop' ? renderCrop(g) : renderFlower(g))).join('');
    renderEmptyState(visible.length);
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
      if (!compact && s.remark) text += line('備註：' + s.remark);
      if (!compact && s.name !== i.name) text += line('圖表名稱：' + s.name);
    } else text += line('本次 77 種總表未收錄五星條件。');
    return text + (compact ? '' : '</div>');
  }
  const money = v =>
    Number.isFinite(v) ? v.toLocaleString('zh-TW', { maximumFractionDigits: 2 }) : '待確認';
  function dishEconomics(i) {
    const e = i.economics;
    if (!e) return line('成本待確認');
    // 用到子料理時，提示子料理是以 1 星售價計入成本
    const subDishes = Object.keys(i.ingredients || {}).filter(name => MATERIAL_BY_NAME.get(name)?.subDish === true);
    // 子料理材料明細：每道子料理的材料成本（以材料目錄單價統計），僅供參考，不計入本料理成本
    const subDishRows = subDishes
      .map(name => {
        const src = subDishSource(name);
        if (!src) return '';
        const parts = Object.entries(src.ingredients || {}).map(([n, q]) => {
          const m = MATERIAL_BY_NAME.get(n);
          return `${n}${m?.subDish ? '（子料理售價）' : ''} ${money(m?.cost)}${q > 1 ? '×' + q : ''}`;
        });
        const label = name === src.name ? name : `${name} → ${src.name}（系列最低售價）`;
        return `<li><b>${esc(label)}</b>：1 星售價 ${money(src.economics?.stars?.[0]?.price)}｜材料成本 ${money(src.economics?.cost)}${parts.length ? `（${esc(parts.join('＋'))}）` : ''}</li>`;
      })
      .join('');
    const subDishNote = subDishes.length
      ? `<p class="dish-cost-note">※ 子料理（${esc(subDishes.join('、'))}）以 1 星售價計入成本；「任意」子料理以該系列最低 1 星售價計算。</p>` +
        (subDishRows ? `<details class="dish-cost-note sub-dish-detail"><summary>子料理材料明細（參考，不計入成本）</summary><ul>${subDishRows}</ul></details>` : '')
      : '';
    const table =
      `<div class="dish-price-wrap"><table class="dish-price-table" aria-label="${esc(i.name)}各星級成本、售價與利潤">` +
      '<thead><tr><th scope="col">星級</th><th scope="col">成本</th><th scope="col">售價</th><th scope="col">利潤</th></tr></thead>' +
      `<tbody>${e.stars.map(s => dishPriceRow(i, e, s)).join('')}</tbody></table></div>`;
    const notes =
      (e.costNote ? `<p class="dish-cost-note">${esc(e.costNote)}</p>` : '') +
      (e.missing.length ? `<p class="dish-cost-note">缺少單價：${esc(e.missing.join('、'))}</p>` : '');
    return subDishNote + table + notes;
  }
  // 料理價格表的一列：星級、成本、售價、利潤（虧損標紅；不計利潤的料理顯示 X）
  function dishPriceRow(i, e, s) {
    const excluded = JournalCore.excludesProfit(i);
    const cls = excluded ? '' : Number.isFinite(s.profit) && s.profit < 0 ? 'loss' : 'gain';
    const profit = excluded ? 'X' : (Number.isFinite(s.profit) && s.profit > 0 ? '+' : '') + money(s.profit);
    return `<tr><th scope="row">${s.star} 星</th><td>${money(e.cost)}</td><td>${money(s.price)}</td><td class="${cls}">${profit}</td></tr>`;
  }
  /* ----------------------------------------------------------------
   * 主要列表：魚、蟲、鳥、料理的表格渲染
   * ---------------------------------------------------------------- */
  // 表頭：可排序的欄位用 sortHeader()
  function listHeader(c, f, habitat) {
    const third = habitat ? sortHeader('出沒地點', 'location') : `<th>${c === 'plants' ? '花色・生長' : '所需食材'}</th>`;
    const fourth =
      c === 'dishes'
        ? sortHeader(`${Number(f.profitStar || 1)} 星利潤`, 'profit') + sortHeader('金額', 'price')
        : `<th>${habitat ? '時段・天氣' : '花色資料'}</th>`;
    return (
      `<tr><th>${c === 'plants' ? '收集' : '五星'}</th>${sortHeader(meta[c].name + '名稱', 'name')}${sortHeader('等級', 'level')}` +
      `${third}${fourth}<th>詳情</th></tr>`
    );
  }
  // 魚、蟲、鳥：出沒時段與天氣
  function habitatTimes(i) {
    const weather =
      i.weather
        .map(w => `<span class="${{ 晴: 'sunny', 雨: 'rainy', 彩虹: 'rainbow' }[w] || ''}">${{ 晴: '☀ 晴', 雨: '☂ 雨', 彩虹: '🌈 彩虹日' }[w]}</span>`)
        .join('') || '天氣未知';
    return line(i.times.length === 4 ? '全天' : i.times.join(' / ') || '時段未知') + `<div class="weather-symbols">${weather}</div>`;
  }
  // 列表第 4、5 欄：info（地點／花色／食材）與 extra（時段天氣／售價／利潤）
  function rowColumns(i, c, f, habitat) {
    let info = '',
      extra = '';
    if (habitat) {
      info = c === 'bugs' ? bugLocationLines(i) : line(locationSummary(i));
      if (c === 'fish') info += `<span class="number">魚影：${esc(i.raw['魚影大小'] || '未知')}</span>`;
      if (c === 'birds') info += `<span class="number">完美距離：${esc(i.raw['完美距離'] || '未知')}</span>`;
      extra = habitatTimes(i);
    } else if (c === 'plants') {
      const price = i.raw[(i.stars?.[0] || 5) + '星'];
      info =
        line(i.color === '待確認' ? '花色待確認' : i.color + ' · ' + i.stars.join('/') + '星') +
        `<span class="number">生長：${esc(i.raw['生長週期'] || '未知')}</span>`;
      extra = line('售價：' + (price === 'N/A' ? '未知' : (price ?? '未知')));
    } else {
      info =
        Object.entries(i.ingredients)
          .map(([name, n]) => line(name + ' × ' + n))
          .join('') || line('來源未提供');
      info += `<span class="number">解鎖：${esc(i.raw['解鎖方式'] || '未知')}</span>`;
      const star = Number(f.profitStar || 1),
        profit = i.economics?.stars.find(s => s.star === star)?.profit;
      const excluded = JournalCore.excludesProfit(i);
      extra = `<strong class="${excluded ? '' : Number.isFinite(profit) && profit < 0 ? 'loss' : 'gain'}">${excluded ? 'X' : money(profit)}</strong>`;
    }
    if (c === 'birds') {
      info = line(locationSummary(i)) + `<span class="number">完美距離：${esc(i.raw['完美距離'] || '未知')}</span>`;
      extra =
        '<div class="bird-general-conditions"><strong>一般出沒時段・天氣</strong>' +
        extra +
        '</div><div class="bird-five-info bird-five-conditions"><strong>五星時段・天氣</strong>' +
        birdDetails(i, true) +
        '</div>' +
        (birdWhistleNote(i) ? '<div class="bird-whistle-info"><strong>鳥哨</strong>' + line(birdWhistleNote(i)) + '</div>' : '');
    }
    return { info, extra };
  }
  // 名稱下方的徽章：收錄類型、限時材料、限時料理台、花色
  function itemBadges(i, c) {
    return (
      `<span class="badge ${JournalCore.kindClass(i)}">${esc(JournalCore.kindLabel(i))}</span>` +
      (c === 'dishes' && JournalCore.limitedIngredients(i, LIMITED_MATERIALS).length ? '<span class="badge limited">限時材料</span>' : '') +
      (c === 'dishes' && JournalCore.needsActivityStation(i) === true
        ? '<span class="badge station" title="需要活動限定料理台，活動結束後無法製作">限時料理台</span>'
        : '') +
      (i.color ? `<span class="badge ${i.trackable ? 'color' : 'unknown'}">${esc(i.color)}</span>` : '')
    );
  }
  // 勾選欄：不能收集的項目停用並說明原因
  function itemCheckCell(i, c, fullname) {
    const disabled = i.trackable
      ? ''
      : i.displayOnly
        ? 'disabled title="僅供展示，不列入收集"'
        : 'disabled title="來源花色尚待確認"';
    return `<td><label class="check-label"><input type="checkbox" data-check="${i.id}" aria-label="${esc(fullname)} ${c === 'plants' ? '已收集此花色' : '已取得五星'}" ${state.done[i.id] ? 'checked' : ''} ${disabled}><span aria-hidden="true">✓</span></label></td>`;
  }
  function renderItemRow(i, c, f, habitat) {
    const { info, extra } = rowColumns(i, c, f, habitat);
    const fullname = i.name + (i.color ? '・' + i.color : '');
    const currency = c === 'dishes' ? `<td class="dish-currency-cell">${dishCurrencySummary(i, Number(f.profitStar || 1))}</td>` : '';
    return (
      `<tr class="item ${state.done[i.id] ? 'complete' : ''}" data-item="${i.id}">${itemCheckCell(i, c, fullname)}` +
      `<td><span class="item-name">${esc(i.name)}</span><div class="item-meta">${itemBadges(i, c)}</div></td>` +
      `${levelCell(i)}<td>${info}</td><td>${extra}</td>${currency}` +
      `<td><button class="row-detail" data-detail="${i.id}" aria-label="查看${esc(fullname)}資料" aria-expanded="false">${c === 'dishes' ? '詳情 ＋' : '資料 ＋'}</button></td></tr>`
    );
  }
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
    if (state.active === 'plants') {
      renderFlowers();
      return;
    }
    const c = state.active,
      f = state.filters[c],
      group = ITEMS.filter(i => i.category === c),
      visible = JournalCore.filterItems(group, f, state.done, LIMITED_MATERIALS);
    const habitat = ['fish', 'bugs', 'birds'].includes(c),
      pending = visible.filter(i => !i.trackable && !i.displayOnly).length;
    document.querySelectorAll('[data-status]').forEach(b => {
      b.classList.toggle('active', b.dataset.status === f.status);
      b.setAttribute('aria-pressed', String(b.dataset.status === f.status));
    });
    $('result-count').textContent = `顯示 ${visible.length} 項`;
    $('result-note').textContent =
      `${visible.filter(i => state.done[i.id]).length} 項已完成${pending ? ' · ' + pending + ' 項資料待確認' : ''}`;
    $('thead').innerHTML = listHeader(c, f, habitat);
    $('rows').innerHTML = visible.map(i => renderItemRow(i, c, f, habitat)).join('');
    renderEmptyState(visible.length);
    $('thead').hidden = visible.length === 0;
    updateProgress();
  }
  $('categories').innerHTML = JournalCore.categories
    .map(
      c =>
        `<button id="nav-${c}" class="nav-item" data-category="${c}"><span class="nav-icon">${icon(c)}</span><span class="nav-name">${{ fish: '釣魚', bugs: '捕蟲', birds: '觀鳥', plants: '園藝', dishes: '烹飪' }[c]}</span><span class="nav-count"></span></button>`,
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
      (key === 'growth' && state.active !== 'plants') ||
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

  // 換分類時沿用上一頁的共用篩選：收錄類型、可獲取、完成狀態；
  // 愛好等級各分類分開記憶（例如釣魚 10 級、觀鳥 8 級），不跨頁同步；
  // 天氣與時段只在釣魚、捕蟲、觀鳥之間同步（園藝、烹飪沒有這兩項）
  const HABITAT = ['fish', 'bugs', 'birds'];
  function switchCategory(next) {
    const from = state.filters[state.active],
      to = state.filters[next];
    if (from && to && next !== state.active) {
      // 搜尋文字不跨頁保留：換頁時兩邊都清空
      from.search = '';
      to.search = '';
      to.kind = [...from.kind];
      to.cookableOnly = from.cookableOnly;
      to.status = from.status;
      if (HABITAT.includes(state.active) && HABITAT.includes(next)) {
        to.weather = from.weather;
        to.time = from.time;
      }
    }
    state.active = next;
  }
  $('categories').addEventListener('click', e => {
    const b = e.target.closest('[data-category]');
    if (!b) return;
    switchCategory(b.dataset.category);
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
  // 可獲取一定可製作：勾選「當前可獲取」時，「當前可製作」自動勾選且不能取消
  function syncCraftableBox(f) {
    $('craftable-only').checked = f.craftableOnly || f.cookableOnly;
    $('craftable-only').disabled = f.cookableOnly;
  }
  $('cookable-only').addEventListener('change', () => {
    const f = state.filters[state.active];
    f.cookableOnly = $('cookable-only').checked;
    if (f.cookableOnly) f.craftableOnly = true;
    syncCraftableBox(f);
    save();
    renderRows();
  });
  $('craftable-only').addEventListener('change', () => {
    state.filters[state.active].craftableOnly = $('craftable-only').checked;
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
      craftableOnly: false,
    });
    JournalCore.syncHabitatFilters(state, state.active);
    save();
    configureCategory();
  }
  /* 已套用的篩選：沒有結果時列出「清除篩選」會清掉的條件（天氣、時段不清除，所以不列）。 */
  function appliedFilters() {
    const c = state.active,
      f = state.filters[c],
      habitat = ['fish', 'bugs', 'birds'].includes(c),
      list = [];
    if (f.status !== 'all') list.push({ todo: '未完成', done: '已完成' }[f.status]);
    if (f.search) list.push('搜尋「' + f.search + '」');
    if (f.level !== 'all') list.push(f.level + ' 級以下');
    if (f.kind.length !== 3) list.push(f.kind.length ? f.kind.join('、') : '未選擇收錄類型');
    if (habitat && f.location !== 'all') list.push($('location').selectedOptions[0]?.textContent || f.location);
    if (c === 'plants' && f.plantType !== 'all') list.push({ flower: '花卉', crop: '作物' }[f.plantType]);
    if (c === 'birds' && f.fiveStarOnly) list.push('僅五星');
    if (f.cookableOnly) list.push('當前可獲取');
    else if (c === 'dishes' && f.craftableOnly) list.push('當前可製作');
    return list;
  }
  // 沒有結果時依原因提供下一步：有套用篩選就給「清除篩選」；沒有的話提示天氣、時段
  function renderEmptyState(count) {
    const c = state.active,
      list = appliedFilters(),
      noun = { fish: '魚類', bugs: '蟲類', birds: '鳥類', plants: '花卉或作物', dishes: '料理' }[c];
    $('empty').hidden = count > 0;
    $('empty-title').textContent = '目前沒有符合條件的' + noun + '。';
    $('empty-hint').textContent = list.length
      ? '已套用：' + list.join(' · ')
      : ['fish', 'bugs', 'birds'].includes(c)
        ? '試著調整天氣或時段。'
        : '';
    $('empty-hint').hidden = !$('empty-hint').textContent;
    $('empty-reset').hidden = !list.length;
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
    if (c === 'plants') parts.push({ all: '花卉與作物', flower: '花卉', crop: '作物' }[f.plantType]);
    if (c === 'dishes') parts.push(f.profitStar + ' 星利潤');
    if (f.cookableOnly) parts.push('當前可獲取');
    else if (c === 'dishes' && f.craftableOnly) parts.push('當前可製作');
    $('filter-summary').textContent = '目前篩選：' + parts.join(' · ');
    // 手機版收合列：顯示和預設條件不同的篩選數（搜尋與完成狀態收合時仍看得到，不計入）
    const d = JournalCore.defaults(c);
    const changed = [
      f.level !== d.level,
      f.kind.length !== d.kind.length,
      habitat && f.weather !== d.weather,
      habitat && f.location !== d.location,
      c === 'plants' && f.plantType !== d.plantType,
      c === 'birds' && f.fiveStarOnly !== d.fiveStarOnly,
      c === 'dishes' && f.profitStar !== d.profitStar,
      f.cookableOnly !== d.cookableOnly,
      c === 'dishes' && !f.cookableOnly && f.craftableOnly !== d.craftableOnly,
    ].filter(Boolean).length;
    $('filter-count').textContent = changed;
    $('filter-count').hidden = !changed;
    $('filter-reset-mini').hidden = !changed;
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
  // 問題紀錄的版本資訊一律取自最新一筆更新紀錄與資料版本，更新網站時不用手動改
  function currentReleaseLabel() {
    const latest = (DATA.changelog || [])[0];
    const release = latest
      ? `v${latest.version}（${String(latest.date || '').replaceAll('-', '/')} 更新）`
      : '版本未知';
    return `${release}・資料版本 ${DATA.dataVersion || '未知'}`;
  }
  $('report-issue').addEventListener('click', () => {
    $('report-text').value =
      '心動小鎮五星圖鑑 ' + currentReleaseLabel() + '\n分類：' +
      { fish: '釣魚', bugs: '捕蟲', birds: '觀鳥', plants: '園藝', dishes: '烹飪' }[state.active] +
      '\n' +
      $('filter-summary').textContent +
      '\n\n項目名稱：\n遇到的問題：\n預期資料：\n可核對的來源與日期：\n裝置與瀏覽器：';
    $('report-dialog').showModal();
  });
  $('copy-report').addEventListener('click', async () => {
    const field = $('report-text');
    try {
      await navigator.clipboard.writeText(field.value);
    } catch {
      // 不支援剪貼簿 API（例如非 HTTPS）時，改用選取文字＋execCommand
      field.focus();
      field.select();
      if (!document.execCommand('copy')) {
        toast('無法自動複製，請手動選取文字後複製。');
        return;
      }
    }
    toast('已複製問題紀錄，請貼到留言告知作者。');
    // 提示會被對話框背景遮住，按鈕本身也短暫顯示已複製
    const button = $('copy-report');
    button.textContent = '已複製 ✓';
    clearTimeout(button._resetTimer);
    button._resetTimer = setTimeout(() => (button.textContent = '複製問題紀錄'), 2000);
  });
  function resetFilters() {
    state.filters[state.active] = JournalCore.defaults(state.active);
    JournalCore.syncHabitatFilters(state, state.active);
    save();
    configureCategory();
  }
  $('reset-filters').addEventListener('click', resetFilters);
  // 手機版：篩選條件預設收合，只露出搜尋、完成狀態與這一列；桌面版這一列隱藏、條件全部顯示
  $('filter-toggle').addEventListener('click', () => {
    const open = !$('filter-panel').classList.contains('is-open');
    $('filter-panel').classList.toggle('is-open', open);
    $('filter-toggle').setAttribute('aria-expanded', String(open));
  });
  $('filter-reset-mini').addEventListener('click', resetFilters);
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
    if (i.category === 'plants') {
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
        pending = visible.filter(i => !i.trackable && !i.displayOnly).length;
      $('result-note').textContent =
        `${visible.filter(i => state.done[i.id]).length} 項已完成${pending ? ' · ' + pending + ' 項資料待確認' : ''}`;
    }
  });
  /* ----------------------------------------------------------------
   * 列表「資料／詳情」展開後的內容
   * ---------------------------------------------------------------- */
  const PRICED_CATEGORIES = ['fish', 'bugs', 'birds'];
  // 料理：特殊製作方式（不是在料理台製作的料理，例如溫泉蛋）、成本售價利潤、食材
  function dishDetail(i) {
    const method = i.raw?.['製作方式']
      ? '<section class="dish-method"><h4>製作方式</h4><p>' + esc(i.raw['製作方式']) + '</p></section>'
      : '';
    const ingredients = Object.keys(i.ingredients || {}).length
      ? '<ul>' +
        Object.entries(i.ingredients)
          .map(
            ([name, n]) =>
              '<li' + (LIMITED_MATERIALS.has(name) ? ' class="limited-material"' : '') + '>' + esc(name) + ' <b>× ' + esc(n) + '</b></li>',
          )
          .join('') +
        '</ul>'
      : line('來源未提供');
    return (
      method +
      '<section class="dish-economics-detail"><h4>成本・售價・利潤</h4>' +
      dishEconomics(i) +
      '</section><section class="dish-ingredients"><h4>食材</h4>' +
      ingredients +
      '</section>'
    );
  }
  // 觀鳥：五星條件；非活動鳥另列百科的一般出沒條件
  function birdDetailPanel(i) {
    if (i.eventName) return birdDetails(i);
    return (
      birdDetails(i) +
      '<h4>一般出沒條件</h4>' +
      line('時段：' + (i.times.length === 4 ? '全天' : i.times.join(' / '))) +
      line('天氣：' + i.weather.join('／'))
    );
  }
  // 來源原始欄位：魚蟲鳥只列 1–5 星售價；料理整塊隱藏
  function rawGrid(i) {
    const priced = PRICED_CATEGORIES.includes(i.category);
    const pairs = Object.entries(i.raw)
      .filter(([key]) => key !== '編號' && i.category !== 'dishes' && (!priced || /^[1-5]星$/.test(key)))
      .map(
        ([key, value]) =>
          `<div class="raw-pair"><dt>${esc(priced ? key + '售價' : key)}</dt><dd>${esc(value === '' || value === 'N/A' ? 'N/A' : value)}</dd></div>`,
      )
      .join('');
    return (
      (priced ? '<h4>星級售價</h4>' : '') +
      `<dl ${i.category === 'dishes' ? 'hidden' : ''} class="raw-grid${priced ? ' fish-prices' : ''}">${pairs}</dl>`
    );
  }
  function itemDetailPanel(i) {
    const sourceNote =
      PRICED_CATEGORIES.includes(i.category) || i.category === 'dishes'
        ? ''
        : '<div class="detail-source">來源原始欄位 · O 表示來源勾選；來源空白或 N/A 皆顯示為 N/A。花卉依所有花色分開記錄，全部花色收齊才算完成；不確定資訊標示待確認。</div>';
    return (
      `<td colspan="${i.category === 'dishes' ? 7 : 6}">` +
      eventDetails(i) +
      (i.category === 'dishes' ? dishDetail(i) : '') +
      (i.category === 'birds' ? birdDetailPanel(i) : '') +
      rawGrid(i) +
      dropDetails(i) +
      sourceNote +
      '</td>'
    );
  }
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
    tr.innerHTML = itemDetailPanel(i);
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
      const achievements = Object.keys(pendingImport.state.achievements).length,
        pets = pendingImport.state.pets.length,
        skipped = pendingImport.skipped;
      $('import-summary').textContent =
        `目前有 ${before} 筆勾選，備份含 ${after} 筆可還原勾選（花卉按花色記錄；完成率按整種花計算）。` +
        `備份另含 ${achievements} 項成就、${pets} 隻寵物紀錄。` +
        (skipped ? '另有 ' + skipped + ' 項無法對應目前圖鑑，將略過。' : '');
      $('import-dialog').showModal();
    } catch (e) {
      pendingImport = null;
      toast(e instanceof SyntaxError ? '檔案不是有效的 JSON 備份。' : e.message);
    }
  });
  function restore(merge) {
    if (!pendingImport) return;
    if (merge) {
      state.done = { ...state.done, ...pendingImport.state.done };
      state.achievements = { ...state.achievements, ...pendingImport.state.achievements };
      state.pets = JournalCore.mergePets(state.pets, pendingImport.state.pets);
    } else state = pendingImport.state;
    selectedPetId = null;
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
  // 更新紀錄：由 data/changelog.json 產生。文字先全部跳脫，只放行 <strong>…</strong>
  const changelog = DATA.changelog || [];
  const richText = s => esc(s).replace(/&lt;(\/?)strong&gt;/g, '<$1strong>');
  $('release-batches').innerHTML = changelog.length
    ? changelog
        .map(
          (entry, n) =>
            `<article class="release-batch" aria-labelledby="release-title-${n}"><h3 id="release-title-${n}">v${esc(entry.version)} · ${esc(String(entry.date || '').replaceAll('-', '/'))} ${esc(entry.label || '更新')}</h3>` +
            (entry.summary ? `<p class="release-count-line">${richText(entry.summary)}</p>` : '') +
            `<ul class="release-bullets">${(entry.items || [])
              .map(item => `<li>${item.title ? `<strong>${esc(item.title)}</strong>：` : ''}${richText(item.text)}</li>`)
              .join('')}</ul></article>`,
        )
        .join('')
    : '<p class="release-loading">目前沒有更新紀錄。</p>';
  // 版本告示（說明視窗）跟著最新一筆更新紀錄
  if (changelog[0]) {
    const latest = changelog[0],
      [y, m, d] = String(latest.date || '').split('-').map(Number);
    const versionEl = document.querySelector('#help-dialog .release-notice strong'),
      timeEl = document.querySelector('#help-dialog .release-notice time');
    if (versionEl) versionEl.textContent = '版本告示 · v' + latest.version;
    if (timeEl && y) {
      timeEl.setAttribute('datetime', latest.date);
      timeEl.textContent = `${y} 年 ${m} 月 ${d} 日`;
    }
  }
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
    const panel = e.target.closest('[data-home-panel]');
    if (panel) return showPanel(panel.dataset.homePanel);
    const b = e.target.closest('[data-home-category]');
    if (!b) return;
    switchCategory(b.dataset.homeCategory);
    showView(false);
    save();
    configureCategory();
  });
  $('home-continue').addEventListener('click', () => {
    showView(false);
    configureCategory();
  });
  /* ----------------------------------------------------------------
   * 右上角「配色」面板：這裡只負責打開／關閉；選色塊後換配色的程式在 js/theme.js
   * ---------------------------------------------------------------- */
  function setThemeMenu(open) {
    $('theme-menu').hidden = !open;
    $('theme-toggle').setAttribute('aria-expanded', String(open));
  }
  $('theme-toggle').addEventListener('click', e => {
    e.stopPropagation();
    setThemeMenu($('theme-menu').hidden);
  });
  // 點面板內部不要關閉面板（選色塊由 js/theme.js 處理）
  $('theme-menu').addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', () => setThemeMenu(false));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('theme-menu').hidden) {
      setThemeMenu(false);
      $('theme-toggle').focus();
    }
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
  /* ----------------------------------------------------------------
   * 成就：依 data/achievements.json 分組顯示，勾選紀錄存在 state.achievements
   * ---------------------------------------------------------------- */
  const ACHIEVEMENT_GROUPS = (DATA.achievementGroups || []).map(g => ({
    key: String(g.key || ''),
    name: String(g.name || ''),
    unlock: String(g.unlock || ''),
    title: String(g.title || ''),
    note: String(g.note || ''),
    items: (Array.isArray(g.items) ? g.items : []).filter(i => i && i.id && i.name),
  }));
  // 大滿貫：該組所有稱號都勾選時自動視為達成（不另外存檔）
  const groupComplete = g => g.items.length > 0 && g.items.every(i => state.achievements[i.id]);
  function achievementStats(items = ACHIEVEMENT_GROUPS.flatMap(g => g.items)) {
    return { done: items.filter(i => state.achievements[i.id]).length, total: items.length };
  }
  function updatePanelCounts() {
    const a = achievementStats();
    $('nav-achievements').querySelector('.nav-count').textContent = a.total ? `${a.done} / ${a.total}` : '';
    $('nav-pets').querySelector('.nav-count').textContent = state.pets.length ? state.pets.length + ' 隻' : '';
    $('pets-count').textContent = state.pets.length ? state.pets.length + ' 隻' : '';
  }
  // 各大滿貫的展開／收合狀態只記在這台瀏覽器（不進備份）；預設展開
  const ACH_COLLAPSE_KEY = KEY + '.achievements-collapsed';
  const collapsedGroups = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(ACH_COLLAPSE_KEY) || '[]');
    if (Array.isArray(saved)) saved.forEach(k => typeof k === 'string' && collapsedGroups.add(k));
  } catch {
    // 讀不到就全部展開
  }
  function saveCollapsedGroups() {
    try {
      localStorage.setItem(ACH_COLLAPSE_KEY, JSON.stringify([...collapsedGroups]));
    } catch {
      // 記不住展開狀態不影響勾選
    }
  }
  function achievementItem(i) {
    const done = state.achievements[i.id];
    return `<li><label class="achievement-item${done ? ' is-done' : ''}"><input type="checkbox" data-achievement="${esc(i.id)}"${done ? ' checked' : ''}><span><b>${esc(i.name)}</b>${i.desc ? `<small>${esc(i.desc)}</small>` : ''}</span></label></li>`;
  }
  // 批量：這一組的稱號全部勾選或全部取消
  function achievementBatchBar(g, s) {
    const key = esc(g.key);
    return (
      '<div class="batch-bar">' +
      `<button type="button" class="button batch-button" data-achievement-batch="all" data-group="${key}"${s.done === s.total ? ' disabled' : ''}>全部完成</button>` +
      `<button type="button" class="text-button" data-achievement-batch="none" data-group="${key}"${s.done ? '' : ' disabled'}>全部取消</button>` +
      '</div>'
    );
  }
  // 一組大滿貫：可收合的標題、進度條、獲得稱號與解鎖條件、稱號清單、備註
  function achievementGroup(g) {
    const s = achievementStats(g.items),
      complete = groupComplete(g);
    const info = [
      g.title && `<p><b>獲得稱號</b><span class="achievement-reward">${esc(g.title)}</span></p>`,
      g.unlock && `<p><b>解鎖條件</b>${esc(g.unlock)}</p>`,
    ].filter(Boolean).join('');
    const open = !collapsedGroups.has(g.key),
      bodyId = 'achievement-body-' + g.key;
    const head =
      `<header class="calc-card-heading achievement-head" data-achievement-toggle="${esc(g.key)}">` +
      `<h2><button type="button" class="achievement-toggle" aria-expanded="${open}" aria-controls="${bodyId}">${esc(g.name)}</button></h2>` +
      (complete ? '<span class="achievement-badge">已達成</span>' : '') +
      `<span class="achievement-group-count">${s.total ? s.done + ' / ' + s.total : '待補'}</span><span class="achievement-chevron" aria-hidden="true"></span></header>`;
    const meter = `<div class="achievement-meter" aria-hidden="true"><i style="width:${s.total ? Math.round((s.done / s.total) * 100) : 0}%"></i></div>`;
    const list = g.items.length
      ? achievementBatchBar(g, s) + `<ul class="achievement-list">${g.items.map(i => achievementItem(i)).join('')}</ul>`
      : '<p class="panel-empty">成就名稱與描述待補，資料更新後即可勾選。</p>';
    return (
      `<section class="calc-card achievement-group${complete ? ' is-complete' : ''}${open ? '' : ' is-collapsed'}">` +
      head +
      meter +
      `<div class="achievement-body" id="${bodyId}"${open ? '' : ' hidden'}>` +
      (info ? `<div class="achievement-info">${info}</div>` : '') +
      list +
      (g.note ? `<footer class="achievement-foot"><p>${esc(g.note)}</p></footer>` : '') +
      '</div></section>'
    );
  }
  function renderAchievements() {
    const all = achievementStats(),
      pct = all.total ? Math.round((all.done / all.total) * 100) : 0;
    const slams = ACHIEVEMENT_GROUPS.filter(g => g.items.length);
    $('achievements-count').textContent = all.total
      ? `大滿貫 ${slams.filter(groupComplete).length} / ${slams.length} · 稱號 ${all.done} / ${all.total}（${pct}%）`
      : '成就資料待補';
    $('achievements-bar').style.width = pct + '%';
    // 已達成的大滿貫排到最後，其餘維持資料檔順序
    const ordered = [...ACHIEVEMENT_GROUPS.filter(g => !groupComplete(g)), ...ACHIEVEMENT_GROUPS.filter(groupComplete)];
    $('achievement-groups').innerHTML = ordered.length ? achievementColumns(ordered) : '<p class="panel-empty">成就資料待補。</p>';
    balanceAchievementColumns(ordered);
    updatePanelCounts();
  }
  // 頁面看得到時，用實際高度重新分配左右欄（估算只在頁面隱藏時使用）
  function balanceAchievementColumns(groups) {
    const cols = $('achievement-groups').querySelectorAll('.achievement-col');
    if (cols.length !== 2) return;
    const sections = groups.map(g =>
      $('achievement-groups').querySelector(`[data-achievement-toggle="${CSS.escape(g.key)}"]`)?.closest('.achievement-group'),
    );
    if (sections.some(s => !s || !s.offsetHeight)) return;
    const heights = sections.map(s => s.offsetHeight);
    // 組數很少：試遍所有左右分法（第一組固定在左欄），取較高那欄最矮的分法；各欄內維持原本順序
    let best = null;
    const n = sections.length;
    if (n > 12) return;
    for (let mask = 0; mask < 1 << n; mask += 2) {
      let left = 0,
        right = 0;
      heights.forEach((h, i) => ((mask >> i) & 1 ? (right += h) : (left += h)));
      const tallest = Math.max(left, right);
      if (!best || tallest < best.tallest) best = { tallest, mask };
    }
    sections.forEach((s, i) => cols[(best.mask >> i) & 1].appendChild(s));
  }
  // 寬螢幕分左右兩欄：依序把每組放進目前比較短的那一欄（收合的組很矮），
  // 避免收合幾組後，展開的組全部擠在同一邊。窄螢幕維持單欄、資料順序。
  const ACH_ONE_COLUMN = window.matchMedia('(max-width: 800px)');
  function achievementWeight(g) {
    if (collapsedGroups.has(g.key)) return 1.3;
    return 2 + (g.items.length || 1) + (g.title || g.unlock ? 1 : 0) + (g.note ? 1 : 0);
  }
  function achievementColumns(groups) {
    if (ACH_ONE_COLUMN.matches) return groups.map(achievementGroup).join('');
    const cols = [
      { html: '', h: 0 },
      { html: '', h: 0 },
    ];
    for (const g of groups) {
      const col = cols[1].h < cols[0].h ? cols[1] : cols[0];
      col.html += achievementGroup(g);
      col.h += achievementWeight(g);
    }
    return cols.map(c => `<div class="achievement-col">${c.html}</div>`).join('');
  }
  ACH_ONE_COLUMN.addEventListener('change', () => {
    if (!$('achievements-view').hidden) renderAchievements();
  });
  $('achievement-groups').addEventListener('click', e => {
    const batch = e.target.closest('[data-achievement-batch]');
    if (batch) {
      const g = ACHIEVEMENT_GROUPS.find(x => x.key === batch.dataset.group);
      if (!g) return;
      const all = batch.dataset.achievementBatch === 'all';
      if (!all && !confirm(`確定取消「${g.name}」的全部 ${g.items.length} 項勾選嗎？`)) return;
      for (const i of g.items) {
        if (all) state.achievements[i.id] = true;
        else delete state.achievements[i.id];
      }
      save();
      renderAchievements();
      updateProgress();
      toast(all ? `「${g.name}」已全部完成。` : `已取消「${g.name}」的勾選。`);
      return $('achievement-groups')
        .querySelector(`[data-group="${CSS.escape(g.key)}"][data-achievement-batch="${all ? 'none' : 'all'}"]`)
        ?.focus({ preventScroll: true });
    }
    const head = e.target.closest('[data-achievement-toggle]');
    if (!head) return;
    const key = head.dataset.achievementToggle;
    if (collapsedGroups.has(key)) collapsedGroups.delete(key);
    else collapsedGroups.add(key);
    saveCollapsedGroups();
    renderAchievements();
    $('achievement-groups')
      .querySelector(`[data-achievement-toggle="${CSS.escape(key)}"] .achievement-toggle`)
      ?.focus({ preventScroll: true });
  });
  $('achievement-groups').addEventListener('change', e => {
    const id = e.target.dataset?.achievement;
    if (!id) return;
    if (e.target.checked) state.achievements[id] = true;
    else delete state.achievements[id];
    save();
    updateProgress();
    $('achievement-groups').querySelector(`[data-achievement="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  });
  /* ----------------------------------------------------------------
   * 寵物：玩家自行新增寵物（state.pets），食物清單來自 data/pet-foods.json
   * 食物可加 "for": "cat" 或 "dog"，只顯示給該種類；沒寫則貓和狗都顯示
   * ---------------------------------------------------------------- */
  const PET_FOODS = (DATA.petFoods || []).filter(f => f && f.id && f.name);
  const PET_TYPE_NAME = { cat: '貓', dog: '狗' };
  let selectedPetId = (() => {
      try {
        return localStorage.getItem(KEY + '.pet');
      } catch {
        return null;
      }
    })(),
    petFilter = 'all',
    petSearch = '';
  // 正在新增備註、但還沒打字的食物（只在畫面上暫時展開）
  const openNotes = new Set();
  const noteAddButton = f =>
    `<button type="button" class="pet-note-add" data-note-add="${esc(f.id)}" aria-label="替${esc(f.name)}新增備註" title="新增備註"><span aria-hidden="true">＋</span>備註</button>`;
  // 有備註或剛按了「+」才顯示輸入欄，否則只顯示「+」
  function noteField(pet, f) {
    const text = pet.notes[f.id] || '';
    if (!text && !openNotes.has(f.id)) return noteAddButton(f);
    return `<input type="text" class="pet-food-note${text ? ' has-note' : ''}" data-note-food="${esc(f.id)}" maxlength="${JournalCore.MAX_PET_NOTE}" placeholder="備註" aria-label="${esc(f.name)}備註" value="${esc(text)}">`;
  }
  const newRecordId = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(10)), b => b.toString(16).padStart(2, '0')).join('');
  // 沒有 "for" 的食物是貓狗通用，兩種寵物都會顯示
  const foodsFor = pet => PET_FOODS.filter(f => !f.for || f.for === pet.type);
  // 食物有 "link"（圖鑑項目 ID，例如料理或魚）時，名稱可點，跳到該分類並捲到那一項
  const ITEM_BY_ID = new Map(ITEMS.map(i => [i.id, i]));
  const CATEGORY_LABEL = { fish: '釣魚', bugs: '捕蟲', birds: '觀鳥', plants: '園藝', dishes: '烹飪' };
  function openItem(id) {
    const item = ITEM_BY_ID.get(id);
    if (!item || !JournalCore.categories.includes(item.category)) return;
    const cat = item.category;
    switchCategory(cat);
    // 放寬篩選，確保這一項一定會出現在列表裡
    Object.assign(state.filters[cat], {
      search: item.name,
      level: 'all',
      kind: ['日常', '當前活動', '過往活動'],
      status: 'all',
      location: 'all',
      time: 'all',
      plantType: 'all',
      fiveStarOnly: false,
      cookableOnly: false,
    });
    if (Array.isArray(item.weather) && item.weather.length && !item.weather.includes(state.filters[cat].weather))
      state.filters[cat].weather = item.weather.includes('晴') ? '晴' : item.weather[0];
    JournalCore.syncHabitatFilters(state, cat);
    showView(false);
    save();
    configureCategory();
    const row = document.querySelector(`#rows [data-item="${CSS.escape(id)}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.classList.add('jump-target');
      setTimeout(() => row.classList.remove('jump-target'), 2000);
    }
  }
  function currentPet() {
    return state.pets.find(p => p.id === selectedPetId) || state.pets[0] || null;
  }
  // 寵物卡片標題：種類、可直接修改的名稱、吃過／喜歡／不喜歡統計、改名與刪除、進度條
  function petHeader(pet, total, eaten, liked, disliked) {
    return (
      `<header class="calc-card-heading"><span class="pet-type-badge pet-${pet.type}">${PET_TYPE_NAME[pet.type]}</span>` +
      `<h2 class="pet-name-head"><input id="pet-rename-input" class="pet-name-edit" type="text" maxlength="20" value="${esc(pet.name)}" aria-label="寵物名稱（可直接修改）" title="點一下即可修改名稱"></h2>` +
      `<span class="pet-stats" aria-label="吃過 ${eaten} / ${total}，喜歡 ${liked}，不喜歡 ${disliked}">` +
      `<span>吃過 <b>${eaten}</b> / ${total}</span><span class="is-like">♥ <b>${liked}</b></span><span class="is-dislike">✕ <b>${disliked}</b></span></span>` +
      '<span class="pet-actions"><button type="button" class="text-button" data-pet-rename>改名</button><button type="button" class="text-button pet-delete" data-pet-delete>刪除</button></span></header>' +
      `<div class="achievement-meter pet-meter" aria-hidden="true"><i style="width:${total ? Math.round((eaten / total) * 100) : 0}%"></i></div>`
    );
  }
  // 搜尋框與篩選按鈕；「已吃過」與「不喜歡」合併成一個篩選：吃過但沒標喜歡
  // 目前列出的食物：套用搜尋文字與「全部／未吃過／喜歡／不喜歡」篩選
  function shownPetFoods(pet) {
    const query = petSearch.trim().toLowerCase();
    return foodsFor(pet).filter(
      f =>
        (!query || f.name.toLowerCase().includes(query) || (pet.notes[f.id] || '').toLowerCase().includes(query)) &&
        (petFilter === 'all' ||
          (petFilter === 'todo' && !pet.eaten[f.id]) ||
          (petFilter === 'liked' && pet.liked[f.id]) ||
          (petFilter === 'disliked' && pet.eaten[f.id] && !pet.liked[f.id])),
    );
  }
  function petToolbar() {
    const filters = { all: '全部', todo: '未吃過', liked: '喜歡', disliked: '不喜歡' };
    const buttons = Object.entries(filters)
      .map(([k, v]) => `<button type="button" data-pet-filter="${k}" class="${petFilter === k ? 'active' : ''}" aria-pressed="${petFilter === k}">${v}</button>`)
      .join('');
    return (
      `<div class="pet-toolbar"><label class="search-wrap"><span>⌕</span><input id="pet-search" type="search" placeholder="搜尋食物…" aria-label="搜尋食物" value="${esc(petSearch)}"></label>` +
      `<div class="segments" role="group" aria-label="食物篩選">${buttons}</div></div>` +
      petBatchBar()
    );
  }
  // 批量：只在「未吃過」篩選時出現，把目前列出的未吃過食物全部設為「不喜歡」（可再用搜尋縮小範圍）
  function petBatchBar() {
    if (petFilter !== 'todo') return '';
    const pet = currentPet();
    const targets = pet ? shownPetFoods(pet).filter(f => !(pet.eaten[f.id] && !pet.liked[f.id])) : [];
    return (
      '<div class="batch-bar pet-batch-bar"><span>批量設定目前列出的未吃過食物</span>' +
      `<button type="button" class="button batch-button" data-pet-batch="dislike"${targets.length ? '' : ' disabled'}><span aria-hidden="true">✕</span>全部設為不喜歡（${targets.length} 樣）</button></div>`
    );
  }
  // 一種食物：名稱（有圖鑑資料時可跳過去）、魚的地點、備註、未吃過／喜歡／不喜歡、筆記
  function petFoodItem(pet, f) {
    const status = !pet.eaten[f.id] ? 'none' : pet.liked[f.id] ? 'like' : 'dislike',
      choices = { none: ['○', '未吃過'], like: ['♥', '喜歡'], dislike: ['✕', '不喜歡'] };
    const linked = ITEM_BY_ID.get(f.link);
    const name = linked
      ? `<button type="button" class="pet-food-link" data-pet-link="${esc(f.link)}" title="到${CATEGORY_LABEL[linked.category] || '圖鑑'}頁查看${esc(f.name)}">${esc(f.name)}<span aria-hidden="true"> ↗</span></button>`
      : esc(f.name);
    const where =
      linked?.category === 'fish' && linked.locations?.length
        ? `<small class="pet-food-where">${esc(linked.locations.join('、'))}</small>`
        : '';
    const pref = Object.entries(choices)
      .map(
        ([k, [mark, text]]) =>
          `<button type="button" class="pet-choice pet-${k}${status === k ? ' active' : ''}" data-pet-state="${k}" data-food="${esc(f.id)}" aria-pressed="${status === k}"><span aria-hidden="true">${mark}</span>${text}</button>`,
      )
      .join('');
    return (
      `<li class="pet-food is-${status}"><div class="pet-food-name">${name}${where}${f.note ? `<small>${esc(f.note)}</small>` : ''}</div>` +
      `<div class="pet-pref" role="group" aria-label="${esc(pet.name)}${esc(f.name)}">${pref}</div>${noteField(pet, f)}</li>`
    );
  }
  function renderPets() {
    const pet = currentPet();
    selectedPetId = pet?.id ?? null;
    // 記住目前看的寵物，重新開啟寵物頁時回到同一隻
    try {
      if (selectedPetId) localStorage.setItem(KEY + '.pet', selectedPetId);
    } catch {
      // 記不住也不影響紀錄
    }
    $('pet-tabs').innerHTML = state.pets
      .map(
        p =>
          `<button type="button" class="pet-tab${p.id === selectedPetId ? ' active' : ''}" data-pet="${esc(p.id)}" aria-pressed="${p.id === selectedPetId}"><span class="pet-type-badge pet-${p.type}">${PET_TYPE_NAME[p.type]}</span>${esc(p.name)}</button>`,
      )
      .join('');
    updatePanelCounts();
    if (!pet) {
      $('pet-detail').innerHTML = '<p class="panel-empty">還沒有寵物。輸入名字並選擇貓或狗，按「新增寵物」開始記錄。</p>';
      return;
    }
    const foods = foodsFor(pet),
      eaten = foods.filter(f => pet.eaten[f.id]).length,
      liked = foods.filter(f => pet.liked[f.id]).length,
      disliked = eaten - liked,
      shown = shownPetFoods(pet);
    const list = shown.length
      ? `<ul class="pet-food-list">${shown.map(f => petFoodItem(pet, f)).join('')}</ul>`
      : '<p class="panel-empty">這個條件下沒有食物。</p>';
    $('pet-detail').innerHTML =
      '<section class="calc-card pet-card">' +
      petHeader(pet, foods.length, eaten, liked, disliked) +
      (foods.length
        ? petToolbar() + list
        : '<p class="panel-empty">食物清單待補，資料更新後即可記錄吃過、喜歡與不喜歡的食物。</p>') +
      '</section>';
  }
  $('pet-form').addEventListener('submit', e => {
    e.preventDefault();
    let name = $('pet-name').value.trim().slice(0, 20);
    // 沒填名字就自動取「未命名1」「未命名2」…，挑第一個沒被用過的號碼
    if (!name) {
      const used = new Set(state.pets.map(p => p.name));
      let n = 1;
      while (used.has(`未命名${n}`)) n++;
      name = `未命名${n}`;
    }
    if (state.pets.length >= JournalCore.MAX_PETS)
      return toast(`最多可記錄 ${JournalCore.MAX_PETS} 隻寵物。`);
    const pet = { id: newRecordId(), name, type: $('pet-type').value === 'dog' ? 'dog' : 'cat', eaten: {}, liked: {}, notes: {} };
    state.pets.push(pet);
    selectedPetId = pet.id;
    $('pet-name').value = '';
    save();
    updateProgress();
    toast(`已新增「${name}」。`);
  });
  $('pets-view').addEventListener('click', e => {
    const tab = e.target.closest('[data-pet]');
    if (tab) {
      selectedPetId = tab.dataset.pet;
      openNotes.clear();
      return renderPets();
    }
    const pet = currentPet();
    if (!pet) return;
    const filter = e.target.closest('[data-pet-filter]');
    if (filter) {
      petFilter = filter.dataset.petFilter;
      return renderPets();
    }
    const addNote = e.target.closest('[data-note-add]');
    if (addNote) {
      const id = addNote.dataset.noteAdd;
      openNotes.add(id);
      renderPets();
      // 只展開這一次；之後畫面重畫時，沒打字的空白備註會自動收回成「+」
      openNotes.clear();
      return $('pet-detail').querySelector(`[data-note-food="${CSS.escape(id)}"]`)?.focus();
    }
    const itemLink = e.target.closest('[data-pet-link]');
    if (itemLink) return openItem(itemLink.dataset.petLink);
    const refocus = sel => $('pet-detail').querySelector(sel)?.focus({ preventScroll: true });
    if (e.target.closest('[data-pet-batch="dislike"]') && petFilter === 'todo') {
      const targets = shownPetFoods(pet).filter(f => !(pet.eaten[f.id] && !pet.liked[f.id]));
      if (!targets.length) return;
      const liked = targets.filter(f => pet.liked[f.id]).length;
      if (
        !confirm(
          `確定把目前列出的 ${targets.length} 樣食物都設為「不喜歡」嗎？` +
            (liked ? `其中 ${liked} 樣原本是「喜歡」，也會改成「不喜歡」。` : '') +
            '之後可以逐一改回。',
        )
      )
        return;
      for (const f of targets) {
        pet.eaten[f.id] = true;
        delete pet.liked[f.id];
      }
      save();
      renderPets();
      toast(`已把 ${targets.length} 樣食物設為「不喜歡」。`);
      return refocus('[data-pet-batch]');
    }
    const stateBtn = e.target.closest('[data-pet-state]');
    if (stateBtn) {
      // 三選一：未吃過＝清除；喜歡＝吃過＋喜歡；不喜歡＝吃過但不標喜歡
      const id = stateBtn.dataset.food,
        next = stateBtn.dataset.petState;
      if (next === 'none') delete pet.eaten[id];
      else pet.eaten[id] = true;
      if (next === 'like') pet.liked[id] = true;
      else delete pet.liked[id];
      save();
      renderPets();
      return refocus(`[data-pet-state="${next}"][data-food="${CSS.escape(id)}"]`);
    }
    if (e.target.closest('[data-pet-rename]')) {
      // 改名：直接把標題的名字欄位選起來，打字即可修改
      const box = $('pet-rename-input');
      box.focus();
      return box.select();
    }
    if (e.target.closest('[data-pet-delete]')) {
      if (!confirm(`確定要刪除「${pet.name}」和牠的所有飲食紀錄嗎？刪除後無法復原。`)) return;
      state.pets = state.pets.filter(p => p.id !== pet.id);
      selectedPetId = null;
      save();
      updateProgress();
      toast(`已刪除「${pet.name}」。`);
    }
  });
  // 標題上的名字欄位：離開欄位或按 Enter 時儲存；清空則還原原本的名字
  $('pets-view').addEventListener('change', e => {
    if (e.target.id !== 'pet-rename-input') return;
    const pet = currentPet();
    if (!pet) return;
    const name = e.target.value.trim().slice(0, 20);
    if (!name || name === pet.name) {
      e.target.value = pet.name;
      return;
    }
    pet.name = name;
    save();
    renderPets();
    toast(`已改名為「${name}」。`);
  });
  // 備註欄離開時若是空的，就收回成「+」（只換掉這一格，不重畫整個清單）
  $('pets-view').addEventListener('focusout', e => {
    const box = e.target.closest('[data-note-food]');
    if (!box || box.value.trim()) return;
    const id = box.dataset.noteFood,
      food = PET_FOODS.find(f => f.id === id);
    openNotes.delete(id);
    if (food) box.outerHTML = noteAddButton(food);
  });
  $('pets-view').addEventListener('keydown', e => {
    if (e.target.id !== 'pet-rename-input') return;
    if (e.key === 'Enter') e.target.blur();
    else if (e.key === 'Escape') {
      e.target.value = currentPet()?.name || '';
      e.target.blur();
    }
  });
  $('pets-view').addEventListener('input', e => {
    const noteBox = e.target.closest('[data-note-food]');
    if (noteBox) {
      // 食物備註邊打邊存，不重新繪製畫面以免游標跳走
      const pet = currentPet();
      if (!pet) return;
      const text = noteBox.value.slice(0, JournalCore.MAX_PET_NOTE);
      if (text.trim()) pet.notes[noteBox.dataset.noteFood] = text;
      else delete pet.notes[noteBox.dataset.noteFood];
      noteBox.classList.toggle('has-note', !!text.trim());
      return save();
    }
    if (e.target.id !== 'pet-search') return;
    petSearch = e.target.value;
    const pos = e.target.selectionStart;
    renderPets();
    const box = $('pet-search');
    box.focus();
    box.setSelectionRange(pos, pos);
  });
  $('nav-achievements').addEventListener('click', () => showPanel('achievements'));
  $('nav-pets').addEventListener('click', () => showPanel('pets'));
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
  if (PANELS.includes(initialView)) showPanel(initialView);
  else showView(homeVisible);
  refreshEventSchedule();
  configureCategory();
  // 側欄的成就／寵物數字：開站就算好，不必等點進該頁
  updatePanelCounts();
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
