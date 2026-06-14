(function () {
  'use strict';

  // ============================ State & storage ============================
  const state = {
    entries: [],          // effective entries (seed±overrides±deleted + user)
    facets: {},           // computed filter facets
    dbView: 'gallery',    // 'gallery' | 'table'
    dbFilter: { series: new Set(), category: new Set(), typicality: new Set(), sub: new Set(), tags: new Set(), disease: new Set(), source: new Set(), q: '' },
    dbMoreOpen: false,
    detailId: null,
    editingId: null,      // entry id being edited (null = adding)
    formImage: null,      // data URL / path of current form image
    formImageDirty: false,
    formQueue: [],        // queued data URLs for batch add
    // quiz
    qtype: 'name',
    setupFilter: { series: new Set(), typicality: new Set(), category: new Set() },
    questions: [], results: {}, curIdx: 0, submitted: false, selected: null,
    mode: 'practice', sessionLabel: '',
    tableSort: { key: 'id', dir: -1 },
  };

  const K = {
    user: 'mtl_user_entries_v1', overrides: 'mtl_overrides_v1', deleted: 'mtl_deleted_v1',
    wrong: 'mtl_wrong_v1', stats: 'mtl_stats_v1',
    // shared with the 练习系统 module so the UI size is unified across the whole system
    scale: 'morphology_ui_scale_v1',
    taxo: 'mtl_taxonomy_v1',   // user-defined custom 分类 / 子分类
  };
  const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { alert('保存失败：浏览器存储空间可能已满（图片过多过大）。请精简后重试。'); return false; } };
  const loadUser = () => lsGet(K.user, []);
  const saveUser = (a) => lsSet(K.user, a);
  const loadOverrides = () => lsGet(K.overrides, {});
  const saveOverrides = (o) => lsSet(K.overrides, o);
  const loadDeleted = () => new Set(lsGet(K.deleted, []));
  const saveDeleted = (s) => lsSet(K.deleted, [...s]);
  const loadWrong = () => new Set(lsGet(K.wrong, []));
  const saveWrong = (s) => lsSet(K.wrong, [...s]);
  const loadStats = () => lsGet(K.stats, { answered: 0, correct: 0 });
  const saveStats = (s) => lsSet(K.stats, s);
  // custom taxonomy: user-added 分类 / 子分类 that exist even before any image uses them
  function loadTaxo() {
    const t = lsGet(K.taxo, {});
    return { categories: Array.isArray(t.categories) ? t.categories : [], subcategories: Array.isArray(t.subcategories) ? t.subcategories : [] };
  }
  const saveTaxo = (t) => lsSet(K.taxo, t);

  let _seedIds = null;
  const seedIds = () => _seedIds || (_seedIds = new Set((window.SEED_ENTRIES || []).map(e => e.id)));
  const isSeed = (id) => seedIds().has(id);

  // ============================ Utils ============================
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of kids) { if (c == null || c === false) continue; n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c); }
    return n;
  }
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; };
  const distinct = (a) => [...new Set(a)];
  // make a non-button element keyboard-operable (Enter/Space → click)
  function btnize(node, label) { node.setAttribute('role', 'button'); node.setAttribute('tabindex', '0'); if (label) node.setAttribute('aria-label', label); node.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); node.click(); } }); return node; }
  const imgAlt = (e) => e.name || e.category || ('第' + e.id + '条图片');
  let _modalReturnFocus = null;
  function openImgModal(src) {
    document.getElementById('modal-img').setAttribute('src', src);
    document.getElementById('img-modal').classList.add('show');
    _modalReturnFocus = document.activeElement;
    const cb = document.getElementById('img-modal-close'); if (cb) cb.focus();
  }
  window.closeImgModal = () => {
    document.getElementById('img-modal').classList.remove('show');
    if (_modalReturnFocus && _modalReturnFocus.focus) _modalReturnFocus.focus();
    _modalReturnFocus = null;
  };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.getElementById('img-modal').classList.contains('show')) { e.stopPropagation(); window.closeImgModal(); } });
  function showPanel(id) { document.querySelectorAll('.panel').forEach(p => p.classList.remove('active')); const panel = document.getElementById(id); panel.classList.add('active'); document.getElementById('main').scrollTop = 0; window.scrollTo(0, 0); if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1'); panel.focus({ preventScroll: true }); }
  // set a hint string that may contain one **bold** segment, DOM-safely
  function setHint(node, str) {
    node.textContent = '';
    str.split(/\*\*(.+?)\*\*/).forEach((part, i) => node.appendChild(i % 2 ? el('strong', { text: part }) : document.createTextNode(part)));
  }

  const PREFIX2SERIES = { '0': '原始/幼稚细胞', 'N': '粒细胞系', 'R': '红细胞系', 'M': '单核细胞系', 'L': '淋巴细胞系', 'J': '浆细胞系', 'P': '巨核系/血小板' };
  const SERIES_ORDER = ['原始/幼稚细胞', '粒细胞系', '红细胞系', '单核细胞系', '淋巴细胞系', '浆细胞系', '巨核系/血小板', '退化细胞', '非血液细胞', '病原体', '胞质碎片（浆质体）', '杂质', '其他', '未分类'];
  const TYP_LEVELS = ['典型', '一般', '不典型', '较难鉴别', '原幼细胞较难分类', '推测', '有争议'];
  function deriveCategory(raw) {
    raw = (raw || '').trim();
    let code = '', name = raw;
    const us = raw.indexOf('_');
    if (us >= 0) { code = raw.slice(0, us).trim(); name = raw.slice(us + 1).trim(); }
    let series = code ? (PREFIX2SERIES[code[0]] || name || '其他') : (name || '其他');
    return { code, name, series };
  }
  const splitTags = (s) => (s || '').split(/[,，、;；]+/).map(x => x.trim()).filter(Boolean);

  // ============================ Build effective data ============================
  function rebuildData() {
    const overrides = loadOverrides();
    const deleted = loadDeleted();
    const seed = (window.SEED_ENTRIES || []).filter(e => !deleted.has(e.id)).map(e => overrides[e.id] ? overrides[e.id] : e);
    const user = loadUser();
    user.forEach(e => { e.userCreated = true; });
    state.entries = [...seed, ...user];
    const ids = new Set(state.entries.map(e => e.id));
    const w = loadWrong(); let ch = false;
    for (const id of [...w]) if (!ids.has(id)) { w.delete(id); ch = true; }
    if (ch) saveWrong(w);
    computeFacets();
  }

  function computeFacets() {
    const f = { series: {}, category: {}, typicality: {}, sub: {}, tags: {}, disease: {}, source: {} };
    state.entries.forEach(e => {
      const add = (o, k) => { if (k) o[k] = (o[k] || 0) + 1; };
      add(f.series, e.series); add(f.category, e.name);
      if (TYP_LEVELS.includes(e.typicality)) add(f.typicality, e.typicality);
      add(f.sub, e.subcategory); add(f.disease, e.disease); add(f.source, e.source);
      (e.tags || []).forEach(t => add(f.tags, t));
    });
    // surface user-defined categories / subcategories even when no image uses them yet (count 0)
    const taxo = loadTaxo();
    taxo.categories.forEach(c => { const d = deriveCategory(c); if (d.name && !(d.name in f.category)) f.category[d.name] = 0; if (d.series && !(d.series in f.series)) f.series[d.series] = 0; });
    taxo.subcategories.forEach(s => { if (s && !(s in f.sub)) f.sub[s] = 0; });
    state.facets = f;
  }

  function nextId() { let m = 0; state.entries.forEach(e => { if (typeof e.id === 'number' && e.id > m) m = e.id; }); (window.SEED_ENTRIES || []).forEach(e => { if (e.id > m) m = e.id; }); return m + 1; }

  // ============================ UI scale ============================
  const clampScale = (v) => Math.max(0.6, Math.min(1.5, Number(v) || 1));
  function applyScale(v) { v = clampScale(v); document.documentElement.style.setProperty('--ui-scale', v); const s = document.getElementById('size-slider'), val = document.getElementById('size-val'); if (s) s.value = Math.round(v * 100); if (val) val.textContent = Math.round(v * 100) + '%'; return v; }
  function setScale(v) { const c = applyScale(v); lsSet(K.scale, c); }
  function loadScale() { const raw = localStorage.getItem(K.scale); if (raw == null) { const h = window.innerHeight; return clampScale(h >= 1280 ? 1.1 : h >= 1080 ? 1 : h >= 900 ? 0.92 : 0.82); } return clampScale(parseFloat(raw) || 1); }

  // ============================ Sidebar refresh ============================
  function refreshSidebar() {
    document.getElementById('sb-subtitle').textContent = `${state.entries.length} 张图片 · ${Object.keys(state.facets.category).length} 类`;
    const w = loadWrong().size;
    document.getElementById('wrong-count').textContent = w ? `共 ${w} 道错题` : '暂无错题';
    document.getElementById('practice-wrong-btn').disabled = w === 0;
    document.getElementById('view-wrong-btn').disabled = w === 0;
    document.getElementById('clear-wrong-btn').disabled = w === 0;
    const st = loadStats();
    document.getElementById('stats-line').textContent = st.answered ? `累计答题 ${st.answered}，正确率 ${Math.round(st.correct / st.answered * 100)}%` : '尚未答题';
  }

  // ============================ Database browser ============================
  function filteredEntries() {
    const df = state.dbFilter;
    const q = df.q.trim().toLowerCase();
    return state.entries.filter(e => {
      if (df.series.size && !df.series.has(e.series)) return false;
      if (df.category.size && !df.category.has(e.name)) return false;
      if (df.typicality.size && !df.typicality.has(e.typicality)) return false;
      if (df.sub.size && !df.sub.has(e.subcategory)) return false;
      if (df.disease.size && !df.disease.has(e.disease)) return false;
      if (df.source.size && !df.source.has(e.source)) return false;
      if (df.tags.size && !(e.tags || []).some(t => df.tags.has(t))) return false;
      if (q) {
        const hay = [e.name, e.category, e.series, e.subcategory, e.disease, e.source, e.explanation, (e.tags || []).join(' ')].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function chip(label, count, on, onClick) {
    const c = el('span', { class: 'chip' + (on ? ' on' : ''), onclick: onClick, 'aria-pressed': on ? 'true' : 'false' }, label);
    if (count != null) c.appendChild(el('span', { class: 'c-n', text: count }));
    return btnize(c);
  }

  function renderFilters() {
    const wrap = document.getElementById('db-filters');
    wrap.textContent = '';
    const f = state.facets, df = state.dbFilter;
    const group = (label, facetObj, setKey, order, wrapClass) => {
      const keys = order ? order.filter(k => facetObj[k]) : Object.keys(facetObj).sort((a, b) => facetObj[b] - facetObj[a]);
      if (!keys.length) return null;
      const row = el('div', { class: 'filter-group' }, el('span', { class: 'filter-label', text: label }));
      const cr = el('div', { class: 'chip-row' + (wrapClass ? ' ' + wrapClass : '') });
      keys.forEach(k => cr.appendChild(chip(k, facetObj[k], df[setKey].has(k), () => { df[setKey].has(k) ? df[setKey].delete(k) : df[setKey].add(k); renderDB(); })));
      row.appendChild(cr); return row;
    };
    [group('系列', f.series, 'series', SERIES_ORDER), group('典型程度', f.typicality, 'typicality'), group('具体分类', f.category, 'category', null, 'chip-row-wrap')].forEach(g => { if (g) wrap.appendChild(g); });
    const moreBtn = el('button', { class: 'more-filter-toggle', text: state.dbMoreOpen ? '收起更多筛选 ▴' : '更多筛选（子分类 / 标签 / 疾病 / 来源）▾', onclick: () => { state.dbMoreOpen = !state.dbMoreOpen; renderDB(); } });
    wrap.appendChild(moreBtn);
    if (state.dbMoreOpen) {
      [['子分类', f.sub, 'sub'], ['标签', f.tags, 'tags'], ['疾病', f.disease, 'disease'], ['来源', f.source, 'source']].forEach(([l, o, k]) => { const g = group(l, o, k); if (g) wrap.appendChild(g); });
    }
  }

  function renderActiveFilters() {
    const wrap = document.getElementById('db-active-filters');
    wrap.textContent = '';
    const df = state.dbFilter;
    let any = false;
    [['series', '系列'], ['typicality', '典型'], ['category', '分类'], ['sub', '子分类'], ['tags', '标签'], ['disease', '疾病'], ['source', '来源']].forEach(([k, lbl]) => {
      df[k].forEach(v => { any = true; wrap.appendChild(el('span', { class: 'active-chip' }, `${lbl}：${v}`, el('button', { class: 'chip-x', type: 'button', 'aria-label': `移除筛选 ${lbl}：${v}`, text: '✕', onclick: () => { df[k].delete(v); renderDB(); } }))); });
    });
    if (df.q) { any = true; wrap.appendChild(el('span', { class: 'active-chip' }, `搜索：${df.q}`, el('button', { class: 'chip-x', type: 'button', 'aria-label': '清除搜索', text: '✕', onclick: () => { df.q = ''; document.getElementById('db-search').value = ''; renderDB(); } }))); }
    if (any) wrap.appendChild(el('button', { class: 'more-filter-toggle', text: '清空全部筛选', onclick: () => { ['series', 'category', 'typicality', 'sub', 'tags', 'disease', 'source'].forEach(k => df[k].clear()); df.q = ''; document.getElementById('db-search').value = ''; renderDB(); } }));
  }

  function renderDB() {
    renderFilters(); renderActiveFilters();
    const list = filteredEntries();
    document.getElementById('db-count').textContent = `（${list.length} / ${state.entries.length}）`;
    document.getElementById('view-gallery').classList.toggle('active', state.dbView === 'gallery');
    document.getElementById('view-table').classList.toggle('active', state.dbView === 'table');
    const body = document.getElementById('db-body');
    body.textContent = '';
    if (!list.length) { body.appendChild(el('div', { class: 'db-empty', text: '没有符合条件的条目。' })); return; }
    state.dbView === 'gallery' ? renderGallery(body, list) : renderTable(body, list);
  }

  function typBadge(t) { if (!t) return null; const cls = TYP_LEVELS.includes(t) ? 'typ typ-' + t : 'typ typ-other'; return el('span', { class: cls, text: t }); }

  function renderGallery(body, list) {
    const g = el('div', { class: 'gallery' });
    list.forEach(e => {
      const card = btnize(el('div', { class: 'gcard', onclick: () => openDetail(e.id) }), (e.name || '条目') + ' 详情');
      card.appendChild(el('img', { class: 'gimg', src: e.image, alt: imgAlt(e), loading: 'lazy' }));
      const meta = el('div', { class: 'gmeta' });
      meta.appendChild(el('div', { class: 'gname', text: e.name || '(未命名)' }));
      const sub = el('div', { class: 'gsub' });
      if (e.typicality) sub.appendChild(typBadge(e.typicality));
      if (e.subcategory) sub.appendChild(el('span', { text: e.subcategory }));
      if (e.userCreated) sub.appendChild(el('span', { class: 'badge-user', text: '自建' }));
      meta.appendChild(sub); card.appendChild(meta); g.appendChild(card);
    });
    body.appendChild(g);
  }

  function renderTable(body, list) {
    const cols = [['id', '编号'], ['image', '图片'], ['name', '分类'], ['series', '系列'], ['subcategory', '子分类'], ['tags', '标签'], ['typicality', '典型'], ['disease', '疾病'], ['source', '来源']];
    const s = state.tableSort;
    const sorted = list.slice().sort((a, b) => {
      let av = a[s.key], bv = b[s.key]; if (Array.isArray(av)) av = av.join(); if (Array.isArray(bv)) bv = bv.join();
      av = av == null ? '' : av; bv = bv == null ? '' : bv;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * s.dir;
      return String(av).localeCompare(String(bv), 'zh') * s.dir;
    });
    const t = el('table', { class: 'dtable' });
    const thead = el('tr');
    cols.forEach(([k, lbl]) => { const th = el('th', { text: lbl + (s.key === k ? (s.dir > 0 ? ' ▲' : ' ▼') : ''), onclick: () => { if (s.key === k) s.dir *= -1; else { s.key = k; s.dir = 1; } renderDB(); } }); btnize(th, '按' + lbl + '排序'); thead.appendChild(th); });
    t.appendChild(el('thead', null, thead));
    const tb = el('tbody');
    sorted.forEach(e => {
      const tr = btnize(el('tr', { class: 'trow', onclick: (ev) => { if (ev.target.tagName === 'IMG') return; openDetail(e.id); } }), (e.category || e.name || '条目') + ' 详情');
      tr.appendChild(el('td', { text: e.id }));
      const imgtd = el('td'); imgtd.appendChild(el('img', { class: 'tthumb', src: e.image, alt: imgAlt(e), loading: 'lazy', onclick: (ev) => { ev.stopPropagation(); openImgModal(e.image); } })); tr.appendChild(imgtd);
      tr.appendChild(el('td', { text: e.category || e.name }));
      tr.appendChild(el('td', { text: e.series }));
      tr.appendChild(el('td', { text: e.subcategory }));
      tr.appendChild(el('td', { text: (e.tags || []).join('、') }));
      tr.appendChild(el('td', null, typBadge(e.typicality) || document.createTextNode('')));
      tr.appendChild(el('td', { text: e.disease }));
      tr.appendChild(el('td', { text: e.source }));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    const tw = el('div', { class: 'table-wrap' }); tw.appendChild(t); body.appendChild(tw);
  }

  // ============================ Detail ============================
  function openDetail(id) {
    const e = state.entries.find(x => x.id === id); if (!e) return;
    state.detailId = id;
    document.getElementById('detail-title').textContent = `第 ${e.id} 条 · ${e.name || '(未命名)'}`;
    const body = document.getElementById('detail-body'); body.textContent = '';
    body.appendChild(el('img', { class: 'detail-img', src: e.image, alt: imgAlt(e), onclick: () => openImgModal(e.image) }));
    const fields = el('div', { class: 'detail-fields' });
    const field = (k, vNode) => { const r = el('div', { class: 'dfield' }, el('span', { class: 'dk', text: k })); const dv = el('div', { class: 'dv' }); if (typeof vNode === 'string') dv.textContent = vNode || '—'; else dv.appendChild(vNode); r.appendChild(dv); return r; };
    fields.appendChild(field('编号', String(e.id) + (e.userCreated ? '（自建）' : '')));
    fields.appendChild(field('来源', e.source || '—'));
    fields.appendChild(field('分类', e.category || e.name || '—'));
    fields.appendChild(field('系列', e.series || '—'));
    fields.appendChild(field('子分类', e.subcategory || '—'));
    const tagWrap = el('div'); (e.tags || []).forEach(t => tagWrap.appendChild(el('span', { class: 'dtag', text: t }))); if (!(e.tags || []).length) tagWrap.textContent = '—';
    fields.appendChild(field('其他标签', tagWrap));
    fields.appendChild(field('典型程度', typBadge(e.typicality) || document.createTextNode(e.typicality || '—')));
    fields.appendChild(field('疾病', e.disease || '—'));
    fields.appendChild(field('解说', e.explanation || '—'));
    body.appendChild(fields);
    showPanel('detail');
  }

  // ============================ Add / Edit form ============================
  function refreshDatalists() {
    const fill = (id, keys) => { const dl = document.getElementById(id); dl.textContent = ''; keys.forEach(k => dl.appendChild(el('option', { value: k }))); };
    const taxo = loadTaxo();
    const cats = distinct([...(window.SEED_ENTRIES || []).map(e => e.category), ...state.entries.map(e => e.category), ...taxo.categories]).filter(Boolean).sort();
    fill('dl-category', cats);
    fill('dl-subcategory', distinct([...Object.keys(state.facets.sub), ...taxo.subcategories]).filter(Boolean).sort());
    fill('dl-source', Object.keys(state.facets.source).sort());
    fill('dl-disease', Object.keys(state.facets.disease).sort());
    fill('dl-typicality', TYP_LEVELS.slice());
  }

  function openForm(id) {
    state.editingId = id || null; state.formImage = null; state.formImageDirty = false; state.formQueue = [];
    document.getElementById('form-title').textContent = id ? '编辑条目' : '添加图片条目';
    refreshDatalists();
    const e = id ? state.entries.find(x => x.id === id) : null;
    document.getElementById('f-source').value = e ? e.source : '';
    document.getElementById('f-typicality').value = e ? e.typicality : '';
    document.getElementById('f-category').value = e ? e.category : '';
    document.getElementById('f-subcategory').value = e ? e.subcategory : '';
    document.getElementById('f-disease').value = e ? e.disease : '';
    document.getElementById('f-tags').value = e ? (e.tags || []).join(', ') : '';
    document.getElementById('f-explanation').value = e ? e.explanation : '';
    document.getElementById('f-image').value = '';
    const prev = document.getElementById('f-image-preview'), clr = document.getElementById('f-image-clear');
    if (e && e.image) { state.formImage = e.image; prev.src = e.image; prev.style.display = 'block'; clr.style.display = 'inline-block'; }
    else { prev.style.display = 'none'; prev.removeAttribute('src'); clr.style.display = 'none'; }
    renderQueue();
    showPanel('form');
  }

  function renderQueue() {
    const q = document.getElementById('f-queue'); q.textContent = '';
    state.formQueue.forEach(src => q.appendChild(el('img', { src })));
    document.getElementById('form-save-next').style.display = state.formQueue.length ? 'inline-block' : 'none';
  }

  function readFiles(files) {
    const arr = [...files]; if (!arr.length) return;
    let pending = arr.length; const results = new Array(arr.length);
    arr.forEach((file, i) => {
      const r = new FileReader();
      r.onload = () => { results[i] = r.result; if (--pending === 0) onFilesRead(results.filter(Boolean)); };
      r.onerror = () => { if (--pending === 0) onFilesRead(results.filter(Boolean)); };
      r.readAsDataURL(file);
    });
  }
  function onFilesRead(urls) {
    if (!urls.length) return;
    state.formImage = urls[0]; state.formImageDirty = true;
    const prev = document.getElementById('f-image-preview'); prev.src = urls[0]; prev.style.display = 'block';
    document.getElementById('f-image-clear').style.display = 'inline-block';
    state.formQueue = urls.slice(1);
    renderQueue();
  }

  function collectForm() {
    const catRaw = document.getElementById('f-category').value.trim();
    const d = deriveCategory(catRaw);
    return {
      source: document.getElementById('f-source').value.trim(),
      category: catRaw, code: d.code, name: d.name, series: d.series,
      subcategory: document.getElementById('f-subcategory').value.trim(),
      tags: splitTags(document.getElementById('f-tags').value),
      typicality: document.getElementById('f-typicality').value.trim(),
      disease: document.getElementById('f-disease').value.trim(),
      explanation: document.getElementById('f-explanation').value.trim(),
    };
  }

  function saveForm(thenNext) {
    if (!state.formImage) { alert('请先选择 / 上传图片'); return false; }
    const data = collectForm();
    if (!data.category) { alert('请填写「分类」'); return false; }
    const existing = state.editingId ? state.entries.find(x => x.id === state.editingId) : null;
    const image = state.formImageDirty ? state.formImage : (existing ? existing.image : state.formImage);
    const entry = Object.assign({ id: state.editingId || nextId(), image }, data);

    if (state.editingId && isSeed(state.editingId)) {
      const ov = loadOverrides(); ov[state.editingId] = entry; if (!saveOverrides(ov)) return false;
    } else if (state.editingId) {
      const u = loadUser(); const i = u.findIndex(x => x.id === state.editingId); if (i >= 0) u[i] = entry; else u.push(entry); if (!saveUser(u)) return false;
    } else {
      const u = loadUser(); u.push(entry); if (!saveUser(u)) return false;
    }
    rebuildData(); refreshSidebar();

    if (thenNext && state.formQueue.length) {
      const next = state.formQueue.shift();
      state.editingId = null; state.formImage = next; state.formImageDirty = true;
      const prev = document.getElementById('f-image-preview'); prev.src = next; prev.style.display = 'block';
      document.getElementById('f-category').value = ''; document.getElementById('f-subcategory').value = '';
      document.getElementById('f-tags').value = ''; document.getElementById('f-disease').value = ''; document.getElementById('f-explanation').value = '';
      document.getElementById('form-title').textContent = '添加图片条目（队列剩余 ' + state.formQueue.length + ' 张）';
      refreshDatalists(); renderQueue(); window.scrollTo(0, 0);
      return true;
    }
    renderDB(); showPanel('db');
    return true;
  }

  function deleteEntry(id) {
    const e = state.entries.find(x => x.id === id);
    if (!confirm(`确认删除第 ${id} 条（${e ? e.name : ''}）？` + (isSeed(id) ? '\n（内置条目可用「恢复内置默认」找回）' : '\n此操作不可恢复。'))) return;
    if (isSeed(id)) { const d = loadDeleted(); d.add(id); saveDeleted(d); const ov = loadOverrides(); if (ov[id]) { delete ov[id]; saveOverrides(ov); } }
    else { saveUser(loadUser().filter(x => x.id !== id)); }
    const w = loadWrong(); w.delete(id); saveWrong(w);
    rebuildData(); refreshSidebar(); renderDB(); showPanel('db');
  }

  // ============================ Taxonomy manager (分类管理) ============================
  const UNCLASSIFIED = '未分类';
  function openTaxo() { renderTaxo(); showPanel('taxo'); }
  function taxoRow(label, count, opts) {
    opts = opts || {};
    const row = el('div', { class: 'taxo-row' });
    row.appendChild(el('span', { class: 'taxo-name', text: label }));
    if (opts.seriesLabel) row.appendChild(el('span', { class: 'taxo-series', text: opts.seriesLabel }));
    row.appendChild(el('span', { class: 'taxo-count', text: count + ' 图' }));
    if (opts.isCustom) row.appendChild(el('span', { class: 'taxo-tag', text: count === 0 ? '自定义' : '自定义·使用中' }));
    if (opts.onDelete) row.appendChild(el('button', { class: 'btn btn-sm btn-danger-ghost', text: '删除', onclick: opts.onDelete }));
    return row;
  }
  // Apply field changes to all matching effective entries: overrides for built-in, direct edits for user.
  function reassignEntries(matchFn, changes) {
    const overrides = loadOverrides();
    const user = loadUser();
    const apply = (e) => {
      const merged = Object.assign({}, e, changes);
      if ('category' in changes) { const d = deriveCategory(changes.category); merged.code = d.code; merged.name = d.name; merged.series = d.series; }
      return merged;
    };
    let n = 0;
    state.entries.forEach(e => {
      if (!matchFn(e)) return;
      if (isSeed(e.id)) { overrides[e.id] = apply(e); n++; }
      else { const i = user.findIndex(u => u.id === e.id); if (i >= 0) { user[i] = apply(user[i]); n++; } }
    });
    if (n) { saveOverrides(overrides); saveUser(user); }
    return n;
  }
  function deleteCategory(cat, count) {
    if (deriveCategory(cat).name === UNCLASSIFIED || cat === UNCLASSIFIED) { alert('「未分类」是删除分类后图片的归处，无法删除。'); return; }
    if (count > 0) {
      if (!confirm(`删除分类「${cat}」？\n该分类下的 ${count} 张图片将移动到「未分类」。\n（内置图片之后可用「恢复内置默认」找回）`)) return;
      reassignEntries(e => e.category === cat, { category: UNCLASSIFIED });
    } else {
      if (!confirm(`删除自定义分类「${cat}」？`)) return;
    }
    const t = loadTaxo(); t.categories = t.categories.filter(x => x !== cat); saveTaxo(t);
    rebuildData(); refreshSidebar(); renderTaxo();
  }
  function deleteSub(sub, count) {
    if (count > 0) {
      if (!confirm(`删除子分类「${sub}」？\n该子分类下 ${count} 张图片的「子分类」将被清空（移入未分类）。\n（内置图片之后可用「恢复内置默认」找回）`)) return;
      reassignEntries(e => e.subcategory === sub, { subcategory: '' });
    } else {
      if (!confirm(`删除自定义子分类「${sub}」？`)) return;
    }
    const t = loadTaxo(); t.subcategories = t.subcategories.filter(x => x !== sub); saveTaxo(t);
    rebuildData(); refreshSidebar(); renderTaxo();
  }
  function renderTaxo() {
    const taxo = loadTaxo();
    // categories (by full 编码_名称)
    const usedCats = {};
    state.entries.forEach(e => { if (e.category) usedCats[e.category] = (usedCats[e.category] || 0) + 1; });
    const allCats = distinct([...Object.keys(usedCats), ...taxo.categories]).sort();
    const catList = document.getElementById('taxo-cat-list'); catList.textContent = '';
    if (!allCats.length) catList.appendChild(el('div', { class: 'taxo-empty', text: '暂无分类，请在上方添加。' }));
    allCats.forEach(c => {
      const cnt = usedCats[c] || 0;
      const isUnclassified = (deriveCategory(c).name === UNCLASSIFIED || c === UNCLASSIFIED);
      catList.appendChild(taxoRow(c, cnt, {
        seriesLabel: deriveCategory(c).series,
        isCustom: taxo.categories.includes(c),
        onDelete: isUnclassified ? null : () => deleteCategory(c, cnt),
      }));
    });
    // subcategories
    const usedSubs = {};
    state.entries.forEach(e => { if (e.subcategory) usedSubs[e.subcategory] = (usedSubs[e.subcategory] || 0) + 1; });
    const allSubs = distinct([...Object.keys(usedSubs), ...taxo.subcategories]).sort();
    const subList = document.getElementById('taxo-sub-list'); subList.textContent = '';
    if (!allSubs.length) subList.appendChild(el('div', { class: 'taxo-empty', text: '暂无子分类，请在上方添加。' }));
    allSubs.forEach(s => {
      const cnt = usedSubs[s] || 0;
      subList.appendChild(taxoRow(s, cnt, { isCustom: taxo.subcategories.includes(s), onDelete: () => deleteSub(s, cnt) }));
    });
    document.getElementById('taxo-cat-series').textContent = '';
  }
  function addTaxoCategory() {
    const inp = document.getElementById('taxo-cat-input');
    const v = inp.value.trim();
    if (!v) { alert('请输入分类（建议用「编码_名称」，如 L3_大颗粒淋巴细胞）'); return; }
    const t = loadTaxo();
    if (!t.categories.includes(v)) t.categories.push(v);
    saveTaxo(t); inp.value = ''; rebuildData(); refreshSidebar(); renderTaxo();
  }
  function addTaxoSub() {
    const inp = document.getElementById('taxo-sub-input');
    const v = inp.value.trim();
    if (!v) { alert('请输入子分类名称'); return; }
    const t = loadTaxo();
    if (!t.subcategories.includes(v)) t.subcategories.push(v);
    saveTaxo(t); inp.value = ''; rebuildData(); refreshSidebar(); renderTaxo();
  }

  // ============================ Quiz setup ============================
  function openQuizSetup() { renderSetupChips(); updateSetupPool(); showPanel('quizsetup'); }
  function renderSetupChips() {
    const f = state.facets, sf = state.setupFilter;
    const fill = (containerId, facetObj, key, order) => {
      const wrap = document.getElementById(containerId); wrap.textContent = '';
      const keys = order ? order.filter(k => facetObj[k]) : Object.keys(facetObj).sort((a, b) => facetObj[b] - facetObj[a]);
      keys.forEach(k => wrap.appendChild(chip(k, facetObj[k], sf[key].has(k), () => { sf[key].has(k) ? sf[key].delete(k) : sf[key].add(k); renderSetupChips(); updateSetupPool(); })));
    };
    fill('setup-series', f.series, 'series', SERIES_ORDER);
    fill('setup-typicality', f.typicality, 'typicality');
    fill('setup-category', f.category, 'category');
  }
  function setupPoolEntries() {
    const sf = state.setupFilter;
    return state.entries.filter(e => {
      if (sf.series.size && !sf.series.has(e.series)) return false;
      if (sf.typicality.size && !sf.typicality.has(e.typicality)) return false;
      if (sf.category.size && !sf.category.has(e.name)) return false;
      return true;
    });
  }
  function updateSetupPool() { const n = setupPoolEntries().length; document.getElementById('setup-pool').textContent = n; document.getElementById('setup-n').max = n; }

  function buildQuestions(entries, qtype, shuffleOn) {
    const list = shuffleOn ? shuffle(entries) : entries.slice();
    const allNames = distinct(state.entries.map(e => e.name).filter(Boolean));
    const allSeries = distinct(state.entries.map(e => e.series).filter(Boolean));
    return list.map(e => {
      const correct = qtype === 'series' ? e.series : e.name;
      let pool;
      if (qtype === 'series') pool = allSeries.filter(s => s !== correct);
      else {
        const same = distinct(state.entries.filter(x => x.series === e.series).map(x => x.name)).filter(n => n && n !== correct);
        const other = allNames.filter(n => n !== correct && !same.includes(n));
        pool = shuffle(same).concat(shuffle(other));
      }
      pool = distinct(pool);
      // pad from the cross-label space if the primary pool can't supply 3 distractors
      if (pool.length < 3) {
        const fallback = (qtype === 'series' ? allNames : allSeries).filter(t => t && t !== correct && !pool.includes(t));
        pool = distinct(pool.concat(shuffle(fallback)));
      }
      const distractors = pool.slice(0, 3);
      const opts = shuffle([correct, ...distractors]).map((t, i) => ({ letter: 'ABCDE'[i], text: t, correct: t === correct }));
      return { entry: e, options: opts, answer: opts.find(o => o.correct).letter };
    });
  }

  function startQuiz({ entries, qtype, shuffleOn, label, mode }) {
    if (!entries.length) { alert('没有可出题的条目，请调整筛选范围。'); return; }
    state.qtype = qtype || state.qtype;
    const qs = buildQuestions(entries, state.qtype, shuffleOn);
    const minOpts = qs.length ? Math.min(...qs.map(q => q.options.length)) : 0;
    if (minOpts < 2) { alert('当前题库可用的不同' + (state.qtype === 'series' ? '系列' : '分类') + '过少（不足 2 个），无法生成有效的选择题。请扩充题库或调整筛选范围。'); return; }
    state.questions = qs;
    state.results = {}; state.curIdx = 0; state.submitted = false; state.mode = mode || 'practice';
    state.sessionLabel = label || (state.qtype === 'series' ? '识别系列' : '识别细胞');
    showPanel('quiz'); renderQnav(); renderQuestion();
  }

  // ============================ Quiz runner ============================
  function counts() { let c = 0, w = 0; for (const k in state.results) state.results[k].correct ? c++ : w++; return { correct: c, wrong: w }; }

  function renderQnav() {
    const nav = document.getElementById('qnav'); nav.textContent = '';
    state.questions.forEach((q, i) => {
      let cls = 'qnav-item'; if (i === state.curIdx) cls += ' current';
      const r = state.results[q.entry.id]; let suffix = '';
      if (r) { cls += r.correct ? ' correct' : ' wrong'; suffix = r.correct ? ' ✓' : ' ✗'; }
      nav.appendChild(el('button', { class: cls, text: (i + 1) + suffix, title: r ? (r.correct ? '已答对' : '已答错') : '未作答', onclick: () => { state.curIdx = i; renderQuestion(); renderQnav(); } }));
    });
  }

  function renderQuestion() {
    const q = state.questions[state.curIdx], e = q.entry;
    const prior = state.results[e.id];
    state.submitted = !!prior; state.selected = prior ? prior.userLetter : null;
    const total = state.questions.length;
    document.getElementById('q-progress').textContent = `第 ${state.curIdx + 1} / ${total} 题`;
    document.getElementById('q-label').textContent = state.sessionLabel;
    const cs = counts();
    document.getElementById('q-correct').textContent = cs.correct;
    document.getElementById('q-wrong').textContent = cs.wrong;
    document.getElementById('q-fill').style.width = (Object.keys(state.results).length / total * 100) + '%';
    document.getElementById('q-jump').max = total; document.getElementById('q-jump').placeholder = '1-' + total;

    const card = document.getElementById('q-card'); card.textContent = '';
    card.appendChild(el('div', { class: 'q-meta' }, el('span', { class: 'badge', text: state.qtype === 'series' ? '识别系列' : '识别细胞' }), e.typicality ? el('span', { class: 'badge', text: '典型程度：' + e.typicality }) : null));
    card.appendChild(el('div', { class: 'q-prompt', text: state.qtype === 'series' ? '图中所示细胞 / 物属于哪个系列？' : '请判读图中所示细胞 / 物的具体分类：' }));
    const iw = el('div', { class: 'q-image-wrap' });
    iw.appendChild(el('img', { src: e.image, alt: '题图', onclick: () => openImgModal(e.image) }));
    card.appendChild(iw);
    const ol = el('div', { class: 'options-list' });
    const rightLetter = q.answer;
    q.options.forEach(opt => {
      let cls = 'option', mark = null, sr = '';
      if (state.submitted) {
        cls += ' disabled';
        if (opt.letter === rightLetter) { cls += ' correct'; mark = '✓'; sr = '（正确答案）'; }
        else if (opt.letter === state.selected) { cls += ' incorrect'; mark = '✗'; sr = '（你的选择，错误）'; }
      } else if (opt.letter === state.selected) cls += ' selected';
      const btn = el('button', { class: cls, dataset: { letter: opt.letter } },
        el('span', { class: 'letter', text: opt.letter }),
        el('span', { text: opt.text }),
        sr ? el('span', { class: 'sr-only', text: sr }) : null,
        mark ? el('span', { class: 'opt-mark', 'aria-hidden': 'true', text: mark }) : null);
      if (state.submitted) { btn.disabled = true; btn.setAttribute('aria-disabled', 'true'); }
      btn.addEventListener('click', () => { if (!state.submitted) submitAnswer(opt.letter); });
      ol.appendChild(btn);
    });
    card.appendChild(ol);
    if (prior) appendFeedback(card, q, prior.userLetter);

    document.getElementById('q-next').style.display = state.submitted ? 'inline-block' : 'none';
    document.getElementById('q-skip').style.display = state.submitted ? 'none' : 'inline-block';
    document.getElementById('q-prev').disabled = state.curIdx === 0;
    document.getElementById('q-next').textContent = state.curIdx >= total - 1 ? '完成本轮 ✓' : '下一题 →';
    if (state.curIdx >= total - 1) document.getElementById('q-skip').style.display = 'none';
  }

  function appendFeedback(card, q, userLetter) {
    const e = q.entry, correct = userLetter === q.answer;
    const fb = el('div', { class: 'feedback ' + (correct ? 'ok' : 'bad') });
    const corrText = q.options.find(o => o.correct).text;
    fb.appendChild(el('div', { class: 'fb-title', text: correct ? '回答正确 ✓' : `回答错误 ✗　正确答案：${corrText}` }));
    const grid = el('div', { class: 'fb-grid' });
    const line = (k, v) => { if (!v || (Array.isArray(v) && !v.length)) return; grid.appendChild(el('div', null, el('span', { class: 'fk', text: k }), Array.isArray(v) ? v.join('、') : String(v))); };
    line('分类', e.category || e.name); line('系列', e.series); line('子分类', e.subcategory);
    line('其他标签', e.tags); line('典型程度', e.typicality); line('疾病', e.disease);
    line('解说', e.explanation); line('来源', e.source); line('编号', e.id);
    fb.appendChild(grid); card.appendChild(fb);
  }

  function submitAnswer(letter) {
    const q = state.questions[state.curIdx], e = q.entry;
    const already = !!state.results[e.id];
    state.selected = letter; state.submitted = true;
    const correct = letter === q.answer;
    state.results[e.id] = { userLetter: letter, correct };
    if (!already) { const st = loadStats(); st.answered++; if (correct) st.correct++; saveStats(st); }
    const w = loadWrong();
    if (correct) { if (state.mode === 'wrong') { w.delete(e.id); saveWrong(w); } }
    else { w.add(e.id); saveWrong(w); }
    renderQuestion(); renderQnav(); refreshSidebar();
  }

  function nextQ() { if (state.curIdx >= state.questions.length - 1) return finishQuiz(); state.curIdx++; renderQuestion(); renderQnav(); }
  function prevQ() { if (state.curIdx === 0) return; state.curIdx--; renderQuestion(); renderQnav(); }
  function finishQuiz() {
    const total = state.questions.length, cs = counts(), ans = cs.correct + cs.wrong;
    document.getElementById('r-total').textContent = total;
    document.getElementById('r-correct').textContent = cs.correct;
    document.getElementById('r-wrong').textContent = cs.wrong;
    document.getElementById('r-rate').textContent = (ans ? Math.round(cs.correct / ans * 100) : 0) + '%';
    showPanel('result'); refreshSidebar();
  }

  // ============================ Wrong review ============================
  function renderReview() {
    const w = loadWrong(); const list = document.getElementById('review-list'); list.textContent = '';
    if (!w.size) { list.appendChild(el('div', { class: 'db-empty', text: '暂无错题 🎉' })); return; }
    state.entries.filter(e => w.has(e.id)).forEach(e => {
      const item = btnize(el('div', { class: 'review-item', onclick: () => startQuiz({ entries: [e], qtype: state.qtype, shuffleOn: false, label: '复习错题', mode: 'wrong' }) }), (e.name || '条目') + ' 复习');
      item.appendChild(el('img', { src: e.image, alt: imgAlt(e) }));
      const info = el('div'); info.appendChild(el('div', { class: 'ri-name', text: e.name })); info.appendChild(el('div', { class: 'ri-meta', text: `${e.series}　${e.typicality || ''}　第${e.id}条` }));
      item.appendChild(info); list.appendChild(item);
    });
  }

  // ============================ Import / Export / Reset ============================
  function exportDB() {
    const payload = { app: 'morphology-tag-library', type: 'db-diff', version: 1, exportedAt: new Date().toISOString(), userEntries: loadUser(), overrides: loadOverrides(), deleted: [...loadDeleted()] };
    const cnt = payload.userEntries.length + Object.keys(payload.overrides).length + payload.deleted.length;
    if (!cnt) { alert('当前没有自建 / 修改 / 删除记录可导出。\n（内置 75 条随程序附带，无需导出。）'); return; }
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: '形态学标签库_备份_' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.json' });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function importDB(file) {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      let d; try { d = JSON.parse(r.result); } catch (e) { alert('导入失败：不是有效的 JSON 文件。'); return; }
      // validate field TYPES, coerce wrong types to safe empties, before touching storage
      const ue = Array.isArray(d && d.userEntries) ? d.userEntries : [];
      const ov0 = (d && d.overrides && typeof d.overrides === 'object' && !Array.isArray(d.overrides)) ? d.overrides : {};
      const del0 = Array.isArray(d && d.deleted) ? d.deleted : [];
      if (!d || (!ue.length && !Object.keys(ov0).length && !del0.length)) { alert('导入失败：文件格式不正确。请用本程序「导出」生成的文件。'); return; }
      const safeImg = (s) => typeof s === 'string' && /^(data:image\/|images\/)/i.test(s);
      try {
        const existingIds = new Set(state.entries.map(e => e.id));
        const u = loadUser(); let added = 0;
        ue.forEach(e => {
          if (!e || !e.image || !safeImg(e.image)) return;
          let id = e.id; if (typeof id !== 'number' || existingIds.has(id)) { id = nextId(); while (existingIds.has(id)) id++; }
          const der = deriveCategory(e.category || e.name || '');
          u.push(Object.assign({}, e, { id, code: der.code, name: e.name || der.name, series: e.series || der.series, tags: Array.isArray(e.tags) ? e.tags : splitTags(e.tags) }));
          existingIds.add(id); added++;
        });
        const ov = loadOverrides(); let ovc = 0;
        Object.entries(ov0).forEach(([id, e]) => {
          const nid = Number(id);
          if (!isSeed(nid) || !e || typeof e !== 'object' || Array.isArray(e) || !safeImg(e.image) || !(e.name || e.category)) return;
          const der = deriveCategory(e.category || e.name || '');
          ov[id] = Object.assign({}, e, { id: nid, code: e.code || der.code, name: e.name || der.name, series: e.series || der.series, tags: Array.isArray(e.tags) ? e.tags : splitTags(e.tags) });
          ovc++;
        });
        const del = loadDeleted(); let delc = 0;
        del0.forEach(id => { if (isSeed(id) && !del.has(id)) { del.add(id); delc++; } });
        // commit only after all validation passed
        if (!saveUser(u)) return;
        saveOverrides(ov); saveDeleted(del);
        rebuildData(); refreshSidebar(); renderDB(); showPanel('db');
        alert(`导入完成：新增 ${added} 条、修改 ${ovc} 条、删除 ${delc} 条。`);
      } catch (err) { alert('导入失败：文件内容异常。'); }
    };
    r.readAsText(file);
  }
  function resetDB() {
    if (!confirm('确认恢复内置默认？\n你的所有自建条目、修改、删除记录、自定义分类都将清除，且不可撤销（建议先导出备份）。')) return;
    [K.user, K.overrides, K.deleted, K.taxo].forEach(k => localStorage.removeItem(k));
    rebuildData(); refreshSidebar(); renderDB(); showPanel('db');
  }

  // ============================ Events ============================
  function bind() {
    document.getElementById('nav-db').onclick = () => { renderDB(); showPanel('db'); };
    document.getElementById('nav-add').onclick = () => openForm(null);
    document.getElementById('nav-taxo').onclick = openTaxo;
    document.getElementById('taxo-back').onclick = () => { renderDB(); showPanel('db'); };
    document.getElementById('taxo-cat-add').onclick = addTaxoCategory;
    document.getElementById('taxo-sub-add').onclick = addTaxoSub;
    document.getElementById('taxo-cat-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addTaxoCategory(); } });
    document.getElementById('taxo-sub-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addTaxoSub(); } });
    document.getElementById('taxo-cat-input').addEventListener('input', e => { const v = e.target.value.trim(); document.getElementById('taxo-cat-series').textContent = v ? `→ 系列：${deriveCategory(v).series}` : ''; });
    document.getElementById('nav-quizsetup').onclick = openQuizSetup;
    document.getElementById('quick-rand-go').onclick = () => {
      let n = parseInt(document.getElementById('quick-rand-n').value, 10); if (isNaN(n) || n < 1) n = 20;
      const pool = state.entries; n = Math.min(n, pool.length);
      startQuiz({ entries: shuffle(pool).slice(0, n), qtype: state.qtype, shuffleOn: true, label: `随机测验（${n}）`, mode: 'practice' });
    };
    document.getElementById('practice-wrong-btn').onclick = () => { const w = loadWrong(); startQuiz({ entries: state.entries.filter(e => w.has(e.id)), qtype: state.qtype, shuffleOn: true, label: '错题练习', mode: 'wrong' }); };
    document.getElementById('view-wrong-btn').onclick = () => { renderReview(); showPanel('review'); };
    document.getElementById('clear-wrong-btn').onclick = () => { if (confirm('确认清空所有错题？')) { saveWrong(new Set()); refreshSidebar(); } };

    document.getElementById('view-gallery').onclick = () => { state.dbView = 'gallery'; renderDB(); };
    document.getElementById('view-table').onclick = () => { state.dbView = 'table'; renderDB(); };
    let st; document.getElementById('db-search').addEventListener('input', (e) => { clearTimeout(st); const v = e.target.value; st = setTimeout(() => { state.dbFilter.q = v; renderDB(); }, 180); });

    document.getElementById('detail-back').onclick = () => { renderDB(); showPanel('db'); };
    document.getElementById('detail-edit').onclick = () => { if (state.detailId != null) openForm(state.detailId); };
    document.getElementById('detail-delete').onclick = () => { if (state.detailId != null) deleteEntry(state.detailId); };

    document.getElementById('f-image').addEventListener('change', (e) => readFiles(e.target.files));
    document.getElementById('f-image-clear').onclick = () => { state.formImage = null; state.formImageDirty = true; document.getElementById('f-image').value = ''; const p = document.getElementById('f-image-preview'); p.style.display = 'none'; p.removeAttribute('src'); document.getElementById('f-image-clear').style.display = 'none'; };
    document.getElementById('form-save').onclick = () => saveForm(false);
    document.getElementById('form-save-next').onclick = () => saveForm(true);
    document.getElementById('form-cancel').onclick = () => { renderDB(); showPanel('db'); };
    document.getElementById('form-cancel2').onclick = () => { renderDB(); showPanel('db'); };

    document.querySelectorAll('#qtype-seg .seg-btn').forEach(b => b.onclick = () => {
      document.querySelectorAll('#qtype-seg .seg-btn').forEach(x => x.classList.remove('active')); b.classList.add('active');
      state.qtype = b.dataset.qtype;
      setHint(document.getElementById('qtype-hint'), state.qtype === 'series' ? '看图选出该细胞所属**系列**（粒系 / 红系 / 淋巴系…），更简单。' : '看图选出该细胞的**具体分类**（如 中性中幼粒细胞）。干扰项优先取同系列易混项。');
    });
    document.getElementById('setup-n-all').onclick = () => { document.getElementById('setup-n').value = setupPoolEntries().length; };
    document.getElementById('quizsetup-back').onclick = () => { renderDB(); showPanel('db'); };
    document.getElementById('setup-start').onclick = () => {
      const pool = setupPoolEntries(); if (!pool.length) { alert('当前筛选下没有可出题的条目。'); return; }
      let n = parseInt(document.getElementById('setup-n').value, 10); if (isNaN(n) || n < 1) n = pool.length; n = Math.min(n, pool.length);
      const shuffleOn = document.getElementById('setup-shuffle').checked;
      const chosen = shuffleOn ? shuffle(pool).slice(0, n) : pool.slice(0, n);
      startQuiz({ entries: chosen, qtype: state.qtype, shuffleOn, label: (state.qtype === 'series' ? '识别系列' : '识别细胞') + `（${chosen.length}题）`, mode: 'practice' });
    };

    document.getElementById('q-next').onclick = nextQ;
    document.getElementById('q-prev').onclick = prevQ;
    document.getElementById('q-skip').onclick = nextQ;
    document.getElementById('q-end').onclick = () => { if (confirm('确认结束本轮？')) finishQuiz(); };
    document.getElementById('qnav-toggle').onclick = () => { const n = document.getElementById('qnav'), b = document.getElementById('qnav-toggle'); const o = n.classList.toggle('open'); b.textContent = o ? '题号导航 ▴' : '题号导航 ▾'; };
    function jump() { const v = parseInt(document.getElementById('q-jump').value, 10); if (isNaN(v) || v < 1 || v > state.questions.length) { alert('题号超出范围'); return; } state.curIdx = v - 1; renderQuestion(); renderQnav(); document.getElementById('q-jump').value = ''; }
    document.getElementById('q-jump-btn').onclick = jump;
    document.getElementById('q-jump').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); jump(); } });

    document.getElementById('r-home').onclick = () => { renderDB(); showPanel('db'); };
    document.getElementById('r-review').onclick = () => { renderReview(); showPanel('review'); };
    document.getElementById('review-back').onclick = () => { renderDB(); showPanel('db'); };

    document.getElementById('export-btn').onclick = exportDB;
    document.getElementById('import-btn').onclick = () => document.getElementById('import-file').click();
    document.getElementById('import-file').addEventListener('change', e => { importDB(e.target.files && e.target.files[0]); e.target.value = ''; });
    document.getElementById('reset-btn').onclick = resetDB;

    document.getElementById('size-slider').addEventListener('input', e => setScale(parseInt(e.target.value, 10) / 100));
    document.getElementById('size-minus').onclick = () => setScale(loadScale() - 0.05);
    document.getElementById('size-plus').onclick = () => setScale(loadScale() + 0.05);
    document.querySelectorAll('.size-preset').forEach(b => b.onclick = () => setScale(parseFloat(b.dataset.scale)));

    document.addEventListener('keydown', e => {
      if (!document.getElementById('quiz').classList.contains('active')) return;
      if (document.activeElement && document.activeElement.id === 'q-jump') return;
      const k = e.key.toUpperCase();
      if (['A', 'B', 'C', 'D', 'E'].includes(k) && !state.submitted) { const b = document.querySelector(`.option[data-letter="${k}"]`); if (b) b.click(); }
      else if (e.key === 'Enter') { if (state.submitted) nextQ(); }
      else if (e.key === 'ArrowRight') { if (state.submitted || state.curIdx < state.questions.length - 1) nextQ(); }
      else if (e.key === 'ArrowLeft') prevQ();
    });
  }

  function init() {
    if (!window.SEED_ENTRIES || !Array.isArray(window.SEED_ENTRIES)) {
      document.body.textContent = ''; document.body.appendChild(el('div', { style: 'padding:40px;text-align:center;color:#dc2626' }, el('h2', { text: '加载数据失败' }), el('p', { text: '请确保 entries.js 与本页在同一目录。' }))); return;
    }
    applyScale(loadScale());
    rebuildData(); refreshSidebar(); renderDB(); bind();
  }
  init();
})();
