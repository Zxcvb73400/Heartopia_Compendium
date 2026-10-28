/* =====================================================================
 * journal-core.js ── 圖鑑的核心邏輯（篩選、排序、活動檔期、存檔檢查）
 *
 * 這個檔案「只處理資料」，完全不碰畫面（沒有 document / 按鈕 / HTML），
 * 所以可以單獨測試。畫面相關的程式在 app.js。
 * 對外提供：JournalCore（網頁用）；若在 Node.js 執行，則用 module.exports 匯出。
 * ===================================================================== */
const JournalCore = (() => {
  /* ----------------------------------------------------------------
   * 基本設定：分類清單、預設篩選條件、活動標籤
   * ---------------------------------------------------------------- */
  const categories = ['fish', 'bugs', 'birds', 'flowers', 'dishes'];
  const currentTimeSlot = (date = new Date()) =>
    ['0-6時', '6-12時', '12-18時', '18-24時'][Math.floor(date.getHours() / 6)];
  const defaults = category => ({
    search: '',
    level: '10',
    kind: ['日常', '當前活動', '過往活動'],
    weather: '晴',
    time: currentTimeSlot(),
    location: 'all',
    status: 'all',
    sort: 'number',
    profitStar: '1',
    plantType: 'all',
    fiveStarOnly: false,
    cookableOnly: true,
  });
  const kindLabel = item =>
    ['當前活動', '過往活動'].includes(item.kind) && item.eventName
      ? `${item.kind} · ${item.eventName}`
      : item.eventStatus === 'upcoming'
        ? '活動（尚未開始）'
        : item.kind === '活動'
          ? '活動（效期待確認）'
          : item.kind;
  /* ----------------------------------------------------------------
   * 地點處理：把地點整理成「區域」與篩選選項
   * ---------------------------------------------------------------- */
  function locationRegions(value, category) {
    if (category === 'birds' && /[／/]/.test(value))
      return [
        ...new Set(
          value
            .split(/[／/]/)
            .map(part => part.trim())
            .filter(Boolean)
            .flatMap(part => locationRegions(part, category)),
        ),
      ];
    if (category === 'fish' && value === '雀鱔魚（事件）') return ['雀鱔魚（事件）'];
    if (category === 'fish' && value === '海釣（事件）') return ['海釣（事件）'];
    if (category === 'birds' && /^(戴勝鳥事件|戴勝鳥（事件）)/.test(value))
      return value.split('/').map(x => (x.startsWith('戴勝鳥') ? '戴勝鳥（事件）' : x));
    if (category === 'fish' && /^(雀鱔魚事件(?:-|$)|事件$|雀鱔魚 \(事件\)$)/.test(value))
      return ['雀鱔魚（事件）'];
    if (category === 'fish' && /^(海釣(?:-|$)|海釣\(事件\)$)/.test(value)) return ['海釣（事件）'];
    if (category === 'birds' && /^(事件-(冬令採錄|特殊積木鳥|紳士鴿)|過往事件)$/.test(value))
      return ['過往事件'];
    if (
      category === 'bugs' &&
      (value.startsWith('事件-') || value.startsWith('引蟲出洞-') || value === '引蟲出洞（事件）')
    )
      return ['事件'];
    const aliases = {
      '水邊': '水域',
      '海洋': '海域',
      '森林湖畔': '森林湖',
      '舊海海邊': '舊海',
      '鯨魚海海邊': '鯨魚海',
      '舊海鯨魚海': '舊海／鯨魚海',
      '東海緩風海': '東海／緩風海',
      '「百鳥歸巢」事件': '百鳥歸巢（事件）',
      '百鳥歸巢': '百鳥歸巢（事件）',
      '百鳥歸巢（事件）': '百鳥歸巢（事件）',
      '百鳥歸巢(事件)': '百鳥歸巢（事件）',
      '百鳥歸巢事件': '百鳥歸巢（事件）',
      '百鳥歸巢隱藏': '百鳥歸巢（事件）',
    };
    const base = (category === 'bugs' ? value.split(/\s*[-－–—]\s*/) : value.split('-'))[0].trim();
    return (Object.prototype.hasOwnProperty.call(aliases, base) ? aliases[base] : base).split('／');
  }
  function matchesLocation(locations, choice, category) {
    if (choice === 'all') return true;
    if (choice.startsWith('exact:')) return locations.some(x => String(x).trim() === choice.slice(6).trim());
    const wanted = locationRegions(choice.slice(choice.indexOf(':') + 1), category);
    return locations.some(x => locationRegions(x, category).some(root => wanted.includes(root)));
  }
  function locationChoices(items) {
    const groups = [
      ...new Set(
        items.flatMap(i =>
          [...i.locations, ...(i.fiveStar?.locations || [])].flatMap(x => locationRegions(x, i.category)),
        ),
      ),
    ].sort((a, b) => {
      const eventOrder = Number(a.includes('事件')) - Number(b.includes('事件'));
      if (eventOrder) return eventOrder;
      if (items.some(i => i.category === 'fish') && a.includes('事件') && b.includes('事件')) {
        const order = ['海釣（事件）', '雀鱔魚事件（事件）', '幽光魚潮（事件）'];
        const ai = order.indexOf(a),
          bi = order.indexOf(b);
        if (ai !== bi && (ai >= 0 || bi >= 0)) return ai < 0 ? 1 : bi < 0 ? -1 : ai - bi;
      }
      return a.localeCompare(b, 'zh-Hant');
    });
    return { groups, exact: [] };
  }
  function locationSortKey(item) {
    const places =
      item.category === 'birds'
        ? item.locations.flatMap(x => locationRegions(x, item.category))
        : item.locations;
    return [...new Set(places)].sort((a, b) => a.localeCompare(b, 'zh-Hant')).join(' / ');
  }
  /* ----------------------------------------------------------------
   * 排序：生長時間、活動分組、依編號／價格／利潤排序
   * ---------------------------------------------------------------- */
  function growthMinutes(item) {
    const text = String(item.raw?.['生長週期'] ?? '').replace(/\s+/g, '');
    const parts = [...text.matchAll(/(\d+(?:\.\d+)?)天|(\d+(?:\.\d+)?)小時|(\d+(?:\.\d+)?)(?:分鐘|分)/g)];
    if (!parts.length || parts.map(p => p[0]).join('') !== text) return null;
    return parts.reduce(
      (total, p) =>
        total +
        (p[1] !== undefined ? Number(p[1]) * 1440 : p[2] !== undefined ? Number(p[2]) * 60 : Number(p[3])),
      0,
    );
  }
  function compareActivityGroups(a, b) {
    const rank = i => (i.kind === '日常' ? 0 : i.kind === '當前活動' ? 1 : i.kind === '過往活動' ? 2 : 3);
    const name = i => (i.kind === '日常' ? '' : String(i.eventName || '').trim());
    const av = name(a),
      bv = name(b);
    return (
      rank(a) - rank(b) || (Boolean(av) !== Boolean(bv) ? (av ? -1 : 1) : av.localeCompare(bv, 'zh-Hant'))
    );
  }
  function excludesProfit(item) {
    return item?.category === 'dishes' && item.name?.startsWith('詭異的');
  }
  function compareItems(a, b, f) {
    if (f.sort === 'price-asc' || f.sort === 'price-desc') {
      const star = Number(f.profitStar || 1),
        av = a.economics?.stars?.find(s => s.star === star)?.price,
        bv = b.economics?.stars?.find(s => s.star === star)?.price;
      const ak = Number.isFinite(av),
        bk = Number.isFinite(bv);
      if (ak !== bk) return ak ? -1 : 1;
      if (ak && av !== bv) return (f.sort === 'price-desc' ? -1 : 1) * (av - bv);
    }
    if (f.sort === 'profit-desc' || f.sort === 'profit-asc') {
      const star = Number(f.profitStar || 1),
        av = excludesProfit(a) ? NaN : a.economics?.stars.find(s => s.star === star)?.profit,
        bv = excludesProfit(b) ? NaN : b.economics?.stars.find(s => s.star === star)?.profit;
      const ak = Number.isFinite(av),
        bk = Number.isFinite(bv);
      if (ak !== bk) return ak ? -1 : 1;
      if (ak && av !== bv) return f.sort === 'profit-desc' ? bv - av : av - bv;
    }
    const tie = Number(a.number) - Number(b.number) || String(a.id).localeCompare(String(b.id));
    if (f.sort === 'number') {
      if (a.category === 'birds' && b.category === 'birds') {
        const raven = i => /渡鴉/.test(i.name);
        const position = i => {
          const n = Number(i.number);
          return raven(i) ? 306 + n / 10000 : n >= 306 ? n + 10 : n;
        };
        const av = position(a),
          bv = position(b);
        if (av !== bv) return av - bv;
        if (raven(a) && raven(b)) return String(a.id).localeCompare(String(b.id));
      }
      return a.category === 'dishes' && b.category === 'dishes' ? tie : compareActivityGroups(a, b) || tie;
    }
    if (f.sort === 'growth' || f.sort === 'growth-desc') {
      const av = growthMinutes(a),
        bv = growthMinutes(b),
        ak = Number.isFinite(av),
        bk = Number.isFinite(bv);
      if (ak !== bk) return ak ? -1 : 1;
      return (ak ? (f.sort === 'growth-desc' ? -1 : 1) * (av - bv) : 0) || tie;
    }
    if (f.sort === 'location' || f.sort === 'location-desc') {
      const av = locationSortKey(a),
        bv = locationSortKey(b);
      if (Boolean(av) !== Boolean(bv)) return av ? -1 : 1;
      return (f.sort === 'location-desc' ? -1 : 1) * av.localeCompare(bv, 'zh-Hant') || tie;
    }
    if (f.sort === 'name' || f.sort === 'name-desc')
      return (
        (f.sort === 'name-desc' ? -1 : 1) *
          (a.name + (a.color || '')).localeCompare(b.name + (b.color || ''), 'zh-Hant') || tie
      );
    if (f.sort === 'level' || f.sort === 'level-desc') {
      const ak = Number.isFinite(a.level),
        bk = Number.isFinite(b.level);
      if (ak !== bk) return ak ? -1 : 1;
      if (ak && a.level !== b.level) return (f.sort === 'level-desc' ? -1 : 1) * (a.level - b.level);
    }
    return tie;
  }
  /* ----------------------------------------------------------------
   * 活動檔期：判斷活動進行中／已結束、料理能否製作
   * ---------------------------------------------------------------- */
  function applyEventSchedule(item, now = Date.now(), schedules = {}) {
    const schedule = (item.eventName && schedules[item.eventName]) || item.eventSchedule;
    if (!schedule) return { ...item };
    const start = schedule.startsAt ? Date.parse(schedule.startsAt) : NaN,
      end = schedule.endsAt ? Date.parse(schedule.endsAt) : NaN;
    const expired = Number.isFinite(end)
        ? now >= end
        : schedule.status === 'expired' || item.eventStatus === 'expired' || item.kind === '過往活動',
      upcoming = !expired && Number.isFinite(start) && now < start;
    const outside = expired || upcoming;
    return {
      ...item,
      kind: expired ? '過往活動' : upcoming ? '活動' : '當前活動',
      eventStatus: expired ? 'expired' : upcoming ? 'upcoming' : 'active',
      eventAvailable: item.category === 'dishes' ? undefined : !outside,
    };
  }
  function limitedIngredients(item, limitedMaterials = new Set()) {
    const schedule = item.eventSchedule;
    if (item.category !== 'dishes' || schedule?.requiresActivityStation === true) return [];
    return Object.keys(item.ingredients || {}).filter(name => limitedMaterials.has(name));
  }
  function isAvailable(item, limitedMaterials = new Set()) {
    const schedule = item.category === 'dishes' && item.eventSchedule;
    if (schedule?.requiresActivityStation === true) return item.eventStatus === 'active';
    if (schedule?.requiresActivityStation === false) return true;
    if (typeof item.eventAvailable === 'boolean') return item.eventAvailable;
    if (typeof item.available === 'boolean') return item.available;
    if (item.category === 'dishes' && typeof item.cookable === 'boolean') return item.cookable;
    const mark = item.raw?.['當前可用'] ?? (item.category === 'dishes' ? item.raw?.['可製作'] : undefined);
    if (mark === true || mark === '是' || mark === '可用' || mark === '可製作') return true;
    if (mark === false || mark === '否' || mark === '不可用' || mark === '不可製作') return false;
    return item.kind === '日常' || item.kind === '當前活動';
  }
  /* ----------------------------------------------------------------
   * 篩選：依搜尋字、等級、天氣、時段、地點等條件過濾
   * ---------------------------------------------------------------- */
  const kindClass = item =>
    item.kind === '當前活動' ? 'kind-current' : item.kind === '過往活動' ? 'kind-past' : 'kind-daily';
  function filterItems(items, f, done, limitedMaterials = new Set()) {
    const query = f.search.trim().toLocaleLowerCase();
    const rainbowOnly = f.weather === 'rainbow-only',
      weather = rainbowOnly ? '彩虹' : f.weather;
    return items
      .filter(i => {
        const level = i.level;
        if (f.level !== 'all' && (level === null || level === undefined || level > Number(f.level)))
          return false;
        if (
          !f.kind.includes(i.kind) &&
          !(f.kind.length === 3 && !['日常', '當前活動', '過往活動'].includes(i.kind))
        )
          return false;
        if (f.cookableOnly && !isAvailable(i, limitedMaterials)) return false;
        if (
          i.category === 'flowers' &&
          f.plantType &&
          f.plantType !== 'all' &&
          (i.plantType || 'flower') !== f.plantType
        )
          return false;
        if (f.status === 'done' && !done[i.id]) return false;
        if (f.status === 'todo' && done[i.id]) return false;
        if (
          query &&
          ![
            i.name,
            i.eventName || '',
            ...(i.aliases || []),
            i.color,
            i.fiveStar?.name || '',
            ...i.locations,
            ...(i.fiveStar?.locations || []),
            ...Object.keys(i.ingredients),
            i.raw['解鎖方式'] || '',
          ]
            .join(' ')
            .toLocaleLowerCase()
            .includes(query)
        )
          return false;
        if (rainbowOnly && ['fish', 'bugs', 'birds'].includes(i.category)) {
          const weathers =
            i.category === 'birds' && f.fiveStarOnly
              ? (i.fiveStarConditions || []).flatMap(r => r.weather || [])
              : i.weather;
          if (!weathers.includes('彩虹') || weathers.some(w => w !== '彩虹')) return false;
        }
        if (i.category === 'birds' && f.fiveStarOnly) {
          if (
            !i.fiveStarConditions?.some(
              rule =>
                Array.isArray(rule.times) &&
                rule.times.length > 0 &&
                Array.isArray(rule.weather) &&
                rule.weather.length > 0 &&
                (f.time === 'all' || rule.times.includes(f.time)) &&
                (weather === 'all' || rule.weather.includes(weather)),
            )
          )
            return false;
        }
        if (['fish', 'bugs', 'birds'].includes(i.category) && !(i.category === 'birds' && f.fiveStarOnly)) {
          if (weather !== 'all' && i.weather.length > 0 && !i.weather.includes(weather)) return false;
          if (f.time !== 'all' && i.times.length > 0 && !i.times.includes(f.time)) return false;
          const birdExactStage =
            i.category === 'birds' && f.location.startsWith('exact:')
              ? i.fiveStar?.locations || []
              : i.locations;
          const birdLocations =
            i.category === 'birds' && !f.location.startsWith('exact:')
              ? [...birdExactStage, ...(i.fiveStar?.locations || [])]
              : birdExactStage;
          if (!matchesLocation(birdLocations, f.location, i.category)) return false;
        }
        if (i.category === 'birds' && f.fiveStarOnly) {
          const locations =
            i.name === '綠孔雀' && !f.location.startsWith('exact:')
              ? i.locations
              : i.fiveStar?.locations || [];
          if (!matchesLocation(locations, f.location, i.category)) return false;
        }
        return true;
      })
      .sort((a, b) => compareItems(a, b, f));
  }
  /* ----------------------------------------------------------------
   * 花朵：同一種花的不同花色合併成一列顯示
   * ---------------------------------------------------------------- */
  function flowerGroups(items, done) {
    const groups = new Map();
    for (const i of items.filter(i => i.category === 'flowers')) {
      const key = JSON.stringify([i.plantType || 'flower', i.name, i.kind]);
      if (!groups.has(key)) groups.set(key, { ...i, colors: [] });
      groups.get(key).colors.push(i);
    }
    return [...groups.values()].map(g => ({
      ...g,
      collected: g.colors.filter(i => i.trackable && done[i.id]).length,
      complete: g.colors.every(i => i.trackable && done[i.id]),
      trackable: g.colors.every(i => i.trackable),
    }));
  }
  function visibleFlowers(items, f, done) {
    const matching = new Set(filterItems(items, { ...f, status: 'all' }, done).map(i => i.id));
    const groups = flowerGroups(items, done).filter(
      g =>
        g.colors.some(i => matching.has(i.id)) &&
        (f.status === 'all' || (f.status === 'done' ? g.complete : !g.complete)),
    );
    return groups.sort((a, b) => {
      return compareItems({ ...a, color: '' }, { ...b, color: '' }, f);
    });
  }
  /* ----------------------------------------------------------------
   * 棲地篩選：天氣、時段、地點三個下拉選單互相連動
   * ---------------------------------------------------------------- */
  function syncHabitatFilters(state, source) {
    if (!['fish', 'bugs', 'birds'].includes(source)) return;
    const { weather, time } = state.filters[source];
    for (const c of ['fish', 'bugs', 'birds']) Object.assign(state.filters[c], { weather, time });
  }
  /* ----------------------------------------------------------------
   * 存檔：檢查並清理使用者的收藏紀錄與備份檔
   * ---------------------------------------------------------------- */
  function sanitizeState(input, items, retiredIds = []) {
    const value = input && typeof input === 'object' ? input : {};
    const state = {
      active: categories.includes(value.active) ? value.active : 'fish',
      done: {},
      filters: {},
    };
    for (const i of items)
      if (
        i.trackable &&
        [i.id, ...(i.legacyIds || [])].some(
          id => value.done?.[id] === true || value.flowerColorArchive?.[id] === true,
        )
      )
        state.done[i.id] = true;
    for (const id of retiredIds) if (value.done?.[id] === true) state.done[id] = true;
    for (const c of categories) {
      const f = defaults(c),
        v = { ...(value.filters?.[c] || {}) };
      if (typeof v.search === 'string') f.search = v.search.slice(0, 200);
      f.fiveStarOnly = c === 'birds' && v.fiveStarOnly === true;
      if (typeof v.cookableOnly === 'boolean') f.cookableOnly = v.cookableOnly;
      const places = locationChoices(items.filter(i => i.category === c));
      if (c === 'bugs' && v.location === 'exact:引蟲出洞（事件）') v.location = 'group:事件';
      if (typeof v.location === 'string' && /^(exact|group):/.test(v.location)) {
        const exactValue = v.location.startsWith('exact:') ? v.location.slice(6) : '';
        if (!places.exact.includes(exactValue)) {
          const root =
            c === 'birds' && v.location === 'group:事件'
              ? '過往事件'
              : locationRegions(v.location.slice(6), c)[0];
          if (places.groups.includes(root)) v.location = 'group:' + root;
        }
      }
      const options = {
        level: ['all', ...Array.from({ length: 14 }, (_, i) => String(i + 1))],
        kind: ['all', '日常', '當前活動', '過往活動'],
        weather: ['晴', '雨', '彩虹', 'rainbow-only'],
        time: ['all', '0-6時', '6-12時', '12-18時', '18-24時'],
        status: ['all', 'todo', 'done'],
        sort: [
          'number',
          'level',
          'level-desc',
          'name',
          'name-desc',
          ...(['fish', 'bugs', 'birds'].includes(c) ? ['location', 'location-desc'] : []),
          ...(c === 'dishes' ? ['profit-desc', 'profit-asc', 'price-asc', 'price-desc'] : []),
          ...(c === 'flowers' ? ['growth', 'growth-desc'] : []),
        ],
        profitStar: ['1', '2', '3', '4', '5'],
        plantType: ['all', 'flower', 'crop'],
        location: ['all', ...places.groups.map(x => 'group:' + x), ...places.exact.map(x => 'exact:' + x)],
      };
      for (const [key, allowed] of Object.entries(options))
        if (key !== 'kind' && allowed.includes(v[key])) f[key] = v[key];
      const validKinds = ['日常', '當前活動', '過往活動'];
      f.kind = [
        ...new Set(
          Array.isArray(v.kind)
            ? v.kind.filter(k => validKinds.includes(k))
            : v.kind === 'all' || v.kind == null
              ? validKinds
              : validKinds.includes(v.kind)
                ? [v.kind]
                : validKinds,
        ),
      ];

      state.filters[c] = f;
    }
    syncHabitatFilters(state, ['fish', 'bugs', 'birds'].includes(state.active) ? state.active : 'fish');
    return state;
  }
  function readBackup(value, items, retiredIds = []) {
    if (
      !value ||
      value.app !== 'heartopia-five-star-journal' ||
      value.version !== 1 ||
      !value.state ||
      typeof value.state.done !== 'object' ||
      value.state.done === null ||
      Array.isArray(value.state.done)
    )
      throw new Error('這不是支援的圖鑑備份，請選擇由「匯出備份」產生的 JSON。');
    if (Object.values(value.state.done).some(v => typeof v !== 'boolean'))
      throw new Error('備份中的勾選資料格式不正確。');
    const state = sanitizeState(value.state, items, retiredIds);
    const accepted = new Set([
      ...items.filter(i => i.trackable).flatMap(i => [i.id, ...(i.legacyIds || [])]),
      ...retiredIds,
    ]);
    return {
      state,
      skipped: Object.entries(value.state.done).filter(([key, val]) => val && !accepted.has(key)).length,
    };
  }
  return {
    categories,
    excludesProfit,
    compareItems,
    currentTimeSlot,
    defaults,
    kindLabel,
    kindClass,
    isAvailable,
    limitedIngredients,
    applyEventSchedule,
    locationRegions,
    locationChoices,
    filterItems,
    flowerGroups,
    visibleFlowers,
    syncHabitatFilters,
    sanitizeState,
    readBackup,
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = JournalCore;
