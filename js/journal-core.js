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
  const categories = ['fish', 'bugs', 'birds', 'plants', 'dishes'];
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
    // 烹飪專用：僅顯示可製作（可獲取的料理一定可製作）
    craftableOnly: true,
  });
  // 活動徽章：依目前時間顯示「當前／過往」＋活動類型＋活動名稱，例如「過往潮流季·冰雪季」
  const kindLabel = item =>
    ['當前活動', '過往活動'].includes(item.kind) && item.eventName
      ? item.eventSchedule?.activityType
        ? `${item.kind === '當前活動' ? '當前' : '過往'}${item.eventSchedule.activityType}·${item.eventName}`
        : `${item.kind} · ${item.eventName}`
      : item.eventStatus === 'upcoming'
        ? '活動（尚未開始）'
        : item.kind === '活動'
          ? '活動（效期待確認）'
          : item.kind;
  /* ----------------------------------------------------------------
   * 地點處理：把地點整理成「區域」與篩選選項
   * ---------------------------------------------------------------- */
  const SPECIAL_EVENT = '活動特殊事件';
  const DAILY_EVENTS = ['海釣（事件）', '百鳥歸巢（事件）', '引蟲出洞（事件）'];
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
    // 活動限定的事件（雀鱔魚、幽光魚潮、冰晶魚、積木魚、戴勝鳥、糞金龜異變…）在地點選單統一歸成「活動特殊事件」；
    // 常駐事件（海釣、百鳥歸巢、引蟲出洞）維持各自的選項
    // 「戴勝鳥（事件）-額外階段」這類帶階段的寫法，以「（事件）」之前的事件名稱判斷
    const eventName = String(value).trim().match(/^[^／/]*?（事件）/)?.[0];
    if (eventName && !DAILY_EVENTS.includes(eventName)) return [SPECIAL_EVENT];
    // 常駐事件帶階段（例如「百鳥歸巢（事件）－第二階段」）時，仍歸在原本的事件選項
    if (eventName && String(value).trim() !== eventName) return locationRegions(eventName, category);
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
      // 「活動特殊事件」固定排在所有事件的最後
      const specialOrder = Number(a === SPECIAL_EVENT) - Number(b === SPECIAL_EVENT);
      if (specialOrder) return specialOrder;
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
    // 同值時的排序：日常在前；活動項目依活動開始時間分組（同一活動放一起），
    // 園藝同活動內作物在前、花卉在後，最後依編號
    const isEvent = i => Boolean(String(i.eventName || '').trim());
    const eventTie = () => {
      const ae = isEvent(a),
        be = isEvent(b);
      if (ae !== be) return ae ? 1 : -1;
      if (ae && a.eventName !== b.eventName) {
        const start = i => Date.parse(i.eventSchedule?.startsAt) || Infinity;
        return start(a) - start(b) || String(a.eventName).localeCompare(String(b.eventName), 'zh-Hant');
      }
      if (ae && a.category === 'plants' && b.category === 'plants') {
        const crop = i => (i.plantType === 'crop' ? 0 : 1);
        if (crop(a) !== crop(b)) return crop(a) - crop(b);
      }
      return tie;
    };
    if (f.sort === 'number') {
      // 日常在前（依愛好等級再依編號）；活動項目依活動分組
      const ae = isEvent(a),
        be = isEvent(b);
      if (ae !== be) return ae ? 1 : -1;
      if (!ae) {
        const al = Number.isFinite(a.level) ? a.level : Infinity,
          bl = Number.isFinite(b.level) ? b.level : Infinity;
        if (al !== bl) return al - bl;
        return tie;
      }
      return eventTie();
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
      // 活動項目不論等級，同一活動一律放在一起（日常在前、活動依開始時間分組），活動內再依等級
      if (isEvent(a) || isEvent(b)) {
        if (isEvent(a) !== isEvent(b) || a.eventName !== b.eventName) return eventTie();
      }
      if (ak && a.level !== b.level) return (f.sort === 'level-desc' ? -1 : 1) * (a.level - b.level);
      return eventTie();
    }
    return tie;
  }
  /* ----------------------------------------------------------------
   * 活動檔期：判斷活動進行中／已結束、料理能否製作
   * ---------------------------------------------------------------- */
  function applyEventSchedule(item, now = Date.now(), schedules = {}) {
    // activity-schedules.json 為準；shared.json 的舊檔期只補它沒寫到的欄位
    const named = item.eventName && schedules[item.eventName];
    const schedule = named ? { ...(item.eventSchedule || {}), ...named } : item.eventSchedule;
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
      eventSchedule: schedule,
      kind: expired ? '過往活動' : upcoming ? '活動' : '當前活動',
      eventStatus: expired ? 'expired' : upcoming ? 'upcoming' : 'active',
      eventAvailable: item.category === 'dishes' ? undefined : !outside,
    };
  }
  // 是否需要活動限定料理台：料理資料的「活動料理台需求」優先，其次才看活動檔期設定
  function needsActivityStation(item) {
    if (item.category !== 'dishes') return undefined;
    const mark = item.raw?.['活動料理台需求'];
    if (mark === '否') return false;
    if (mark === '是') return true;
    return item.eventSchedule?.requiresActivityStation;
  }
  function limitedIngredients(item, limitedMaterials = new Set()) {
    if (item.category !== 'dishes' || needsActivityStation(item) === true) return [];
    return Object.keys(item.ingredients || {}).filter(name => limitedMaterials.has(name));
  }
  // 「當前可獲取」：過往活動一律不可獲取；料理另需可製作，且是日常或進行中活動的料理
  function isObtainable(item, limitedMaterials = new Set()) {
    if (item.kind === '過往活動') return false;
    if (item.category !== 'dishes') return isAvailable(item, limitedMaterials);
    return (item.kind === '日常' || item.kind === '當前活動') && isAvailable(item, limitedMaterials);
  }
  // 料理時代表「當前可製作」：需要限時料理台的料理只在活動期間可製作；
  // 活動不在進行中時，用到限時材料的料理也無法製作
  function isAvailable(item, limitedMaterials = new Set()) {
    const station = needsActivityStation(item);
    if (station === true) return item.eventStatus === 'active';
    if (
      item.category === 'dishes' &&
      item.eventStatus &&
      item.eventStatus !== 'active' &&
      limitedIngredients(item, limitedMaterials).length
    )
      return false;
    if (station === false) return true;
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
        // 「當前可獲取」：過往活動一律不可獲取
        if (f.cookableOnly && !isObtainable(i, limitedMaterials)) return false;
        // 料理的「當前可製作」：勾選可獲取時也一定要可製作
        if (i.category === 'dishes' && (f.craftableOnly || f.cookableOnly) && !isAvailable(i, limitedMaterials))
          return false;
        if (
          i.category === 'plants' &&
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
    for (const i of items.filter(i => i.category === 'plants')) {
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
  // 舊版的園藝分類代碼是 flowers（2026-11 改為 plants），讀舊存檔／備份時自動對應
  const LEGACY_CATEGORY = { flowers: 'plants' };
  function sanitizeState(input, items, retiredIds = []) {
    const value = input && typeof input === 'object' ? input : {};
    const active = LEGACY_CATEGORY[value.active] || value.active;
    const state = {
      active: categories.includes(active) ? active : 'fish',
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
        v = { ...(value.filters?.[c] || value.filters?.[Object.keys(LEGACY_CATEGORY).find(k => LEGACY_CATEGORY[k] === c)] || {}) };
      if (typeof v.search === 'string') f.search = v.search.slice(0, 200);
      f.fiveStarOnly = c === 'birds' && v.fiveStarOnly === true;
      if (typeof v.cookableOnly === 'boolean') f.cookableOnly = v.cookableOnly;
      if (typeof v.craftableOnly === 'boolean') f.craftableOnly = v.craftableOnly;
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
          ...(c === 'plants' ? ['growth', 'growth-desc'] : []),
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
    state.achievements = sanitizeFlags(value.achievements);
    state.pets = sanitizePets(value.pets);
    return state;
  }
  /* ----------------------------------------------------------------
   * 成就與寵物：不計入圖鑑總進度，但和勾選紀錄一起保存與備份。
   * 不依目前資料檔過濾 ID，資料暫時下架或還沒補齊時，玩家的紀錄也不會遺失。
   * ---------------------------------------------------------------- */
  const MAX_PETS = 50;
  const MAX_PET_NOTE = 100; // 每樣食物的備註字數上限
  const isRecordId = id => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);
  // { id: true } 形式的勾選紀錄：只保留合法 ID 且值為 true 的項目
  function sanitizeFlags(input) {
    const flags = {};
    if (input && typeof input === 'object' && !Array.isArray(input))
      for (const [id, v] of Object.entries(input)) if (v === true && isRecordId(id)) flags[id] = true;
    return flags;
  }
  // { 食物 ID: '備註' }：只保留合法 ID 與非空白文字
  function sanitizeNotes(input) {
    const notes = {};
    if (input && typeof input === 'object' && !Array.isArray(input))
      for (const [id, v] of Object.entries(input))
        if (isRecordId(id) && typeof v === 'string' && v.trim()) notes[id] = v.slice(0, MAX_PET_NOTE);
    return notes;
  }
  function sanitizePets(input) {
    if (!Array.isArray(input)) return [];
    const seen = new Set(),
      pets = [];
    for (const p of input) {
      if (!p || typeof p !== 'object' || !isRecordId(p.id) || seen.has(p.id)) continue;
      const name = typeof p.name === 'string' ? p.name.trim().slice(0, 20) : '';
      if (!name) continue;
      seen.add(p.id);
      const liked = sanitizeFlags(p.liked);
      // 喜歡的食物一定吃過；吃過但沒標喜歡＝不喜歡（不另存）
      // notes：每樣食物各自的備註（例如要餵幾隻），最多 MAX_PET_NOTE 字
      pets.push({ id: p.id, name, type: p.type === 'dog' ? 'dog' : 'cat', eaten: { ...sanitizeFlags(p.eaten), ...liked }, liked, notes: sanitizeNotes(p.notes) });
      if (pets.length >= MAX_PETS) break;
    }
    return pets;
  }
  // 合併兩份寵物紀錄：同一隻（同 ID）合併吃過與喜歡，備份裡多出來的寵物加在後面
  function mergePets(current, incoming) {
    const merged = current.map(p => ({ ...p, eaten: { ...p.eaten }, liked: { ...p.liked }, notes: { ...p.notes } }));
    for (const p of incoming) {
      const same = merged.find(m => m.id === p.id);
      if (same) {
        Object.assign(same.eaten, p.eaten);
        Object.assign(same.liked, p.liked);
        // 食物備註：目前沒寫的才採用備份裡的內容，避免覆蓋
        for (const [id, text] of Object.entries(p.notes || {})) if (!same.notes[id]) same.notes[id] = text;
      } else if (merged.length < MAX_PETS) merged.push(p);
    }
    return merged;
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
    isObtainable,
    limitedIngredients,
    needsActivityStation,
    applyEventSchedule,
    locationRegions,
    locationChoices,
    filterItems,
    flowerGroups,
    visibleFlowers,
    syncHabitatFilters,
    sanitizeState,
    readBackup,
    mergePets,
    MAX_PETS,
    MAX_PET_NOTE,
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = JournalCore;
