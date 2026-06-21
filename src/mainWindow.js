const __oaTrackControl = <trackcontrol>;
if (__oaTrackControl.blockCrash) { // Disable sentry based on precise tracking control
  try {
    window.__SENTRY__.hub.getClient().getOptions().enabled = false;

    Object.keys(console).forEach(x => console[x] = console[x].__sentry_original__ ?? console[x]);
  } catch { }
}

try {
  const oaOriginalFetch = window.fetch;
  window.fetch = function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    if (__oaTrackControl.blockScience && url.indexOf('/science') !== -1) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 204 }));
    }
    if (__oaTrackControl.blockMetrics && url.indexOf('/metrics') !== -1) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 204 }));
    }
    if (__oaTrackControl.blockTyping && url.indexOf('/typing') !== -1) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 204 }));
    }
    if (__oaTrackControl.blockOther && (url.indexOf('/track') !== -1 || url.indexOf('analytics') !== -1)) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 204 }));
    }
    if (__oaTrackControl.blockCrash && url.indexOf('sentry.io') !== -1) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 204 }));
    }
    return oaOriginalFetch.apply(this, args);
  };

  const oaOriginalXHR = window.XMLHttpRequest.prototype.open;
  window.XMLHttpRequest.prototype.open = function(method, url) {
    const urlStr = String(url || '');
    let blocked = false;
    if (__oaTrackControl.blockScience && urlStr.indexOf('/science') !== -1) blocked = true;
    if (__oaTrackControl.blockMetrics && urlStr.indexOf('/metrics') !== -1) blocked = true;
    if (__oaTrackControl.blockTyping && urlStr.indexOf('/typing') !== -1) blocked = true;
    if (__oaTrackControl.blockOther && (urlStr.indexOf('/track') !== -1 || urlStr.indexOf('analytics') !== -1)) blocked = true;
    if (__oaTrackControl.blockCrash && urlStr.indexOf('sentry.io') !== -1) blocked = true;
    if (blocked) {
      this.__oaBlocked = true;
      this.send = function() {
        setTimeout(() => {
          Object.defineProperty(this, 'status', { value: 204 });
          Object.defineProperty(this, 'readyState', { value: 4 });
          Object.defineProperty(this, 'responseText', { value: '' });
          Object.defineProperty(this, 'response', { value: '' });
          if (this.onreadystatechange) this.onreadystatechange();
          if (this.onload) this.onload();
        }, 0);
      };
      return;
    }
    return oaOriginalXHR.apply(this, arguments);
  };
} catch { }

let lastBgPrimary = '';
const themesync = async () => {
  const getVar = (name, el = document.body) => el && (getComputedStyle(el).getPropertyValue(name) || getVar(name, el.parentElement))?.trim();

  const bgPrimary = getVar('--background-primary');
  if (!bgPrimary || bgPrimary === '#36393f' || bgPrimary === '#fff' || bgPrimary === lastBgPrimary) return; // Default primary bg or same as last
  lastBgPrimary = bgPrimary;

  const vars = [ '--background-primary', '--background-secondary', '--brand-experiment', '--header-primary', '--text-muted' ];

  let cached = await DiscordNative.userDataCache.getCached() || {};

  const value = `body { ${vars.reduce((acc, x) => acc += `${x}: ${getVar(x)}; `, '')} }`;
  const pastValue = cached['openasarSplashCSS'];
  cached['openasarSplashCSS'] = value;

  if (value !== pastValue) DiscordNative.userDataCache.cacheUserData(JSON.stringify(cached));
};

// Settings injection
setInterval(() => {
  const versionInfo = document.querySelector('[class*="sidebar"] [class*="compactInfo"]');
  if (!versionInfo || document.getElementById('openasar-ver')) return;

  const oaVersionInfo = versionInfo.cloneNode(true);
  const oaVersion = oaVersionInfo.children[0];
  oaVersion.id = 'openasar-ver';
  oaVersion.textContent = 'OpenAsar <channel> (<hash>)';
  oaVersion.onclick = () => DiscordNative.ipc.send('DISCORD_UPDATED_QUOTES', 'o');

  oaVersionInfo.textContent = '';
  oaVersionInfo.appendChild(oaVersion);
  versionInfo.parentElement.parentElement.lastElementChild.insertAdjacentElement('beforebegin', oaVersionInfo);

  if (document.getElementById('openasar-item')) return;
  let advanced = document.querySelector('[data-list-item-id="settings-sidebar___advanced_sidebar_item"]');
  if (!advanced) advanced = document.querySelector('[class*="sidebar"] [class*="nav"] > [class*="section"]:nth-child(3) > :last-child');
  if (!advanced) advanced = [...document.querySelectorAll('[class*="item"]')].find(x => x.textContent === 'Advanced');

  const oaSetting = advanced.cloneNode(true);
  oaSetting.querySelector('[class*="text"]').textContent = 'OpenAsar';
  oaSetting.id = 'openasar-item';
  oaSetting.onclick = oaVersion.onclick;

  advanced.insertAdjacentElement('afterend', oaSetting);
}, 800);

const injCSS = x => {
  const el = document.createElement('style');
  el.appendChild(document.createTextNode(x));
  document.body.appendChild(el);
};

injCSS(`<css>`);

// Define global for any mods which want to know / etc
openasar = {};

// Try init themesync
setInterval(() => {
  try {
    themesync();
  } catch (e) { }
}, 10000);
themesync();

// DOM Optimizer - https://github.com/GooseMod/OpenAsar/wiki/DOM-Optimizer
const optimize = orig => function(...args) {
  if (typeof args[0].className === 'string' && (args[0].className.indexOf('activity') !== -1))
    return setTimeout(() => orig.apply(this, args), 100);

  return orig.apply(this, args);
};

if ('<domopt>' === 'true') {
  Element.prototype.removeChild = optimize(Element.prototype.removeChild);
  // Element.prototype.appendChild = optimize(Element.prototype.appendChild);
}

// Chat Lazy Load - defer rendering of messages beyond the threshold until user scrolls
if ('<chatlazyload>' === 'true') {
  (function() {
    const CHAT_THRESHOLD = 500;
    const CHUNK_SIZE = 100;
    const SENTINEL_HEIGHT = 40;
    const SENTINEL_COLOR = 'rgba(88, 101, 242, 0.15)';
    const SCROLL_BOTTOM_MARGIN = 800;

    const hiddenStore = new WeakMap();
    const sentinelInfo = new WeakMap();
    const chatObservers = new WeakMap();

    openasar.chatLazyLoad = {
      threshold: CHAT_THRESHOLD,
      chunkSize: CHUNK_SIZE,
      enabled: true
    };

    const isChatContainer = el => {
      if (!el || !el.tagName) return false;
      if (typeof el.className !== 'string') return false;
      const cn = el.className;
      if (cn.indexOf('chat') === -1 && cn.indexOf('message') === -1 && cn.indexOf('scroller') === -1) return false;
      const dataList = el.querySelectorAll ? el.querySelectorAll('[class*="messageListItem"], [class*="messageListItem"], [id^="chat-messages-"], li[class*="item"]') : [];
      if (dataList && dataList.length > 200) return true;
      return false;
    };

    const getMessageChildren = container => {
      if (!container || !container.children) return [];
      const result = [];
      const c = container.children;
      for (let i = 0; i < c.length; i++) {
        const child = c[i];
        if (child.dataset && child.dataset.oaLazySentinel) continue;
        const tag = (child.tagName || '').toLowerCase();
        const cls = typeof child.className === 'string' ? child.className : '';
        if (tag === 'li' || cls.indexOf('message') !== -1 || cls.indexOf('listItem') !== -1 || cls.indexOf('item') !== -1 || cls.indexOf('container') !== -1 || cls.indexOf('group') !== -1) {
          result.push(child);
        } else if (cls.indexOf('divider') !== -1 || cls.indexOf('separator') !== -1 || cls.indexOf('header') !== -1 || cls.indexOf('systemMessage') !== -1) {
          result.push(child);
        }
      }
      return result;
    };

    const processChatContainer = container => {
      if (!container || hiddenStore.has(container)) return;
      const messages = getMessageChildren(container);
      if (messages.length <= CHAT_THRESHOLD) return;

      const toHide = messages.slice(0, messages.length - CHAT_THRESHOLD);
      const firstVisible = messages[messages.length - CHAT_THRESHOLD];
      if (!firstVisible || toHide.length < 50) return;

      const df = document.createDocumentFragment();
      const hiddenEls = [];
      for (let i = 0; i < toHide.length; i++) {
        const el = toHide[i];
        if (!el.parentNode) continue;
        hiddenEls.push(el);
        df.appendChild(el);
      }
      if (hiddenEls.length === 0) return;

      hiddenStore.set(container, {
        messages: hiddenEls,
        cursor: 0,
        scroller: container.closest('[class*="scroller"]') || container.parentElement || container
      });

      const sentinel = document.createElement('div');
      sentinel.dataset.oaLazySentinel = 'top';
      sentinel.style.cssText = 'display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;transition:background 0.2s;font-size:12px;color:#5865F2;font-weight:600;border-radius:4px;margin:4px 8px;';
      sentinel.style.height = SENTINEL_HEIGHT + 'px';
      sentinel.style.background = SENTINEL_COLOR;
      sentinel.textContent = '▲ 加载 ' + hiddenEls.length + ' 条更早的消息 (滚动或点击)';
      sentinel.onmouseover = function() { this.style.background = 'rgba(88,101,242,0.3)'; };
      sentinel.onmouseout = function() { this.style.background = SENTINEL_COLOR; };
      sentinel.onclick = () => revealChunk(container, hiddenEls.length);
      sentinelInfo.set(sentinel, container);

      container.insertBefore(sentinel, firstVisible);

      const info = hiddenStore.get(container);
      info.sentinel = sentinel;

      observeScroller(container, info.scroller);
      log('OpenAsar', 'ChatLazyLoad: hid', hiddenEls.length, 'messages in container');
    };

    const revealChunk = (container, count) => {
      const info = hiddenStore.get(container);
      if (!info) return;
      count = Math.min(count || CHUNK_SIZE, info.messages.length - info.cursor);
      if (count <= 0) {
        removeSentinel(container, info);
        return;
      }
      const df = document.createDocumentFragment();
      const end = info.cursor + count;
      for (let i = info.cursor; i < end; i++) {
        df.appendChild(info.messages[i]);
      }
      info.cursor = end;
      const sentinel = info.sentinel;
      if (sentinel && sentinel.parentNode) {
        sentinel.parentNode.insertBefore(df, sentinel);
      }
      const remaining = info.messages.length - info.cursor;
      if (remaining <= 0) {
        removeSentinel(container, info);
      } else if (sentinel) {
        sentinel.textContent = '▲ 还有 ' + remaining + ' 条更早的消息 (滚动或点击)';
      }
    };

    const removeSentinel = (container, info) => {
      if (info && info.sentinel && info.sentinel.parentNode) {
        info.sentinel.parentNode.removeChild(info.sentinel);
      }
      hiddenStore.delete(container);
      const ob = chatObservers.get(container);
      if (ob) {
        try { ob.disconnect(); } catch {}
        chatObservers.delete(container);
      }
    };

    const observeScroller = (container, scroller) => {
      if (!scroller || chatObservers.has(scroller)) return;
      const handler = () => {
        const info = hiddenStore.get(container);
        if (!info) return;
        const scrollTop = scroller.scrollTop || 0;
        if (scrollTop < SCROLL_BOTTOM_MARGIN) {
          revealChunk(container, CHUNK_SIZE * 2);
        }
        const sentinel = info.sentinel;
        if (sentinel && sentinel.getBoundingClientRect) {
          const rect = sentinel.getBoundingClientRect();
          const viewport = window.innerHeight;
          if (rect.top < viewport && rect.bottom > 0) {
            revealChunk(container, CHUNK_SIZE);
          }
        }
      };
      scroller.addEventListener('scroll', handler, { passive: true });
      chatObservers.set(scroller, { disconnect: () => scroller.removeEventListener('scroll', handler) });
      chatObservers.set(container, { disconnect: () => scroller.removeEventListener('scroll', handler) });
    };

    const mo = new MutationObserver(mutations => {
      if (!openasar.chatLazyLoad.enabled) return;
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        if (m.addedNodes && m.addedNodes.length > 0) {
          for (let j = 0; j < m.addedNodes.length; j++) {
            const n = m.addedNodes[j];
            if (n.nodeType !== 1) continue;
            if (isChatContainer(n)) {
              processChatContainer(n);
            } else if (n.querySelectorAll) {
              const targets = n.querySelectorAll('[class*="scrollerInner"], [class*="chatContent"], [id^="chat-messages-"], [class*="messagesWrapper"] ol, [class*="list"]');
              for (let k = 0; k < targets.length; k++) {
                if (isChatContainer(targets[k])) processChatContainer(targets[k]);
              }
            }
          }
        }
      }
    });

    const scanExisting = () => {
      const targets = document.querySelectorAll('[class*="scrollerInner"], [class*="chatContent"], [id^="chat-messages-"], [class*="messagesWrapper"] ol, [class*="list"]');
      for (let i = 0; i < targets.length; i++) {
        if (isChatContainer(targets[i])) processChatContainer(targets[i]);
      }
    };

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(scanExisting, 2000);
    } else {
      document.addEventListener('DOMContentLoaded', () => setTimeout(scanExisting, 2000));
    }
    setTimeout(() => {
      try {
        mo.observe(document.body, { childList: true, subtree: true });
      } catch {}
    }, 1000);
  })();
}
