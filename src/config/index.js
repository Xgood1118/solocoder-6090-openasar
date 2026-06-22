const { ipcMain, app, shell } = require('electron');
const fs = require('fs');
const { join, resolve, basename, sep } = require('path');

ipcMain.on('DISCORD_UPDATED_QUOTES', (e, c) => {
  if (c === 'o') exports.open();
});

const restart = () => {
  app.relaunch();
  app.exit(0);
};

const MODULE_NAME_REGEX = /^[a-zA-Z0-9_-]{1,100}$/;

const isModuleNameSafe = (name) => {
  if (typeof name !== 'string') return false;
  if (!MODULE_NAME_REGEX.test(name)) return false;
  if (name.includes('..')) return false;
  if (name.includes(sep)) return false;
  if (name.includes('/')) return false;
  if (name.includes('\\')) return false;
  if (name.includes('\0')) return false;
  return true;
};

const isPathInsideBase = (targetPath, basePath) => {
  try {
    const normalizedTarget = resolve(targetPath);
    const normalizedBase = resolve(basePath) + sep;
    if (!normalizedTarget.startsWith(normalizedBase)) return false;
    const relativePart = normalizedTarget.slice(normalizedBase.length);
    if (relativePart.includes('..' + sep) || relativePart.includes(sep + '..')) return false;
    return true;
  } catch {
    return false;
  }
};

const getValidModuleNames = () => {
  const names = new Set();
  try {
    const moduleUpdater = require('../updater/moduleUpdater');
    const installed = moduleUpdater.getInstalled();
    for (const name in installed) {
      if (isModuleNameSafe(name)) names.add(name);
    }
  } catch {}
  try {
    const Module = require('module');
    for (const p of Module.globalPaths) {
      const baseName = p.split(/[\\/]/).pop();
      const cleanName = baseName.replace(/-\d[\d.]*$/, '');
      if (isModuleNameSafe(cleanName)) names.add(cleanName);
      if (isModuleNameSafe(baseName)) names.add(baseName);
    }
  } catch {}
  return names;
};

const calcDirSize = (dir) => {
  let total = 0;
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        total += calcDirSize(full);
      } else if (item.isFile()) {
        try { total += fs.statSync(full).size; } catch {}
      }
    }
  } catch {}
  return total;
};

const fmtSize = (bytes) => {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
};

const getModuleBasePath = () => {
  try {
    const paths = require('../paths');
    const buildInfo = require('../utils/buildInfo');
    if (buildInfo.localModulesRoot != null) return buildInfo.localModulesRoot;
    if (buildInfo.newUpdater) return join(paths.getUserData(), 'module_data');
    return join(paths.getUserDataVersioned(), 'modules');
  } catch { return null; }
};

const enumerateModules = () => {
  const modules = [];
  const base = getModuleBasePath();
  const disabledSet = new Set((oaConfig.disabledModules || []));

  try {
    const moduleUpdater = require('../updater/moduleUpdater');
    const installed = moduleUpdater.getInstalled();
    for (const rawName in installed) {
      if (!isModuleNameSafe(rawName)) {
        log('Config', 'Skipping unsafe module name in enumeration:', rawName);
        continue;
      }
      const name = rawName;
      let size = 0;
      let modulePath = null;
      if (base) {
        const tryPaths = [
          join(base, name),
          join(base, name + '-' + (installed[name].installedVersion || '')),
          join(base, name + '-' + (installed[name].installedVersion || ''), name)
        ];
        for (const rawP of tryPaths) {
          if (!isPathInsideBase(rawP, base)) continue;
          const p = resolve(rawP);
          if (!isPathInsideBase(p, base)) continue;
          if (fs.existsSync(p)) {
            modulePath = p;
            size = calcDirSize(p);
            break;
          }
        }
      }
      modules.push({
        name,
        version: installed[name].installedVersion || 'unknown',
        size,
        sizeStr: fmtSize(size),
        disabled: disabledSet.has(name),
        path: modulePath
      });
    }
  } catch (e) {
    log('Config', 'Enumerate modules error', e);
  }

  const Module = require('module');
  const seen = new Set(modules.map(m => m.name));
  for (const p of Module.globalPaths) {
    const baseName = p.split(/[\\/]/).pop();
    const cleanName = baseName.replace(/-\d[\d.]*$/, '');
    const safeName = isModuleNameSafe(cleanName) ? cleanName : (isModuleNameSafe(baseName) ? baseName : null);
    if (!safeName) continue;
    if (seen.has(safeName)) continue;

    let size = 0;
    try {
      if (base && isPathInsideBase(p, base)) {
        size = calcDirSize(resolve(p));
      } else if (base) {
        continue;
      } else {
        size = calcDirSize(p);
      }
    } catch {}
    modules.push({
      name: safeName,
      version: 'detected',
      size,
      sizeStr: fmtSize(size),
      disabled: disabledSet.has(safeName),
      path: p
    });
    seen.add(safeName);
  }

  return modules.sort((a, b) => b.size - a.size);
};

let win;
exports.open = () => {
  if (win && !win.isDestroyed()) return win.show();

  win = require('../utils/win')({
    width: 500,
    height: 650
  }, 'config');

  win.on('closed', () => {
    win = null;
  });

  let config = settings.get('openasar', {});
  config.setup = true;
  settings.set('openasar', config);
  settings.save();

  win.webContents.once('dom-ready', () => {
    try {
      win.webContents.executeJavaScript(`
        (function() {
          if (document.getElementById('openasar-pm-injected')) return;
          var flag = document.createElement('div');
          flag.id = 'openasar-pm-injected';
          flag.style.display = 'none';
          document.body.appendChild(flag);

          var sidebar = document.querySelector('[class*="side"]') || document.querySelector('nav') || document.querySelector('[class*="sidebar"]');
          var contentArea = document.querySelector('[class*="content"]') || document.querySelector('main') || document.querySelector('[class*="settingsContent"]');
          if (!sidebar || !contentArea) { setTimeout(arguments.callee, 500); return; }

          var pmNav = null;
          var navItems = sidebar.querySelectorAll('[class*="item"], [class*="navItem"], div');
          for (var i = 0; i < navItems.length; i++) {
            if (navItems[i].textContent && navItems[i].textContent.trim() === 'Splash') {
              pmNav = navItems[i].cloneNode(true);
              navItems[i].parentNode.insertBefore(pmNav, navItems[i].nextSibling);
              break;
            }
          }
          if (!pmNav && navItems.length > 0) {
            pmNav = navItems[navItems.length - 1].cloneNode(true);
            sidebar.appendChild(pmNav);
          }
          if (!pmNav) return;

          var pmText = pmNav.querySelector('[class*="text"]') || pmNav;
          pmText.textContent = '插件管理';
          pmNav.onclick = function() { renderPluginManager(); };

          var tcNav = pmNav.cloneNode(true);
          pmNav.parentNode.insertBefore(tcNav, pmNav);
          var tcText = tcNav.querySelector('[class*="text"]') || tcNav;
          tcText.textContent = '追踪控制';
          tcNav.onclick = function() { renderTrackControl(); };

          var domOptNav = pmNav.cloneNode(true);
          pmNav.parentNode.insertBefore(domOptNav, pmNav.nextSibling);
          var domOptText = domOptNav.querySelector('[class*="text"]') || domOptNav;
          domOptText.textContent = '性能优化';
          domOptNav.onclick = function() { renderPerfPage(); };

          function setActive(el) {
            var items = sidebar.querySelectorAll('[class*="item"], [class*="navItem"]');
            for (var i = 0; i < items.length; i++) {
              items[i].classList.remove && items[i].classList.remove(/active|selected/g);
              items[i].style.opacity = '0.6';
            }
            el.style.opacity = '1';
          }

          function getCfg() { return Native.get() || {}; }
          function saveCfg(cfg) { Native.set(cfg); }
          function tcGet() { var cfg = getCfg(); return cfg.trackControl || {}; }
          function tcSet(key, val) {
            var cfg = getCfg();
            if (!cfg.trackControl) cfg.trackControl = {};
            cfg.trackControl[key] = val;
            saveCfg(cfg);
          }

          function renderTrackControl() {
            setActive(tcNav);
            var tc = tcGet();
            var legacy = getCfg();
            var legacyNoTrack = legacy.noTrack !== false;

            var items = [
              { key:'blockCrash', name:'崩溃上报 (Sentry)', icon:'💥', desc:'拦截应用崩溃数据上报到 Sentry。关闭后将能帮助 Discord 诊断崩溃问题。', defaultVal: legacyNoTrack },
              { key:'blockScience', name:'使用统计 (Science)', icon:'📊', desc:'拦截用户行为分析 / 使用频率数据。包括打开的频道、点击按钮等匿名统计。', defaultVal: legacyNoTrack },
              { key:'blockMetrics', name:'性能指标 (Metrics)', icon:'⏱️', desc:'拦截性能采样 / 响应时间数据。包括首屏启动、消息加载耗时等指标。', defaultVal: legacyNoTrack },
              { key:'blockTyping', name:'输入状态 (Typing)', icon:'⌨️', desc:'拦截"正在输入..."状态上报。开启后别人看不到你在输入，同时你也看不到别人是否在输入。', defaultVal: (legacy.noTyping === true) },
              { key:'blockOther', name:'其他追踪 (Other)', icon:'🔒', desc:'拦截其他分析链接 / 追踪类请求（/track、analytics 等）。', defaultVal: legacyNoTrack }
            ];

            contentArea.innerHTML = '';
            var header = document.createElement('div');
            header.style.cssText = 'padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.06);';
            header.innerHTML = '<h2 style="margin:0;font-size:18px;font-weight:700;color:#fff;">精确追踪控制</h2><p style="margin:6px 0 0;font-size:12px;color:#b9bbbe;">按分类开关数据拦截，而非一刀切。建议关闭对使用影响较小的类型以平衡隐私和体验。</p>';
            contentArea.appendChild(header);

            var list = document.createElement('div');
            list.style.cssText = 'padding:8px;max-height:calc(650px - 110px);overflow-y:auto;';
            items.forEach(function(it) {
              var cur = tc[it.key] !== undefined ? tc[it.key] : it.defaultVal;
              var row = document.createElement('div');
              row.style.cssText = 'display:flex;align-items:center;padding:14px;margin:6px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:8px;';
              var icon = document.createElement('div');
              icon.style.cssText = 'width:40px;height:40px;border-radius:10px;background:rgba(88,101,242,0.12);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;';
              icon.textContent = it.icon;
              row.appendChild(icon);

              var info = document.createElement('div');
              info.style.cssText = 'flex:1;margin-left:12px;min-width:0;';
              var titleRow = document.createElement('div');
              titleRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
              var title = document.createElement('span');
              title.style.cssText = 'font-weight:600;color:#fff;font-size:14px;';
              title.textContent = it.name;
              titleRow.appendChild(title);
              var statusTag = document.createElement('span');
              statusTag.style.cssText = 'font-size:10px;padding:2px 6px;border-radius:3px;font-weight:600;background:' + (cur ? 'rgba(88,101,242,0.2);color:#5865F2;' : 'rgba(59,165,92,0.2);color:#3ba55c;');
              statusTag.textContent = cur ? '已拦截' : '已放行';
              titleRow.appendChild(statusTag);
              info.appendChild(titleRow);
              var desc = document.createElement('div');
              desc.style.cssText = 'margin-top:4px;font-size:11px;color:#b9bbbe;line-height:1.5;';
              desc.textContent = it.desc;
              info.appendChild(desc);
              row.appendChild(info);

              var sw = document.createElement('div');
              sw.style.cssText = 'width:42px;height:24px;border-radius:12px;background:' + (cur ? '#5865F2' : '#4f545c') + ';position:relative;cursor:pointer;flex-shrink:0;transition:background 0.15s;';
              sw.title = cur ? '点击放行' : '点击拦截';
              var knob = document.createElement('div');
              knob.style.cssText = 'position:absolute;top:3px;left:' + (cur ? '21px' : '3px') + ';width:18px;height:18px;border-radius:50%;background:#fff;transition:left 0.15s;';
              sw.appendChild(knob);
              (function(key, def) {
                sw.onclick = function() {
                  var cur2 = tc[key] !== undefined ? tc[key] : def;
                  tcSet(key, !cur2);
                  renderTrackControl();
                };
              })(it.key, it.defaultVal);
              row.appendChild(sw);

              list.appendChild(row);
            });
            contentArea.appendChild(list);
          }

          function renderPerfPage() {
            setActive(domOptNav);
            var cfg = getCfg();
            var domOpt = cfg.domOptimizer !== false;
            var chatLazy = cfg.chatLazyLoad !== false;

            contentArea.innerHTML = '';
            var header = document.createElement('div');
            header.style.cssText = 'padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.06);';
            header.innerHTML = '<h2 style="margin:0;font-size:18px;font-weight:700;color:#fff;">性能优化</h2><p style="margin:6px 0 0;font-size:12px;color:#b9bbbe;">调整渲染和内存相关的优化选项，根据设备性能权衡体验。</p>';
            contentArea.appendChild(header);

            var list = document.createElement('div');
            list.style.cssText = 'padding:8px;max-height:calc(650px - 110px);overflow-y:auto;';

            var items = [
              { key:'domOptimizer', name:'DOM 优化器', icon:'⚡', desc:'延迟非关键 DOM 操作（如活动面板更新），降低主线程压力，提高滚动流畅度。', value: domOpt },
              { key:'chatLazyLoad', name:'懒加载聊天区', icon:'💬', desc:'打开频道时聊天面板中超过 500 条的消息先不渲染，等用户滚动到对应位置再动态插入。显著降低大频道的内存占用和首屏时间。', value: chatLazy }
            ];

            items.forEach(function(it) {
              var row = document.createElement('div');
              row.style.cssText = 'display:flex;align-items:center;padding:14px;margin:6px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:8px;';
              var icon = document.createElement('div');
              icon.style.cssText = 'width:40px;height:40px;border-radius:10px;background:rgba(88,101,242,0.12);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;';
              icon.textContent = it.icon;
              row.appendChild(icon);

              var info = document.createElement('div');
              info.style.cssText = 'flex:1;margin-left:12px;min-width:0;';
              var titleRow = document.createElement('div');
              titleRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
              var title = document.createElement('span');
              title.style.cssText = 'font-weight:600;color:#fff;font-size:14px;';
              title.textContent = it.name;
              titleRow.appendChild(title);
              var statusTag = document.createElement('span');
              statusTag.style.cssText = 'font-size:10px;padding:2px 6px;border-radius:3px;font-weight:600;background:' + (it.value ? 'rgba(59,165,92,0.2);color:#3ba55c;' : 'rgba(127,127,127,0.2);color:#b9bbbe;');
              statusTag.textContent = it.value ? '已启用' : '已关闭';
              titleRow.appendChild(statusTag);
              info.appendChild(titleRow);
              var desc = document.createElement('div');
              desc.style.cssText = 'margin-top:4px;font-size:11px;color:#b9bbbe;line-height:1.5;';
              desc.textContent = it.desc;
              info.appendChild(desc);
              row.appendChild(info);

              var sw = document.createElement('div');
              sw.style.cssText = 'width:42px;height:24px;border-radius:12px;background:' + (it.value ? '#3ba55c' : '#4f545c') + ';position:relative;cursor:pointer;flex-shrink:0;transition:background 0.15s;';
              var knob = document.createElement('div');
              knob.style.cssText = 'position:absolute;top:3px;left:' + (it.value ? '21px' : '3px') + ';width:18px;height:18px;border-radius:50%;background:#fff;transition:left 0.15s;';
              sw.appendChild(knob);
              (function(key) {
                sw.onclick = function() {
                  var cfg2 = getCfg();
                  cfg2[key] = !(cfg2[key] !== false);
                  if (key === 'domOptimizer') {
                    if (cfg2[key] === true) delete cfg2[key];
                  } else {
                    if (cfg2[key] === true) delete cfg2[key];
                  }
                  saveCfg(cfg2);
                  renderPerfPage();
                };
              })(it.key);
              row.appendChild(sw);
              list.appendChild(row);
            });
            contentArea.appendChild(list);
          }

          function renderPluginManager() {
            setActive(pmNav);
            var modules = Native.getModules();
            contentArea.innerHTML = '';

            var header = document.createElement('div');
            header.style.cssText = 'padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.06);';
            header.innerHTML = '<h2 style="margin:0;font-size:18px;font-weight:700;color:#fff;">插件管理</h2><p style="margin:6px 0 0;font-size:12px;color:#b9bbbe;">管理已安装的 Discord 模块。禁用的模块下次启动不再加载，卸载会删除文件。</p>';
            contentArea.appendChild(header);

            var stats = document.createElement('div');
            stats.style.cssText = 'padding:12px 20px;display:flex;gap:16px;border-bottom:1px solid rgba(255,255,255,0.06);';
            var totalSize = modules.reduce(function(a, m) { return a + m.size; }, 0);
            stats.innerHTML = '<div><span style="color:#b9bbbe;font-size:11px;">模块总数</span><div style="font-size:20px;font-weight:700;color:#fff;">' + modules.length + '</div></div><div><span style="color:#b9bbbe;font-size:11px;">总占用空间</span><div style="font-size:20px;font-weight:700;color:#5865F2;">' + formatSize(totalSize) + '</div></div><div><span style="color:#b9bbbe;font-size:11px;">已禁用</span><div style="font-size:20px;font-weight:700;color:#faa61a;">' + modules.filter(function(m){return m.disabled;}).length + '</div></div>';
            contentArea.appendChild(stats);

            var list = document.createElement('div');
            list.style.cssText = 'padding:8px;max-height:calc(650px - 160px);overflow-y:auto;';
            modules.forEach(function(m) { list.appendChild(renderModuleCard(m)); });
            contentArea.appendChild(list);
          }

          function formatSize(b) {
            if (b < 1024) return b + ' B';
            if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
            if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
            return (b/1073741824).toFixed(2) + ' GB';
          }

          function renderModuleCard(m) {
            var card = document.createElement('div');
            card.style.cssText = 'display:flex;align-items:center;padding:12px;margin:6px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:8px;transition:background 0.15s;';
            card.onmouseover = function() { this.style.background = 'rgba(255,255,255,0.05)'; };
            card.onmouseout = function() { this.style.background = 'rgba(255,255,255,0.03)'; };

            var icon = document.createElement('div');
            icon.style.cssText = 'width:40px;height:40px;border-radius:10px;background:' + (m.disabled ? 'rgba(250,166,26,0.15)' : 'rgba(88,101,242,0.15)') + ';display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;';
            icon.textContent = m.disabled ? '⏸' : '📦';
            card.appendChild(icon);

            var info = document.createElement('div');
            info.style.cssText = 'flex:1;margin-left:12px;min-width:0;';
            var nameRow = document.createElement('div');
            nameRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
            var nameEl = document.createElement('span');
            nameEl.style.cssText = 'font-weight:600;color:#fff;font-size:14px;';
            nameEl.textContent = m.name;
            nameRow.appendChild(nameEl);
            if (m.disabled) {
              var tag = document.createElement('span');
              tag.style.cssText = 'font-size:10px;padding:2px 6px;background:rgba(250,166,26,0.2);color:#faa61a;border-radius:3px;font-weight:600;';
              tag.textContent = '已禁用';
              nameRow.appendChild(tag);
            }
            info.appendChild(nameRow);
            var metaRow = document.createElement('div');
            metaRow.style.cssText = 'margin-top:4px;font-size:11px;color:#b9bbbe;';
            metaRow.textContent = 'v' + m.version + '  •  ' + m.sizeStr;
            info.appendChild(metaRow);
            card.appendChild(info);

            var btns = document.createElement('div');
            btns.style.cssText = 'display:flex;gap:6px;flex-shrink:0;';

            var toggleBtn = document.createElement('button');
            toggleBtn.style.cssText = 'padding:6px 12px;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;transition:filter 0.15s;background:' + (m.disabled ? '#3ba55c' : '#747f8d') + ';color:#fff;';
            toggleBtn.textContent = m.disabled ? '启用' : '禁用';
            toggleBtn.onmouseover = function() { this.style.filter = 'brightness(1.15)'; };
            toggleBtn.onmouseout = function() { this.style.filter = 'brightness(1)'; };
            toggleBtn.onclick = function() {
              Native.toggleModule(m.name);
              m.disabled = !m.disabled;
              renderPluginManager();
            };
            btns.appendChild(toggleBtn);

            var uninstBtn = document.createElement('button');
            uninstBtn.style.cssText = 'padding:6px 12px;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;transition:filter 0.15s;background:rgba(237,66,69,0.15);color:#ed4245;';
            uninstBtn.textContent = '卸载';
            uninstBtn.onmouseover = function() { this.style.filter = 'brightness(1.2)'; };
            uninstBtn.onmouseout = function() { this.style.filter = 'brightness(1)'; };
            uninstBtn.onclick = function() {
              if (!confirm('确定要卸载模块 "' + m.name + '" 吗？此操作将删除模块文件且不可撤销。')) return;
              if (Native.uninstallModule(m.name)) {
                renderPluginManager();
              } else {
                alert('卸载失败，模块文件可能正在被使用。请重启后重试。');
              }
            };
            btns.appendChild(uninstBtn);

            card.appendChild(btns);
            return card;
          }
        })();
      `);
    } catch (e) { log('Config', 'Inject plugin manager UI failed', e); }
  });

  ipcMain.on('cs', (e, c) => {
    if (typeof c === 'string') {
      global.oaVersion = c + '-';
      require('../asarUpdate')().then(restart);
      return;
    }

    config = c;
    settings.set('openasar', config);
    settings.save();
  });

  ipcMain.on('cg', e => {
    e.returnValue = config;
  });

  ipcMain.on('cr', () => {
    settings.save();
    restart();
  });

  ipcMain.on('of', () => {
    shell.openPath(require('../paths').getUserData() + '/settings.json');
  });

  ipcMain.on('gm', e => {
    e.returnValue = enumerateModules();
  });

  ipcMain.on('tm', (e, name) => {
    if (!isModuleNameSafe(name)) {
      log('Config', 'Blocked unsafe module name in tm:', name);
      e.returnValue = false;
      return;
    }

    const validNames = getValidModuleNames();
    if (!validNames.has(name)) {
      log('Config', 'Blocked unknown module name in tm:', name);
      e.returnValue = false;
      return;
    }

    const disabled = new Set(config.disabledModules || []);
    if (disabled.has(name)) {
      disabled.delete(name);
    } else {
      disabled.add(name);
    }
    config.disabledModules = [...disabled];
    oaConfig.disabledModules = config.disabledModules;
    settings.set('openasar', config);
    settings.save();
    e.returnValue = true;
  });

  ipcMain.on('um', (e, name) => {
    if (!isModuleNameSafe(name)) {
      log('Config', 'Blocked unsafe module name in um:', name);
      e.returnValue = false;
      return;
    }

    const validNames = getValidModuleNames();
    if (!validNames.has(name)) {
      log('Config', 'Blocked unknown module name in um:', name);
      e.returnValue = false;
      return;
    }

    let success = false;
    try {
      const base = getModuleBasePath();
      if (!base) {
        e.returnValue = false;
        return;
      }

      const moduleUpdater = require('../updater/moduleUpdater');
      const installed = moduleUpdater.getInstalled();
      const version = installed[name]?.installedVersion;

      const candidatePaths = [
        join(base, name),
        join(base, name + '-' + (version || '')),
        join(base, name + '-' + (version || ''), name)
      ];

      for (const rawP of candidatePaths) {
        if (!isPathInsideBase(rawP, base)) {
          log('Config', 'Blocked path traversal attempt in um:', rawP);
          continue;
        }
        const p = resolve(rawP);
        if (!isPathInsideBase(p, base)) {
          log('Config', 'Blocked path traversal after resolve in um:', p);
          continue;
        }
        if (fs.existsSync(p)) {
          try {
            fs.rmSync(p, { recursive: true, force: true });
            success = true;
            log('Config', 'Uninstalled module:', name, 'from:', p);
          } catch (e3) {
            log('Config', 'Failed to remove module path', p, e3);
          }
        }
      }

      if (installed[name]) {
        delete installed[name];
        try {
          const manifestPath = join(base, 'installed.json');
          if (isPathInsideBase(manifestPath, base)) {
            fs.writeFileSync(resolve(manifestPath), JSON.stringify(installed, null, 2));
            success = true;
          }
        } catch (e3) {
          log('Config', 'Failed to update manifest', e3);
        }
      }
    } catch (e2) {
      log('Config', 'Uninstall module error', name, e2);
    }
    e.returnValue = success;
  });
};
