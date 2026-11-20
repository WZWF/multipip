/* =========================================================================
 * Multi-PiP background (service worker)
 * -------------------------------------------------------------------------
 * Chrome allows only ONE always-on-top PiP window globally (both video PiP
 * and Document PiP). The "dock" mode therefore merges videos into ONE
 * Document PiP window, including videos from OTHER TABS: the source tab
 * captures its video with captureStream() and relays the MediaStream here;
 * the owner tab turns it into a viewer card with custom controls that talk
 * back to the source tab through this relay.
 *
 * Message protocol (sender.tab.id / sender.frameId):
 *   { type: 'mp-claim'  } -> { ok: true } | { ok:false, ownerFrame }
 *   { type: 'mp-release' } -> { ok: true }
 *   { type: 'mp-note'    } -> { ok: true }          (I played a video)
 *   { type: 'mp-dock-owner', tabId } -> { ok: true } (this tab owns the dock)
 *   { type: 'mp-dock-who' } -> { ok:true, ownerTabId }  (who owns the dock)
 *   { type: 'mp-dock-stream', stream, meta }          (source tab -> owner)
 *   { type: 'mp-dock-ctl', toTab, op, value }         (owner -> source tab)
 *   { type: 'mp-dock-recall', toTab }                 (owner -> source tab)
 *   { type: 'mp-companion-open'|'close'|'list' }      (native host bridge)
 * All state is best-effort: a service-worker restart clears it.
 * ========================================================================= */
'use strict';

/** tabId -> frameId that owns the tab's PiP window */
const owners = new Map();

/** tabId -> Map(frameId -> count of videos in frame) */
const tabVideos = new Map();

/** last tab that popped a video (speed-shortcut fallback target) */
let lastVideoTabId = null;

/** tabId of the tab that owns the dock window (null if none) */
let dockOwnerTabId = null;

/** companion host name (must match companion/com.multipip.host.json) */
const HOST_NAME = 'com.multipip.host';

/** Win32 置顶宿主（must match companion/com.multipip.winhost.json） */
const WIN_HOST_NAME = 'com.multipip.winhost';

/** companion window id -> { port, url, openerTabId } */
const companionWindows = new Map();
let companionNextId = 1;

/** solo（原生拆窗）窗口记账：winId -> { winId, tabId, token, originWinId, originIndex } */
const soloWindows = new Map();
/** solo token -> 同一条记录，宿主按 title 里的 token 找到 HWND */
const soloByToken = new Map();

/* ------------------------- core message handling ------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 严格校验消息来源必须为本扩展自身，拒绝任何外部扩展或异常上下文伪造调用
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (!msg || typeof msg.type !== 'string') return false;
  if (msg.type.indexOf('mp-') !== 0) return false;

  const tabId = sender.tab ? sender.tab.id : -1;
  const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;

  if (msg.type === 'mp-note') {
    if (sender.tab && typeof tabId === 'number') lastVideoTabId = tabId;
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'mp-window-fullscreen') {
    // 查找包含 sender tab 的窗口或者最新的独立弹窗
    chrome.windows.getCurrent((curWin) => {
      const winId = msg.windowId || (curWin ? curWin.id : null);
      if (winId != null) {
        const nextState = msg.fullscreen ? 'fullscreen' : 'normal';
        chrome.windows.update(winId, { state: nextState }, (updated) => {
          sendResponse({ ok: !chrome.runtime.lastError, state: updated ? updated.state : null });
        });
      } else {
        sendResponse({ ok: false });
      }
    });
    return true;
  }

  if (msg.type === 'mp-claim') {
    const cur = owners.get(tabId);
    if (cur === undefined || cur === frameId) {
      owners.set(tabId, frameId);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, ownerFrame: cur });
    }
    return true;
  }

  if (msg.type === 'mp-release') {
    if (owners.get(tabId) === frameId) owners.delete(tabId);
    if (dockOwnerTabId === tabId) dockOwnerTabId = null;
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'mp-dock-owner') {
    dockOwnerTabId = tabId;
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'mp-dock-who') {
    sendResponse({ ok: true, ownerTabId: dockOwnerTabId, iAmOwner: dockOwnerTabId === null || dockOwnerTabId === tabId });
    return true;
  }

  // 子框架或任意页面上报检测到的视频数量
  if (msg.type === 'mp-report-videos') {
    if (typeof tabId === 'number' && tabId >= 0) {
      let frameMap = tabVideos.get(tabId);
      if (!frameMap) {
        frameMap = new Map();
        tabVideos.set(tabId, frameMap);
      }
      frameMap.set(frameId, Number(msg.count) || 0);
      let total = 0;
      for (const cnt of frameMap.values()) total += cnt;
      // 通知顶层 frame 该标签页内的总有效视频数
      chrome.tabs.sendMessage(tabId, { type: 'mp-tab-video-count', total }, { frameId: 0 }, () => {
        void chrome.runtime.lastError;
      });
    }
    sendResponse({ ok: true });
    return true;
  }

  // 子框架请求顶层主窗口协助代开 Document PiP 坞窗口
  if (msg.type === 'mp-dock-open-top') {
    if (typeof tabId === 'number') {
      chrome.tabs.sendMessage(tabId, { type: 'mp-top-open-dock-request' }, { frameId: 0 }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err || !resp || !resp.ok) {
          sendResponse({ ok: false, error: (err && err.message) || (resp && resp.error) || 'top frame rejected dock open' });
        } else {
          sendResponse({ ok: true, tabId });
        }
      });
      return true; // async
    }
    sendResponse({ ok: false });
    return true;
  }

  // WebRTC signaling relay between source tab and dock owner tab
  if (msg.type === 'mp-rtc-offer') {
    const targetTab = (typeof msg.toTab === 'number') ? msg.toTab : dockOwnerTabId;
    if (targetTab != null) {
      chrome.tabs.sendMessage(targetTab, {
        type: 'mp-rtc-offer',
        offer: msg.offer,
        connId: msg.connId,
        meta: msg.meta,
        fromTab: tabId,
      }, () => { void chrome.runtime.lastError; });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'mp-rtc-answer') {
    if (typeof msg.toTab === 'number') {
      chrome.tabs.sendMessage(msg.toTab, {
        type: 'mp-rtc-answer',
        answer: msg.answer,
        connId: msg.connId,
      }, () => { void chrome.runtime.lastError; });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'mp-rtc-ice') {
    if (typeof msg.toTab === 'number') {
      chrome.tabs.sendMessage(msg.toTab, {
        type: 'mp-rtc-ice',
        candidate: msg.candidate,
        connId: msg.connId,
        fromTab: tabId,
      }, () => { void chrome.runtime.lastError; });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'mp-dock-meta-sync') {
    if (typeof msg.toTab === 'number') {
      chrome.tabs.sendMessage(msg.toTab, {
        type: 'mp-dock-meta-sync',
        connId: msg.connId,
        fromTab: tabId,
        currentTime: msg.currentTime,
        duration: msg.duration,
        paused: msg.paused,
        playbackRate: msg.playbackRate,
        volume: msg.volume,
      }, () => { void chrome.runtime.lastError; });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'mp-dock-embed') {
    // source tab -> dock owner tab (a plain URL: the owner embeds the player)
    if (dockOwnerTabId != null && dockOwnerTabId !== tabId) {
      chrome.tabs.sendMessage(dockOwnerTabId, {
        type: 'mp-dock-add-embed',
        url: msg.url,
        meta: msg.meta,
        fromTab: tabId,
      }, () => { void chrome.runtime.lastError; });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'mp-dock-ctl') {
    if (typeof msg.toTab === 'number') {
      chrome.tabs.sendMessage(msg.toTab, {
        type: 'mp-dock-ctl',
        op: msg.op,
        value: msg.value,
        id: msg.id,
      }, () => { void chrome.runtime.lastError; });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'mp-dock-recall-card') {
    // toTab given -> the card's SOURCE tab (clean up its RTC source);
    // otherwise -> the dock owner (remove the card).
    const target = (typeof msg.toTab === 'number' && msg.toTab >= 0) ? msg.toTab : dockOwnerTabId;
    if (target != null) {
      chrome.tabs.sendMessage(target, { type: 'mp-dock-recall-card', id: msg.id }, () => { void chrome.runtime.lastError; });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'mp-dock-recall') {
    if (typeof msg.toTab === 'number') {
      chrome.tabs.sendMessage(msg.toTab, {
        type: 'mp-dock-recall',
      }, () => { void chrome.runtime.lastError; });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'mp-companion-open') {
    companionOpen(msg, sender)
      .then((resp) => sendResponse(resp))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // async response
  }

  if (msg.type === 'mp-companion-signal') {
    const entry = companionWindows.get(msg.id);
    const allowedCmds = { 'rtc-offer': true, 'rtc-ice': true, 'meta-sync': true };
    if (entry && msg.data && allowedCmds[msg.data.cmd]) {
      try {
        entry.port.postMessage(msg.data);
      } catch (e) {}
    }
    sendResponse({ ok: !!entry });
    return true;
  }

  if (msg.type === 'mp-companion-layout') {
    const wins = msg.windows || [];
    wins.forEach((w) => {
      const entry = companionWindows.get(w.id);
      if (entry) {
        try {
          entry.port.postMessage({
            cmd: 'set-bounds',
            x: w.x,
            y: w.y,
            width: w.width,
            height: w.height,
          });
        } catch (e) {}
      }
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'mp-companion-close') {
    const entry = companionWindows.get(msg.id);
    if (entry) {
      try { entry.port.postMessage({ cmd: 'close', id: msg.id }); } catch (e) { /* gone */ }
    }
    sendResponse({ ok: !!entry });
    return true;
  }

  if (msg.type === 'mp-companion-list') {
    sendResponse({ ok: true, ids: Array.from(companionWindows.keys()) });
    return true;
  }

  /* ------------------------------ solo 拆窗 ------------------------------ */

  if (msg.type === 'mp-solo-open') {
    soloOpen(msg, sender)
      .then((resp) => sendResponse(resp))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (msg.type === 'mp-solo-recall') {
    const rec = (msg.token && soloByToken.get(String(msg.token))) || soloByTabId(tabId);
    if (!rec) {
      sendResponse({ ok: false, error: '\u5f53\u524d\u9875\u9762\u4e0d\u5728\u62c6\u7a97\u6a21\u5f0f\u4e0b' });
      return true;
    }
    soloRecall(rec);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'mp-solo-topmost') {
    const token = String(msg.token || '');
    const on = msg.on !== false;
    const posted = on
      ? winHostPost({ cmd: 'attach', token, topmost: 1 })
      : winHostPost({ cmd: 'detach', token });
    sendResponse({ ok: posted, error: posted ? '' : winHostLastError });
    return true;
  }

  if (msg.type === 'mp-win-ping') {
    sendResponse({ ok: !!winHostConnect(), error: winHostLastError });
    return true;
  }

  return false;
});

/* --------------------- solo: Chrome popup 拆窗 + Win32 置顶 --------------------- */

/**
 * 把视频所在的 Tab 整体挪进一个 Chrome popup 窗口（同一个 WebContents，不重载、不掉进度、
 * 不走任何编码），再由常驻 Win32 宿主把这个 HWND 置顶。
 * 这是“多开 + 零重编码 + 支持 DRM”的唯一可靠路径。
 */
function soloOpen(msg, sender) {
  return new Promise((resolve) => {
    const tabId = sender.tab ? sender.tab.id : -1;
    if (typeof tabId !== 'number' || tabId < 0) {
      resolve({ ok: false, error: '\u65e0\u6cd5\u8bc6\u522b\u6765\u6e90\u6807\u7b7e\u9875' });
      return;
    }
    const token = String(msg.token || '').slice(0, 64);
    if (!token) {
      resolve({ ok: false, error: '\u7f3a\u5c11 token' });
      return;
    }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve({ ok: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'tab gone' });
        return;
      }
      const originWinId = tab.windowId;
      const originIndex = tab.index;
      const width = Math.max(240, Math.min(3000, Math.round(Number(msg.width) || 720)));
      const height = Math.max(140, Math.min(2000, Math.round(Number(msg.height) || 405)));
      chrome.windows.create({ tabId, type: 'popup', width, height, focused: true }, (win) => {
        if (chrome.runtime.lastError || !win) {
          resolve({ ok: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'windows.create failed' });
          return;
        }
        const rec = { winId: win.id, tabId, token, originWinId, originIndex };
        soloWindows.set(win.id, rec);
        soloByToken.set(token, rec);
        soloPersist();
        // 宿主按 title 里的 token 找窗口，窗口晚于消息出现也能自愈（宿主内部重试 3s）
        winHostPost({ cmd: 'attach', token, topmost: 1 });
        resolve({ ok: true, winId: win.id, topmost: true });
      });
    });
  });
}

function soloByTabId(tabId) {
  for (const rec of soloWindows.values()) {
    if (rec.tabId === tabId) return rec;
  }
  return null;
}

/** 召回：先让页面撤销 CSS 隔离，再把 Tab 原路移回、销毁空的 popup 窗口、取消置顶。 */
function soloRecall(rec) {
  if (!rec) return;
  soloWindows.delete(rec.winId);
  soloByToken.delete(rec.token);
  soloPersist();
  winHostPost({ cmd: 'detach', token: rec.token });
  try {
    chrome.tabs.sendMessage(rec.tabId, { type: 'mp-solo-restore', token: rec.token }, () => { void chrome.runtime.lastError; });
  } catch (e) { /* tab gone */ }
  chrome.tabs.move(rec.tabId, { windowId: rec.originWinId, index: rec.originIndex }, () => {
    if (chrome.runtime.lastError) return;
    chrome.windows.remove(rec.winId, () => { void chrome.runtime.lastError; });
  });
}

chrome.windows.onRemoved.addListener((winId) => {
  const rec = soloWindows.get(winId);
  if (!rec) return;
  soloWindows.delete(winId);
  soloByToken.delete(rec.token);
  soloPersist();
  winHostPost({ cmd: 'detach', token: rec.token });
  if (rec.tabId != null) {
    chrome.tabs.sendMessage(rec.tabId, { type: 'mp-solo-restore', token: rec.token }, () => { void chrome.runtime.lastError; });
  }
});

/* ------------------------ Win32 host (single instance) ------------------------ */

let winPort = null;
let winHostLastError = '';
let winHeartbeat = null;

/** MV3 service worker 空闲会被回收（连带断开宿主管道）。心跳能显著延长存活，
 *  即使被回收也不影响置顶：宿主在 EOF 时刻意不还原置顶，恢复后再幂等重发 attach。 */
function winHeartbeatStart() {
  if (winHeartbeat) return;
  winHeartbeat = setInterval(() => {
    if (soloByToken.size === 0) return;
    winHostPost({ cmd: 'ping' });
  }, 20000);
}

/** solo 状态落盘到 storage.session，SW 重启后据此恢复置顶。 */
function soloPersist() {
  try {
    const list = Array.from(soloWindows.values());
    chrome.storage.session.set({ multipip_solo: list }, () => { void chrome.runtime.lastError; });
  } catch (e) { /* storage.session unavailable */ }
}

function soloRestoreOnBoot() {
  try {
    chrome.storage.session.get(['multipip_solo'], (res) => {
      if (chrome.runtime.lastError) return;
      const list = (res && res.multipip_solo) || [];
      for (const rec of list) {
        if (!rec || !rec.token || rec.winId == null) continue;
        if (soloWindows.has(rec.winId)) continue;
        soloWindows.set(rec.winId, rec);
        soloByToken.set(rec.token, rec);
        winHostPost({ cmd: 'attach', token: rec.token, topmost: 1 });
      }
    });
  } catch (e) { /* ignore */ }
}
soloRestoreOnBoot();

/** 全局只保持一条长连接：与 companion 每窗一个进程不同，这里只做置顶，不需要进程隔离。 */
function winHostConnect() {
  if (winPort) return winPort;
  try {
    winPort = chrome.runtime.connectNative(WIN_HOST_NAME);
  } catch (e) {
    winPort = null;
    winHostLastError = String((e && e.message) || e);
    return null;
  }
  winHostLastError = '';
  winHeartbeatStart();
  winPort.onMessage.addListener((m) => {
    if (!m) return;
    if (m.event === 'ready') return;
    if (!m.token) return;
    const rec = soloByToken.get(m.token);
    if (rec && rec.tabId != null) {
      chrome.tabs.sendMessage(rec.tabId, {
        type: 'mp-solo-topmost-state',
        token: m.token,
        ok: !!m.ok,
        error: m.error || '',
      }, () => { void chrome.runtime.lastError; });
    }
  });
  winPort.onDisconnect.addListener(() => {
    winHostLastError = (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'disconnected';
    winPort = null;
  });
  return winPort;
}

function winHostPost(msg) {
  const port = winHostConnect();
  if (!port) return false;
  try {
    port.postMessage(msg);
    return true;
  } catch (e) {
    winPort = null;
    winHostLastError = String((e && e.message) || e);
    return false;
  }
}

/* ------------------------- companion (native host) ------------------------- */

/** Opens one frameless always-on-top window via the native host.
 *  Resolves with {ok, id} or {ok:false, error} (host not installed etc.). */
function companionOpen(msg, sender) {
  return new Promise((resolve) => {
    const id = companionNextId++;
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (e) {
      resolve({ ok: false, error: '\u65e0\u6cd5\u8fde\u63a5\u4f34\u4fa3\u7a0b\u5e8f\uff1a' + String((e && e.message) || e) });
      return;
    }

    const openerTabId = sender.tab ? sender.tab.id : -1;
    const entry = { id, port, url: msg.url || '', openerTabId };
    companionWindows.set(id, entry);

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: true, id });
      }
    }, 5000);

    const finish = (resp) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(resp);
    };

    port.onMessage.addListener((m) => {
      if (!m) return;
      if (m.event === 'closed') {
        companionWindows.delete(id);
        notifyCompanionClosed(openerTabId, id);
        return;
      }
      // 将来自伴侣原生窗口的 WebRTC 信令及控制指令转发给对应 content tab
      if (m.cmd === 'rtc-answer' || m.cmd === 'rtc-ice' || m.cmd === 'ctl') {
        if (typeof openerTabId === 'number' && openerTabId >= 0) {
          chrome.tabs.sendMessage(openerTabId, {
            type: 'mp-companion-signal-recv',
            id,
            data: m
          }, () => { void chrome.runtime.lastError; });
        }
        return;
      }
      if (m.ok === true) {
        finish({ ok: true, id });
      } else if (m.ok === false) {
        companionWindows.delete(id);
        try { port.disconnect(); } catch (e) { /* gone */ }
        finish({ ok: false, error: m.error || 'host error' });
      }
    });

    port.onDisconnect.addListener(() => {
      companionWindows.delete(id);
      const err = chrome.runtime.lastError && chrome.runtime.lastError.message;
      if (err) notifyCompanionClosed(openerTabId, id);
      const hint = '\uff08\u8bf7\u53cc\u51fb\u8fd0\u884c companion/register_host.bat \u5e76\u5728\u6269\u5c55\u7ba1\u7406\u9875\u5237\u65b0\u672c\u6269\u5c55\uff09';
      finish({ ok: false, error: (err ? err + ' ' + hint : '\u4f34\u4fa3\u7a0b\u5e8f\u8fde\u63a5\u4e2d\u65ad ' + hint) });
    });

    try {
      port.postMessage({
        cmd: 'open',
        id,
        width: Math.max(160, Math.min(4096, Number(msg.width) || 480)),
        height: Math.max(90, Math.min(2160, Number(msg.height) || 270)),
        x: typeof msg.x === 'number' ? Math.round(msg.x) : undefined,
        y: typeof msg.y === 'number' ? Math.round(msg.y) : undefined,
      });
    } catch (e) {
      companionWindows.delete(id);
      finish({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

/** Tell the opening tab that a companion window went away (user closed it). */
function notifyCompanionClosed(tabId, id) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  try {
    chrome.tabs.sendMessage(tabId, { type: 'mp-companion-closed', id });
  } catch (e) { /* tab gone */ }
}

/* ------------------------------- shortcuts ------------------------------- */

chrome.tabs.onRemoved.addListener((tabId) => {
  owners.delete(tabId);
  tabVideos.delete(tabId);
  if (dockOwnerTabId === tabId) dockOwnerTabId = null;
  if (lastVideoTabId === tabId) lastVideoTabId = null;
  const rec = soloByTabId(tabId);
  if (rec) {
    soloWindows.delete(rec.winId);
    soloByToken.delete(rec.token);
    soloPersist();
    winHostPost({ cmd: 'detach', token: rec.token });
  }
});

/** Alt+Shift+S: cycle playback speed of the current video */
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'mp-cycle-speed') return;

  const targets = [];
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active && typeof active.id === 'number') targets.push(active.id);
  } catch (e) { /* ignore */ }
  if (lastVideoTabId != null && targets.indexOf(lastVideoTabId) < 0) {
    targets.push(lastVideoTabId);
  }

  for (const id of targets) {
    try {
      const resp = await chrome.tabs.sendMessage(id, { type: 'mp-cycle-speed' });
      if (resp && resp.ok) return; // handled by that tab
    } catch (e) { /* no content-script receiver in that tab */ }
  }
});
