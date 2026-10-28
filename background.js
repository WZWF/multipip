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

/** last tab that popped a video (speed-shortcut fallback target) */
let lastVideoTabId = null;

/** tabId of the tab that owns the dock window (null if none) */
let dockOwnerTabId = null;

/** companion host name (must match companion/com.multipip.host.json) */
const HOST_NAME = 'com.multipip.host';

/** companion window id -> { port, url, openerTabId } */
const companionWindows = new Map();
let companionNextId = 1;

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

  // WebRTC signaling relay between source tab and dock owner tab
  if (msg.type === 'mp-rtc-offer') {
    if (dockOwnerTabId != null && dockOwnerTabId !== tabId) {
      chrome.tabs.sendMessage(dockOwnerTabId, {
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

  return false;
});

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
