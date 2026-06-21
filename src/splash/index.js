const { app, ipcMain } = require('electron');

const moduleUpdater = require("../updater/moduleUpdater");
const updater = require("../updater/updater");

let launched, win;

let lastProgressTime = 0;
let skipTimer = null;
let skipInjected = false;

const SKIP_TIMEOUT_MS = 15000;

const updateProgressTime = () => {
  lastProgressTime = Date.now();
  armSkipTimer();
};

const armSkipTimer = () => {
  if (skipTimer) clearTimeout(skipTimer);
  skipInjected = false;
  skipTimer = setTimeout(() => {
    if (launched) return;
    injectSkipButton();
  }, SKIP_TIMEOUT_MS);
};

const injectSkipButton = () => {
  if (skipInjected || !win || win.isDestroyed()) return;
  skipInjected = true;
  try {
    win.webContents.executeJavaScript(`
      (function() {
        if (document.getElementById('openasar-skip-btn')) return;
        var btn = document.createElement('button');
        btn.id = 'openasar-skip-btn';
        btn.textContent = '跳过更新直接启动';
        btn.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);padding:10px 24px;background:#5865F2;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:13px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,0.3);z-index:9999;transition:background 0.15s;';
        btn.onmouseover = function() { this.style.background = '#4752C4'; };
        btn.onmouseout = function() { this.style.background = '#5865F2'; };
        btn.onclick = function() {
          try { Splash.manualSkip(); } catch(e) { try { ipcRenderer.send('sm'); } catch(e2){} }
        };
        var tip = document.createElement('div');
        tip.id = 'openasar-skip-tip';
        tip.style.cssText = 'position:fixed;bottom:58px;left:50%;transform:translateX(-50%);color:#b9bbbe;font-size:11px;text-align:center;width:100%;padding:0 16px;z-index:9998;';
        tip.textContent = '更新已超过 15 秒无响应，可跳过更新立即启动';
        document.body.appendChild(tip);
        document.body.appendChild(btn);
      })();
    `);
  } catch (e) { log('Splash', 'Inject skip button failed', e); }
};

exports.initSplash = (startMin) => {
  lastProgressTime = Date.now();
  armSkipTimer();

  const inst = updater.getUpdater();
  if (inst) initNew(inst);
    else initOld();

  launchSplash(startMin);


  if (process.env.OPENASAR_QUICKSTART || oaConfig.quickstart) setTimeout(() => {
    if (skipTimer) clearTimeout(skipTimer);
    destroySplash();

    launchMain();

    setTimeout(() => {
      events.emit('APP_SHOULD_SHOW');
    }, 100);
  }, 300);
};

exports.focusWindow = () => win?.focus?.();
exports.pageReady = () => destroySplash() || process.nextTick(() => events.emit('APP_SHOULD_SHOW'));

const destroySplash = () => {
  if (skipTimer) { clearTimeout(skipTimer); skipTimer = null; }
  win?.setSkipTaskbar?.(true);

  setTimeout(() => {
    if (!win) return;

    win.hide();
    win.close();
    win = null;
  }, 100);
};

const launchMain = () => {
  if (skipTimer) { clearTimeout(skipTimer); skipTimer = null; }
  moduleUpdater.events.removeAllListeners(); // Remove updater v1 listeners

  if (!launched) {
    sendState('starting');

    launched = true;
    events.emit('APP_SHOULD_LAUNCH');
  }
};

const sendState = (status, s = {}) => {
  try {
    win.webContents.send('state', { status, ...s });
  } catch { }
};


const launchSplash = (startMin) => {
  win = require('../utils/win')({
    width: 300,
    height: process.platform === 'darwin' ? 300 : 350
  }, 'splash');

  if (process.platform !== 'darwin') win.on('closed', () => !launched && app.quit());

  ipcMain.on('ss', launchMain);
  ipcMain.on('sq', app.quit);
  ipcMain.on('sm', () => {
    log('Splash', 'User manually skipped update');
    launchMain();
  });

  win.webContents.once('dom-ready', () => {
    if (!launched) updateProgressTime();
  });

  if (!startMin) win.once('ready-to-show', win.show);
};


const events = exports.events = new (require('events').EventEmitter)();

let toSend = 0; // Progress state to send for ModuleUpdater (0 = downloading, 1 = installing)
class UIProgress { // Generic class to track updating and sent states to splash
  constructor(st) {
    this.st = st;

    this.reset();
  }

  reset() {
    Object.assign(this, {
      progress: new Map(),
      done: new Set(),
      total: new Set()
    });
  }

  record(id, state, current, outOf) {
    this.total.add(id);

    if (current) this.progress.set(id, [ current, outOf ?? 100 ]);
    if (state === 'Complete') this.done.add(id);

    updateProgressTime();
    this.send();
  }

  send() {
    if ((toSend === -1 && this.progress.size > 0 && this.progress.size > this.done.size) || toSend === this.st) {
      const progress = Math.min(100, [...this.progress.values()].reduce((a, x) => a + x[0], 0) / [...this.progress.values()].reduce((a, x) => a + x[1], 0) * 100); // Clamp progress to 0-100

      updateProgressTime();
      sendState(this.st ? 'installing' : 'downloading', {
        current: this.done.size + 1,
        total: this.total.size,
        progress
      });

      return true;
    }
  }
}

const initNew = async (inst) => {
  toSend = -1;

  const retryOptions = {
    skip_host_delta: true,
    skip_module_delta: {},
    skip_all_module_delta: false,
    allow_optional_updates: settings.get('ALLOW_OPTIONAL_UPDATES', true)
  };

  while (true) {
    updateProgressTime();
    sendState('checking-for-updates');

    try {
      let installedAnything = false;
      const downloads = new UIProgress(0);
      const installs = new UIProgress(1);

      await inst.updateToLatestWithOptions(retryOptions, ({ task, state, percent }) => {
        const download = task.HostDownload || task.ModuleDownload;
        const install = task.HostInstall || task.ModuleInstall;

        installedAnything = true;

        const simpleRecord = (tracker, x) => tracker.record(x.package_sha256, state, percent);

        if (download != null) simpleRecord(downloads, download);

        if (!downloads.send()) installs.send();

        if (install == null) return;
        simpleRecord(installs, install);

        if (state === 'Failed') {
          if (task.HostInstall != null) {
            retryOptions.skip_host_delta = true;
          } else if (task.ModuleInstall != null) {
            retryOptions.skip_module_delta[install.version.module.name] = true;
          }
        }
      });

      if (!installedAnything) {
        await inst.startCurrentVersion({});
        inst.collectGarbage();

        return launchMain();
      }
    } catch (e) {
      log('Splash', e);
      await new Promise(r => fail(r));
    }
  }
};

const initOld = () => { // "Old" (not v2 / new, win32 only)
  const on = (k, v) => moduleUpdater.events.on(k, v);

  const check = () => moduleUpdater.checkForUpdates();

  const downloads = new UIProgress(0), installs = new UIProgress(1);

  const handleFail = () => {
    fail(check);
  };

  on('checked', ({ failed, count }) => { // Finished check
    updateProgressTime();
    installs.reset();
    downloads.reset();

    if (failed) handleFail();
      else if (!count) launchMain(); // Count is 0 / undefined
  });

  on('downloaded', ({ failed }) => { // Downloaded all modules
    updateProgressTime();
    toSend = 1;

    if (failed > 0) handleFail();
  });

  on('installed', check); // Installed all modules

  on('downloading-module', ({ name, cur, total }) => {
    downloads.record(name, '', cur, total);
    installs.record(name, 'Waiting');
  });

  on('installing-module', ({ name, cur, total }) => {
    installs.record(name, '', cur, total);
  });

  const segment = (tracker) => (({ name }) => {
    tracker.record(name, 'Complete');
  });

  on('downloaded-module', segment(downloads));
  on('installed-module', segment(installs));

  on('manual', (e) => { updateProgressTime(); sendState('manual', { details: e }); }); // Host manual update required

  updateProgressTime();
  sendState('checking-for-updates');

  check();
};

const fail = (c) => {
  injectSkipButton();
  sendState('fail', { seconds: 10 });

  const fallbackTimer = setTimeout(c, 10000);
  const checkInterval = setInterval(() => {
    if (launched) {
      clearTimeout(fallbackTimer);
      clearInterval(checkInterval);
    }
  }, 100);
};
