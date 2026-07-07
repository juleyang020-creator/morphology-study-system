(function() {
  'use strict';

  // ==== MorphShared 别名（共用工具 / 跨模块存储 key） ====
  const S = window.MorphShared;
  const el = S.el;
  const shuffle = S.shuffle;
  const toast = S.toast;
  const openImgModal = S.openImgModal;
  const closeImgModal = S.closeImgModal;
  const isSafeImgPath = S.isSafeImgPath;
  const clampScale = S.clampScale;
  const loadScale = S.loadScale;
  const saveScale = S.saveScale;
  const applyScale = S.applyScale;
  const setScale = S.setScale;
  const registerServiceWorker = S.registerServiceWorker;
  const closeDrawer = S.closeDrawer;
  const toggleDrawer = S.toggleDrawer;
  // showPanel 本模块需要额外渲染 resume UI，下面有本地包装
  const sharedShowPanel = S.showPanel;
  const K = S.KEYS;
  // 兼容旧字段名（不直接复用，保留以便后续逐步替换）
  const STORAGE_WRONG = K.quizWrong;
  const STORAGE_STATS = K.quizStats;
  const STORAGE_USER_GROUPS = K.quizUserGroups;
  const STORAGE_USER_QUESTIONS = K.quizUserQuestions;
  const STORAGE_OVERRIDES = K.quizOverrides;
  const STORAGE_DELETED = K.quizDeleted;
  const STORAGE_SESSION = K.quizSession;
  const STORAGE_UI_SCALE = K.uiScale;
  // 兼容别名：旧的 UI_SCALE_MIN/MAX 常量
  const UI_SCALE_MIN = 0.6, UI_SCALE_MAX = 1.5;

  const state = {
    allQuestions: [],
    groups: [],           // ordered list of group names (builtin first, then user)
    builtinGroups: new Set(),
    activeGroup: null,    // currently selected group in the sidebar
    sessionQuestions: [],
    results: {},          // question id -> { userAns, correct }
    currentIdx: 0,
    submitted: false,     // whether the *currently displayed* question is in answered state
    selectedSet: new Set(),
    mode: 'practice',
    sessionLabel: '',
    currentCategory: null,// the category key of the running session (for sidebar highlight)
    // ---- manage / edit state ----
    manageGroup: null,    // group name currently being managed
    editingId: null,      // question id being edited (null = adding new)
    formGroup: null,      // group the form question belongs to
    formImage: null,      // data URL (or path) of the question image in the form
    formImageDirty: false,// whether the user changed the image in this edit
    formOptionImages: null,// for image-option questions being edited
    // ---- explore (taxonomy / custom test) state ----
    exploreTree: null,
    exploreSelected: new Set(),
    exploreNodeByKey: new Map(),
    exploreCheckboxes: new Map(),
    exploreScope: 'group',   // 'group' | 'all'
    exploreQtype: 'name',    // taglib quiz type: 'name' | 'series'
    galleryNode: null,
    taglibById: new Map(),   // 'tl_<rawId>' -> normalized taglib entry
    // ---- taglib -> question bank builder ----
    tbSelected: new Set(),   // selected taglib ids in the build panel
    tbSeries: new Set(),     // active series filters
    tbTyp: new Set(),        // active typicality filters
    tbQtype: 'name',
    // ---- 性能优化：rebuildData 的存储缓存 + saveSession 防抖 ----
    _storageCache: null,        // 缓存 localStorage 中所有题库相关数据（避免每次 rebuild 重复 JSON.parse）
    _storageCacheDirty: false,  // 标记缓存是否已过期（写入后置 true，下次 rebuild 重新读）
    _saveSessionTimer: null,    // saveSession 防抖句柄（连续答题只写一次）
  };

  // ---- UI 缩放：clampScale/loadScale/saveScale/applyScale/setScale 已委派给 MorphShared ----
  // 兼容旧调用名
  function loadUIScale() { return loadScale(); }
  function saveUIScale(v) { saveScale(v); }
  function applyUIScale(v) { return applyScale(v); }
  function setUIScale(v) { setScale(v); }
  function autoFitUIScale() {
    const quizActive = document.getElementById('quiz').classList.contains('active');
    let s;
    if (quizActive) {
      // measure the actual rendered content at 100% and pick a scale that fits the viewport
      applyUIScale(1);
      void document.body.offsetHeight;                       // force reflow
      const contentH = document.documentElement.scrollHeight;
      s = (window.innerHeight - 6) / Math.max(contentH, 1);
    } else {
      // no question on screen — estimate from viewport height (assume a tall-ish question layout)
      s = window.innerHeight / 1120;
    }
    s = clampScale(Math.min(s, 1.3));
    s = Math.round(s * 100) / 100;
    setUIScale(s);
  }

  // ---- 存储读写：全部走 MorphShared.lsGet/lsSet（带 try/catch + 配额 toast） ----
  function loadWrongSet() { return new Set(S.lsGet(STORAGE_WRONG, [])); }
  function saveWrongSet(set) { const ok = S.lsSet(STORAGE_WRONG, [...set]); if (ok) invalidateStorageCache(); return ok; }
  function loadStats() { return S.lsGet(STORAGE_STATS, { answered: 0, correct: 0 }); }
  function saveStats(stats) { return S.lsSet(STORAGE_STATS, stats); }

  function loadUserGroups() { return S.lsGet(STORAGE_USER_GROUPS, []); }
  function saveUserGroups(arr) { const ok = S.lsSet(STORAGE_USER_GROUPS, arr); if (ok) invalidateStorageCache(); return ok; }
  function loadUserQuestions() { return S.lsGet(STORAGE_USER_QUESTIONS, []); }
  function saveUserQuestions(arr) { const ok = S.lsSet(STORAGE_USER_QUESTIONS, arr); if (ok) invalidateStorageCache(); return ok; }

  // ---- overrides / deletions for built-in questions ----
  function loadOverrides() { return S.lsGet(STORAGE_OVERRIDES, {}); }
  function saveOverrides(obj) { const ok = S.lsSet(STORAGE_OVERRIDES, obj); if (ok) invalidateStorageCache(); return ok; }
  function loadDeleted() { return new Set(S.lsGet(STORAGE_DELETED, [])); }
  function saveDeleted(set) { const ok = S.lsSet(STORAGE_DELETED, [...set]); if (ok) invalidateStorageCache(); return ok; }

  // ---- 性能优化：rebuildData 的 localStorage 缓存（避免重复 JSON.parse） ----
  function getCachedStorage() {
    if (state._storageCache && !state._storageCacheDirty) return state._storageCache;
    state._storageCache = {
      wrong: loadWrongSet(),
      stats: loadStats(),
      userGroups: loadUserGroups(),
      userQuestions: loadUserQuestions(),
      overrides: loadOverrides(),
      deleted: loadDeleted(),
    };
    state._storageCacheDirty = false;
    return state._storageCache;
  }
  function invalidateStorageCache() { state._storageCacheDirty = true; state._storageCache = null; }

  // is this id one of the original built-in questions?
  let _builtinIds = null;
  function builtinIdSet() {
    if (!_builtinIds) _builtinIds = new Set((window.QUESTIONS || []).map(q => q.id));
    return _builtinIds;
  }
  function isBuiltinQuestion(id) { return builtinIdSet().has(id); }

  function normalizeAnswer(s) {
    return String(s).replace(/[^A-Z]/gi, '').toUpperCase().split('').sort().join('');
  }
  // (escapeNothing 已移除——我们用 textContent，无需转义)

  // 旧 openImgModal / window.closeImgModal 已委派给 MorphShared；保留 window.closeImgModal 以兼容 onclick
  window.closeImgModal = closeImgModal;

  // 本模块的 showPanel 包装：在共用逻辑后追加 welcome 面板的 resume 渲染
  function showPanel(panelId) {
    sharedShowPanel(panelId);
    if (panelId === 'welcome') renderResumeUI();
  }

  // ---------- Sidebar ----------
  const CATEGORY_ORDER = [
    '血液细胞形态', '骨髓与造血', '尿液有形成分', '结晶/异常物质',
    '体液（脑脊液/胸腹水/灌洗液）', '微生物形态', '寄生虫',
    '染色体核型', '粪便/分泌物', '其他'
  ];

  // ---------- Flagged questions ----------
  // All flags now live in each question's `flag` field (data-driven), so they
  // travel with the data, show everywhere, and can be edited / cleared in the form.
  function questionFlag(q) { return q.flag || null; }

  // ---------- Distractor pools (for "根据答案添加近似错误选项") ----------
  // Each pool groups morphologically/clinically similar items that are commonly confused,
  // so picking distractors from the same pool yields plausible wrong options.
  const DISTRACTOR_POOLS = {
    '白细胞': ['中性分叶核粒细胞', '中性杆状核粒细胞', '嗜酸性粒细胞', '嗜碱性粒细胞', '单核细胞', '淋巴细胞', '异型淋巴细胞', '浆细胞', '大单核细胞', '花瓣样淋巴细胞'],
    '幼稚血细胞': ['原始粒细胞', '早幼粒细胞', '中幼粒细胞', '晚幼粒细胞', '原始单核细胞', '幼稚单核细胞', '原始淋巴细胞', '幼稚淋巴细胞', '原始红细胞', '早幼红细胞', '中幼红细胞', '晚幼红细胞', '异常早幼粒细胞', '异常单核细胞', '高雪氏细胞', '尼曼-匹克细胞'],
    '红细胞形态': ['正常红细胞', '球形红细胞', '椭圆形红细胞', '口形红细胞', '靶形红细胞', '镰形红细胞', '泪滴形红细胞', '棘形红细胞', '锯齿状红细胞', '裂红细胞', '咬痕红细胞', '低色素性红细胞', '嗜多色性红细胞', '低色素性大红细胞', '大红细胞', '小红细胞'],
    '红细胞排列凝集': ['正常红细胞', '缗钱状红细胞', '红细胞聚集', '红细胞冷凝集'],
    '红细胞内含物': ['豪焦小体', '卡波环', '嗜碱性点彩红细胞', '帕彭海姆小体', '有核红细胞', 'Heinz小体', '疟原虫环状体'],
    '管型': ['透明管型', '颗粒管型', '细颗粒管型', '粗颗粒管型', '红细胞管型', '白细胞管型', '上皮细胞管型', '蜡样管型', '脂肪管型', '宽幅管型', '肾衰竭管型', '血红蛋白管型', '胆红素管型', '血液管型'],
    '结晶': ['草酸钙结晶', '尿酸结晶', '非晶形尿酸盐', '非晶形磷酸盐', '磷酸铵镁结晶', '磷酸钙结晶', '尿酸铵结晶', '胱氨酸结晶', '亮氨酸结晶', '酪氨酸结晶', '胆固醇结晶', '胆红素结晶', '胆红质结晶', '磺胺类药物结晶'],
    '尿液上皮细胞': ['鳞状上皮细胞', '移行上皮细胞', '肾小管上皮细胞', '尾形上皮细胞', '圆形上皮细胞', '复粒细胞'],
    '尿液成分': ['红细胞', '白细胞', '脂肪颗粒细胞', '复粒细胞', '酵母菌', '草酸钙结晶', '透明管型', '黏液丝'],
    '真菌': ['曲霉', '毛霉', '根霉', '镰刀菌', '青霉', '念珠菌', '白色念珠菌', '新生隐球菌', '马尔尼菲篮状菌', '毛癣菌', '小孢子菌', '表皮癣菌', '孢子丝菌', '地丝菌'],
    '真菌结构': ['真菌孢子', '真菌菌丝', '假菌丝', '关节孢子', '厚壁孢子', '芽生孢子', '子囊孢子', '分生孢子'],
    '细菌染色': ['革兰阳性球菌', '革兰阴性球菌', '革兰阳性杆菌', '革兰阴性杆菌', '革兰阳性双球菌', '革兰阴性双球菌', '抗酸杆菌'],
    '疟原虫': ['间日疟原虫', '恶性疟原虫', '三日疟原虫', '卵形疟原虫', '间日疟原虫环状体', '间日疟原虫大滋养体', '间日疟原虫裂殖体', '恶性疟原虫配子体'],
    '肠道原虫': ['溶组织内阿米巴滋养体', '结肠内阿米巴滋养体', '溶组织内阿米巴包囊', '结肠内阿米巴包囊', '哈门氏内阿米巴', '微小内蜒阿米巴', '蓝氏贾第鞭毛虫滋养体', '蓝氏贾第鞭毛虫包囊', '人毛滴虫', '阴道毛滴虫'],
    '蠕虫卵': ['蛔虫卵', '受精蛔虫卵', '未受精蛔虫卵', '钩虫卵', '鞭虫卵', '蛲虫卵', '日本血吸虫卵', '华支睾吸虫卵', '姜片虫卵', '带绦虫卵', '微小膜壳绦虫卵'],
    'ANA核型': ['均质型', '颗粒型', '粗颗粒型', '细颗粒型', '核仁型', '着丝点型', '核膜型', '核点型', '胞浆颗粒型', '胞浆纤维型', '核颗粒型'],
    '浆膜腔体液细胞': ['间皮细胞', '反应性间皮细胞', '组织细胞', '巨噬细胞', '淋巴细胞', '中性粒细胞', '嗜酸性粒细胞', '浆细胞', '腺癌细胞', '鳞癌细胞', '小细胞癌细胞', '间皮瘤细胞', '肿瘤细胞'],
    '肺泡灌洗液细胞': ['肺泡巨噬细胞', '尘细胞', '含铁血黄素细胞', '心衰细胞', '纤毛柱状上皮细胞', '鳞状上皮细胞', '间质细胞', '肿瘤细胞', '朗格汉斯细胞', '淋巴细胞'],
    '血小板': ['血小板', '大血小板', '巨大血小板', '血小板聚集', '血小板卫星现象'],
    '粒细胞异常结构': ['Auer小体', '棒状小体', '柴捆细胞', '中毒颗粒', 'Döhle小体', '空泡变性', 'Pelger-Huët异常', 'May-Hegglin异常', '杜勒小体'],
  };
  // keyword → pool name, used when the answer text isn't found verbatim in any pool
  const DISTRACTOR_KW = [
    ['管型', '管型'],
    ['结晶', '结晶'], ['结石', '结晶'],
    ['受精', '蠕虫卵'], ['虫卵', '蠕虫卵'],
    ['疟原虫', '疟原虫'],
    ['阿米巴', '肠道原虫'], ['滴虫', '肠道原虫'], ['贾第', '肠道原虫'], ['鞭毛虫', '肠道原虫'],
    ['霉', '真菌'], ['念珠菌', '真菌'], ['隐球菌', '真菌'], ['癣菌', '真菌'], ['丝菌', '真菌'],
    ['菌丝', '真菌结构'], ['孢子', '真菌结构'],
    ['革兰', '细菌染色'], ['抗酸', '细菌染色'],
    ['核型', 'ANA核型'], ['均质型', 'ANA核型'], ['颗粒型', 'ANA核型'], ['核仁型', 'ANA核型'], ['着丝点型', 'ANA核型'],
    ['杆状核', '白细胞'], ['分叶核', '白细胞'], ['粒细胞', '白细胞'], ['淋巴细胞', '白细胞'], ['单核细胞', '白细胞'],
    ['幼粒', '幼稚血细胞'], ['幼红', '幼稚血细胞'], ['原始', '幼稚血细胞'],
    ['上皮', '尿液上皮细胞'],
    ['间皮', '浆膜腔体液细胞'],
    ['巨噬', '肺泡灌洗液细胞'], ['尘细胞', '肺泡灌洗液细胞'],
    ['缗钱', '红细胞排列凝集'], ['冷凝集', '红细胞排列凝集'], ['聚集', '红细胞排列凝集'],
    ['豪焦', '红细胞内含物'], ['卡波', '红细胞内含物'], ['点彩', '红细胞内含物'], ['帕彭海姆', '红细胞内含物'],
    ['红细胞', '红细胞形态'],
    ['血小板', '血小板'],
    ['Auer', '粒细胞异常结构'], ['棒状小体', '粒细胞异常结构'], ['中毒颗粒', '粒细胞异常结构'],
  ];

  function poolFor(text) {
    text = String(text || '').trim();
    if (!text) return null;
    // 1) verbatim membership
    for (const name in DISTRACTOR_POOLS) {
      if (DISTRACTOR_POOLS[name].includes(text)) return DISTRACTOR_POOLS[name];
    }
    // 2) substring overlap with pool items
    for (const name in DISTRACTOR_POOLS) {
      if (DISTRACTOR_POOLS[name].some(p => p.includes(text) || text.includes(p))) return DISTRACTOR_POOLS[name];
    }
    // 3) keyword map
    for (const [kw, poolName] of DISTRACTOR_KW) {
      if (text.includes(kw) && DISTRACTOR_POOLS[poolName]) return DISTRACTOR_POOLS[poolName];
    }
    return null;
  }

  function groupQuestions(groupName) {
    return state.allQuestions.filter(q => q.group === groupName);
  }

  // Merge built-in questions + user-created questions; rebuild group list & numbering.
  function rebuildData() {
    // 使用缓存的 localStorage 数据（避免每次 rebuild 重复 JSON.parse）
    const cached = getCachedStorage();

    // built-in group order (first appearance)
    // 注意：不要直接改写 window.QUESTIONS 上的字段（item 19），用 Object.assign 派生新对象
    const builtinOrder = [];
    const seenB = new Set();
    const normalizedBuiltin = (window.QUESTIONS || []).map(q => {
      const copy = Object.assign({}, q);
      if (copy.id == null) copy.id = q.number;
      if (copy.group == null) copy.group = '题库';
      return copy;
    });
    normalizedBuiltin.forEach(q => {
      if (!seenB.has(q.group)) { seenB.add(q.group); builtinOrder.push(q.group); }
    });
    state.builtinGroups = new Set(builtinOrder);

    const userGroups = cached.userGroups.slice();        // ordered names (may include empty groups)
    const userQs = cached.userQuestions.map(q => Object.assign({}, q, { userCreated: true }));

    // apply edits (overrides) and deletions to built-in questions
    const overrides = cached.overrides;
    const deleted = cached.deleted;
    const builtinEffective = normalizedBuiltin
      .filter(q => !deleted.has(q.id))
      .map(q => {
        if (!overrides[q.id]) return q;
        // keep the override's edits but always inherit the current built-in group
        // (so renaming a built-in bank never leaves edited questions in a stale group)
        return Object.assign({}, overrides[q.id], { group: q.group });
      });

    state.allQuestions = [...builtinEffective, ...userQs];

    // group order = builtin first, then user groups (in stored order), de-duped
    const order = [...builtinOrder];
    userGroups.forEach(g => { if (!order.includes(g)) order.push(g); });
    // also include any user-question group not yet in the list (safety)
    userQs.forEach(q => { if (!order.includes(q.group)) order.push(q.group); });
    state.groups = order;

    // recompute displayNumber per group (array order within group)
    const counters = {};
    state.allQuestions.forEach(q => {
      counters[q.group] = (counters[q.group] || 0) + 1;
      q.displayNumber = counters[q.group];
    });

    // cleanup wrong set: drop ids that no longer exist
    const allIds = new Set(state.allQuestions.map(q => q.id));
    const wrongSet = cached.wrong;
    let changed = false;
    for (const id of [...wrongSet]) { if (!allIds.has(id)) { wrongSet.delete(id); changed = true; } }
    if (changed) { saveWrongSet(wrongSet); invalidateStorageCache(); }

    // keep activeGroup valid
    if (!state.activeGroup || !state.groups.includes(state.activeGroup)) {
      state.activeGroup = state.groups[0] || null;
    }
  }

  function isBuiltinGroup(name) { return state.builtinGroups.has(name); }
  function newQuestionId() { return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function renderGroupSelect() {
    const sel = document.getElementById('group-select');
    sel.textContent = '';
    state.groups.forEach(g => {
      const n = groupQuestions(g).length;
      const opt = el('option', { value: g, text: `${g}（${n} 题）` });
      if (g === state.activeGroup) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  function updateStartAllBtn() {
    const n = groupQuestions(state.activeGroup).length;
    document.getElementById('start-all-btn').textContent = `全部练习（${n} 题）`;
  }

  function renderSidebar() {
    const sub = document.querySelector('.sb-hero .subtitle');
    if (sub) sub.textContent = `${state.groups.length} 个题库 · 共 ${state.allQuestions.length} 题`;
    renderGroupSelect();
    updateStartAllBtn();
    refreshWrongUI();
    refreshStatsUI();
  }

  function highlightSidebarCategory() { /* 分类练习 已移除，此处无操作 */ }

  function refreshWrongUI() {
    const count = loadWrongSet().size;
    document.getElementById('wrong-count').textContent = count ? `共 ${count} 道错题` : '暂无错题';
    document.getElementById('practice-wrong-btn').disabled = count === 0;
    document.getElementById('view-wrong-btn').disabled = count === 0;
    document.getElementById('clear-wrong-btn').disabled = count === 0;
  }
  function refreshStatsUI() {
    const stats = loadStats();
    document.getElementById('stats-line').textContent = stats.answered === 0
      ? '尚未开始'
      : `累计答题 ${stats.answered}，答对 ${stats.correct}，正确率 ${Math.round(stats.correct / stats.answered * 100)}%`;
  }

  // ---------- Session persistence (resume where you left off) ----------
  // 防抖：连续答题（每题都触发 saveSession）合并为 800ms 内的一次写入
  function saveSession() {
    if (state._saveSessionTimer) clearTimeout(state._saveSessionTimer);
    state._saveSessionTimer = setTimeout(_doSaveSession, 800);
  }
  function _doSaveSession() {
    state._saveSessionTimer = null;
    const qs = state.sessionQuestions;
    if (!qs || !qs.length) return;
    const data = {
      version: S.PAYLOAD_VERSION,
      savedAt: Date.now(),
      label: state.sessionLabel,
      mode: state.mode,
      currentIdx: state.currentIdx,
      currentCategory: state.currentCategory || null,
      results: state.results,
      // real questions → id refs. 标签库临时题只保存引用，避免把 data:image 大图重复写入续练进度。
      questions: qs.map(q => {
        if (q._ephemeral && q._taglibId) return { tlId: q._taglibId, qtype: q._taglibQtype || state.exploreQtype || 'name' };
        return q._ephemeral ? { e: q } : { id: q.id };
      }),
    };
    S.lsSet(STORAGE_SESSION, data);
  }
  function loadSession() { return S.lsGet(STORAGE_SESSION, null); }
  function clearSession() {
    if (state._saveSessionTimer) {
      clearTimeout(state._saveSessionTimer);
      state._saveSessionTimer = null;
    }
    S.lsRemove(STORAGE_SESSION);
  }

  // meaningful progress worth resuming? (answered something or moved past Q1)
  function sessionProgress(saved) {
    if (!saved || !Array.isArray(saved.questions) || !saved.questions.length) return null;
    const total = saved.questions.length;
    const results = saved.results || {};
    const answered = Object.keys(results).length;
    let correct = 0; for (const k in results) { if (results[k] && results[k].correct) correct++; }
    const idx = Math.min(saved.currentIdx || 0, total - 1);
    if (answered === 0 && idx === 0) return null;
    return { total, answered, correct, idx, label: saved.label || '上次练习', savedAt: saved.savedAt || null };
  }
  function relTime(ts) {
    if (!ts) return '';
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    const d = Math.floor(h / 24);
    if (d === 1) return '昨天';
    if (d < 7) return d + ' 天前';
    return new Date(ts).toLocaleDateString();
  }

  function restoreSession(saved) {
    if (!saved || !Array.isArray(saved.questions)) { clearSession(); renderResumeUI(); return; }
    const byId = new Map(state.allQuestions.map(q => [q.id, q]));
    taglibEntries();
    const qs = [];
    saved.questions.forEach(item => {
      if (item && item.e) qs.push(item.e);
      else if (item && item.tlId) {
        const e = state.taglibById.get(item.tlId);
        if (e) qs.push(taglibQuestion(e, item.qtype || saved.qtype || state.exploreQtype || 'name', { id: e.id }));
      }
      else if (item && item.id != null && byId.has(item.id)) qs.push(byId.get(item.id));
    });
    if (!qs.length) { toast('上次练习的题目已不存在，无法继续。', 'bad'); clearSession(); renderResumeUI(); return; }
    // keep only results belonging to questions still present (accurate score)
    const present = new Set(qs.map(q => String(q.id)));
    const results = {};
    Object.keys(saved.results || {}).forEach(k => { if (present.has(k)) results[k] = saved.results[k]; });
    state.sessionQuestions = qs;
    state.results = results;
    state.counted = new Set(Object.keys(results));   // 恢复时把已答题标记为已计入
    state.mode = saved.mode || 'practice';
    state.sessionLabel = saved.label || '继续练习';
    state.currentCategory = saved.currentCategory || null;
    state.currentIdx = Math.max(0, Math.min(saved.currentIdx || 0, qs.length - 1));
    state.submitted = false;
    showPanel('quiz');
    renderQnav();
    renderQuestion();
  }

  // show / hide the "继续上次练习" affordances (sidebar section + welcome banner)
  function renderResumeUI() {
    const p = sessionProgress(loadSession());
    const sec = document.getElementById('resume-section');
    const banner = document.getElementById('resume-banner');
    if (!p) {
      if (sec) sec.style.display = 'none';
      if (banner) banner.style.display = 'none';
      return;
    }
    const rate = p.answered > 0 ? Math.round(p.correct / p.answered * 100) : 0;
    const parts = [p.label, `第 ${p.idx + 1}/${p.total} 题`, `已答 ${p.answered}`];
    if (p.answered > 0) parts.push(`正确率 ${rate}%`);
    const when = relTime(p.savedAt);
    const short = `第 ${p.idx + 1}/${p.total} 题 · 已答 ${p.answered}${p.answered > 0 ? ' · 正确率 ' + rate + '%' : ''}`;
    const full = (when ? when + ' · ' : '') + parts.join(' · ');
    if (sec) { sec.style.display = 'block'; const pr = document.getElementById('resume-progress'); if (pr) pr.textContent = short; }
    if (banner) { banner.style.display = 'flex'; const bt = document.getElementById('resume-banner-text'); if (bt) bt.textContent = full; }
  }

  // ---------- Session ----------
  function startSession({ category = null, ids = null, pool = null, label = null, mode = 'practice', shuffle: forceShuffle = false } = {}) {
    let qs;
    if (pool) {
      // pre-built question objects (e.g. generated from the tag library) — use as-is
      qs = pool.slice();
    } else if (ids) {
      // preserve the order of the given ids array (dedup); supports pre-shuffled lists
      const byId = new Map(state.allQuestions.map(q => [q.id, q]));
      const seen = new Set();
      qs = [];
      ids.forEach(id => { if (!seen.has(id) && byId.has(id)) { seen.add(id); qs.push(byId.get(id)); } });
    } else if (category) {
      qs = groupQuestions(state.activeGroup).filter(q => q.category === category);
    } else {
      qs = groupQuestions(state.activeGroup);
    }
    if (qs.length === 0) { toast('没有可练习的题目', 'bad'); return; }

    if (forceShuffle || document.getElementById('shuffle-toggle').checked) qs = shuffle(qs);

    state.sessionQuestions = qs;
    state.results = {};
    state.counted = new Set();   // 本轮已计入累计统计的题（防重做重复计）
    state.currentIdx = 0;
    state.submitted = false;
    state.mode = mode;
    state.sessionLabel = label || category || '全部练习';
    state.currentCategory = category;

    highlightSidebarCategory();
    showPanel('quiz');
    renderQnav();
    renderQuestion();
    saveSession();
  }

  function counts() {
    let c = 0, w = 0;
    for (const k in state.results) { state.results[k].correct ? c++ : w++; }
    return { correct: c, wrong: w };
  }

  // ---------- Question navigator ----------
  // ---------- Scroll / motion helpers ----------
  function _reduceMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function scrollQuizTop() { window.scrollTo({ top: 0, behavior: _reduceMotion() ? 'auto' : 'smooth' }); const m = document.getElementById('main'); if (m) m.scrollTop = 0; }
  function scrollFeedbackIntoView() {
    const fb = document.querySelector('#question-card .feedback');
    if (fb) fb.scrollIntoView({ block: 'nearest', behavior: _reduceMotion() ? 'auto' : 'smooth' });
  }
  // 展开答题卡时把「当前题」滚到可视区中部（不牵动整页滚动）
  function centerCurrentQnav() {
    const nav = document.getElementById('qnav');
    if (!nav || !nav.classList.contains('open')) return;
    const cur = nav.querySelector('.qnav-item.current');
    if (cur) nav.scrollTop = Math.max(0, cur.offsetTop - nav.clientHeight / 2 + cur.clientHeight / 2);
  }
  // 重做本题：清掉本题作答，回到未答态（累计统计不重复计入，见 state.counted）
  function redoQuestion(q) {
    delete state.results[q.id];
    state.submitted = false;
    state.selectedSet = new Set();
    renderQuestion();
    renderQnav();
    refreshWrongUI();
    refreshStatsUI();
    saveSession();
  }

  function renderQnav() {
    const nav = document.getElementById('qnav');
    nav.textContent = '';
    state.sessionQuestions.forEach((q, idx) => {
      let cls = 'qnav-item';
      if (idx === state.currentIdx) cls += ' current';
      const r = state.results[q.id];
      if (r) cls += r.correct ? ' correct' : ' wrong';
      const navNumber = q.displayNumber != null ? q.displayNumber : idx + 1;
      const item = el('button', {
        class: cls,
        text: String(navNumber),
        title: `第 ${navNumber} 题`,
        onclick: () => jumpToIndex(idx)
      });
      nav.appendChild(item);
    });
    centerCurrentQnav();
  }

  function jumpToIndex(idx) {
    if (idx < 0 || idx >= state.sessionQuestions.length) { toast('题号超出范围', 'bad'); return; }
    state.currentIdx = idx;
    renderQuestion();
    renderQnav();
    scrollQuizTop();
    saveSession();
  }

  // ---------- Render a question ----------
  function renderQuestion() {
    const q = state.sessionQuestions[state.currentIdx];
    const prior = state.results[q.id]; // already answered?
    state.submitted = !!prior;
    state.selectedSet = new Set(prior ? prior.userAns.split('') : []);

    const total = state.sessionQuestions.length;
    document.getElementById('progress-label').textContent = `第 ${state.currentIdx + 1} / ${total} 题`;
    document.getElementById('category-label').textContent = state.sessionLabel;
    const cs = counts();
    document.getElementById('correct-count').textContent = cs.correct;
    document.getElementById('wrong-now-count').textContent = cs.wrong;
    const answeredN = Object.keys(state.results).length;
    document.getElementById('progress-fill').style.width = (answeredN / total * 100) + '%';
    const ji = document.getElementById('jump-input');
    ji.max = total;
    ji.placeholder = `1-${total}`;

    const card = document.getElementById('question-card');
    card.textContent = '';
    const isMulti = q.is_multi || q.answer.length > 1;

    // tag-library questions: q.category is the answer (cell name / series) — never show it as a
    // badge or it spoils the question. Show a neutral label instead, and fall back the number.
    const dispNum = (q.displayNumber != null) ? q.displayNumber : (state.currentIdx + 1);
    const catLabel = q._taglib ? '🔬 标签库 · 看图识别' : q.category;
    const meta = el('div', { class: 'q-meta' },
      el('span', { class: 'badge', text: `第 ${dispNum} 题` }),
      el('span', { class: 'badge', text: catLabel })
    );
    if (isMulti) meta.appendChild(el('span', { class: 'badge multi', text: '不定项选择' }));
    const flag = questionFlag(q);
    if (flag) {
      const fb = el('span', { class: 'badge flag', title: flag, text: '⚠ 答案存疑' });
      fb.addEventListener('click', () => toast('本题存疑说明：' + flag, 'info', 6000));
      meta.appendChild(fb);
    }
    card.appendChild(meta);

    card.appendChild(el('div', { class: 'q-text', text: q.question || '' }));

    if (q.images && q.images.length) {
      const imgWrap = el('div', { class: 'q-images' });
      q.images.forEach(src => {
        const img = el('img', { src, alt: (q.question || '题图').slice(0, 80), loading: 'lazy', decoding: 'async' });
        img.addEventListener('click', () => openImgModal(src, (q.question || '题图').slice(0, 80)));
        imgWrap.appendChild(img);
      });
      card.appendChild(imgWrap);
    }

    const rightAns = normalizeAnswer(q.answer);
    const hasOptImages = q.options.some(o => o && o.image);
    const optList = el('div', { class: 'options-list' + (hasOptImages ? ' image-options' : '') });
    q.options.forEach(opt => {
      const content = el('div', { class: 'opt-content' });
      if (opt.text) content.appendChild(document.createTextNode(opt.text));
      if (opt.image) {
        const optImg = el('img', { src: opt.image, alt: (opt.text || '选项图').slice(0, 80), loading: 'lazy', decoding: 'async' });
        optImg.addEventListener('click', e => {
          if (state.submitted) { e.stopPropagation(); openImgModal(opt.image); }
        });
        content.appendChild(optImg);
      }
      let cls = 'option';
      if (state.submitted) {
        cls += ' disabled';
        if (rightAns.includes(opt.letter)) cls += ' correct';
        else if (state.selectedSet.has(opt.letter)) cls += ' incorrect';
      } else if (state.selectedSet.has(opt.letter)) {
        cls += ' selected';
      }
      const btn = el('button', { class: cls, dataset: { letter: opt.letter } },
        el('span', { class: 'letter', text: opt.letter }),
        content
      );
      btn.addEventListener('click', () => onSelectOption(btn, q));
      optList.appendChild(btn);
    });
    card.appendChild(optList);

    if (prior) appendFeedback(card, q, prior.userAns, prior.correct);

    // Action buttons
    document.getElementById('submit-btn').style.display = (!state.submitted && isMulti) ? 'inline-block' : 'none';
    document.getElementById('next-btn').style.display = state.submitted ? 'inline-block' : 'none';
    document.getElementById('skip-btn').style.display = state.submitted ? 'none' : 'inline-block';
    document.getElementById('prev-btn').disabled = state.currentIdx === 0;
    if (state.currentIdx >= total - 1) {
      document.getElementById('next-btn').textContent = '完成本轮 ✓';
      document.getElementById('skip-btn').style.display = 'none';
    } else {
      document.getElementById('next-btn').textContent = '下一题 →';
    }
  }

  function appendFeedback(card, q, userAns, isCorrect) {
    const fb = el('div', { class: 'feedback ' + (isCorrect ? 'ok' : 'bad'), role: 'status', 'aria-live': 'polite' });
    if (isCorrect) {
      fb.appendChild(document.createTextNode('回答正确 ✓ 正确答案：'));
    } else {
      fb.appendChild(document.createTextNode('回答错误 ✗ 你的答案：'));
      fb.appendChild(el('span', { class: 'ans', text: userAns || '(未选)' }));
      fb.appendChild(document.createTextNode(' · 正确答案：'));
    }
    fb.appendChild(el('span', { class: 'ans', text: q.answer }));
    // show the correct option's text + any explanation (useful for generated tag-library questions)
    const rightSet = normalizeAnswer(q.answer);
    const rightTexts = (q.options || []).filter(o => rightSet.includes(o.letter)).map(o => o.text).filter(Boolean).join(' / ');
    if (rightTexts) fb.appendChild(el('span', { class: 'ans-text', text: '（' + rightTexts + '）' }));
    card.appendChild(fb);
    if (q.explanation) card.appendChild(el('div', { class: 'feedback-exp', text: '💡 ' + q.explanation }));
    // 误触/想重看时可重做本题（尤其单选点一下即判分的情况）
    const redoRow = el('div', { class: 'feedback-actions' },
      el('button', { class: 'btn btn-sm btn-ghost', text: '↻ 重做此题', onclick: () => redoQuestion(q) })
    );
    card.appendChild(redoRow);
  }

  function onSelectOption(btn, q) {
    if (state.submitted) return;
    const letter = btn.dataset.letter;
    const isMulti = q.is_multi || q.answer.length > 1;
    if (isMulti) {
      if (state.selectedSet.has(letter)) { state.selectedSet.delete(letter); btn.classList.remove('selected'); }
      else { state.selectedSet.add(letter); btn.classList.add('selected'); }
    } else {
      state.selectedSet = new Set([letter]);
      document.querySelectorAll('.option').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      submitAnswer();
    }
  }

  function submitAnswer() {
    const q = state.sessionQuestions[state.currentIdx];
    if (state.selectedSet.size === 0) { toast('请先选择答案', 'bad'); return; }

    if (!state.counted) state.counted = new Set();
    const idKey = String(q.id);
    const alreadyCounted = state.counted.has(idKey);   // 重做同一题不重复计入累计统计
    state.submitted = true;
    const userAns = [...state.selectedSet].sort().join('');
    const rightAns = normalizeAnswer(q.answer);
    const isCorrect = userAns === rightAns;
    state.results[q.id] = { userAns, correct: isCorrect };

    if (!alreadyCounted) {
      const stats = loadStats();
      stats.answered += 1;
      if (isCorrect) stats.correct += 1;
      if (!saveStats(stats)) return;
      state.counted.add(idKey);
    }

    // ephemeral generated questions (tag-library quick tests) are practice-only:
    // they are not real persisted questions, so keep them out of the 错题库.
    if (!q._ephemeral) {
      const wrongSet = loadWrongSet();
      if (isCorrect) {
        if (state.mode === 'wrong') { wrongSet.delete(q.id); if (!saveWrongSet(wrongSet)) return; }
      } else {
        wrongSet.add(q.id); if (!saveWrongSet(wrongSet)) return;
      }
    }

    document.querySelectorAll('.option').forEach(b => {
      const letter = b.dataset.letter;
      b.classList.add('disabled');
      b.classList.remove('selected');
      if (rightAns.includes(letter)) b.classList.add('correct');
      else if (state.selectedSet.has(letter)) b.classList.add('incorrect');
    });

    const card = document.getElementById('question-card');
    appendFeedback(card, q, userAns, isCorrect);

    const cs = counts();
    document.getElementById('correct-count').textContent = cs.correct;
    document.getElementById('wrong-now-count').textContent = cs.wrong;
    const total = state.sessionQuestions.length;
    document.getElementById('progress-fill').style.width = (Object.keys(state.results).length / total * 100) + '%';

    document.getElementById('submit-btn').style.display = 'none';
    document.getElementById('next-btn').style.display = 'inline-block';
    document.getElementById('skip-btn').style.display = 'none';

    renderQnav();
    refreshWrongUI();
    refreshStatsUI();
    saveSession();
    scrollFeedbackIntoView();   // 判分后把「正确答案 + 解析」滚入视口
  }

  function nextQuestion() {
    if (state.currentIdx >= state.sessionQuestions.length - 1) { finishSession(); return; }
    state.currentIdx += 1;
    renderQuestion();
    renderQnav();
    scrollQuizTop();
    saveSession();
  }
  function prevQuestion() {
    if (state.currentIdx === 0) return;
    state.currentIdx -= 1;
    renderQuestion();
    renderQnav();
    scrollQuizTop();
    saveSession();
  }

  function finishSession() {
    const total = state.sessionQuestions.length;
    const cs = counts();
    const answered = cs.correct + cs.wrong;
    const rate = answered > 0 ? Math.round(cs.correct / answered * 100) : 0;
    document.getElementById('result-total').textContent = total;
    document.getElementById('result-correct').textContent = cs.correct;
    document.getElementById('result-wrong').textContent = cs.wrong;
    const unansweredEl = document.getElementById('result-unanswered');
    if (unansweredEl) unansweredEl.textContent = Math.max(0, total - answered);
    document.getElementById('result-rate').textContent = rate + '%';
    clearSession();          // round finished → nothing to resume
    showPanel('result');
    refreshStatsUI();
    refreshWrongUI();
  }

  // ---------- Review ----------
  function renderReview() {
    const wrongSet = loadWrongSet();
    const list = document.getElementById('review-list');
    list.textContent = '';
    if (wrongSet.size === 0) {
      list.appendChild(el('p', { class: 'sb-muted', style: 'text-align:center;padding:40px', text: '暂无错题 🎉' }));
      return;
    }
    state.allQuestions.filter(q => wrongSet.has(q.id)).forEach(q => {
      const item = el('div', { class: 'review-item' });
      item.appendChild(el('div', { class: 'ri-header' },
        el('span', { class: 'ri-num', text: `${q.group} · 第 ${q.displayNumber} 题` }),
        el('span', { class: 'tag', text: q.category })
      ));
      const qText = q.question || '';
      item.appendChild(el('div', { class: 'ri-q', text: qText.length > 90 ? qText.slice(0, 90) + '…' : qText }));
      const ans = el('div', { class: 'ri-ans' });
      ans.appendChild(document.createTextNode('正确答案：'));
      ans.appendChild(el('span', { class: 'right', text: q.answer }));
      item.appendChild(ans);
      item.addEventListener('click', () => startSession({ ids: [q.id], label: `复习：${q.group} 第${q.displayNumber}题`, mode: 'wrong' }));
      list.appendChild(item);
    });
  }

  // ========== Tag library bridge (标签库接入) ==========
  // The cell tag library (../标签库/entries.js -> window.SEED_ENTRIES) is treated as a
  // reference image source: it feeds a dedicated branch of the 细胞分类图谱 (browse + quick
  // test) and the 题库管理 "从标签库建题" flow (turn images into permanent questions).
  const TAGLIB_TOP = '标签库·细胞图谱';
  const TL_PREFIX2SERIES = { '0': '原始/幼稚细胞', 'N': '粒细胞系', 'R': '红细胞系', 'M': '单核细胞系', 'L': '淋巴细胞系', 'J': '浆细胞系', 'P': '巨核系/血小板' };
  const TL_SERIES_ORDER = ['原始/幼稚细胞', '粒细胞系', '红细胞系', '单核细胞系', '淋巴细胞系', '浆细胞系', '巨核系/血小板', '退化细胞', '非血液细胞', '病原体', '胞质碎片（浆质体）', '杂质', '其他', '未分类'];
  const TL_TYP_LEVELS = ['典型', '一般', '不典型', '较难鉴别', '原幼细胞较难分类', '推测', '有争议'];

  // Canonical, textbook-level morphology notes per cell type — supplements missing image info
  // and is shown in the gallery / as quiz feedback. (General cell-type description, not a claim
  // about any single slide.)
  const CELL_INFO = {
    '原始细胞': '胞体较大，核大居中、染色质细致疏松、核仁清晰（1～数个）；胞质少、嗜碱性、多无颗粒。各系原始细胞需结合细胞化学 / 免疫分型鉴别。',
    '早幼粒细胞': '较原粒大，核圆或椭圆、常偏位，染色质开始聚集、核仁可见；胞质丰富，含大量紫红色嗜天青（非特异性）颗粒。',
    '中性中幼粒细胞': '核椭圆或一侧开始扁平（约占胞体 1/2～2/3），染色质聚集成块、核仁消失；胞质出现细小淡紫红的特异性中性颗粒。',
    '中性晚幼粒细胞': '核明显凹陷呈肾形（凹陷 < 核假定直径 1/2），染色质粗块状；胞质充满中性颗粒。',
    '中性杆状核粒细胞': '核呈带状 / 杆状弯曲、尚未分叶，染色质粗块；胞质粉红、布满中性颗粒。',
    '中性分叶核粒细胞': '核分 2～5 叶、叶间以细丝相连，染色质致密；胞质粉红含中性颗粒。为外周血最多的白细胞。',
    '嗜酸性粒细胞': '核多为两叶（眼镜状）；胞质充满粗大、整齐、橘红色的嗜酸性颗粒。',
    '嗜碱性粒细胞': '核常被颗粒遮盖、分叶不清；胞质含大小不等、深紫黑色的嗜碱性颗粒，常覆盖于核上。',
    '中幼红细胞': '核圆居中、染色质聚集呈车轮 / 团块状；胞质因血红蛋白增多呈嗜多色性（灰蓝—灰红）。',
    '晚幼红细胞': '核小而致密、固缩呈紫黑色团块（即将脱核）；胞质多呈淡红色，接近成熟红细胞。',
    '单核细胞': '胞体大，核形不规则（肾形 / 马蹄形 / 扭曲折叠），染色质疏松细致呈条索状；胞质灰蓝半透明，可见细小粉尘样颗粒及空泡。',
    '淋巴细胞': '小淋巴：胞体小、核圆深染、染色质粗块、胞质极少呈天蓝色；大淋巴：胞质稍多、可含少量嗜天青颗粒。',
    '异型淋巴细胞': '抗原刺激后的反应性淋巴细胞，胞体增大、形态多样（Downey Ⅰ～Ⅲ 型），胞质丰富嗜碱、边缘深染、可见空泡，核形不规则。常见于病毒感染（如传染性单核细胞增多症）。',
    '浆细胞': '核圆偏位、染色质块状呈车轮状；胞质丰富深蓝、核旁有淡染区（高尔基体），可见空泡。',
    '血小板': '巨核细胞胞质脱落的无核小体，胞体 2～4μm，淡蓝—淡红、中央含紫红色颗粒，常成簇分布。',
    '退化细胞': '涂片中破损 / 退变的细胞（如篮状 / 涂抹细胞）：核结构松散模糊、胞膜不完整，多为推片所致，一般无诊断意义。',
    '非血液细胞': '涂片中混入的非血液有核成分（如上皮细胞、组织细胞等），需与异常细胞相鉴别。',
    '病原体': '血 / 体液涂片中可见的病原微生物（如疟原虫、细菌、真菌等），需结合形态与临床综合判断。',
  };

  function tlImg(path) {
    if (!path) return '';
    if (/^(data:|https?:|\.\.\/|\/)/.test(path)) return path;
    return '../标签库/' + path;   // SEED entries store "images/xxx" relative to the 标签库 folder
  }
  function tlDerive(raw) {
    raw = (raw || '').trim();
    let code = '', name = raw;
    const us = raw.indexOf('_');
    if (us >= 0) { code = raw.slice(0, us).trim(); name = raw.slice(us + 1).trim(); }
    const series = code ? (TL_PREFIX2SERIES[code[0]] || name || '其他') : (name || '其他');
    return { code, name, series };
  }

  let _tlCache = null;
  function invalidateTaglibCache() { _tlCache = null; state.taglibById = new Map(); }
  function taglibEntries() {
    if (_tlCache) return _tlCache;
    const seed = (window.SEED_ENTRIES || []);
    // Defensive cross-module read: on file:// many browsers share localStorage across the
    // sibling 标签库 page, so the user's own additions/edits flow through automatically.
    let user = [], overrides = {}, deleted = new Set();
    try { const u = JSON.parse(localStorage.getItem(K.taglibUser) || '[]'); if (Array.isArray(u)) user = u; } catch (e) {}
    try { const o = JSON.parse(localStorage.getItem(K.taglibOverrides) || '{}'); if (o && typeof o === 'object') overrides = o; } catch (e) {}
    try { deleted = new Set(JSON.parse(localStorage.getItem(K.taglibDeleted) || '[]')); } catch (e) {}
    const eff = seed.filter(e => e && !deleted.has(e.id)).map(e => overrides[e.id] || e).concat(user);
    const map = new Map();
    _tlCache = eff.filter(e => e && e.image).map(e => {
      const d = (e.series && e.name) ? { series: e.series, name: e.name } : tlDerive(e.category || e.name || '');
      const norm = {
        id: 'tl_' + e.id,
        rawId: e.id,
        img: tlImg(e.image),
        name: e.name || d.name || '未分类',
        series: e.series || d.series || '其他',
        typicality: TL_TYP_LEVELS.includes(e.typicality) ? e.typicality : '',
        subcategory: e.subcategory || '',
        tags: Array.isArray(e.tags) ? e.tags : [],
        disease: e.disease || '',
        explanation: e.explanation || '',
        source: e.source || '',
      };
      map.set(norm.id, norm);
      return norm;
    });
    state.taglibById = map;
    return _tlCache;
  }
  function taglibAvailable() { return (window.SEED_ENTRIES && window.SEED_ENTRIES.length) || taglibEntries().length; }
  function cellNote(name) { return CELL_INFO[name] || ''; }

  // Build a practice-shape question object from one tag-library entry.
  // qtype: 'name' (识别具体细胞) | 'series' (识别所属系列). Distractors prefer same-series siblings.
  function taglibQuestion(entry, qtype, opts) {
    opts = opts || {};
    const all = taglibEntries();
    const correct = qtype === 'series' ? entry.series : entry.name;
    let pool;
    if (qtype === 'series') {
      pool = [...new Set(all.map(e => e.series))].filter(s => s && s !== correct);
      pool = shuffle(pool);
    } else {
      const same = [...new Set(all.filter(e => e.series === entry.series).map(e => e.name))].filter(n => n && n !== correct);
      const other = [...new Set(all.map(e => e.name))].filter(n => n && n !== correct && !same.includes(n));
      pool = shuffle(same).concat(shuffle(other));
    }
    pool = [...new Set(pool)].slice(0, 3);
    const LETTERS = ['A', 'B', 'C', 'D', 'E'];
    const optTexts = shuffle([correct].concat(pool));
    const options = optTexts.map((t, i) => ({ letter: LETTERS[i], text: t, image: null }));
    const answer = (options.find(o => o.text === correct) || options[0]).letter;
    const note = cellNote(entry.name);
    // ephemeral (atlas reference branch) keeps the 标签库 path; permanent (built into a bank)
    // merges into the main 血细胞·骨髓 cell tree so it lives alongside real exam questions.
    const path = opts.permanent ? ['血细胞·骨髓', entry.series, entry.name] : [TAGLIB_TOP, entry.series, entry.name];
    return {
      id: opts.id || entry.id,
      number: undefined,
      group: opts.group || TAGLIB_TOP,
      category: qtype === 'series' ? entry.series : entry.name,
      paths: [path],
      question: qtype === 'series' ? '下图细胞属于哪个系列？' : '下图视野 / 箭头所指的细胞是哪种？',
      images: [entry.img],
      options,
      answer,
      is_multi: false,
      explanation: entry.explanation || note || '',
      _taglib: true,
      _ephemeral: !opts.permanent,
      _taglibId: entry.id,
      _taglibQtype: qtype,
      userCreated: !!opts.permanent,
    };
  }

  // ========== Explore: fine-grained taxonomy + random + custom test ==========
  // tree node: { name, depth, ids:Set, entryIds:Set, children:Map<name,node>, key }
  function qPaths(q) {
    if (Array.isArray(q.paths) && q.paths.length) return q.paths;
    return [[q.category || '其他']];   // user questions fall back to flat category
  }

  // Distinct hierarchical path strings ("A / B / C") across all questions, for the add/edit datalist.
  function pathSuggestions() {
    const set = new Set();
    state.allQuestions.forEach(q => {
      if (Array.isArray(q.paths)) q.paths.forEach(p => set.add(p.join(' / ')));
      else if (q.category) set.add(q.category);
    });
    CATEGORY_ORDER.forEach(c => set.add(c));
    return [...set].sort();
  }

  // Parse a "A / B / C" path string into levels.
  function parsePathInput(raw) {
    return String(raw || '').split('/').map(s => s.trim()).filter(Boolean);
  }

  function buildTree(questions, entries) {
    const mk = (name, depth, key, parent) => ({ name, depth, ids: new Set(), entryIds: new Set(), children: new Map(), key, parent });
    const root = mk('__root__', -1, '', null);
    function addPath(path, bucket, id) {
      let node = root, key = '';
      path.forEach((level, i) => {
        key = key ? key + ' / ' + level : level;
        if (!node.children.has(level)) node.children.set(level, mk(level, i, key, node));
        node = node.children.get(level);
        node[bucket].add(id);   // aggregate ids up the chain (every ancestor gets the id)
      });
    }
    (questions || []).forEach(q => qPaths(q).forEach(path => addPath(path, 'ids', q.id)));
    (entries || []).forEach(e => addPath([TAGLIB_TOP, e.series, e.name], 'entryIds', e.id));
    return root;
  }
  // total specimens (questions + tag-library images) aggregated at a node
  function nodeCount(node) { return node.ids.size + node.entryIds.size; }

  function questionsForExplore() {
    return state.exploreScope === 'all' ? state.allQuestions.slice() : groupQuestions(state.activeGroup);
  }

  function renderExplore() {
    const qs = questionsForExplore();
    const tl = taglibEntries();                  // always include the tag-library branch
    state.exploreTree = buildTree(qs, tl);
    state.exploreSelected = new Set();           // set of node keys checked
    const scopeName = state.exploreScope === 'all' ? '全部题库' : state.activeGroup;
    document.getElementById('explore-title').textContent = `细胞分类图谱 / 组卷 — ${scopeName}`;
    document.getElementById('rand-group-name').textContent = scopeName;
    document.getElementById('rand-total').textContent = qs.length;
    document.getElementById('rand-count').max = qs.length;
    document.querySelectorAll('.scope-btn').forEach(b => b.classList.toggle('active', b.dataset.scope === state.exploreScope));
    const tlHint = document.getElementById('explore-tl-hint');
    if (tlHint) tlHint.style.display = tl.length ? 'flex' : 'none';
    document.querySelectorAll('.eqtype-btn').forEach(b => b.classList.toggle('active', b.dataset.qtype === state.exploreQtype));

    const wrap = document.getElementById('tree');
    wrap.textContent = '';
    state.exploreNodeByKey = new Map();
    state.exploreCheckboxes = new Map();
    // render top-level children sorted by descending count (tag-library branch pinned to top)
    const tops = [...state.exploreTree.children.values()].sort((a, b) => {
      if (a.name === TAGLIB_TOP) return -1;
      if (b.name === TAGLIB_TOP) return 1;
      return nodeCount(b) - nodeCount(a);
    });
    // 默认展开「标签库·细胞图谱」这一重点分支，让用户一进来就看到细胞结构
    tops.forEach(node => wrap.appendChild(renderTreeNode(node, 0, node.name === TAGLIB_TOP)));
    updateExploreFooter();
  }

  // Hierarchical checkbox: toggling a node cascades to descendants; unchecking also clears ancestors.
  function subtreeNodes(node, out) {
    out = out || [];
    out.push(node);
    node.children.forEach(c => subtreeNodes(c, out));
    return out;
  }
  function toggleNodeSelection(node, on) {
    subtreeNodes(node).forEach(d => {
      if (d.cb) d.cb.checked = on;
      if (on) state.exploreSelected.add(d.key); else state.exploreSelected.delete(d.key);
    });
    if (!on) {
      let p = node.parent;
      while (p && p.key) { if (p.cb) p.cb.checked = false; state.exploreSelected.delete(p.key); p = p.parent; }
    }
    updateExploreFooter();
  }
  function selectAllTree() {
    [...state.exploreTree.children.values()].forEach(top => toggleNodeSelection(top, true));
  }

  function renderTreeNode(node, depth, autoOpen) {
    state.exploreNodeByKey.set(node.key, node);
    const hasChildren = node.children.size > 0;
    const isTaglib = node.entryIds.size > 0 && node.ids.size === 0;   // pure tag-library node
    const container = el('div', { class: 'tree-node' });

    const row = el('div', { class: 'tree-row lvl' + depth + (isTaglib ? ' tl-node' : '') });

    const startOpen = hasChildren && !!autoOpen;
    const toggle = el('button', { type: 'button', class: 'tree-toggle' + (hasChildren ? '' : ' leaf'), text: hasChildren ? (startOpen ? '▾' : '▸') : '·', 'aria-label': hasChildren ? (startOpen ? '折叠分类' : '展开分类') : '叶节点' });
    const childrenWrap = el('div', { class: 'tree-children' + (startOpen ? ' open' : ''), style: `margin-left:${18 + depth * 6}px` });

    if (hasChildren) {
      toggle.addEventListener('click', () => {
        const open = childrenWrap.classList.toggle('open');
        toggle.textContent = open ? '▾' : '▸';
        toggle.setAttribute('aria-label', open ? '折叠分类' : '展开分类');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      toggle.setAttribute('aria-expanded', startOpen ? 'true' : 'false');
    } else {
      toggle.disabled = true;
    }

    const cb = el('input', { type: 'checkbox' });
    cb.dataset.key = node.key;
    node.cb = cb;
    state.exploreCheckboxes.set(node.key, cb);
    cb.addEventListener('change', () => { toggleNodeSelection(node, cb.checked); });

    const name = el('button', { type: 'button', class: 'tree-name', text: node.name });
    name.addEventListener('click', () => {
      if (hasChildren) { toggle.click(); }
      else { openGallery(node); }   // leaf name → image gallery
    });

    const count = el('span', { class: 'tree-count', text: nodeCount(node) });
    if (depth === 0 && isTaglib) name.appendChild(el('span', { class: 'tl-tag', text: '标签库' }));
    const gallery = el('button', { class: 'tree-practice tree-look', text: '看图', title: `查看「${node.name}」全部图片`, onclick: () => openGallery(node) });
    const practice = el('button', { class: 'tree-practice tree-do', text: '练习', title: `练习「${node.name}」`, onclick: () => practiceNode(node) });

    row.appendChild(toggle);
    row.appendChild(cb);
    row.appendChild(name);
    row.appendChild(count);
    row.appendChild(gallery);
    row.appendChild(practice);
    container.appendChild(row);

    if (hasChildren) {
      const kids = [...node.children.values()].sort((a, b) => nodeCount(b) - nodeCount(a));
      kids.forEach(child => childrenWrap.appendChild(renderTreeNode(child, depth + 1)));
      container.appendChild(childrenWrap);
    }
    return container;
  }

  // Gather a runnable question pool from a node: real questions (by id) + generated
  // tag-library questions (by entry id), so a mixed cell node practices both seamlessly.
  function nodeQuestions(node) {
    const byId = new Map(state.allQuestions.map(q => [q.id, q]));
    const out = [];
    node.ids.forEach(id => { const q = byId.get(id); if (q) out.push(q); });
    node.entryIds.forEach(id => { const e = state.taglibById.get(id); if (e) out.push(taglibQuestion(e, state.exploreQtype, { id: e.id })); });
    return out;
  }
  function practiceNode(node) {
    const pool = nodeQuestions(node);
    if (pool.length === 0) { toast('该分类暂无可练习的内容', 'bad'); return; }
    startSession({ pool, label: `分类练习：${node.name}（${pool.length}题）`, mode: 'practice', shuffle: true });
  }

  // ----- Gallery: lay out all images of one node (cell) -----
  function nodeImages(node) {
    const byId = new Map(state.allQuestions.map(q => [q.id, q]));
    const out = [];
    [...node.ids].forEach(id => {
      const q = byId.get(id);
      if (!q) return;
      const right = normalizeAnswer(q.answer);
      const correctTexts = q.options.filter(o => right.includes(o.letter)).map(o => o.text).filter(Boolean).join(' / ');
      let imgs = (q.images && q.images.length) ? q.images.slice() : [];
      if (!imgs.length) {  // question has no main image → use correct option's image(s)
        q.options.forEach(o => { if (right.includes(o.letter) && o.image) imgs.push(o.image); });
      }
      if (!imgs.length) {  // still none → any option image
        q.options.forEach(o => { if (o.image) imgs.push(o.image); });
      }
      imgs.forEach(src => out.push({
        src,
        num: q.displayNumber,
        name: correctTexts || node.name,
        group: q.group,
      }));
    });
    out.sort((a, b) => a.num - b.num);
    return out;
  }

  function taglibEntriesForNode(node) {
    const out = [];
    node.entryIds.forEach(id => { const e = state.taglibById.get(id); if (e) out.push(e); });
    return out;
  }

  function openGallery(node) {
    state.galleryNode = node;
    const imgs = nodeImages(node);                 // question-derived images
    const tlEntries = taglibEntriesForNode(node);  // tag-library reference images
    document.getElementById('gallery-title').textContent = `图谱：${node.name}`;
    const parts = [`共 ${nodeCount(node)} 项`];
    if (tlEntries.length) parts.push(`标签库图 ${tlEntries.length} 张`);
    if (imgs.length) parts.push(`题库图 ${imgs.length} 张`);
    document.getElementById('gallery-sub').textContent = parts.join(' · ') + '　（点击图片可放大查看）';

    const noteBox = document.getElementById('gallery-note');
    const note = cellNote(node.name);
    if (noteBox) { noteBox.textContent = note; noteBox.style.display = note ? 'block' : 'none'; }

    const grid = document.getElementById('gallery-grid');
    grid.textContent = '';
    if (imgs.length === 0 && tlEntries.length === 0) {
      grid.appendChild(el('div', { class: 'gallery-empty', text: '该分类下没有可显示的图片。' }));
    } else {
      const seen = new Set();
      // curated tag-library images first
      tlEntries.forEach(e => {
        if (e.img) { if (seen.has(e.img)) return; seen.add(e.img); }
        const img = el('img', { src: e.img, alt: e.name, loading: 'lazy' });
        img.addEventListener('click', () => openImgModal(e.img));
        const nameRow = el('div', { class: 'gc-name' }, document.createTextNode(e.name));
        if (e.typicality) nameRow.appendChild(el('span', { class: 'typ typ-' + e.typicality, text: e.typicality }));
        const cap = el('div', { class: 'gallery-cap' }, nameRow);
        const meta = ['🔬 标签库'];
        if (e.source) meta.push('来源 ' + e.source);
        if (e.disease) meta.push(e.disease);
        cap.appendChild(el('div', { class: 'gc-meta', text: meta.join(' · ') }));
        if (e.explanation) cap.appendChild(el('div', { class: 'gc-exp', text: e.explanation }));
        grid.appendChild(el('div', { class: 'gallery-card tl-card' }, img, cap));
      });
      imgs.forEach(item => {
        if (item.src) { if (seen.has(item.src)) return; seen.add(item.src); }
        const img = el('img', { src: item.src, alt: item.name, loading: 'lazy' });
        img.addEventListener('click', () => openImgModal(item.src));
        const cap = el('div', { class: 'gallery-cap' },
          el('div', { class: 'gc-name', text: item.name }),
          el('div', { class: 'gc-meta', text: `第 ${item.num} 题` + (state.exploreScope === 'all' ? ` · ${item.group}` : '') })
        );
        grid.appendChild(el('div', { class: 'gallery-card' }, img, cap));
      });
    }
    showPanel('gallery');
  }

  function selectedSpecimens() {
    const qIds = new Set(), eIds = new Set();
    state.exploreSelected.forEach(key => {
      const node = state.exploreNodeByKey.get(key);
      if (!node) return;
      node.ids.forEach(id => qIds.add(id));
      node.entryIds.forEach(id => eIds.add(id));
    });
    return { qIds, eIds };
  }

  function updateExploreFooter() {
    const { qIds, eIds } = selectedSpecimens();
    // count only selected leaf categories (具体细胞) for a meaningful number
    let leafCount = 0;
    state.exploreSelected.forEach(key => {
      const node = state.exploreNodeByKey.get(key);
      if (node && node.children.size === 0) leafCount++;
    });
    const total = qIds.size + eIds.size;
    document.getElementById('sel-cat-count').textContent = leafCount;
    document.getElementById('sel-q-count').textContent = total;
    document.getElementById('custom-start-btn').disabled = total === 0;
  }

  function setAllTreeOpen(open) {
    document.querySelectorAll('#tree .tree-children').forEach(c => {
      const hasKids = c.children.length > 0;
      if (!hasKids) return;
      c.classList.toggle('open', open);
    });
    document.querySelectorAll('#tree .tree-toggle').forEach(t => {
      if (t.classList.contains('leaf')) return;
      t.textContent = open ? '▾' : '▸';
    });
  }

  function clearTreeSelection() {
    state.exploreSelected = new Set();
    document.querySelectorAll('#tree input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    updateExploreFooter();
  }

  function startRandomTest() {
    const all = questionsForExplore();
    let n = parseInt(document.getElementById('rand-count').value, 10);
    if (isNaN(n) || n < 1) { toast('请输入要抽取的题目数量', 'bad'); return; }
    n = Math.min(n, all.length);
    const ids = shuffle(all.map(q => q.id)).slice(0, n);
    startSession({ ids, label: `随机测试（${n} 题）`, mode: 'practice', shuffle: true });
  }

  function startCustomTest() {
    const { qIds, eIds } = selectedSpecimens();
    if (qIds.size + eIds.size === 0) { toast('请先在上面勾选至少一个分类', 'bad'); return; }
    const byId = new Map(state.allQuestions.map(q => [q.id, q]));
    let pool = [];
    qIds.forEach(id => { const q = byId.get(id); if (q) pool.push(q); });
    eIds.forEach(id => { const e = state.taglibById.get(id); if (e) pool.push(taglibQuestion(e, state.exploreQtype, { id: e.id })); });
    const doShuffle = document.getElementById('custom-shuffle').checked;
    if (doShuffle) pool = shuffle(pool);
    const lim = parseInt(document.getElementById('custom-limit').value, 10);
    if (!isNaN(lim) && lim >= 1 && lim < pool.length) pool = pool.slice(0, lim);
    startSession({
      pool,
      label: `自定义组卷（${state.exploreSelected.size} 类 / ${pool.length} 题）`,
      mode: 'practice',
      shuffle: false,
    });
  }

  // ========== Build permanent questions from the tag library (从标签库建题) ==========
  function toggleSet(set, v) { if (set.has(v)) set.delete(v); else set.add(v); }
  function tbChip(label, on, onClick) {
    const c = el('button', { class: 'tb-chip' + (on ? ' on' : ''), text: label });
    c.addEventListener('click', onClick);
    return c;
  }
  function tbFiltered() {
    return taglibEntries().filter(e =>
      (state.tbSeries.size === 0 || state.tbSeries.has(e.series)) &&
      (state.tbTyp.size === 0 || state.tbTyp.has(e.typicality)));
  }
  function openTaglibBuild(presetGroup) {
    if (!taglibAvailable()) { toast('未找到标签库数据。请确认「标签库」与「练习系统」在同一文件夹内（综合系统）。', 'bad'); return; }
    taglibEntries();
    state.tbSelected = new Set();
    state.tbSeries = new Set();
    state.tbTyp = new Set();
    state.tbQtype = 'name';
    const sel = document.getElementById('tb-group');
    sel.textContent = '';
    const userGroups = state.groups.filter(g => !isBuiltinGroup(g));
    userGroups.forEach(g => sel.appendChild(el('option', { value: g, text: g })));
    sel.appendChild(el('option', { value: '__new__', text: '＋ 新建题库…' }));
    if (presetGroup && userGroups.includes(presetGroup)) sel.value = presetGroup;
    else if (userGroups.length === 0) sel.value = '__new__';
    renderTbControls();
    renderTbGrid();
    showPanel('taglib-build');
  }
  function renderTbControls() {
    document.querySelectorAll('.tbq-btn').forEach(b => b.classList.toggle('active', b.dataset.qtype === state.tbQtype));
    const all = taglibEntries();
    const sWrap = document.getElementById('tb-series'); sWrap.textContent = '';
    TL_SERIES_ORDER.filter(s => all.some(e => e.series === s)).forEach(s => {
      const n = all.filter(e => e.series === s).length;
      sWrap.appendChild(tbChip(`${s} (${n})`, state.tbSeries.has(s), () => { toggleSet(state.tbSeries, s); renderTbControls(); renderTbGrid(); }));
    });
    const tWrap = document.getElementById('tb-typ'); tWrap.textContent = '';
    TL_TYP_LEVELS.forEach(t => {
      const n = all.filter(e => e.typicality === t).length;
      if (!n) return;
      tWrap.appendChild(tbChip(`${t} (${n})`, state.tbTyp.has(t), () => { toggleSet(state.tbTyp, t); renderTbControls(); renderTbGrid(); }));
    });
  }
  function renderTbGrid() {
    const grid = document.getElementById('tb-grid');
    grid.textContent = '';
    const list = tbFiltered();
    document.getElementById('tb-pool').textContent = list.length;
    if (!list.length) {
      grid.appendChild(el('div', { class: 'gallery-empty', text: '没有符合筛选条件的图片。' }));
    } else {
      list.forEach(e => {
        const isSel = state.tbSelected.has(e.id);
        const card = el('button', { type: 'button', class: 'tb-card' + (isSel ? ' sel' : ''), 'aria-pressed': isSel ? 'true' : 'false' });
        card.appendChild(el('div', { class: 'tb-check', text: isSel ? '✓' : '' }));
        card.appendChild(el('img', { src: e.img, alt: e.name, loading: 'lazy' }));
        const cap = el('div', { class: 'tb-cap' }, el('span', { class: 'tb-name', text: e.name }));
        if (e.typicality) cap.appendChild(el('span', { class: 'typ typ-' + e.typicality, text: e.typicality }));
        card.appendChild(cap);
        card.addEventListener('click', () => { toggleSet(state.tbSelected, e.id); renderTbGrid(); });
        grid.appendChild(card);
      });
    }
    document.getElementById('tb-selcount').textContent = state.tbSelected.size;
    document.getElementById('tb-generate-btn').disabled = state.tbSelected.size === 0;
  }
  function tbSelectAllFiltered() { tbFiltered().forEach(e => state.tbSelected.add(e.id)); renderTbGrid(); }
  function tbClearSel() { state.tbSelected = new Set(); renderTbGrid(); }
  function generateFromTaglib() {
    if (state.tbSelected.size === 0) { toast('请先选择至少一张图片。', 'bad'); return; }
    let group = document.getElementById('tb-group').value;
    if (group === '__new__') {
      const name = (prompt('新建题库名称：', '我的标签库题库') || '').trim();
      if (!name) return;
      if (!state.groups.includes(name)) { const ug = loadUserGroups(); ug.push(name); if (!saveUserGroups(ug)) return; }
      group = name;
    } else if (isBuiltinGroup(group)) {
      toast('请选择一个自建题库或新建题库（内置题库不支持直接批量加题）。', 'bad'); return;
    }
    const qtype = state.tbQtype;
    const selected = [...state.tbSelected].map(id => state.taglibById.get(id)).filter(Boolean);
    const uq = loadUserQuestions();
    selected.forEach(e => uq.push(taglibQuestion(e, qtype, { id: newQuestionId(), group, permanent: true })));
    if (!saveUserQuestions(uq)) return;
    rebuildData();
    renderSidebar();
    toast(`已生成 ${selected.length} 道题，加入题库「${group}」。`);
    state.manageGroup = group;
    renderManageGroupQuestions();
    showPanel('manage-group');
  }

  // ========== Question bank management ==========
  function openManage() {
    state.currentCategory = null; highlightSidebarCategory();
    renderManageGroups();
    showPanel('manage');
  }

  function renderManageGroups() {
    const list = document.getElementById('manage-group-list');
    list.textContent = '';
    state.groups.forEach(g => {
      const n = groupQuestions(g).length;
      const builtin = isBuiltinGroup(g);
      const row = el('div', { class: 'manage-row' });
      const info = el('div', { class: 'mr-info' });
      const nameLine = el('div', { class: 'mr-name' });
      nameLine.appendChild(document.createTextNode(g));
      nameLine.appendChild(el('span', { class: builtin ? 'badge-builtin' : 'badge-user', text: builtin ? '内置·可编辑' : '自建' }));
      info.appendChild(nameLine);
      info.appendChild(el('div', { class: 'mr-sub', text: `${n} 道题` }));
      row.appendChild(info);

      const actions = el('div', { class: 'mr-actions' });
      actions.appendChild(el('button', { class: 'btn btn-sm', text: '管理题目', onclick: () => openManageGroup(g) }));
      actions.appendChild(el('button', { class: 'btn btn-sm btn-ghost', text: '导出', onclick: () => exportUserData(g) }));
      if (builtin) {
        actions.appendChild(el('button', { class: 'btn btn-sm btn-ghost', text: '恢复默认', onclick: () => resetBuiltinGroup(g) }));
      } else {
        actions.appendChild(el('button', { class: 'btn btn-sm btn-ghost', text: '重命名', onclick: () => renameUserGroup(g) }));
        actions.appendChild(el('button', { class: 'btn btn-sm btn-danger-ghost', text: '删除', onclick: () => deleteUserGroup(g) }));
      }
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  // Restore a built-in group to its shipped default (clear edits + deletions + added questions for that group)
  function resetBuiltinGroup(g) {
    if (!confirm(`确认将「${g}」恢复为内置默认？\n你对该题库的所有编辑、删除将被清除（自建添加进该题库的题目也会移除），且不可撤销。`)) return;
    const overrides = loadOverrides();
    const deleted = loadDeleted();
    (window.QUESTIONS || []).forEach(q => {
      if (q.group === g) { delete overrides[q.id]; deleted.delete(q.id); }
    });
    if (!saveOverrides(overrides) || !saveDeleted(deleted)) return;
    // remove user-added questions that were placed into this built-in group
    if (!saveUserQuestions(loadUserQuestions().filter(q => q.group !== g))) return;
    rebuildData(); renderSidebar(); renderManageGroups();
  }

  function createUserGroup() {
    let name = prompt('请输入新题库的名称：', '');
    if (name == null) return;
    name = name.trim();
    if (!name) { toast('名称不能为空', 'bad'); return; }
    if (state.groups.includes(name)) { toast('已存在同名题库', 'bad'); return; }
    const ug = loadUserGroups();
    ug.push(name);
    if (!saveUserGroups(ug)) return;
    rebuildData();
    renderSidebar();
    renderManageGroups();
    // jump straight into the new group's question editor
    openManageGroup(name);
  }

  function renameUserGroup(oldName) {
    if (isBuiltinGroup(oldName)) return;
    let name = prompt('请输入新的题库名称：', oldName);
    if (name == null) return;
    name = name.trim();
    if (!name) { toast('名称不能为空', 'bad'); return; }
    if (name === oldName) return;
    if (state.groups.includes(name)) { toast('已存在同名题库', 'bad'); return; }
    const ug = loadUserGroups().map(g => g === oldName ? name : g);
    if (!saveUserGroups(ug)) return;
    const uq = loadUserQuestions().map(q => { if (q.group === oldName) q.group = name; return q; });
    if (!saveUserQuestions(uq)) return;
    if (state.activeGroup === oldName) state.activeGroup = name;
    if (state.manageGroup === oldName) state.manageGroup = name;
    rebuildData();
    renderSidebar();
    renderManageGroups();
  }

  function deleteUserGroup(name) {
    if (isBuiltinGroup(name)) return;
    const n = groupQuestions(name).length;
    if (!confirm(`确认删除题库「${name}」？其中的 ${n} 道题目也会一并删除，且不可恢复。`)) return;
    if (!saveUserGroups(loadUserGroups().filter(g => g !== name))) return;
    if (!saveUserQuestions(loadUserQuestions().filter(q => q.group !== name))) return;
    rebuildData();
    renderSidebar();
    renderManageGroups();
  }

  // ---- export / import ----
  function exportUserData(onlyGroup) {
    const ug = loadUserGroups();
    const uq = loadUserQuestions();
    let groups, questions;
    if (onlyGroup && isBuiltinGroup(onlyGroup)) {
      // export the current (possibly edited) effective questions of a built-in group
      groups = [onlyGroup];
      questions = groupQuestions(onlyGroup);
    } else if (onlyGroup) {
      groups = [onlyGroup];
      questions = uq.filter(q => q.group === onlyGroup);
    } else {
      groups = ug.slice();
      questions = uq.slice();
    }
    if (groups.length === 0 && questions.length === 0) {
      toast('当前没有可导出的题库内容。', 'bad');
      return;
    }
    const payload = {
      app: 'morphology-quiz',
      type: 'question-bank-export',
      version: S.PAYLOAD_VERSION,
      exportedAt: new Date().toISOString(),
      groups,
      questions,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const safe = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_');
    const a = el('a', {
      href: url,
      download: (onlyGroup ? `形态学题库_${safe(onlyGroup)}` : '形态学自建题库') + `_${ymd}.json`,
    });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);  // 2s → 10s：大文件下载需要更多时间
  }

  function importUserData(file) {
    if (!file) return;
    const importCheck = S.isSafeImportFile(file);
    if (!importCheck.ok) { toast(importCheck.reason, 'bad'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try { data = JSON.parse(reader.result); }
      catch (e) { toast('导入失败：所选文件不是有效的 JSON 文件。', 'bad'); return; }
      if (!data || !Array.isArray(data.questions)) {
        toast('导入失败：文件格式不正确（找不到题目数据）。请使用本程序「导出」生成的文件。', 'bad');
        return;
      }
      // 版本校验（item 4）：高版本或缺少版本字段时拒绝
      if (!S.checkPayloadVersion(data)) {
        toast('导入失败：文件版本不兼容（version=' + (data && data.version) + '）。', 'bad');
        return;
      }

      const ug = loadUserGroups();
      const uq = loadUserQuestions();
      // ID 冲突映射（item 4）：导入的题目若 id 与已存在 id 冲突，重新分配并记录
      const existingIds = new Set(state.allQuestions.map(q => q.id));
      const idMap = {};
      let remapped = 0;
      // 为每条导入题分配不冲突的 id
      data.questions.forEach(q => {
        if (!q || typeof q.question !== 'string' || !q.question.trim()) return;
        if (q.id == null || existingIds.has(q.id)) {
          const newId = newQuestionId();
          if (q.id != null) { idMap[q.id] = newId; remapped++; }
          q.id = newId;
        }
        existingIds.add(q.id);
      });
      // 校验图片路径安全（item 6）：拒绝 ../ 等跨目录路径
      data.questions.forEach(q => {
        if (q && Array.isArray(q.images)) q.images = q.images.filter(s => isSafeImgPath(s));
        if (q && Array.isArray(q.options)) q.options.forEach(o => {
          if (o && typeof o.image === 'string' && !isSafeImgPath(o.image)) o.image = null;
        });
      });

      const taken = new Set([...state.groups, ...ug]); // builtin + existing user groups
      function uniqueName(name) {
        if (!taken.has(name)) return name;
        let i = 2, n;
        do { n = `${name} (${i++})`; } while (taken.has(n));
        return n;
      }

      // figure out incoming groups (from data.groups and any referenced by questions)
      const incoming = Array.isArray(data.groups) ? data.groups.filter(g => typeof g === 'string' && g.trim()) : [];
      data.questions.forEach(q => { if (q && typeof q.group === 'string' && q.group.trim() && !incoming.includes(q.group)) incoming.push(q.group); });

      const nameMap = {};
      let newGroupCount = 0;
      incoming.forEach(g => {
        if (ug.includes(g)) {
          // an existing USER group with the same name: merge into it
          nameMap[g] = g;
        } else if (state.builtinGroups.has(g)) {
          // collides with a built-in group: must use a new name
          const nn = uniqueName(g);
          nameMap[g] = nn; ug.push(nn); taken.add(nn); newGroupCount++;
        } else {
          nameMap[g] = g; ug.push(g); taken.add(g); newGroupCount++;
        }
      });

      let added = 0, skipped = 0;
      data.questions.forEach(q => {
        if (!q || typeof q.question !== 'string' || !q.question.trim()) { skipped++; return; }
        if (!Array.isArray(q.options) || q.options.length < 2) { skipped++; return; }
        let grp = (typeof q.group === 'string' && nameMap[q.group]) ? nameMap[q.group] : null;
        if (!grp) { skipped++; return; }
        const optLetterMap = {};
        const opts = [];
        q.options.forEach((o, i) => {
          if (!o) return;
          const text = (typeof o.text === 'string') ? o.text.trim() : '';
          const image = (typeof o.image === 'string' && o.image) ? o.image : null;
          if (!text && !image) return;
          const newLetter = String.fromCharCode(65 + opts.length);
          const oldLetter = String(o.letter || String.fromCharCode(65 + i)).toUpperCase().replace(/[^A-Z]/g, '').charAt(0) || String.fromCharCode(65 + i);
          optLetterMap[oldLetter] = newLetter;
          opts.push({ letter: newLetter, text, image });
        });
        if (opts.length < 2) { skipped++; return; }
        const answer = normalizeAnswer(q.answer).split('').map(L => optLetterMap[L]).filter(Boolean).sort().join('');
        const validAns = answer.length > 0 && [...answer].every(L => opts.some(o => o.letter === L));
        if (!validAns) { skipped++; return; }
        uq.push({
          id: q.id || newQuestionId(),
          group: grp,
          category: (typeof q.category === 'string' && q.category.trim()) ? q.category.trim() : '其他',
          question: q.question.trim(),
          images: Array.isArray(q.images) ? q.images.filter(s => typeof s === 'string' && s) : [],
          options: opts,
          answer,
          is_multi: answer.length > 1,
          userCreated: true,
        });
        added++;
      });

      if (added === 0 && newGroupCount === 0) {
        toast('导入失败：文件中没有可识别的题库或题目。', 'bad');
        return;
      }
      if (!saveUserGroups(ug)) return;
      if (!saveUserQuestions(uq)) return;   // quota guard inside
      invalidateStorageCache();

      rebuildData();
      renderSidebar();
      renderManageGroups();
      showPanel('manage');
      toast(`导入完成：新增 ${newGroupCount} 个题库、${added} 道题目`
        + (skipped ? `（另有 ${skipped} 条数据格式异常，已跳过）` : '')
        + (remapped ? `（${remapped} 条 ID 冲突已重新分配）` : '') + '。');
    };
    reader.readAsText(file);
  }

  // ---- one group's question list ----
  function openManageGroup(name) {
    state.manageGroup = name;
    renderManageGroupQuestions();
    showPanel('manage-group');
  }

  function renderManageGroupQuestions() {
    const name = state.manageGroup;
    const builtin = isBuiltinGroup(name);
    document.getElementById('mg-title').textContent = `「${name}」（共 ${groupQuestions(name).length} 题${builtin ? ' · 内置·可编辑' : ''}）`;
    document.getElementById('mg-add-q-btn').style.display = 'inline-block';

    const list = document.getElementById('mg-question-list');
    list.textContent = '';
    const qs = groupQuestions(name);
    if (qs.length === 0) {
      list.appendChild(el('p', { class: 'sb-muted', style: 'text-align:center;padding:30px', text: '该题库还没有题目，点击右上角「＋ 添加题目」开始。' }));
      return;
    }
    qs.forEach(q => {
      const row = el('div', { class: 'manage-row' });
      const info = el('div', { class: 'mr-info' });
      const qText = q.question || '(无题干)';
      const flag = questionFlag(q);
      const titleLine = el('div', { class: 'mq-text', text: `第 ${q.displayNumber} 题：${qText.length > 70 ? qText.slice(0, 70) + '…' : qText}` });
      if (flag) {
        const b = el('span', { class: 'badge flag', title: flag, text: '⚠ 答案存疑', style: 'margin-left:6px;cursor:help' });
        b.addEventListener('click', () => toast('本题存疑说明：' + flag, 'info', 6000));
        titleLine.appendChild(b);
      }
      info.appendChild(titleLine);
      info.appendChild(el('div', { class: 'mq-meta', text: `分类：${q.category} · 正确答案：${q.answer}` + (q.images && q.images.length ? ' · 含图片' : '') }));
      row.appendChild(info);
      const actions = el('div', { class: 'mr-actions' });
      actions.appendChild(el('button', { class: 'btn btn-sm', text: '编辑', onclick: () => openQuestionForm(name, q.id) }));
      actions.appendChild(el('button', { class: 'btn btn-sm btn-danger-ghost', text: '删除', onclick: () => deleteQuestion(q.id) }));
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  function deleteQuestion(id) {
    const q = state.allQuestions.find(x => x.id === id);
    if (!confirm(`确认删除第 ${q ? q.displayNumber : '?'} 题？此操作不可恢复（内置题可用题库列表的「恢复默认」找回）。`)) return;
    if (isBuiltinQuestion(id)) {
      let ok = true;
      const del = loadDeleted(); del.add(id); ok = saveDeleted(del);
      const ov = loadOverrides(); if (ov[id]) { delete ov[id]; ok = saveOverrides(ov) && ok; }
      if (!ok) return;
    } else {
      if (!saveUserQuestions(loadUserQuestions().filter(x => x.id !== id))) return;
    }
    const ws = loadWrongSet(); ws.delete(id); if (!saveWrongSet(ws)) return;
    rebuildData();
    renderSidebar();
    renderManageGroupQuestions();
  }

  // ---- add / edit a question form ----
  function openQuestionForm(group, id) {
    state.formGroup = group;
    state.editingId = id || null;
    state.formImage = null;
    state.formImageDirty = false;
    state.formOptionImages = null;

    document.getElementById('qf-title').textContent = id ? '编辑题目' : '添加题目';
    document.getElementById('qf-group-name').textContent = group;

    // category datalist: offer all existing taxonomy paths (so user questions can nest into the tree)
    const dl = document.getElementById('qf-category-list');
    dl.textContent = '';
    pathSuggestions().forEach(c => dl.appendChild(el('option', { value: c })));

    const existing = id ? state.allQuestions.find(q => q.id === id) : null;
    // prefill the path field: prefer an existing hierarchical path, else the flat category
    let pathStr = '';
    if (existing) {
      if (Array.isArray(existing.paths) && existing.paths.length) pathStr = existing.paths[0].join(' / ');
      else pathStr = existing.category || '';
    }
    document.getElementById('qf-category').value = pathStr;
    document.getElementById('qf-question').value = existing ? (existing.question || '') : '';
    document.getElementById('qf-flag').value = (existing && existing.flag) ? existing.flag : '';

    // image-option questions: keep their option images; show a note
    const hasOptImages = !!(existing && existing.options && existing.options.some(o => o.image));
    document.getElementById('qf-imgopt-note').style.display = hasOptImages ? 'block' : 'none';
    state.formOptionImages = hasOptImages
      ? existing.options.map(o => ({ letter: o.letter, image: o.image, text: o.text || '' }))
      : null;

    // base-option template dropdown
    const baseSel = document.getElementById('qf-base-template');
    baseSel.textContent = '';
    baseSel.appendChild(el('option', { value: '', text: '选择一组常见选项…' }));
    Object.keys(DISTRACTOR_POOLS).forEach(key => {
      const preview = DISTRACTOR_POOLS[key].slice(0, 3).join(' / ');
      baseSel.appendChild(el('option', { value: key, text: `${key}（${preview}…）` }));
    });
    baseSel.value = '';

    // image
    document.getElementById('qf-image-file').value = '';
    const prev = document.getElementById('qf-image-preview');
    const clearBtn = document.getElementById('qf-image-clear');
    if (existing && existing.images && existing.images.length) {
      state.formImage = existing.images[0];
      prev.src = state.formImage; prev.style.display = 'block';
      clearBtn.style.display = 'inline-block';
    } else {
      prev.style.display = 'none'; prev.removeAttribute('src');
      clearBtn.style.display = 'none';
    }

    // options rows (A-E)
    const optWrap = document.getElementById('qf-options');
    optWrap.textContent = '';
    const LETTERS = ['A', 'B', 'C', 'D', 'E'];
    const rightSet = existing ? new Set(normalizeAnswer(existing.answer).split('')) : new Set();
    // 实时提示题型（单选 / 不定项），并高亮已勾「正确」的行
    const answerHint = el('div', { class: 'qf-answer-type' });
    function updateAnswerTypeHint() {
      let n = 0;
      optWrap.querySelectorAll('.qf-opt-row').forEach(row => {
        const c = row.querySelector('input[type="checkbox"]');
        if (c && c.checked) { n++; row.classList.add('is-correct'); } else row.classList.remove('is-correct');
      });
      answerHint.className = 'qf-answer-type ' + (n === 0 ? 'none' : n === 1 ? 'single' : 'multi');
      answerHint.textContent = n === 0 ? '⚠ 还没勾选「正确」选项' : (n === 1 ? '题型：单选题' : `题型：不定项选择（${n} 个正确）`);
    }
    for (let i = 0; i < 5; i++) {
      const letter = LETTERS[i];
      const existingOpt = existing && existing.options[i] ? existing.options[i] : null;
      const textInput = el('input', {
        type: 'text', class: 'qf-opt-text',
        placeholder: i < 2 ? `选项 ${letter}（必填）` : `选项 ${letter}（可留空）`
      });
      if (existingOpt) textInput.value = existingOpt.text || '';
      const cb = el('input', { type: 'checkbox' });
      if (existingOpt && rightSet.has(existingOpt.letter)) cb.checked = true;
      cb.addEventListener('change', updateAnswerTypeHint);
      const row = el('div', { class: 'qf-opt-row' },
        el('span', { class: 'qf-opt-letter', text: letter }),
        textInput,
        el('label', { class: 'qf-opt-correct' }, cb, document.createTextNode('正确'))
      );
      optWrap.appendChild(row);
    }
    optWrap.appendChild(answerHint);
    updateAnswerTypeHint();

    showPanel('qform');
  }

  function handleFormImageFile(file) {
    if (!file) return;
    const check = S.isAcceptableImageFile(file);
    if (!check.ok) { toast(check.reason, 'bad'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      state.formImage = reader.result;
      state.formImageDirty = true;
      const prev = document.getElementById('qf-image-preview');
      prev.src = state.formImage; prev.style.display = 'block';
      document.getElementById('qf-image-clear').style.display = 'inline-block';
    };
    reader.readAsDataURL(file);
  }

  function clearFormImage() {
    state.formImage = null;
    state.formImageDirty = true;
    document.getElementById('qf-image-file').value = '';
    const prev = document.getElementById('qf-image-preview');
    prev.style.display = 'none'; prev.removeAttribute('src');
    document.getElementById('qf-image-clear').style.display = 'none';
  }

  // Insert a set of common "base options" from a template pool into empty option slots.
  function insertBaseOptions() {
    const key = document.getElementById('qf-base-template').value;
    if (!key || !DISTRACTOR_POOLS[key]) { toast('请先在左侧下拉中选择一组基础选项。', 'bad'); return; }
    const rows = [...document.querySelectorAll('#qf-options .qf-opt-row')].map(r => r.querySelector('.qf-opt-text'));
    const existing = new Set(rows.map(i => (i.value || '').trim()).filter(Boolean));
    const emptySlots = rows.filter(i => !(i.value || '').trim());
    if (emptySlots.length === 0) { toast('选项已填满。如需替换，请先清空部分选项再插入。', 'bad'); return; }
    // take pool items not already present, up to the number of empty slots (cap at 4 for a typical question)
    const pool = DISTRACTOR_POOLS[key].filter(t => !existing.has(t));
    const want = Math.min(emptySlots.length, Math.max(4 - existing.size, 1), pool.length);
    for (let i = 0; i < want; i++) emptySlots[i].value = pool[i];
    if (pool.length === 0) toast('该组选项已全部填入。');
  }

  // Auto-fill plausible wrong distractors based on the checked (correct) option(s).
  function autoFillDistractors() {
    const rows = [...document.querySelectorAll('#qf-options .qf-opt-row')].map(r => ({
      input: r.querySelector('.qf-opt-text'),
      cb: r.querySelector('input[type="checkbox"]'),
    }));
    const filledTexts = rows.map(r => (r.input.value || '').trim());
    const correctTexts = rows
      .map((r, i) => (r.cb.checked && filledTexts[i] ? filledTexts[i] : null))
      .filter(Boolean);

    if (correctTexts.length === 0) {
      toast('请先填写「正确选项」的内容并勾选其旁边的「正确」框，再点此按钮。', 'bad');
      return;
    }

    const filledCount = filledTexts.filter(Boolean).length;
    const target = filledCount >= 4 ? Math.min(filledCount, 5) : 4;
    let need = target - filledCount;
    if (need <= 0) {
      toast('当前选项已经填满，无需自动补充。如需更多干扰项，请先清空部分选项。');
      return;
    }

    // gather candidates from the matching pool(s)
    const existing = new Set(filledTexts.filter(Boolean));
    let candidates = [];
    let matched = false;
    correctTexts.forEach(ct => {
      const pool = poolFor(ct);
      if (pool) { matched = true; candidates = candidates.concat(pool); }
    });
    candidates = [...new Set(candidates)].filter(c => !existing.has(c));

    if (!matched || candidates.length === 0) {
      toast('未能根据当前答案匹配到形态相近的错误选项，请手动填写。（提示：答案用规范的形态学名称，如「中性分叶核粒细胞」「红细胞管型」「曲霉」等，自动匹配效果更好）', 'bad');
      return;
    }

    candidates = shuffle(candidates);
    const picked = new Set(filledTexts.filter(Boolean)); // correct answers + any manual options already present
    const tooSimilar = (c) => [...picked].some(p => p === c || p.includes(c) || c.includes(p));
    for (const r of rows) {
      if (need <= 0) break;
      if (!(r.input.value || '').trim()) {
        let chosen = null;
        while (candidates.length) {
          const c = candidates.shift();
          if (!tooSimilar(c)) { chosen = c; break; }
        }
        if (!chosen) break;
        r.input.value = chosen;
        r.cb.checked = false;       // freshly-filled distractor is NOT marked correct
        picked.add(chosen);
        need--;
      }
    }
    if (need > 0) {
      toast('已尽量补充，但匹配到的相近选项数量有限，剩余空位请手动填写。');
    }
  }

  function saveQuestionForm() {
    const group = state.formGroup;
    const editingBuiltin = state.editingId && isBuiltinQuestion(state.editingId);
    const existing = state.editingId ? state.allQuestions.find(q => q.id === state.editingId) : null;
    const levels = parsePathInput(document.getElementById('qf-category').value);
    const path = levels.length ? levels : ['其他'];
    const category = path[path.length - 1];   // leaf = short label
    const question = (document.getElementById('qf-question').value || '').trim();
    if (!question) { toast('请填写题干', 'bad'); return; }
    const flagText = (document.getElementById('qf-flag').value || '').trim();

    const LETTERS = ['A', 'B', 'C', 'D', 'E'];
    const rows = [...document.querySelectorAll('#qf-options .qf-opt-row')];
    let options, answer;

    if (state.formOptionImages) {
      // image-option question: keep option images, only the correct selection may change
      const checks = rows.map(r => r.querySelector('input[type="checkbox"]').checked);
      options = state.formOptionImages.map(o => ({ letter: o.letter, text: o.text || '', image: o.image }));
      const correct = options.map((o, i) => (checks[i] ? o.letter : null)).filter(Boolean);
      if (correct.length === 0) { toast('请至少勾选一个正确选项', 'bad'); return; }
      answer = correct.sort().join('');
    } else {
      const filled = [];
      rows.forEach(r => {
        const text = (r.querySelector('.qf-opt-text').value || '').trim();
        const checked = r.querySelector('input[type="checkbox"]').checked;
        if (text) filled.push({ text, checked });
      });
      if (filled.length < 2) { toast('请至少填写 A、B 两个选项的内容', 'bad'); return; }
      const correctIdx = filled.map((o, i) => (o.checked ? i : -1)).filter(i => i >= 0);
      if (correctIdx.length === 0) { toast('请至少勾选一个正确选项', 'bad'); return; }
      options = filled.map((o, i) => ({ letter: LETTERS[i], text: o.text, image: null }));
      answer = correctIdx.map(i => LETTERS[i]).join('');
    }

    // preserve images: keep existing unless the user changed the upload
    let images;
    if (state.formImageDirty) images = state.formImage ? [state.formImage] : [];
    else if (existing) images = existing.images || [];
    else images = state.formImage ? [state.formImage] : [];

    const q = {
      id: state.editingId || newQuestionId(),
      number: existing ? existing.number : undefined,
      group,
      category,
      paths: [path],
      question,
      images,
      options,
      answer,
      is_multi: answer.length > 1,
    };
    if (flagText) q.flag = flagText;
    if (!editingBuiltin) q.userCreated = true;

    if (editingBuiltin) {
      // store as an override of the built-in question
      const ov = loadOverrides();
      ov[state.editingId] = q;
      if (!saveOverrides(ov)) return;
    } else {
      const uq = loadUserQuestions();
      if (state.editingId) {
        const idx = uq.findIndex(x => x.id === state.editingId);
        if (idx >= 0) uq[idx] = q; else uq.push(q);
      } else {
        uq.push(q);
      }
      if (!saveUserQuestions(uq)) return;
    }

    rebuildData();
    renderSidebar();
    state.manageGroup = group;
    renderManageGroupQuestions();
    showPanel('manage-group');
  }

  // ---------- Events ----------
  function bindEvents() {
    // mobile drawer
    const dt = document.getElementById('drawer-toggle');
    if (dt) { dt.onclick = toggleDrawer; dt.setAttribute('aria-expanded', 'false'); }
    const bd = document.getElementById('drawer-backdrop');
    if (bd) bd.onclick = closeDrawer;
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

    // 数据行动事件代理（替代 onclick="closeImgModal()" 之类的内联调用）
    document.addEventListener('click', e => {
      const t = e.target.closest('[data-action]');
      if (!t) return;
      const action = t.getAttribute('data-action');
      if (action === 'closeImgModal') { e.stopPropagation(); closeImgModal(); }
    });
    // 抽屉打开/关闭时同步 aria-expanded
    const app = document.getElementById('app');
    if (app) {
      const sync = () => { if (dt) dt.setAttribute('aria-expanded', app.classList.contains('drawer-open') ? 'true' : 'false'); };
      new MutationObserver(sync).observe(app, { attributes: true, attributeFilter: ['class'] });
    }

    // resume last session
    const resumeGo = () => { const s = loadSession(); if (s) restoreSession(s); else renderResumeUI(); };
    const resumeDiscard = () => { if (confirm('确认放弃上次练习进度？')) { clearSession(); renderResumeUI(); } };
    ['resume-btn', 'resume-banner-continue'].forEach(id => { const b = document.getElementById(id); if (b) b.onclick = resumeGo; });
    ['resume-discard', 'resume-banner-discard'].forEach(id => { const b = document.getElementById(id); if (b) b.onclick = resumeDiscard; });

    document.getElementById('group-select').onchange = (e) => {
      state.activeGroup = e.target.value;
      state.currentCategory = null;
      updateStartAllBtn();
      closeDrawer();
    };
    document.getElementById('start-all-btn').onclick = () => startSession({ label: `${state.activeGroup} · 全部练习` });
    document.getElementById('practice-wrong-btn').onclick = () => {
      const set = loadWrongSet();
      startSession({ ids: [...set], label: '错题练习（全部分组）', mode: 'wrong' });
    };
    document.getElementById('view-wrong-btn').onclick = () => {
      state.currentCategory = null; highlightSidebarCategory();
      renderReview(); showPanel('review');
    };
    document.getElementById('clear-wrong-btn').onclick = () => {
      if (confirm('确认清空所有错题？') && saveWrongSet(new Set())) { refreshWrongUI(); }
    };
    document.getElementById('reset-stats-btn').onclick = () => {
      if (confirm('确认重置所有答题统计？') && saveStats({ answered: 0, correct: 0 })) { refreshStatsUI(); }
    };
    document.getElementById('end-session-btn').onclick = () => {
      const total = state.sessionQuestions.length;
      const cs = counts();
      const answered = cs.correct + cs.wrong;
      const unanswered = Math.max(0, total - answered);
      const msg = `确认结束本轮？\n本轮共 ${total} 题，已答 ${answered}、未答 ${unanswered}。\n结束后会显示成绩，并清除「继续上次」记录。\n（只是想暂时离开、保留进度，请点「暂离」。）`;
      if (confirm(msg)) { finishSession(); }
    };
    const pauseBtn = document.getElementById('pause-session-btn');
    if (pauseBtn) pauseBtn.onclick = () => { saveSession(); showPanel('welcome'); };   // 保留进度回主页
    document.getElementById('review-back-btn').onclick = () => { state.currentCategory = null; highlightSidebarCategory(); showPanel('welcome'); };

    // ---- 界面尺寸 (UI scale) ----
    document.getElementById('size-slider').addEventListener('input', e => setUIScale(parseInt(e.target.value, 10) / 100));
    document.getElementById('size-minus').onclick = () => setUIScale(loadUIScale() - 0.05);
    document.getElementById('size-plus').onclick = () => setUIScale(loadUIScale() + 0.05);
    document.getElementById('size-auto-btn').onclick = autoFitUIScale;
    document.querySelectorAll('.size-preset').forEach(b => {
      b.onclick = () => setUIScale(parseFloat(b.dataset.scale));
    });
    document.getElementById('submit-btn').onclick = submitAnswer;
    document.getElementById('next-btn').onclick = nextQuestion;
    document.getElementById('prev-btn').onclick = prevQuestion;
    document.getElementById('skip-btn').onclick = nextQuestion;
    document.getElementById('result-home-btn').onclick = () => { state.currentCategory = null; highlightSidebarCategory(); showPanel('welcome'); };
    document.getElementById('result-review-btn').onclick = () => { renderReview(); showPanel('review'); };

    // ---- question bank management ----
    document.getElementById('manage-btn').onclick = openManage;
    document.getElementById('manage-close-btn').onclick = () => showPanel('welcome');

    // ---- explore: taxonomy / random / custom ----
    document.getElementById('explore-btn').onclick = () => {
      state.currentCategory = null; highlightSidebarCategory();
      renderExplore(); showPanel('explore');
    };
    document.getElementById('explore-close-btn').onclick = () => showPanel('welcome');
    document.getElementById('rand-start-btn').onclick = startRandomTest;
    document.getElementById('rand-10').onclick = () => { document.getElementById('rand-count').value = 10; startRandomTest(); };
    document.getElementById('rand-20').onclick = () => { document.getElementById('rand-count').value = 20; startRandomTest(); };
    document.getElementById('rand-50').onclick = () => { document.getElementById('rand-count').value = 50; startRandomTest(); };
    document.getElementById('tree-expand-btn').onclick = () => setAllTreeOpen(true);
    document.getElementById('tree-collapse-btn').onclick = () => setAllTreeOpen(false);
    document.getElementById('tree-selectall-btn').onclick = selectAllTree;
    document.getElementById('tree-clear-btn').onclick = clearTreeSelection;
    document.getElementById('custom-start-btn').onclick = startCustomTest;
    document.querySelectorAll('.scope-btn').forEach(b => {
      b.onclick = () => { state.exploreScope = b.dataset.scope; renderExplore(); };
    });
    document.getElementById('gallery-back-btn').onclick = () => showPanel('explore');
    document.getElementById('gallery-practice-btn').onclick = () => { if (state.galleryNode) practiceNode(state.galleryNode); };
    // tag-library quiz type (controls how the 标签库 cells are quizzed)
    document.querySelectorAll('.eqtype-btn').forEach(b => {
      b.onclick = () => { state.exploreQtype = b.dataset.qtype; document.querySelectorAll('.eqtype-btn').forEach(x => x.classList.toggle('active', x === b)); };
    });

    // ---- build permanent questions from the tag library ----
    const tbOpen = document.getElementById('tb-open-btn');
    if (tbOpen) tbOpen.onclick = () => openTaglibBuild();
    const mgFromTl = document.getElementById('mg-from-taglib-btn');
    if (mgFromTl) mgFromTl.onclick = () => openTaglibBuild(state.manageGroup);
    const tbClose = document.getElementById('tb-close-btn');
    if (tbClose) tbClose.onclick = () => { renderManageGroups(); showPanel('manage'); };
    document.querySelectorAll('.tbq-btn').forEach(b => {
      b.onclick = () => { state.tbQtype = b.dataset.qtype; document.querySelectorAll('.tbq-btn').forEach(x => x.classList.toggle('active', x === b)); };
    });
    const tbSa = document.getElementById('tb-selectall-btn'); if (tbSa) tbSa.onclick = tbSelectAllFiltered;
    const tbCl = document.getElementById('tb-clear-btn'); if (tbCl) tbCl.onclick = tbClearSel;
    const tbGen = document.getElementById('tb-generate-btn'); if (tbGen) tbGen.onclick = generateFromTaglib;

    document.getElementById('new-group-btn').onclick = createUserGroup;
    document.getElementById('export-all-btn').onclick = () => exportUserData(null);
    document.getElementById('import-btn').onclick = () => document.getElementById('import-file').click();
    document.getElementById('import-file').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      importUserData(f);
      e.target.value = '';
    });
    document.getElementById('mg-back-btn').onclick = () => { renderManageGroups(); showPanel('manage'); };
    document.getElementById('mg-add-q-btn').onclick = () => { if (state.manageGroup) openQuestionForm(state.manageGroup); };
    const backToGroup = () => { state.manageGroup = state.formGroup; renderManageGroupQuestions(); showPanel('manage-group'); };
    document.getElementById('qf-cancel-btn').onclick = backToGroup;
    document.getElementById('qf-cancel-btn2').onclick = backToGroup;
    document.getElementById('qf-save-btn').onclick = saveQuestionForm;
    document.getElementById('qf-image-file').addEventListener('change', e => handleFormImageFile(e.target.files && e.target.files[0]));
    document.getElementById('qf-image-clear').onclick = clearFormImage;
    document.getElementById('qf-autofill-btn').onclick = autoFillDistractors;
    document.getElementById('qf-base-insert').onclick = insertBaseOptions;

    // Question navigator toggle
    document.getElementById('qnav-toggle').onclick = () => {
      const nav = document.getElementById('qnav');
      const btn = document.getElementById('qnav-toggle');
      const open = nav.classList.toggle('open');
      btn.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.textContent = open ? '题号导航 ▴' : '题号导航 ▾';
      if (open) centerCurrentQnav();   // 展开时把当前题滚到可视区
    };

    // Jump
    function doJump() {
      const v = parseInt(document.getElementById('jump-input').value, 10);
      if (isNaN(v)) { toast('请输入题号', 'bad'); return; }
      // The jump input is "第几题" within the session (1-based by current order)
      jumpToIndex(v - 1);
      document.getElementById('jump-input').value = '';
    }
    document.getElementById('jump-btn').onclick = doJump;
    document.getElementById('jump-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); doJump(); }
    });

    document.addEventListener('keydown', e => {
      if (S.isImgModalOpen()) return;
      if (!document.getElementById('quiz').classList.contains('active')) return;
      if (document.activeElement && document.activeElement.id === 'jump-input') return;
      const key = e.key.toUpperCase();
      if (['A', 'B', 'C', 'D', 'E'].includes(key) && !state.submitted) {
        const btn = document.querySelector(`.option[data-letter="${key}"]`);
        if (btn) btn.click();
      } else if (e.key === 'Enter') {
        if (state.submitted) nextQuestion();
        else if (document.getElementById('submit-btn').style.display !== 'none') submitAnswer();
      } else if (e.key === 'ArrowRight') { if (state.currentIdx < state.sessionQuestions.length - 1) nextQuestion(); }
      else if (e.key === 'ArrowLeft') { prevQuestion(); }
    });
  }

  function init() {
    registerServiceWorker(new URL('../sw.js', window.location.href).toString());
    window.addEventListener('storage', e => {
      if ([K.taglibUser, K.taglibOverrides, K.taglibDeleted, K.taglibTaxo].includes(e.key)) invalidateTaglibCache();
    });
    if (!window.QUESTIONS || !Array.isArray(window.QUESTIONS)) {
      document.body.textContent = '';
      document.body.appendChild(el('div', { style: 'padding:40px;text-align:center;color:#dc2626' },
        el('h2', { text: '加载题库失败' }),
        el('p', { text: '请确保 questions.js 文件存在于同目录下。' })
      ));
      return;
    }
    applyUIScale(loadUIScale());
    rebuildData();
    renderSidebar();
    bindEvents();
    renderResumeUI();   // offer "继续上次练习" if a session was in progress
  }

  init();
})();
