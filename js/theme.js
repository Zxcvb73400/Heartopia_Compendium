/* 配色切換（v1.3.1）＋夜間模式（v1.3.2）
 * 在 <head> 最先載入：頁面畫出來之前就套用上次選的配色與明暗，避免先閃一下預設綠色或白底。
 * 選擇存在 localStorage（只記在這個瀏覽器，不進備份檔）。
 * 顏色值寫在 css/themes.css；按鈕與面板在 index.html 的 #theme-toggle、#theme-menu，
 * 面板的開關（點按鈕打開、點外面或按 Esc 關閉）在 js/app.js，這裡只處理「選了哪個配色」與「夜間模式」開關。
 * 新增配色時，這裡的 THEMES 也要加上英文名。
 * 夜間模式：沒動過開關時跟隨系統（auto）；動過就記成 light 或 dark。夜間時在 <html> 加上 data-mode="dark"。 */
(function () {
  'use strict';
  var KEY = 'heartopia-five-star-atlas.v1.theme';
  var MODE_KEY = 'heartopia-five-star-atlas.v1.mode';
  var DEFAULT = 'forest'; // 森林綠：css/style.css 的 :root，不加 data-theme
  var THEMES = ['forest', 'tea', 'honey', 'maple', 'cocoa', 'sakura', 'milk', 'mauve', 'lavender', 'bay', 'black', 'white']; // 順序與面板色塊相同
  var MODES = ['auto', 'light', 'dark'];
  var root = document.documentElement;
  var systemDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function load(key, list, fallback) {
    try {
      var saved = localStorage.getItem(key);
      return list.indexOf(saved) >= 0 ? saved : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function save(key, value, fallback) {
    try {
      if (value === fallback) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (err) {
      /* 無痕模式等無法儲存時，只套用這次 */
    }
  }

  function read() {
    return load(KEY, THEMES, DEFAULT);
  }

  function readMode() {
    return load(MODE_KEY, MODES, 'auto');
  }

  function apply(name) {
    if (name === DEFAULT) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', name);
  }

  function applyMode(mode) {
    var dark = mode === 'dark' || (mode === 'auto' && !!systemDark && systemDark.matches);
    if (dark) root.setAttribute('data-mode', 'dark');
    else root.removeAttribute('data-mode');
  }

  // 手機瀏覽器網址列的顏色：淺色跟著主色，夜間用頁面底色
  function syncMetaColor() {
    var meta = document.querySelector('meta[name="theme-color"]');
    var token = root.getAttribute('data-mode') === 'dark' ? '--bg' : '--green';
    var color = getComputedStyle(root).getPropertyValue(token).trim();
    if (meta && color) meta.setAttribute('content', color);
  }

  // 面板上的色塊：標出目前配色
  function syncSwatches(name) {
    var swatches = document.querySelectorAll('[data-theme-swatch]');
    for (var i = 0; i < swatches.length; i++) {
      var on = swatches[i].getAttribute('data-theme-swatch') === name;
      swatches[i].classList.toggle('active', on);
      swatches[i].setAttribute('aria-pressed', String(on));
    }
  }

  // 夜間模式開關：顯示目前實際是不是夜間
  function syncDarkSwitch() {
    var input = document.getElementById('theme-dark');
    if (input) input.checked = root.getAttribute('data-mode') === 'dark';
  }

  apply(read());
  applyMode(readMode());

  // 「自動」時，系統切換深淺色就跟著換
  if (systemDark) {
    var onSystemChange = function () {
      if (readMode() !== 'auto') return;
      applyMode('auto');
      syncMetaColor();
      syncDarkSwitch();
    };
    if (systemDark.addEventListener) systemDark.addEventListener('change', onSystemChange);
    else if (systemDark.addListener) systemDark.addListener(onSystemChange);
  }

  document.addEventListener('DOMContentLoaded', function () {
    syncMetaColor();
    syncSwatches(read());
    syncDarkSwitch();
    var dark = document.getElementById('theme-dark');
    if (dark) {
      dark.addEventListener('change', function () {
        var mode = dark.checked ? 'dark' : 'light';
        applyMode(mode);
        save(MODE_KEY, mode, 'auto');
        syncMetaColor();
      });
    }
    var menu = document.getElementById('theme-menu');
    if (!menu) return;
    menu.addEventListener('click', function (e) {
      var swatch = e.target.closest('[data-theme-swatch]');
      if (!swatch) return;
      var name = swatch.getAttribute('data-theme-swatch');
      if (THEMES.indexOf(name) < 0) name = DEFAULT;
      apply(name);
      save(KEY, name, DEFAULT);
      syncSwatches(name);
      syncMetaColor();
    });
  });
})();
