/* ============================================================
 * shared/ui.js — 两模块共用的工具函数
 * 用法：在每个模块的 app.js 之前用 <script src="../shared/ui.js"></script> 引入。
 * 挂载到 window.MorphShared，避免污染 IIFE 作用域。
 * ============================================================ */
(function () {
  'use strict';

  // ---- 跨模块共享的 localStorage key（统一管理，避免一边改 key 一边漏） ----
  const KEYS = {
    // 标签库
    taglibUser: 'mtl_user_entries_v1',
    taglibOverrides: 'mtl_overrides_v1',
    taglibDeleted: 'mtl_deleted_v1',
    taglibWrong: 'mtl_wrong_v1',
    taglibStats: 'mtl_stats_v1',
    taglibTaxo: 'mtl_taxonomy_v1',
    // 练习系统
    quizWrong: 'morphology_wrong_v1',
    quizStats: 'morphology_stats_v1',
    quizUserGroups: 'morphology_user_groups_v1',
    quizUserQuestions: 'morphology_user_questions_v1',
    quizOverrides: 'morphology_q_overrides_v1',
    quizDeleted: 'morphology_q_deleted_v1',
    quizSession: 'morphology_session_v1',
    // 跨模块共享
    uiScale: 'morphology_ui_scale_v1',
  };

  // ---- 安全的 localStorage 读写（带 try/catch + 配额保护） ----
  const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
  const MAX_BATCH_IMAGE_COUNT = 30;
  const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
  const MAX_DATA_URL_CHARS = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 256;

  function formatBytes(n) {
    n = Number(n) || 0;
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1).replace(/\.0$/, '') + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  function isAcceptableImageFile(file) {
    if (!file) return { ok: false, reason: '未选择图片。' };
    if (!/^image\//i.test(file.type || '')) return { ok: false, reason: '请选择图片文件。' };
    if (file.size > MAX_IMAGE_BYTES) return { ok: false, reason: '图片过大（' + formatBytes(file.size) + '）。请压缩到 ' + formatBytes(MAX_IMAGE_BYTES) + ' 以内后再上传。' };
    return { ok: true };
  }

  function isSafeImportFile(file) {
    if (!file) return { ok: false, reason: '未选择文件。' };
    if (file.size > MAX_IMPORT_BYTES) return { ok: false, reason: '导入文件过大（' + formatBytes(file.size) + '）。请拆分或精简图片后再导入。' };
    return { ok: true };
  }

  function isReasonableDataUrl(s) {
    return typeof s === 'string' && /^data:image\//i.test(s) && s.length <= MAX_DATA_URL_CHARS;
  }

  function lsGet(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) {
      toast('保存失败：浏览器存储空间可能已满（图片过多过大）。请精简后重试。', 'bad');
      return false;
    }
  }
  function lsRemove(key) { try { localStorage.removeItem(key); } catch (e) {} }

  // ---- DOM 工具 ----
  function el(tag, props) {
    const n = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
      else n.setAttribute(k, v);
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c == null || c === false) continue;
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return n;
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // 让非按钮元素可被键盘操作（Enter / Space → click）
  function makeKeyboardActivatable(node, label) {
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    if (label) node.setAttribute('aria-label', label);
    node.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); node.click(); }
    });
    return node;
  }

  // ---- Toast 通知（替代 alert） ----
  let toastHost = null;
  function ensureToastHost() {
    if (toastHost) return toastHost;
    toastHost = document.getElementById('toast-host');
    if (!toastHost) {
      toastHost = el('div', { id: 'toast-host', 'aria-live': 'polite', 'aria-atomic': 'false' });
      document.body.appendChild(toastHost);
    }
    return toastHost;
  }
  function toast(message, kind, ttl) {
    const host = ensureToastHost();
    const t = el('div', { class: 'toast' + (kind ? ' ' + kind : ''), role: 'status' }, String(message));
    host.appendChild(t);
    if (ttl == null) ttl = kind === 'bad' ? 5000 : 2800;
    setTimeout(function () {
      t.style.transition = 'opacity .25s, transform .25s';
      t.style.opacity = '0';
      t.style.transform = 'translateY(-8px)';
      setTimeout(function () { t.remove(); }, 260);
    }, ttl);
  }

  // 包装 confirm：保留原生（避免阻塞答题流），但便于后续替换为内联确认
  function confirmDialog(message) { return window.confirm(message); }
  function promptDialog(message, defaultValue) { return window.prompt(message, defaultValue); }

  // ---- 图片放大模态框（统一焦点管理） ----
  let _modalReturnFocus = null;
  function openImgModal(src, altText) {
    const modal = document.getElementById('img-modal');
    const img = document.getElementById('modal-img');
    if (!modal || !img) return;
    img.setAttribute('src', src);
    if (altText) img.setAttribute('alt', altText); else img.setAttribute('alt', '放大查看');
    modal.classList.add('show');
    _modalReturnFocus = document.activeElement;
    const cb = document.getElementById('img-modal-close');
    if (cb) cb.focus();
    // 焦点陷阱：Tab 在模态框内循环，Esc 关闭
    modal.addEventListener('keydown', trapFocus);
  }
  function closeImgModal() {
    const modal = document.getElementById('img-modal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.removeEventListener('keydown', trapFocus);
    if (_modalReturnFocus && _modalReturnFocus.focus) _modalReturnFocus.focus();
    _modalReturnFocus = null;
  }
  function trapFocus(e) {
    const modal = document.getElementById('img-modal');
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeImgModal();
      return;
    }
    if (e.key !== 'Tab' || !modal) return;
    const focusables = Array.from(modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter(function (n) { return !n.disabled && n.offsetParent !== null; });
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function isImgModalOpen() {
    const modal = document.getElementById('img-modal');
    return !!(modal && modal.classList.contains('show'));
  }

  function registerServiceWorker(swUrl) {
    if (!('serviceWorker' in navigator)) return;
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController) { hadController = true; return; }
      window.location.reload();
    });
    window.addEventListener('load', function () {
      navigator.serviceWorker.register(swUrl).then(function (reg) {
        if (reg && reg.update) reg.update().catch(function () {});
      }).catch(function () {});
    });
  }

  // ---- UI 缩放（共用） ----
  const SCALE_MIN = 0.6, SCALE_MAX = 1.5;
  function clampScale(v) {
    v = Number(v);
    if (!isFinite(v)) return 1;
    return Math.max(SCALE_MIN, Math.min(SCALE_MAX, v));
  }
  function defaultScale() {
    if (window.innerWidth <= 768) return 1;
    const h = window.innerHeight;
    return clampScale(h >= 1280 ? 1.1 : h >= 1080 ? 1 : h >= 900 ? 0.92 : 0.82);
  }
  function loadScale() {
    const raw = localStorage.getItem(KEYS.uiScale);
    if (raw == null) return defaultScale();
    return clampScale(parseFloat(raw) || 1);
  }
  function saveScale(v) { lsSet(KEYS.uiScale, v); }
  function applyScale(v) {
    v = clampScale(v);
    document.documentElement.style.setProperty('--ui-scale', v);
    const s = document.getElementById('size-slider');
    const val = document.getElementById('size-val');
    if (s) s.value = Math.round(v * 100);
    if (val) val.textContent = Math.round(v * 100) + '%';
    return v;
  }
  function setScale(v) { const c = applyScale(v); saveScale(c); }

  // ---- 移动端抽屉（含焦点管理：移入 / 锁定背景 / 关闭还焦点） ----
  let _drawerReturnFocus = null;
  function _isDrawerMode() { return window.matchMedia('(max-width: 768px)').matches; }
  function openDrawer() {
    const app = document.getElementById('app');
    if (!app || app.classList.contains('drawer-open')) return;
    app.classList.add('drawer-open');
    if (!_isDrawerMode()) return;   // 桌面：侧栏常驻，无需模态化
    const sidebar = document.getElementById('sidebar');
    const main = document.getElementById('main');
    document.body.classList.add('drawer-locked');
    if (sidebar) {
      sidebar.setAttribute('role', 'dialog');
      sidebar.setAttribute('aria-modal', 'true');
      sidebar.setAttribute('aria-label', '导航菜单');
      if (!sidebar.hasAttribute('tabindex')) sidebar.setAttribute('tabindex', '-1');
    }
    if (main) main.setAttribute('inert', '');
    _drawerReturnFocus = document.getElementById('drawer-toggle') || document.activeElement;
    const focusable = sidebar && sidebar.querySelector('a, button:not(:disabled), input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable) focusable.focus(); else if (sidebar) sidebar.focus();
  }
  function closeDrawer() {
    const app = document.getElementById('app');
    if (!app) return;
    const wasOpen = app.classList.contains('drawer-open');
    app.classList.remove('drawer-open');
    document.body.classList.remove('drawer-locked');
    const main = document.getElementById('main');
    if (main) main.removeAttribute('inert');
    if (wasOpen && _drawerReturnFocus && _drawerReturnFocus.focus) {
      try { _drawerReturnFocus.focus({ preventScroll: true }); } catch (e) {}
    }
    _drawerReturnFocus = null;
  }
  function toggleDrawer() {
    const app = document.getElementById('app');
    if (!app) return;
    if (app.classList.contains('drawer-open')) closeDrawer(); else openDrawer();
  }

  // ---- 面板切换 ----
  function showPanel(id) {
    document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
    const panel = document.getElementById(id);
    if (!panel) return;
    panel.classList.add('active');
    const main = document.getElementById('main');
    if (main) main.scrollTop = 0;
    window.scrollTo(0, 0);
    closeDrawer();
    if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
    panel.focus({ preventScroll: true });
  }

  // ---- 安全的图片路径校验（防止 ../ 越权读取） ----
  const SAFE_IMG_RE = /^(data:image\/|images\/|images_2024\/|\.\.\/标签库\/images\/)/i;
  const SAFE_TAGLIB_IMG_RE = /^(data:image\/|images\/)/i;
  function isSafeImgPath(s) {
    if (typeof s !== 'string' || !s) return false;
    if (SAFE_IMG_RE.test(s)) return true;
    // 显式拒绝 ../ 跨目录路径
    if (/\.\.[\\/]/.test(s)) return false;
    return false;
  }
  function isSafeTaglibImgPath(s) {
    if (typeof s !== 'string' || !s) return false;
    if (SAFE_TAGLIB_IMG_RE.test(s)) return true;
    if (/\.\.[\\/]/.test(s)) return false;
    return false;
  }

  // ---- 数据版本校验（导入时） ----
  const PAYLOAD_VERSION = 1;
  function checkPayloadVersion(data) {
    if (!data || typeof data !== 'object') return false;
    if (data.version == null) return false;       // 必须声明版本
    if (data.version > PAYLOAD_VERSION) return false;  // 比当前高的版本不兼容
    return true;
  }

  // 暴露到全局
  window.MorphShared = {
    KEYS: KEYS,
    lsGet: lsGet,
    lsSet: lsSet,
    lsRemove: lsRemove,
    el: el,
    shuffle: shuffle,
    makeKeyboardActivatable: makeKeyboardActivatable,
    toast: toast,
    confirmDialog: confirmDialog,
    promptDialog: promptDialog,
    openImgModal: openImgModal,
    closeImgModal: closeImgModal,
    isImgModalOpen: isImgModalOpen,
    registerServiceWorker: registerServiceWorker,
    clampScale: clampScale,
    loadScale: loadScale,
    saveScale: saveScale,
    applyScale: applyScale,
    setScale: setScale,
    openDrawer: openDrawer,
    closeDrawer: closeDrawer,
    toggleDrawer: toggleDrawer,
    showPanel: showPanel,
    isSafeImgPath: isSafeImgPath,
    isSafeTaglibImgPath: isSafeTaglibImgPath,
    isAcceptableImageFile: isAcceptableImageFile,
    isSafeImportFile: isSafeImportFile,
    isReasonableDataUrl: isReasonableDataUrl,
    formatBytes: formatBytes,
    MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
    MAX_BATCH_IMAGE_COUNT: MAX_BATCH_IMAGE_COUNT,
    MAX_IMPORT_BYTES: MAX_IMPORT_BYTES,
    PAYLOAD_VERSION: PAYLOAD_VERSION,
    checkPayloadVersion: checkPayloadVersion,
  };
})();
