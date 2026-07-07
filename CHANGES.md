# 形态学综合系统 — 代码改进记录

> 本文档记录为提升代码质量、性能、可访问性、数据安全与 PWA 体验所做的全部修改。
> 改进点按主题编号（1–37），与此前代码评审建议及本轮追加核查问题对应。

---

## 1. PWA：file:// 下 Service Worker 不生效 → 本地 HTTP 启动器
**问题**：双击 `index.html` 走 `file://` 协议，SW 在 file:// 下不注册，离线缓存完全失效。
**修改**：
- 重写 `双击启动.command`（macOS）：自动找可用端口，启动 `python3 -m http.server`（回退 python/npx serve），再打开浏览器
- 新建 `双击启动.bat`（Windows）：python → py → npx → file:// 回退链
- 涉及文件：
  - `双击启动.command`
  - `双击启动.bat`

## 2. Service Worker 注册分散 → 统一注册与更新处理
**问题**：旧版子模块各自写注册脚本，缺少统一更新处理，容易出现旧缓存接管后页面仍停留在旧版本。
**修改**：
- 子模块改为通过 `shared/ui.js` 的 `registerServiceWorker()` 统一注册 `../sw.js`
- 根 `index.html` 增加 `controllerchange` 监听，新版本接管后自动刷新一次
- 注册成功后主动 `reg.update()`，减少用户长期停留在旧缓存的概率
- 涉及文件：`shared/ui.js`、`标签库/app.js`、`练习系统/app.js`、`index.html`

## 3. 跨模块 localStorage key 散落硬编码 → 统一到 MorphShared.KEYS
**问题**：两模块各自硬编码 `'mtl_user_entries_v1'` / `'morphology_wrong_v1'` 等字符串，重命名时易漏。
**修改**：
- 在 `shared/ui.js` 定义 `KEYS` 常量，集中所有 key
- `标签库/app.js` 顶部 `const K = S.KEYS;`，替换原硬编码
- `练习系统/app.js` 同样替换；`taglibEntries()` 跨模块读标签库数据改用 `K.taglibUser / K.taglibOverrides / K.taglibDeleted`
- 涉及文件：`shared/ui.js`、`标签库/app.js`、`练习系统/app.js`

## 4. 导入数据缺版本校验 + ID 冲突 → 版本校验 + 自动重映射
**问题**：导入 JSON 时无版本字段校验，未来升级 schema 会静默破坏数据；导入题 id 与已有 id 冲突时直接覆盖。
**修改**：
- `shared/ui.js` 新增 `PAYLOAD_VERSION=1` 与 `checkPayloadVersion(data)`
- `标签库/app.js` `importDB`：版本不符时拒绝；构建 `idMap` 解决 ID 冲突并报告重映射数量
- `练习系统/app.js` `importUserData`：版本校验 + ID 冲突重新分配（记录 `remapped` 计数）
- 涉及文件：`shared/ui.js`、`标签库/app.js`、`练习系统/app.js`

## 5. localStorage 写入裸调用 → 统一带 try/catch + 配额 toast
**问题**：所有 `localStorage.setItem` 直接调用，配额溢出时抛未捕获异常。
**修改**：
- `shared/ui.js` 提供 `lsSet(key, value)`：内部 try/catch，失败时弹 toast「存储空间已满」
- 两模块所有 save 函数改走 `S.lsSet`，删除重复的 try/catch + alert 样板
- 涉及文件：`shared/ui.js`、`标签库/app.js`、`练习系统/app.js`

## 6. 图片路径无校验 → 按模块使用安全白名单
**问题**：导入或外部数据中可能含 `../../etc/passwd` 等路径，虽 file:// 下不致泄漏，但拼接后可能加载非预期资源。
**修改**：
- `shared/ui.js` 新增 `isSafeImgPath(s)`：允许练习系统题图使用 `data:image/`、`images/`、`images_2024/` 以及标签库生成题的 `../标签库/images/`
- `shared/ui.js` 新增 `isSafeTaglibImgPath(s)`：标签库自身导入只允许 `data:image/` 与 `images/`
- 两模块导入时过滤不安全路径，显式拒绝其它 `../`
- 涉及文件：`shared/ui.js`、`标签库/app.js`、`练习系统/app.js`

## 7. 题图无懒加载 → loading="lazy" decoding="async"
**问题**：每题 2–4 张图全部立即加载，长题列表会卡顿。
**修改**：
- `练习系统/app.js` 渲染题图与选项图时加 `loading: 'lazy', decoding: 'async'`
- 标签库画廊图原本已有 `loading: 'lazy'`，保留
- 涉及文件：`练习系统/app.js`

## 8. 多模块工具函数重复定义 → 提取 shared/ui.js
**问题**：`shuffle` / `el` / `openImgModal` / `clampScale` / `applyScale` / `closeDrawer` / `toggleDrawer` / `showPanel` 在两模块各自定义，bug 修一处漏一处。
**修改**：
- 新建 `shared/ui.js`（232 行）暴露 `window.MorphShared`，集中所有共用工具
- 两模块在 `index.html` 用 `<script src="../shared/ui.js">` 引入，IIFE 顶部用别名引用
- 涉及文件：`shared/ui.js`（新建）、`标签库/index.html`、`标签库/app.js`、`练习系统/index.html`、`练习系统/app.js`

## 9. 基础样式重复 → 提取 shared/base.css
**问题**：两模块 `style.css` 各自包含按钮、侧栏、面板、模态框等完全相同的 token 与基础规则。
**修改**：
- 新建 `shared/base.css`，移入设计 token、按钮、侧栏、面板、quiz-header、qnav、options、feedback、modal、toast、模块切换、移动端抽屉等共用样式
- 两模块 `style.css` 仅保留模块专属样式，开头 `<link rel="stylesheet" href="../shared/base.css">`
- 涉及文件：`shared/base.css`（新建）、`标签库/index.html`、`标签库/style.css`、`练习系统/index.html`、`练习系统/style.css`

## 10. 单行 JSON 难以 diff → 多行格式化
**问题**：`entries.js`（160 条）和 `questions.js`（320 条）每条写成单行，git diff 时整行变更难以定位字段。
**修改**：
- 用 Node 脚本将 `window.SEED_ENTRIES = [...]` 与 `window.QUESTIONS = [...]` 重新格式化为 `JSON.stringify(x, null, 1)` 多行结构
- 涉及文件：`标签库/entries.js`、`练习系统/questions.js`

## 11. saveSession 每答一题连写 4 次 → 防抖合并
**问题**：练习系统每答一题触发 `saveSession` 多达 4 次（选答案 / 翻页 / 计分 / 错题库），大 session 时 4× 串行 localStorage 写。
**修改**：
- `练习系统/app.js`：`saveSession` 改用 `setTimeout` 800ms 防抖，实际写入函数 `_doSaveSession`
- 状态字段 `_saveSessionTimer` 跟踪句柄
- 涉及文件：`练习系统/app.js`

## 12. SW 预缓存列表不全 → 补全两模块所有资源
**问题**：原 `PRECACHE` 仅含根页面与少量资源，子模块首次离线访问会因缓存缺失而白屏。
**修改**：
- `sw.js` `PRECACHE` 列表加入两模块的 `index.html` / `app.js` / `style.css` / 数据 JS / `shared/base.css` / `shared/ui.js` / 各 icon
- shell 资源用 `addAll` 确保安装时真正缓存完整；图片资源另行容错预缓存
- 涉及文件：`sw.js`

## 13. SW 缓存无淘汰 → 独立 IMG_CACHE + FIFO
**问题**：图片与 shell 共用同一缓存，无限增长会撑爆移动端配额（~78MB 图片）。
**修改**：
- `sw.js` 拆分 `SHELL_CACHE` 与 `IMG_CACHE`，后者上限 `IMG_CACHE_MAX=700`
- 命中后入队，超限时按 FIFO 顺序 `caches.delete` 最早条目
- 版本号 bump 到 `morph-pwa-v3`，activate 时清旧版本缓存
- 涉及文件：`sw.js`

## 14. alert() 用于非破坏性反馈 → toast
**问题**：所有提示都用 `alert()`，每次都阻断主线程、强制点击关闭。
**修改**：
- `shared/ui.js` 新增 `toast(message, kind, ttl)`：`aria-live="polite"`、3 秒自动消失、`bad` 状态 5 秒、`info` 可自定义 ttl
- 两模块所有「保存成功 / 导入完成 / 校验失败」类提示（约 30 处）替换为 `toast`
- 保留 `confirm()` 用于真正破坏性操作（清空错题、放弃进度、删除条目）
- 涉及文件：`shared/ui.js`、`标签库/app.js`、`练习系统/app.js`

## 15. 图片模态框无焦点管理 → 焦点陷阱 + 返回焦点
**问题**：`openImgModal` 仅改 src、加 `.show`，键盘用户 Tab 会跑到背景元素；关闭后焦点丢失。
**修改**：
- `shared/ui.js` `openImgModal(src, altText)`：保存 `document.activeElement`，把焦点移到关闭按钮，模态框加 `keydown` 监听（Esc 关闭）
- `closeImgModal`：移除监听，把焦点还给原元素
- 涉及文件：`shared/ui.js`

## 16. 图片 alt 文本无意义 → 取题目/选项文字
**问题**：题图 `alt="题图"`、选项图 `alt="选项图"`，对屏幕阅读器毫无信息量。
**修改**：
- `练习系统/app.js` 渲染时用 `(q.question || '题图').slice(0, 80)` 与 `(opt.text || '选项图').slice(0, 80)` 作为 alt
- 标签库画廊图原本就用细胞名作 alt，保留
- 涉及文件：`练习系统/app.js`

## 17. 触摸目标小于 44×44px → qnav 题号按钮放大
**问题**：题号导航按钮原 32×32px，违反 WCAG 2.5.5（移动端 44×44px 最低）。
**修改**：
- `shared/base.css` `.qnav button` 改为 `min-width:44px; min-height:44px`
- 涉及文件：`shared/base.css`

## 18. 重复的「带空格」图片文件 → 删除
**问题**：`练习系统/images/` 下有 3 个 `xxx 2.png` 副本文件，占用空间且可能导致引用混乱。
**修改**：
- 删除 `f1_image74 2.png`、`f81_image8 2.png`、`f81_image54 2.png`
- 涉及文件：`练习系统/images/`

## 19. 直接改写 window.QUESTIONS → Object.assign 派生
**问题**：`rebuildData` 中 `if (q.id == null) q.id = q.number;` 直接改写全局 `window.QUESTIONS`，多次调用后内置题库已被污染。
**修改**：
- `练习系统/app.js` `rebuildData`：用 `Object.assign({}, q)` 派生副本再补默认字段
- 涉及文件：`练习系统/app.js`

## 20. rebuildData 每次 JSON.parse 6 次 → 缓存复用
**问题**：每次 `rebuildData` 都会 `loadWrongSet / loadStats / loadUserGroups / loadUserQuestions / loadOverrides / loadDeleted` 共 6 次 `JSON.parse`，但同一帧内数据不变。
**修改**：
- `练习系统/app.js` 新增 `getCachedStorage()` / `invalidateStorageCache()`
- `rebuildData` 改读 `cached`，写后调 `invalidateStorageCache` 失效
- 涉及文件：`练习系统/app.js`

## 21. 内联 onclick → data-action 事件代理
**问题**：`onclick="closeImgModal()"` 等内联处理器违反 CSP 最佳实践、难追踪。
**修改**：
- 两模块 `index.html` 模态框与关闭按钮改 `data-action="closeImgModal"`
- 两模块 `app.js` 在 `bind`/`bindEvents` 中挂全局 `document.addEventListener('click', ...)`，按 `data-action` 派发
- 涉及文件：`标签库/index.html`、`标签库/app.js`、`练习系统/index.html`、`练习系统/app.js`

## 22. btnize 命名晦涩 + escapeNothing 占位 → 重命名 + 删除
**问题**：`btnize(node)` 不知所云；`escapeNothing(s)` 是「我们用 textContent 不需转义」的占位，徒增困惑。
**修改**：
- `shared/ui.js` 重命名为 `makeKeyboardActivatable(node, label)`；两模块保留 `btnize = S.makeKeyboardActivatable` 别名兼容旧调用
- 删除 `escapeNothing`
- 涉及文件：`shared/ui.js`、`标签库/app.js`、`练习系统/app.js`

## 23. iPadOS 16+ 误判为 macOS → 用 maxTouchPoints 检测
**问题**：旧代码用 `navigator.userAgent` 检测 iOS，iPadOS 16+ 默认请求桌面 UA 后误判。
**修改**：
- `index.html` PWA 安装提示逻辑改用 `navigator.maxTouchPoints > 0` + `display-mode: standalone` + Safari 风格组合判断
- 涉及文件：`index.html`

## 24. URL.revokeObjectURL 2s 太短 → 10s
**问题**：导出文件后 2 秒就 revoke blob URL，大文件下载未完成即失效。
**修改**：
- 两模块导出函数的 `setTimeout(..., 2000)` 改为 `10000`
- 涉及文件：`标签库/app.js`、`练习系统/app.js`

## 25. manifest 缺 id 字段 → 补相对 id
**问题**：PWA manifest 无 `id`，浏览器会用 start_url 当 id，start_url 变更时 PWA 身份丢失。
**修改**：
- `manifest.webmanifest` 加 `"id": "./"`，避免部署到子路径时与站点根路径冲突
- 涉及文件：`manifest.webmanifest`

## 26. `.typ-推测` 颜色对比度 3.9:1 → 加深到 6.4:1
**问题**：`.typ-推测` 文字 `#475569` on `#f1f5f9` 背景，对比度 3.9:1，未达 WCAG AA 4.5:1。
**修改**：
- 文字色加深为 `#334155`，背景改为 `#e2e8f0`，对比度 6.4:1
- `.typ-other` 同步修正
- 涉及文件：`标签库/style.css`、`练习系统/style.css`

## 27. 练习系统写入后缓存未失效 → 保存函数统一失效缓存
**问题**：`rebuildData()` 读取本地缓存后，部分写入函数未清缓存，保存题库、错题或覆盖记录后可能短时间看到旧数据。
**修改**：
- `saveWrongSet` / `saveUserGroups` / `saveUserQuestions` / `saveOverrides` / `saveDeleted` 写入成功后统一调用 `invalidateStorageCache()`
- 保存函数返回写入结果，后续流程可在失败时中止
- 涉及文件：`练习系统/app.js`

## 28. 续练防抖写入可能复活已结束进度 → 结束时清理定时器
**问题**：`saveSession()` 防抖后，用户完成或放弃练习时，尚未执行的定时器可能把已清除的进度重新写回。
**修改**：
- `clearSession()` 先取消 `_saveSessionTimer`，再删除续练记录
- 标签库临时题的续练记录改存标签库条目引用，不再把大图数据重复写入 session
- 恢复续练时按 `tlId` 重新从标签库构造题目
- 涉及文件：`练习系统/app.js`

## 29. 练习题导入丢失纯图片选项 → 保留图片选项并重映射答案
**问题**：导入题库时只保留有文字的选项，纯图片选项会被删掉，答案字母也可能失配。
**修改**：
- 导入选项时保留「文字或图片任一存在」的选项
- 按保留下来的新选项顺序重新映射答案字母
- 导入图片路径允许标签库生成题使用的 `../标签库/images/` 安全路径
- 涉及文件：`练习系统/app.js`、`shared/ui.js`

## 30. 上传与导入缺少体积限制 → 图片 / JSON 大小保护
**问题**：大图片或大 JSON 直接读入浏览器，容易撑满 localStorage 或造成页面卡死。
**修改**：
- `shared/ui.js` 增加图片大小、批量数量、导入 JSON 大小检查
- 标签库批量上传最多处理 30 张，过大或非图片文件直接跳过并提示
- 练习系统题图上传和两模块导入都先做体积检查
- 涉及文件：`shared/ui.js`、`标签库/app.js`、`练习系统/app.js`

## 31. 标签库备份遗漏自定义分类 → 导出 / 导入 taxonomy
**问题**：标签库备份只带自建图片、修改和删除记录，未带「分类管理」里新增但尚未使用的分类 / 子分类。
**修改**：
- `exportDB()` 增加 `taxonomy`
- `importDB()` 合并导入的 `categories` / `subcategories`
- 仅自定义分类的备份也允许导入，不再误报为空文件
- 涉及文件：`标签库/app.js`

## 32. 标签库导入校验不够严格 → 专用图片白名单与保存失败中止
**问题**：标签库导入复用练习系统图片白名单，且部分写入失败后仍刷新界面，可能让用户误以为导入成功。
**修改**：
- 标签库导入只允许 `images/` 和合理大小的 `data:image/`
- 覆盖内置条目时统一用数字编号作为保存键
- 用户条目、覆盖、删除、分类写入任一步失败都中止后续刷新
- 涉及文件：`标签库/app.js`、`shared/ui.js`

## 33. 离线图片未预缓存 → 从数据文件扫描并缓存 526 张图片
**问题**：shell 文件可离线，但题库图片未预缓存；首次离线打开题目或标签库时图片可能缺失。
**修改**：
- `sw.js` 从 `标签库/entries.js` 与 `练习系统/questions.js` 扫描 `images/` / `images_2024/` 图片路径
- 安装 Service Worker 时将扫描到的图片放入 `IMG_CACHE`
- 失败图片使用二进制 PNG 占位响应，修复旧版把 data URL 文本当 `image/png` 返回的问题
- 涉及文件：`sw.js`

## 34. Windows 启动器固定端口 → 自动避让占用端口
**问题**：`双击启动.bat` 固定使用 8765，端口被占用时启动失败，并且浏览器可能早于服务器打开。
**修改**：
- 从 8765 开始检测占用，自动递增寻找空闲端口
- 延迟约 1.2 秒后再打开浏览器
- Python / py / npx 三种启动方式共用同一个端口和打开逻辑
- 涉及文件：`双击启动.bat`

## 35. 键盘可访问性补强 → 模态框、树节点、题库卡片
**问题**：图片模态框只处理 Esc，部分可点击区域不是原生按钮，键盘焦点不够明确。
**修改**：
- 图片模态框加入 Tab 焦点循环，并在打开时暂停背景答题快捷键
- 练习系统树节点和标签库组题卡片改为原生 `button`
- 新增 `.tree-toggle` / `.tree-name` / `.tb-card` / `.img-modal-close` 焦点轮廓
- 涉及文件：`shared/ui.js`、`shared/base.css`、`练习系统/app.js`、`练习系统/style.css`、`标签库/app.js`

## 36. 分类筛选用短名称 → 改用完整分类键
**问题**：标签库筛选使用 `name`，同名但不同编号的分类可能被合并显示。
**修改**：
- 新增 `entryCategoryKey()`，筛选、统计和组题设置统一使用 `category || name`
- 自定义分类在筛选中以完整分类名保留
- 涉及文件：`标签库/app.js`

## 37. 题号导航显示异常 → 标签库临时题用会话序号兜底
**问题**：标签库快速测验生成的是临时题，没有固定 `displayNumber` 时题号导航可能显示 `undefined`。
**修改**：
- `renderQnav()` 显示 `displayNumber`，缺失时回退为当前序号 `idx + 1`
- 涉及文件：`练习系统/app.js`

---

## 附：模块结构

```
形态学综合系统/
├── index.html              # 主入口（PWA hub，注册 SW）
├── manifest.webmanifest    # PWA 清单
├── sw.js                   # Service Worker（shell + img 双缓存）
├── 双击启动.command          # Mac 启动器（本地 HTTP）
├── 双击启动.bat             # Windows 启动器
├── shared/
│   ├── base.css            # 共用 CSS token 与基础组件
│   └── ui.js               # MorphShared 工具集
├── 标签库/
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── entries.js          # 160 条标签库数据
├── 练习系统/
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── questions.js        # 320 道真题
│   └── images/
└── CHANGES.md              # 本文档
```
