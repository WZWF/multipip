/* =========================================================================
 * Multi-PiP (content script) v0.9
 * -------------------------------------------------------------------------
 * Pops any <video> on the page into its own window.
 *
 * Modes (switch in the bottom-right panel; choice is remembered):
 *   dock      - Document PiP multi-video dock: merges videos from the same
 *               page AND across tabs (via local WebRTC loopback stream) into
 *               ONE always-on-top window with 5 layouts (stack/grid/bigLeft/
 *               bigRight/free) and per-card controls.
 *   native    - the browser's NATIVE video PiP (video.requestPictureInPicture).
 *               Playback speed is controlled from the panel or Alt+Shift+S.
 *   companion - the native host (companion/dist/multipip_host) opens REAL
 *               frameless always-on-top windows via local WebRTC stream;
 *               multiple windows can coexist with 1-click screen tiling and
 *               SRT/VTT external subtitle support.
 *   window    - standalone browser window (window.open) used as fallback.
 *
 * Falls back to native video PiP when Document PiP is unavailable or
 * the page is not HTTPS.
 * ========================================================================= */
(() => {
  'use strict';

  if (window.__multiPipLoaded) return;
  window.__multiPipLoaded = true;

  const NS = '__multipip__';

  const log = (...args) => console.log('[Multi-PiP]', ...args);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  /* ------------------------------- settings ------------------------------- */
  const modeStore = {
    get() {
      try { return localStorage.getItem(NS + ':mode') || 'dock'; } catch (e) { return 'dock'; }
    },
    set(v) {
      try { localStorage.setItem(NS + ':mode', v); } catch (e) { /* private mode */ }
    },
  };

  /* -------------------------------- toast -------------------------------- */
  const TOAST_ID = NS + 'toast';
  let toastTimer = 0;
  function toast(msg, ms = 2400) {
    let el = document.getElementById(TOAST_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = TOAST_ID;
      Object.assign(el.style, {
        position: 'fixed',
        left: '50%',
        top: '18px',
        transform: 'translateX(-50%)',
        zIndex: '2147483647',
        padding: '10px 16px',
        borderRadius: '10px',
        background: 'rgba(20,20,28,.92)',
        color: '#fff',
        font: '13px/1.5 system-ui, "Microsoft YaHei", sans-serif',
        boxShadow: '0 6px 24px rgba(0,0,0,.35)',
        pointerEvents: 'none',
        transition: 'opacity .2s',
        maxWidth: '70vw',
      });
      (document.documentElement || document.body).appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; }, ms);
  }

  /* --------------------------- video discovery --------------------------- */
  /** Collects <video> elements, including inside shadow DOM. */
  function collectVideos(root = document) {
    const result = [];
    const seen = new Set();
    const walk = (node) => {
      if (!node || !node.querySelectorAll || seen.has(node)) return;
      seen.add(node);
      node.querySelectorAll('video').forEach((v) => {
        if (!result.includes(v)) result.push(v);
      });
      node.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) walk(el.shadowRoot);
      });
    };
    walk(root);
    // 过滤零尺寸/无源的隐藏占位 video，并将正在播放或面积最大的主视频排在最前面
    const valid = result.filter((v) => {
      if (homes.has(v) || nativePopped.has(v) || companionPopped.has(v) || dockCrossPopped.has(v)) return true;
      const r = v.getBoundingClientRect ? v.getBoundingClientRect() : { width: 0, height: 0 };
      const hasMedia = (v.videoWidth > 0 && v.videoHeight > 0) || v.readyState > 0 || Boolean(v.currentSrc || v.src || v.srcObject);
      const isVisible = r.width >= 40 && r.height >= 24;
      return hasMedia || isVisible;
    });
    valid.sort((a, b) => {
      const score = (v) => {
        let s = 0;
        if (!v.paused && v.readyState >= 2) s += 1e9;
        if (v.videoWidth > 0 && v.videoHeight > 0) s += v.videoWidth * v.videoHeight * 100;
        const r = v.getBoundingClientRect ? v.getBoundingClientRect() : { width: 0, height: 0 };
        if (r.width > 0 && r.height > 0) s += r.width * r.height;
        if (Number.isFinite(v.duration) && v.duration > 0) s += 1e5;
        return s;
      };
      return score(b) - score(a);
    });
    return valid;
  }

  /* ------------------------ pop / restore core ------------------------ */
  /**
   * video -> original position + host window info
   * @type {WeakMap<HTMLVideoElement, {
   *   style: string, parent: Node|null, next: Node|null, controls: boolean,
   *   win: Window|null, slot: HTMLElement|null, placeholder: HTMLElement|null
   * }>}
   */
  const homes = new WeakMap();
  const pending = new Set(); // guards against double-click double pops

  /** videos currently living in the browser's NATIVE video PiP window */
  const nativePopped = new Set();

  /** cross-tab dock sources: id -> { video, wasPlaying } (this tab) */
  const dockStreamSources = new Map();
  let nextDockSourceId = 1;

  /** videos merged into the dock via stream relay (this tab, panel state) */
  const dockCrossPopped = new Set();
  const dockCrossIds = new Map(); // video -> stream id (for recall)
  /** WebRTC peer connections for cross-tab video streaming: connId -> { pc, video, stream, syncTimer } */
  const rtcConnections = new Map();
  /** last video popped in any mode (speed-shortcut target) */
  let lastPopped = null;

  /** videos shown in a companion frameless window: video -> window id */
  const companionPopped = new Map();
  /** companion window id -> { pc, video, syncTimer } */
  const companionConnections = new Map();

  /** This document's dock window (Chrome allows one Document PiP window
   *  globally, and this is ours). */
  let dock = null;
  /** Non-null while the dock window is being opened (concurrent-pop guard). */
  let dockOpening = null;

  /* --------------------- background coordination --------------------- */
  /** Talks to the service worker (tab PiP-window ownership bookkeeping,
   *  and remembering which tab last played a video for the speed
   *  shortcut). Silently no-ops when messaging is unavailable. */
  function bgSend(msg) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
          resolve(null);
          return;
        }
        chrome.runtime.sendMessage(msg, (resp) => {
          void chrome.runtime.lastError; // e.g. service worker asleep
          resolve(resp || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function pipSupported() {
    return (
      typeof window.documentPictureInPicture?.requestWindow === 'function' &&
      window.isSecureContext
    );
  }

  function fallbackNativePiP(video) {
    if (typeof video.requestPictureInPicture !== 'function') {
      toast('\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u753b\u4e2d\u753b\uff0c\u65e0\u6cd5\u5f39\u51fa');
      return;
    }
    video.requestPictureInPicture().catch((e) => {
      log('native PiP failed', e);
      toast('\u6d4f\u89c8\u5668\u753b\u4e2d\u753b\u4e5f\u5931\u8d25\u4e86\uff1a' + (e?.message || e));
    });
  }

  function saveHome(video, extra) {
    const home = {
      style: video.style.cssText,
      parent: video.parentNode,
      next: video.nextSibling,
      controls: video.controls,
      win: null,
      slot: null,
      placeholder: null,
    };
    Object.assign(home, extra || {});
    homes.set(video, home);
    return home;
  }

  function restoreVideo(video, opts = {}) {
    const home = homes.get(video);
    if (!home) return;
    homes.delete(video);

    // restore inline style + controls flag
    video.style.cssText = home.style || '';
    if (!home.controls) video.controls = false;

    // put it back where it was (falls back to body if parent is gone)
    const parent = home.parent && home.parent.isConnected ? home.parent : document.body;
    try {
      if (home.next && home.next.parentNode === home.parent) {
        parent.insertBefore(video, home.next);
      } else {
        parent.appendChild(video);
      }
    } catch (e) {
      log('restore failed', e);
    }
    home.placeholder?.remove();
    home.slot?.remove();

    // window mode: close the popup once the video is back
    if (home.win && (!dock || home.win !== dock.win) && !home.win.closed) {
      try { home.win.close(); } catch (e) { /* already closed */ }
    }
    unprotectSourceVideo(video);

    // dock empty -> close the whole window
    if (dock && dock.list.length) {
      dock.list = dock.list.filter((v) => v !== video);
    }
    if (dock && dock.cards) {
      dock.cards = dock.cards.filter((c) => c.video !== video);
    }
    if (dock && dock.list.length === 0 && dock.cards.length === 0) {
      const closing = dock;
      dock = null;
      bgSend({ type: 'mp-release' });
      if (!opts.keepWindow && !closing.win.closed) {
        try { closing.win.close(); } catch (e) { /* already closed */ }
      }
    }
    log('video returned');
  }

  function recallDock() {
    if (!dock) return;
    const d = dock;
    dock = null;
    bgSend({ type: 'mp-release' });
    [...(d.cards || [])].forEach((c) => {
      if (c.kind === 'stream') {
        try { c.media.srcObject = null; } catch (e) {}
        const tracks = c.stream ? c.stream.getTracks() : [];
        tracks.forEach((t) => { try { t.stop(); } catch (e) {} });
        bgSend({ type: 'mp-dock-recall', toTab: c.sourceTabId, id: c.meta && c.meta.id });
      }
    });
    [...d.list].forEach((v) => restoreVideo(v, { keepWindow: true }));
    try { d.win.close(); } catch (e) { /* already closing */ }
  }

  /** native video PiP recall: just exit PiP (the element never moved) */
  function recallNative(video) {
    if (!nativePopped.has(video)) return;
    try {
      if (document.pictureInPictureElement === video && document.exitPictureInPicture) {
        document.exitPictureInPicture();
      }
    } catch (e) { /* already exited */ }
    nativePopped.delete(video);
    log('native piP exited');
  }

  function insertPlaceholder(video, home) {
    const div = document.createElement('div');
    div.textContent = '\u89c6\u9891\u5df2\u5f39\u51fa\u5230\u72ec\u7acb\u7a97\u53e3\u64ad\u653e \u00b7 \u70b9\u51fb\u53ec\u56de';
    Object.assign(div.style, {
      padding: '18px 12px',
      textAlign: 'center',
      borderRadius: '8px',
      background: 'rgba(0,0,0,.55)',
      color: '#fff',
      font: '13px/1.5 system-ui, "Microsoft YaHei", sans-serif',
      cursor: 'pointer',
    });
    div.addEventListener('click', () => restoreVideo(video));
    home.placeholder = div;
    if (home.parent) {
      if (home.next && home.next.parentNode === home.parent) {
        home.parent.insertBefore(div, home.next);
      } else {
        home.parent.appendChild(div);
      }
    }
  }

  /* ------------------------------ pop entry ------------------------------ */
  async function popOut(video) {
    if (homes.has(video)) {
      toast('\u8fd9\u4e2a\u89c6\u9891\u5df2\u7ecf\u5728\u64ad\u653e\u7a97\u91cc\u4e86');
      return;
    }
    if (nativePopped.has(video)) {
      toast('\u8fd9\u4e2a\u89c6\u9891\u5df2\u7ecf\u5728\u7cfb\u7edf\u753b\u4e2d\u753b\u91cc\u4e86');
      return;
    }
    if (companionPopped.has(video)) {
      toast('\u8fd9\u4e2a\u89c6\u9891\u5df2\u7ecf\u5728\u65e0\u8fb9\u6846\u7a97\u91cc\u4e86');
      return;
    }
    if (pending.has(video)) return;
    pending.add(video);
    bgSend({ type: 'mp-note' }); // remember this tab for the speed shortcut
    try {
      const mode = modeStore.get();
      if (mode === 'companion') {
        popOutCompanion(video);
        return;
      }
      if (modeStore.get() === 'dock') {
        const who = await bgSend({ type: 'mp-dock-who' });
        if (who && who.ok && who.ownerTabId != null && who.iAmOwner === false) {
          popOutCrossTabWebRTC(video); // universal cross-tab WebRTC stream to dock
        } else {
          await popOutToDock(video);
        }
        return;
      }
      if (mode === 'native') {
        popOutNative(video);
        return;
      }
      if (!pipSupported()) {
        if (mode === 'window') {
          popOutOwnWindow(video);
          return;
        }
        toast('\u9700\u8981 Chrome/Edge 116+ \u4e14\u9875\u9762\u4e3a HTTPS\uff1b\u9000\u56de\u7cfb\u7edf\u753b\u4e2d\u753b\uff08\u6bcf\u4e2a\u6807\u7b7e\u9875\u4e00\u4e2a\uff09');
        fallbackNativePiP(video);
        return;
      }
      if (mode === 'window') {
        popOutOwnWindow(video);
        return;
      }
      await popOutToDock(video);
    } finally {
      pending.delete(video);
    }
  }

  /** Native mode: hand the video to the browser's own video PiP window
   *  (pure native look, no title strip at all). NOTE: Chrome keeps only
   *  ONE PiP window globally (video or Document PiP), so this is the
   *  cleanest SINGLE always-on-top window experience. */
  function popOutNative(video) {
    if (typeof video.requestPictureInPicture !== 'function') {
      toast('\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u7cfb\u7edf\u753b\u4e2d\u753b');
      return;
    }
    video.requestPictureInPicture().then(() => {
      nativePopped.add(video);
      lastPopped = video;
      video.addEventListener('leavepictureinpicture', onLeave);
      log('native piP:', (video.currentSrc || '').slice(0, 60));
    }).catch((e) => {
      log('native PiP failed', e);
      toast('\u7cfb\u7edf\u753b\u4e2d\u753b\u5931\u8d25\uff1a' + (e?.message || e));
    });
    function onLeave() {
      nativePopped.delete(video);
      video.removeEventListener('leavepictureinpicture', onLeave);
      log('native piP exited');
    }
  }

  /** 为本地回环 WebRTC 补充 127.0.0.1 / ::1 候选地址，避免系统防火墙或虚拟网卡拦截 .local mDNS 导致黑屏无声 */
  function expandLoopbackCandidates(candObj) {
    if (!candObj || typeof candObj.candidate !== 'string') return [candObj];
    const list = [candObj];
    const str = candObj.candidate;
    const m = str.match(/^(candidate:\S+\s+\d+\s+udp\s+\d+\s+)([^\s]+)(\s+\d+\s+typ\s+host.*)$/i);
    if (m) {
      const addr = m[2];
      if (addr !== '127.0.0.1' && addr !== '::1') {
        list.push(Object.assign({}, candObj, { candidate: m[1] + '127.0.0.1' + m[3] }));
        list.push(Object.assign({}, candObj, { candidate: m[1] + '::1' + m[3] }));
      }
    }
    return list;
  }

  /** 为本地回环 WebRTC 解锁原画质高码率与 1:1 原始分辨率，消除默认 360p/1.7Mbps 带宽限制导致的画面模糊 */
  function boostWebRtcVideoSdp(sdp) {
    if (!sdp || typeof sdp !== 'string') return sdp;
    const lines = sdp.split('\r\n');
    const out = [];
    let inVideo = false;
    const videoPts = new Set();
    const hasFmtp = new Set();
    for (const line of lines) {
      if (line.indexOf('m=') === 0) inVideo = line.indexOf('m=video') === 0;
      if (inVideo) {
        const m = line.match(/^a=rtpmap:(\d+)\s+(VP9|VP8|H264|AV1)\/90000/i);
        if (m) videoPts.add(m[1]);
      }
    }
    for (const line of lines) {
      const fm = line.match(/^a=fmtp:(\d+)\s+/);
      if (fm && videoPts.has(fm[1])) hasFmtp.add(fm[1]);
    }
    inVideo = false;
    const br = 'x-google-min-bitrate=8000;x-google-start-bitrate=20000;x-google-max-bitrate=35000';
    for (const line of lines) {
      if (line.indexOf('m=') === 0) inVideo = line.indexOf('m=video') === 0;
      if (inVideo && line.indexOf('c=IN ') === 0) {
        out.push(line);
        out.push('b=AS:35000');
        continue;
      }
      const fm = line.match(/^a=fmtp:(\d+)\s+(.*)$/);
      if (inVideo && fm && videoPts.has(fm[1])) {
        if (fm[2].indexOf('x-google-max-bitrate') < 0) {
          out.push('a=fmtp:' + fm[1] + ' ' + fm[2] + ';' + br);
        } else {
          out.push(line);
        }
        continue;
      }
      out.push(line);
      const rm = line.match(/^a=rtpmap:(\d+)\s+/);
      if (inVideo && rm && videoPts.has(rm[1]) && !hasFmtp.has(rm[1])) {
        out.push('a=fmtp:' + rm[1] + ' ' + br);
      }
    }
    return out.join('\r\n');
  }

  function applyHighQualityRtcSenders(pc) {
    if (!pc || typeof pc.getSenders !== 'function') return;
    pc.getSenders().forEach((sender) => {
      try {
        if (sender.track && sender.track.kind === 'video' && typeof sender.getParameters === 'function') {
          const params = sender.getParameters() || {};
          params.degradationPreference = 'maintain-resolution';
          if (!params.encodings || !params.encodings.length) params.encodings = [{}];
          params.encodings[0].maxBitrate = 35000000;
          params.encodings[0].scaleResolutionDownBy = 1.0;
          params.encodings[0].maxFramerate = 60;
          const p = sender.setParameters(params);
          if (p && p.catch) p.catch(() => {});
        }
      } catch (e) {}
    });
  }

  function prepareHighQualityStream(stream) {
    if (!stream || typeof stream.getVideoTracks !== 'function') return;
    stream.getVideoTracks().forEach((vt) => {
      try {
        if ('contentHint' in vt) vt.contentHint = 'detail';
      } catch (e) {}
    });
  }

  /** Companion mode: REAL frameless always-on-top window using local WebRTC streaming.
   *  Directly captures the video stream via local WebRTC, 100% immune to network proxy,
   *  cookies, and CORS issues. */
  async function popOutCompanion(video) {
    let stream = null;
    try {
      if (typeof video.captureStream === 'function') stream = video.captureStream();
      else if (typeof video.mozCaptureStream === 'function') stream = video.mozCaptureStream();
    } catch (e) {
      log('companion captureStream error:', e);
    }

    const vTracks = stream && stream.getVideoTracks ? stream.getVideoTracks().length : 0;
    if (!stream || vTracks === 0) {
      toast('\u65e0\u6cd5\u83b7\u53d6\u8be5\u89c6\u9891\u7684\u753b\u9762\u6d41\uff0c\u53ef\u80fd\u53d7\u6d4f\u89c8\u5668\u5b89\u5168\u7b56\u7565\u9650\u5236');
      return;
    }
    prepareHighQualityStream(stream);

    const size = guessWindowSize([video]);
    const resp = await bgSend({
      type: 'mp-companion-open',
      width: size.width,
      height: size.height,
    });

    if (!resp || !resp.ok) {
      const errDetail = resp ? (resp.error || '返回错误(空结果)') : '后台未响应(null)';
      toast('\u65e0\u8fb9\u6846\u7a97\u6253\u5f00\u5931\u8d25\uff1a' + errDetail, 6000);
      return;
    }

    const winId = resp.id;
    companionPopped.set(video, winId);
    lastPopped = video;
    protectSourceVideo(video);
    playSourceVideo(video);
    hideCrossSourceVideo(video);
    refreshStates();
    log('companion window opened, id:', winId);

    // 建立本地 WebRTC PeerConnection 直推至伴侣窗口
    const pc = new RTCPeerConnection({ iceServers: [] });
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    const iceCandidates = [];

    // 状态同步定时器
    const syncTimer = setInterval(() => {
      if (!companionPopped.has(video)) {
        clearInterval(syncTimer);
        return;
      }
      bgSend({
        type: 'mp-companion-signal',
        id: winId,
        data: {
          cmd: 'meta-sync',
          currentTime: video.currentTime,
          duration: Number.isFinite(video.duration) ? video.duration : 0,
          paused: video.paused,
          playbackRate: video.playbackRate,
          volume: video.volume,
        }
      });
    }, 250);

    const connEntry = { pc, video, stream, syncTimer, iceCandidates, answerReceived: false, retryTimer: null };
    companionConnections.set(winId, connEntry);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        const rawCand = typeof e.candidate.toJSON === 'function' ? e.candidate.toJSON() : {
          candidate: e.candidate.candidate,
          sdpMid: e.candidate.sdpMid,
          sdpMLineIndex: e.candidate.sdpMLineIndex,
        };
        expandLoopbackCandidates(rawCand).forEach((cand) => {
          iceCandidates.push(cand);
          bgSend({
            type: 'mp-companion-signal',
            id: winId,
            data: {
              cmd: 'rtc-ice',
              candidate: cand
            }
          });
        });
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const offerPayload = {
      cmd: 'rtc-offer',
      offer: { type: offer.type, sdp: offer.sdp }
    };
    bgSend({
      type: 'mp-companion-signal',
      id: winId,
      data: offerPayload
    });

    // 若伴侣窗 WebView2 尚未完成 pywebviewready 初始化，首次信号可能被丢弃；自动重发直至收到 answer
    let retryCount = 0;
    connEntry.retryTimer = setInterval(() => {
      if (!companionPopped.has(video) || connEntry.answerReceived || retryCount >= 8) {
        clearInterval(connEntry.retryTimer);
        connEntry.retryTimer = null;
        return;
      }
      retryCount++;
      bgSend({
        type: 'mp-companion-signal',
        id: winId,
        data: offerPayload
      });
    }, 600);
  }

  function recallCompanion(video) {
    const id = companionPopped.get(video);
    if (id == null) return;
    companionPopped.delete(video);
    restoreCrossSourceVideo(video);
    unprotectSourceVideo(video);
    const conn = companionConnections.get(id);
    if (conn) {
      if (conn.syncTimer) clearInterval(conn.syncTimer);
      if (conn.retryTimer) clearInterval(conn.retryTimer);
      if (conn.stream && conn.stream.getTracks) {
        conn.stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
      }
      try { conn.pc.close(); } catch (e) {}
      companionConnections.delete(id);
    }
    bgSend({ type: 'mp-companion-close', id });
    refreshStates();
  }

  /** Window mode: window.open a real standalone popup window */
  function popOutOwnWindow(video) {
    const size = guessWindowSize([video]);
    let win = null;
    try {
      win = window.open('', '_blank', `popup=yes,width=${size.width},height=${size.height}`);
    } catch (e) { /* cross-origin restrictions */ }
    if (!win) {
      toast('\u5f39\u7a97\u88ab\u62e6\u622a\uff1a\u8bf7\u5141\u8bb8\u672c\u7ad9\u70b9\u5f39\u51fa\u7a97\u53e3\uff0c\u6216\u6539\u7528\u5176\u4ed6\u6a21\u5f0f');
      return;
    }
    try { win.document.title = ''; } catch (e) { /* no access on some pages */ }
    buildOwnWindowPlayer(win, video);
  }

  /** Dock mode: every video of the page shares one Document PiP window */
  async function popOutToDock(video) {
    if (dock && dock.win.closed) dock = null;
    if (dock) {
      addToDock(video, dock);
      return;
    }

    // Another frame of this tab may already own the tab's only PiP window;
    // opening another would close it. Ask the background coordinator.
    const claim = await bgSend({ type: 'mp-claim' });
    if (claim && claim.ok === false) {
      toast('\u672c\u6807\u7b7e\u9875\u5df2\u6709\u4e00\u4e2a\u7f6e\u9876\u7a97\uff08\u6765\u81ea\u9875\u9762\u7684\u5176\u4ed6\u90e8\u5206\uff1bChrome \u5168\u5c40\u4ec5\u5141\u8bb8\u4e00\u4e2a\uff09\u3002\u8fd9\u4e2a\u89c6\u9891\u6539\u7528\u72ec\u7acb\u7a97\u53e3\u6253\u5f00\uff0c\u5df2\u6709\u7a97\u53e3\u4e0d\u53d7\u5f71\u54cd', 3600);
      popOutOwnWindow(video);
      return;
    }

    // Same frame, two clicks in quick succession: the first pop may still
    // be opening the window. Wait for it and merge in, never open a second
    // one (which would close the first).
    if (dockOpening) {
      try { await dockOpening; } catch (e) { /* handled inside openDock */ }
      if (dock && !dock.win.closed) {
        addToDock(video, dock);
        return;
      }
      if (!dock) {
        // the in-flight open fell back to native PiP
        fallbackNativePiP(video);
        return;
      }
    }

    dockOpening = openDock(video);
    try {
      await dockOpening;
    } catch (e) {
      log('openDock failed', e);
    } finally {
      dockOpening = null;
    }
  }

  /** Opens the tab's single Document PiP window (or reuses a bridge) and
   *  docks the video into it. */
  async function openDock(video) {
    const size = guessWindowSize([video]);
    let win = null;
    const opts = {
      width: size.width,
      height: size.height,
    };
    try {
      win = await window.documentPictureInPicture.requestWindow(opts);
    } catch (err) {
      log('requestWindow failed', err);
      win = await tryTopLevelPiP(size);
      if (!win) {
        bgSend({ type: 'mp-release' });
        toast('\u7f6e\u9876\u7a97\u6253\u5f00\u5931\u8d25\uff08' + (err?.message || err) + '\uff09\uff0c\u9000\u56de\u7cfb\u7edf\u753b\u4e2d\u753b');
        fallbackNativePiP(video);
        return;
      }
    }
    setupDockWindow(win, video);
  }

  function setupDockWindow(win, video) {
    try { win.document.title = ''; } catch (e) { /* same as above */ }

    dock = { win, doc: win.document, list: [], body: null, cards: [] };
    setupDockDoc(dock);
    bgSend({ type: 'mp-dock-owner' }); // announce ownership for cross-tab merges
    win.addEventListener('pagehide', () => {
      bgSend({ type: 'mp-release' });
      recallDock();
    });
    addToDock(video, dock);
  }

  /** Some pages keep the player inside an iframe where requestWindow is
   *  not allowed. When the frame is same-origin with the top document,
   *  ask the top-level document to open the window instead: the PiP
   *  document shares our origin, so our video element can still be
   *  adopted into it. */
  async function tryTopLevelPiP(size) {
    try {
      if (window.top === window.self) return null;
      let topOrigin = null;
      try { topOrigin = window.top.location.origin; } catch (e) { return null; }
      if (topOrigin !== window.location.origin) return null;
      const api = window.top.documentPictureInPicture;
      if (!api || typeof api.requestWindow !== 'function') return null;
      return await api.requestWindow({
        width: size.width,
        height: size.height,
      });
    } catch (e) {
      log('top-level PiP bridge failed', e);
      return null;
    }
  }

  function aspectRatio(video) {
    const w = video.videoWidth || 0;
    const h = video.videoHeight || 0;
    if (w > 0 && h > 0) return h / w;
    return 9 / 16;
  }

  /** Initial window size: compact & neat initial size (around 720x405), never oversized */
  function guessWindowSize(videos) {
    const availW = (typeof screen !== 'undefined' && screen.availWidth) || 1280;
    const availH = (typeof screen !== 'undefined' && screen.availHeight) || 720;
    // 首次打开：精致小巧适中（约宽 640~720），不遮挡正常操作，需要大窗可一键右上角点【大】或手动拉伸
    const targetW = Math.min(720, Math.round(availW * 0.45));
    const targetH = Math.round(targetW * (9 / 16));
    return {
      width: clamp(targetW, 400, 1920),
      height: clamp(targetH, 240, 1080),
    };
  }

  /** The window body is one flex column of cards. */
  function setupDockDoc(d) {
    const doc = d.doc;
    d.cards = [];
    d.layout = 'stack';
    d.free = false;
    d.focused = null;
    d.fullscreen = null;
    d.isMaximized = false;
    d.normalBounds = null;

    // 显式保证鼠标指针永久可见
    doc.documentElement.style.cursor = 'default';
    doc.body.style.cssText = 'margin:0;padding:0;overflow:hidden;background:#000;cursor:default;';

    const list = doc.createElement('div');
    Object.assign(list.style, {
      position: 'absolute',
      inset: '0',
      display: 'flex',
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: '0px',
      padding: '0px',
      boxSizing: 'border-box',
      background: '#000',
    });
    doc.body.appendChild(list);
    d.body = list;

    // 双击小窗背景空白处切换全屏/还原
    list.addEventListener('dblclick', (e) => {
      if (e.target === list) {
        toggleWindowFullscreen(d);
      }
    });

    makeLayoutBar(d);

    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (d.fullscreen) {
          exitFullscreen(d);
          return;
        }
        if (d.isMaximized || doc.fullscreenElement) {
          toggleWindowFullscreen(d);
          return;
        }
        recallDock();
        return;
      }
      const card = d.focused || d.cards[0];
      if (!card) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); card.ctl && card.ctl.seek(Math.max(0, card.ctl.time() - 5)); }
      if (e.key === 'ArrowRight') { e.preventDefault(); card.ctl && card.ctl.seek(card.ctl.time() + 5); }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const i = d.cards.indexOf(card);
        const j = (i + (e.key === 'ArrowDown' ? 1 : -1) + d.cards.length) % d.cards.length;
        d.focused = d.cards[j];
      }
    });
  }

  /** Tiny layout switcher, top-right, always visible so controls are never missed. */
  function makeLayoutBar(d) {
    const doc = d.doc;
    const bar = doc.createElement('div');
    Object.assign(bar.style, {
      position: 'absolute', top: '8px', right: '8px', display: 'flex', gap: '5px',
      padding: '4px 6px', borderRadius: '10px', background: 'rgba(0,0,0,.75)',
      boxShadow: '0 4px 16px rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.2)',
      opacity: '0.85', transition: 'opacity .2s', pointerEvents: 'auto', zIndex: '999999',
    });
    bar.addEventListener('mouseenter', () => { bar.style.opacity = '1'; });
    bar.addEventListener('mouseleave', () => { bar.style.opacity = '0.85'; });
    const mk = (label, title, fn) => {
      const b = doc.createElement('button');
      b.textContent = label;
      b.title = title || '';
      Object.assign(b.style, {
        cursor: 'pointer', border: '1px solid rgba(255,255,255,.25)',
        background: 'rgba(255,255,255,.12)', color: '#fff', borderRadius: '6px',
        padding: '3px 8px', font: '12px/1.2 system-ui, Microsoft YaHei, sans-serif',
      });
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    [['stack', '\u5806\u53e0', '\u6309\u5bbd\u9ad8\u6bd4\u7eb5\u5411\u5806\u53e0'], ['grid', '\u5bab\u683c', '\u7b49\u5206\u5bab\u683c'], ['bigLeft', '\u5927\u5de6', '\u4e3b\u753b\u9762\u5728\u5de6'], ['bigRight', '\u5927\u53f3', '\u4e3b\u753b\u9762\u5728\u53f3'], ['free', '\u81ea\u7531', '\u81ea\u7531\u62d6\u52a8 / \u7f29\u653e\u6bcf\u4e2a\u89c6\u9891']].forEach(([key, label, title]) => {
      bar.appendChild(mk(label, title, () => {
        d.free = key === 'free';
        if (key === 'free') {
          syncDockGeometry(d);
        } else {
          applyLayout(d);
        }
      }));
    });
    const fsBtn = mk('\u5168\u5c4f', '\u575e\u7a97\u53e3\u5168\u5c4f / \u9000\u51fa\u5168\u5c4f', () => toggleWindowFullscreen(d));
    d.fsBtn = fsBtn;
    bar.appendChild(fsBtn);
    bar.appendChild(mk('\u5c0f', '\u7a97\u53e3\u7f29\u5230\u5c0f\u5c3a\u5bf8(480p)', () => resizeDock(d, 480, 270)));
    bar.appendChild(mk('\u4e2d', '\u7a97\u53e3\u4e2d\u5c3a\u5bf8(820p)', () => resizeDock(d, 820, 462)));
    bar.appendChild(mk('\u5927', '\u7a97\u53e3\u5927\u5c3a\u5bf8(1180p)', () => resizeDock(d, 1180, 664)));
    bar.appendChild(mk('\uff0b\u653e\u5927', '\u7a97\u53e3\u6309\u6b65\u957f\u653e\u5927', () => stepResize(d, 120)));
    bar.appendChild(mk('\uff0d\u7f29\u5c0f', '\u7a97\u53e3\u6309\u6b65\u957f\u7f29\u5c0f', () => stepResize(d, -120)));
    doc.body.appendChild(bar);
  }

  function stepResize(d, delta) {
    const win = d.win;
    if (!win || !win.resizeTo) return;
    const cw = win.outerWidth || win.innerWidth || 720;
    const nw = Math.max(360, Math.min(cw + delta, (typeof screen !== 'undefined' ? screen.availWidth : 2560) || 1920));
    const nh = Math.round(nw * (9 / 16));
    resizeDock(d, nw, nh);
  }

  /** Auto-tile geometry for the free layout (fractions of the window). */
  function defaultGeo(i, n) {
    if (n <= 1) return { x: 0, y: 0, w: 1, h: 1 };
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const col = i % cols;
    const row = Math.floor(i / cols);
    return { x: col / cols, y: row / rows, w: 1 / cols, h: 1 / rows };
  }

  /** Dock window controls: fullscreen toggle + size presets. */
  function toggleWindowFullscreen(d) {
    const doc = d.doc;
    const win = d.win;
    const isCurrentlyFs = !!(doc && doc.fullscreenElement) || !!d.isMaximized;

    if (isCurrentlyFs) {
      // 退出全屏（还原非全屏）
      if (doc && doc.fullscreenElement) {
        try { if (doc.exitFullscreen) doc.exitFullscreen(); } catch (e) { log('exitFullscreen failed', e); }
      } else if (d.isMaximized) {
        const nb = d.normalBounds;
        try {
          if (win && nb) {
            if (win.moveTo && nb.left != null && nb.top != null) {
              win.moveTo(nb.left, nb.top);
            }
            if (win.resizeTo && nb.width && nb.height) {
              win.resizeTo(nb.width, nb.height);
            }
          }
        } catch (e) {
          log('restore dock size failed', e);
        }
      }
      d.isMaximized = false;
      if (d.fsBtn) {
        d.fsBtn.textContent = '\u5168\u5c4f';
        d.fsBtn.title = '\u575e\u7a97\u53e3\u5168\u5c4f / \u9000\u51fa\u5168\u5c4f';
      }
    } else {
      // 进入全屏（最大化铺满屏幕）
      try {
        if (win) {
          d.normalBounds = {
            left: (typeof win.screenX === 'number' ? win.screenX : win.screenLeft) ?? 100,
            top: (typeof win.screenY === 'number' ? win.screenY : win.screenTop) ?? 100,
            width: win.outerWidth || win.innerWidth || 820,
            height: win.outerHeight || win.innerHeight || 462,
          };
        }
      } catch (e) {}

      let fsTriggered = false;
      try {
        if (doc && doc.documentElement && doc.documentElement.requestFullscreen) {
          const ret = doc.documentElement.requestFullscreen();
          fsTriggered = true;
          if (ret && ret.catch) {
            ret.catch((err) => {
              log('requestFullscreen rejected, fallback to window maximize', err);
              maximizeDockWindow(d);
            });
          }
        }
      } catch (e) {
        log('window requestFullscreen failed', e);
      }

      if (!fsTriggered) {
        maximizeDockWindow(d);
      }
      d.isMaximized = true;
      if (d.fsBtn) {
        d.fsBtn.textContent = '\u8fd8\u539f';
        d.fsBtn.title = '\u9000\u51fa\u5168\u5c4f\uff08\u6062\u590d\u539f\u5c3a\u5bf8\uff09';
      }
    }
  }


  function maximizeDockWindow(d) {
    const win = d.win;
    try {
      const screenObj = (win && win.screen) || (typeof screen !== 'undefined' ? screen : null);
      const sw = (screenObj && (screenObj.availWidth || screenObj.width)) || 1920;
      const sh = (screenObj && (screenObj.availHeight || screenObj.height)) || 1080;
      const sl = (screenObj && screenObj.availLeft !== undefined ? screenObj.availLeft : 0) || 0;
      const st = (screenObj && screenObj.availTop !== undefined ? screenObj.availTop : 0) || 0;
      // 循环微调多次，确保 Chrome 窗口管理器接受最大化尺寸
      if (win && win.moveTo) win.moveTo(sl, st);
      if (win && win.resizeTo) win.resizeTo(sw, sh);
      setTimeout(() => {
        try {
          if (win && win.moveTo) win.moveTo(sl, st);
          if (win && win.resizeTo) win.resizeTo(sw, sh);
        } catch (e) {}
      }, 100);
    } catch (e) {
      log('maximize dock resize failed', e);
    }
  }

  function resizeDock(d, w, h) {
    try {
      d.isMaximized = false;
      if (d.fsBtn) {
        d.fsBtn.textContent = '\u5168\u5c4f';
        d.fsBtn.title = '\u575e\u7a97\u53e3\u5168\u5c4f / \u9000\u51fa\u5168\u5c4f';
      }
      if (d.win && d.win.resizeTo) d.win.resizeTo(w, h);
      log('dock resized to', w, h);
    } catch (e) {
      log('resizeTo failed', e);
    }
  }

  let maxCardZ = 30;
  function bringCardToFront(d, card) {
    if (!card || !card.slot) return;
    d.focused = card;
    maxCardZ += 1;
    card.slot.style.zIndex = String(maxCardZ);
  }

  /** Free-form move/resize: a top drag strip + a top-right resize grip
   *  (active in the free layout; geometry kept as window fractions). */
  function attachCardGeometry(doc, d, card) {
    const strip = doc.createElement('div');
    Object.assign(strip.style, {
      position: 'absolute', left: '0', right: '32px', top: '0', height: '30px',
      cursor: 'grab', opacity: '0.85', transition: 'opacity .2s', zIndex: '99',
      background: 'linear-gradient(to bottom, rgba(0,0,0,.85), rgba(0,0,0,.35) 75%, transparent)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'rgba(255,255,255,.95)', font: '12px/1 system-ui, Microsoft YaHei, sans-serif',
      userSelect: 'none',
      letterSpacing: '0.5px',
      pointerEvents: 'auto',
    });
    strip.textContent = '\u283f \u62d6\u52a8\u79fb\u52a8';
    const grip = doc.createElement('div');
    Object.assign(grip.style, {
      position: 'absolute', right: '0', bottom: '0', width: '32px', height: '32px',
      cursor: 'nwse-resize', opacity: '0.85', transition: 'opacity .2s', zIndex: '100',
      background: 'linear-gradient(135deg, transparent 35%, rgba(255,255,255,.7) 40%, rgba(255,255,255,.7) 60%, transparent 65%)',
      pointerEvents: 'auto',
    });
    grip.title = '\u62d6\u52a8\u7f29\u653e\u6b64\u89c6\u9891';
    card.slot.addEventListener('mouseenter', () => { strip.style.opacity = '1'; grip.style.opacity = '1'; });
    card.slot.addEventListener('mouseleave', () => {
      if (d.draggingCard === card) return;
      strip.style.opacity = '0.85'; grip.style.opacity = '0.85';
    });

    // 点击卡片自动置顶
    card.slot.addEventListener('pointerdown', () => {
      bringCardToFront(d, card);
    });

    // 双击卡片顶部拖动条可在小窗内全屏独占 / 退出全屏
    strip.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (d.fullscreen === card) exitFullscreen(d);
      else enterFullscreen(d, card);
    });

    const begin = (mode) => (ev) => {
      if (!d.free) {
        d.free = true;
        d.layout = 'free';
        applyLayout(d);
      }
      if (ev.preventDefault) ev.preventDefault();
      if (ev.stopPropagation) ev.stopPropagation();
      bringCardToFront(d, card);
      d.draggingCard = card;
      if (mode === 'move') strip.style.cursor = 'grabbing';

      const rect = d.body.getBoundingClientRect ? d.body.getBoundingClientRect() : null;
      const W = (rect && rect.width) || (d.win && d.win.innerWidth) || 800;
      const H = (rect && rect.height) || (d.win && d.win.innerHeight) || 600;
      const geo = card.geo || (card.geo = defaultGeo(d.cards.indexOf(card), d.cards.length));
      const start = { x: geo.x, y: geo.y, w: geo.w, h: geo.h };
      const sx = ev.clientX || 0;
      const sy = ev.clientY || 0;
      const target = ev.target || (mode === 'move' ? strip : grip);
      if (target.setPointerCapture && ev.pointerId != null) {
        try { target.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      }
      const onMove = (e2) => {
        const dx = ((e2.clientX || 0) - sx) / W;
        const dy = ((e2.clientY || 0) - sy) / H;
        card.customGeo = true;
        if (mode === 'move') {
          geo.x = clamp(start.x + dx, 0, Math.max(0, 1 - start.w));
          geo.y = clamp(start.y + dy, 0, Math.max(0, 1 - start.h));
        } else {
          geo.w = clamp(start.w + dx, 0.15, 1 - geo.x);
          geo.h = clamp(start.h + dy, 0.15, 1 - geo.y);
        }
        applyLayout(d);
      };
      const onUp = () => {
        d.draggingCard = null;
        strip.style.cursor = 'grab';
        if (target.removeEventListener) {
          target.removeEventListener('pointermove', onMove);
          target.removeEventListener('pointerup', onUp);
        }
        if (doc.removeEventListener) {
          doc.removeEventListener('pointermove', onMove);
          doc.removeEventListener('pointerup', onUp);
          doc.removeEventListener('pointercancel', onUp);
        }
        if (d.win && d.win.removeEventListener) {
          d.win.removeEventListener('pointermove', onMove);
          d.win.removeEventListener('pointerup', onUp);
        }
        if (target.releasePointerCapture && ev.pointerId != null) {
          try { target.releasePointerCapture(ev.pointerId); } catch (e) {}
        }
      };
      if (target.addEventListener) {
        target.addEventListener('pointermove', onMove);
        target.addEventListener('pointerup', onUp);
      }
      if (doc.addEventListener) {
        doc.addEventListener('pointermove', onMove);
        doc.addEventListener('pointerup', onUp);
        doc.addEventListener('pointercancel', onUp);
      }
      if (d.win && d.win.addEventListener) {
        d.win.addEventListener('pointermove', onMove);
        d.win.addEventListener('pointerup', onUp);
      }
    };
    strip.addEventListener('pointerdown', begin('move'));
    grip.addEventListener('pointerdown', begin('resize'));
    card.slot.appendChild(strip);
    card.slot.appendChild(grip);
    card.geoStrip = strip;
    card.geoGrip = grip;
  }

  function syncDockGeometry(d) {
    const cards = d.cards || [];
    const n = cards.length;
    cards.forEach((c, i) => {
      if (!c.customGeo) {
        c.geo = defaultGeo(i, n);
      }
    });
    applyLayout(d);
  }

  /** Re-arrange the cards for the current layout. */
  function applyLayout(d) {
    const cards = d.cards || [];
    if (d.free) {
      cards.forEach((c, i) => {
        const g = c.geo || (c.geo = defaultGeo(i, cards.length));
        const st = c.slot.style;
        st.position = 'absolute';
        st.flex = 'none';
        st.order = '';
        st.left = (g.x * 100).toFixed(2) + '%';
        st.top = (g.y * 100).toFixed(2) + '%';
        st.width = (g.w * 100).toFixed(2) + '%';
        st.height = (g.h * 100).toFixed(2) + '%';
        st.zIndex = c.slot.style.zIndex || String(3 + i);
      });
      return;
    }
    cards.forEach((c, i) => {
      const st = c.slot.style;
      st.position = 'relative';
      st.left = '';
      st.top = '';
      st.zIndex = '';
      c.slot.style.order = '';
      if (d.layout === 'grid') {
        c.slot.style.flex = '1 1 0';
        c.slot.style.width = cards.length > 2 ? '50%' : '100%';
        c.slot.style.height = cards.length > 2 ? '50%' : '100%';
      } else if (d.layout === 'bigLeft' || d.layout === 'bigRight') {
        c.slot.style.width = '';
        c.slot.style.height = '';
        c.slot.style.flex = i === 0 ? '3 1 0' : '1 1 0';
        if (d.layout === 'bigRight') c.slot.style.order = String(i === 0 ? cards.length : i);
      } else {
        c.slot.style.width = '';
        c.slot.style.height = '';
        let r = 9 / 16;
        if (c.media.videoWidth && c.media.videoHeight) r = c.media.videoHeight / c.media.videoWidth;
        else if (c.meta && c.meta.width && c.meta.height) r = c.meta.height / c.meta.width;
        c.slot.style.flex = r + ' 1 0';
      }
    });
  }

  function addToDock(video, d) {
    const doc = d.doc;
    const home = saveHome(video, { win: d.win });

    const card = buildCard(d, { kind: 'adopt', video });
    home.slot = card.slot;
    d.cards.push(card);

    protectSourceVideo(video);
    playSourceVideo(video);

    d.body.appendChild(card.slot);
    d.list.push(video);
    lastPopped = video;
    insertPlaceholder(video, home);
    syncDockGeometry(d);
    log('added to dock:', (video.currentSrc || '').slice(0, 60));
  }

  /** One dock slot: media element + hover control bar. */
  function buildCard(d, opts) {
    const doc = d.doc;
    const slot = doc.createElement('div');
    slot.setAttribute('data-mslot', '1');
    Object.assign(slot.style, {
      position: 'relative',
      flex: '1 1 0',
      minHeight: '0',
      overflow: 'hidden',
      background: '#000',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    });

    let media;
    if (opts.kind === 'stream') {
      media = doc.createElement('video');
      media.autoplay = true;
      media.muted = true; // audio stays on the source page: no double sound
      media.playsInline = true;
      media.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block;';
      media.srcObject = opts.stream;
    } else {
      media = doc.adoptNode(opts.video);
      media.controls = false; // our custom bar replaces the browser bar
      media.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block;';
    }
    slot.appendChild(media);

    const card = {
      slot,
      media,
      kind: opts.kind,
      video: opts.kind === 'adopt' ? opts.video : null,
      sourceTabId: opts.sourceTabId || null,
      meta: opts.meta || null,
      stream: null,
      wasPlaying: false,
      speedIdx: 2,
    };
    card.ctl = makeController(card);
    const bar = buildControlBar(doc, d, card);
    card.bar = bar;
    slot.appendChild(bar);

    slot.addEventListener('mouseenter', () => { d.focused = card; });

    const sync = () => { if (card.bar && card.bar._sync) card.bar._sync(); };
    media.addEventListener('timeupdate', sync);
    media.addEventListener('play', sync);
    media.addEventListener('pause', sync);
    if (opts.kind === 'stream') {
      media.addEventListener('playing', () => log('stream viewer: playing'));
      media.addEventListener('error', () => log('stream viewer: error:', media.error && media.error.message));
    }
    attachCardGeometry(doc, d, card);
    return card;
  }

  /** Control operations: direct for adopted videos, relayed for streams. */
  function makeController(card) {
    const relay = (op, value) => bgSend({ type: 'mp-dock-ctl', toTab: card.sourceTabId, op, value, id: card.meta && card.meta.id });
    if (card.kind === 'adopt') {
      const v = card.video;
      return {
        toggle: () => { if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); } else v.pause(); },
        seek: (t) => { try { v.currentTime = Math.max(0, t); } catch (e) {} },
        speed: (r) => { v.playbackRate = r; },
        volume: (x) => { v.volume = Math.min(1, Math.max(0, x)); v.muted = x <= 0; },
        paused: () => v.paused,
        time: () => v.currentTime,
        duration: () => v.duration,
      };
    }
    return {
      toggle: () => relay('toggle'),
      seek: (t) => relay('seek', Math.max(0, t)),
      speed: (r) => relay('speed', r),
      volume: (x) => relay('volume', x),
      paused: () => card.media.paused,
      time: () => card.media.currentTime,
      duration: () => (card.meta && card.meta.duration) || card.media.duration || 0,
    };
  }

  /** Per-card control bar: play, seek, time, volume, speed, fullscreen, recall. */
  function buildControlBar(doc, d, card) {
    const ctl = card.ctl;
    const bar = doc.createElement('div');
    Object.assign(bar.style, {
      position: 'absolute', left: '6px', right: '6px', bottom: '6px',
      display: 'flex', alignItems: 'center', gap: '6px',
      padding: '5px 8px', borderRadius: '10px',
      background: 'rgba(0,0,0,.82)', color: '#fff',
      font: '12px/1.2 system-ui, Microsoft YaHei, sans-serif',
      boxShadow: '0 4px 16px rgba(0,0,0,0.7)',
      border: '1px solid rgba(255,255,255,0.18)',
      opacity: '0.88', transition: 'opacity .2s', pointerEvents: 'auto', zIndex: '99',
    });
    bar.addEventListener('mouseenter', () => { bar.style.opacity = '1'; });
    bar.addEventListener('mouseleave', () => { bar.style.opacity = '0.88'; });
    const mk = (text, title, fn, extra) => {
      const b = doc.createElement('button');
      b.textContent = text;
      b.title = title || '';
      Object.assign(b.style, Object.assign({
        cursor: 'pointer', border: '1px solid rgba(255,255,255,.25)',
        background: 'rgba(255,255,255,.08)', color: '#fff', borderRadius: '8px',
        padding: '3px 8px', font: 'inherit', whiteSpace: 'nowrap',
      }, extra || {}));
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };

    const playBtn = mk('\u25b6', '\u64ad\u653e/\u6682\u505c', () => ctl.toggle());
    const seek = doc.createElement('input');
    seek.type = 'range'; seek.min = '0'; seek.max = '1000'; seek.step = '1'; seek.value = '0';
    Object.assign(seek.style, { flex: '1', minWidth: '40px', cursor: 'pointer' });
    const timeLabel = doc.createElement('span');
    Object.assign(timeLabel.style, { fontVariantNumeric: 'tabular-nums', opacity: '.85', whiteSpace: 'nowrap' });
    const vol = doc.createElement('input');
    vol.type = 'range'; vol.min = '0'; vol.max = '1'; vol.step = '0.05'; vol.value = '1';
    Object.assign(vol.style, { width: '52px', cursor: 'pointer' });
    vol.title = '\u97f3\u91cf\uff08\u64ad\u6e90\u9875\u9762\uff09';
    const speedBtn = mk('1x', '\u500d\u901f\uff08\u70b9\u51fb\u5faa\u73af\uff09', () => {
      card.speedIdx = (card.speedIdx + 1) % SPEED_RATES.length;
      const r = SPEED_RATES[card.speedIdx];
      ctl.speed(r);
      speedBtn.textContent = r + 'x';
    });
    const fsBtn = mk('\u26f6', '\u5168\u5c4f\uff08\u5360\u6ee1\u7a97\u53e3\uff09', () => enterFullscreen(d, card));
    const recallBtn = mk('\u00d7', card.kind === 'adopt' ? '\u53ec\u56de\uff08\u653e\u56de\u539f\u9875\u9762\uff09' : '\u5173\u95ed\u5e76\u53ec\u56de\u6e90', () => recallCard(d, card));

    seek.addEventListener('input', () => {
      const dur = ctl.duration();
      if (dur > 0 && isFinite(dur)) ctl.seek((Number(seek.value) / 1000) * dur);
    });
    vol.addEventListener('input', () => ctl.volume(Number(vol.value)));

    const sync = () => {
      const dur = ctl.duration();
      const t = ctl.time();
      playBtn.textContent = ctl.paused() ? '\u25b6' : '\u23f8';
      if (dur > 0 && isFinite(dur)) {
        seek.value = String(Math.round((t / dur) * 1000));
        timeLabel.textContent = fmtTime(t) + ' / ' + fmtTime(dur);
      } else {
        timeLabel.textContent = fmtTime(t);
      }
    };
    bar._sync = sync;

    bar.append(playBtn, seek, timeLabel, vol, speedBtn, fsBtn, recallBtn);
    return bar;
  }

  /** Fullscreen one card inside the dock window; others pause + hide. */
  function enterFullscreen(d, card) {
    if (d.fullscreen) return;
    d.fullscreen = card;
    d.cards.forEach((c) => {
      if (c === card) {
        c.slot.style.position = 'absolute';
        c.slot.style.inset = '0';
        c.slot.style.zIndex = '5';
      } else {
        if (c.kind === 'adopt' && !c.ctl.paused()) {
          c.wasPlaying = true;
          c.video.pause();
        }
        c.slot.style.display = 'none';
      }
    });
  }

  function exitFullscreen(d) {
    if (!d.fullscreen) return;
    const card = d.fullscreen;
    d.fullscreen = null;
    d.cards.forEach((c) => {
      c.slot.style.position = '';
      c.slot.style.inset = '';
      c.slot.style.zIndex = '';
      c.slot.style.display = '';
      if (c.kind === 'adopt' && c.wasPlaying) {
        c.wasPlaying = false;
        const p = c.video.play();
        if (p && p.catch) p.catch(() => {});
      }
    });
  }

  /** Recall one card (adopt -> element back; stream -> close + restore source). */
  function recallCard(d, card) {
    if (card.kind === 'adopt') {
      restoreVideo(card.video);
    } else if (card.kind === 'rtc') {
      try { card.media.srcObject = null; } catch (e) {}
      if (card.remotePc) { try { card.remotePc.close(); } catch (e) {} }
      bgSend({ type: 'mp-dock-recall-card', id: card.connId, toTab: card.sourceTabId });
    } else {
      if (card.kind === 'stream') {
        try { card.media.srcObject = null; } catch (e) {}
        const tracks = card.stream ? card.stream.getTracks() : [];
        tracks.forEach((t) => { try { t.stop(); } catch (e) {} });
      }
      bgSend({ type: 'mp-dock-recall', toTab: card.sourceTabId, id: card.meta && card.meta.id });
    }
    d.cards = d.cards.filter((c) => c !== card);
    if (card.slot.parentNode) card.slot.remove();
    syncDockGeometry(d);
    if (d.cards.length === 0 && dock && dock.win === d.win) {
      dock = null;
      bgSend({ type: 'mp-release' });
      try { d.win.close(); } catch (e) {}
    }
  }

  /** WebRTC card: renders the received live video stream from another tab.
   *  Fully universal across all websites! */
  function addRtcCard(d, remotePc, meta, fromTab, connId) {
    const doc = d.doc;
    const slot = doc.createElement('div');
    slot.setAttribute('data-mslot', '1');
    Object.assign(slot.style, {
      position: 'relative', flex: '1 1 0', minHeight: '0', overflow: 'hidden',
      background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center',
    });

    const media = doc.createElement('video');
    media.autoplay = true;
    media.muted = false; // Audio played with the stream
    media.playsInline = true;
    media.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block;';
    slot.appendChild(media);

    const card = {
      slot,
      media,
      kind: 'rtc',
      video: null,
      sourceTabId: fromTab || null,
      connId,
      remotePc,
      meta: meta || null,
      wasPlaying: false,
      speedIdx: 2,
      lastSync: { currentTime: 0, duration: (meta && meta.duration) || 0, paused: false },
    };

    const relay = (op, value) => bgSend({ type: 'mp-dock-ctl', toTab: card.sourceTabId, op, value, id: connId });

    card.ctl = {
      toggle: () => relay('toggle'),
      seek: (t) => relay('seek', Math.max(0, t)),
      speed: (r) => relay('speed', r),
      volume: (x) => {
        try {
          card.media.volume = Math.min(1, Math.max(0, x));
          card.media.muted = x <= 0;
        } catch (e) {}
        relay('volume', x);
      },
      paused: () => card.lastSync.paused,
      time: () => card.lastSync.currentTime,
      duration: () => card.lastSync.duration || (card.meta && card.meta.duration) || 0,
      fullscreen: () => enterFullscreen(d, card),
    };

    const bar = buildControlBar(doc, d, card);
    card.bar = bar;
    slot.appendChild(bar);

    slot.addEventListener('mouseenter', () => { d.focused = card; });

    attachCardGeometry(doc, d, card);
    d.cards.push(card);
    d.body.appendChild(slot);
    syncDockGeometry(d);
    log('WebRTC card created for dock, connId:', connId);
    return card;
  }

  /** Embed card: an iframe hosting the source site's player (cross-tab merge). */
  function addEmbedCard(d, url, meta, fromTab) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      log('rejected unsafe embed url');
      return null;
    }
    const doc = d.doc;
    const slot = doc.createElement('div');
    slot.setAttribute('data-mslot', '1');
    Object.assign(slot.style, {
      position: 'relative', flex: '1 1 0', minHeight: '0', overflow: 'hidden',
      background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center',
    });

    const frame = doc.createElement('iframe');
    frame.src = url;
    frame.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
    frame.setAttribute('allowfullscreen', '');
    Object.assign(frame.style, { width: '100%', height: '100%', border: '0', background: '#000' });
    slot.appendChild(frame);

    const card = {
      slot,
      media: frame,
      kind: 'embed',
      video: null,
      sourceTabId: fromTab || null,
      meta: meta || null,
      stream: null,
      wasPlaying: false,
      speedIdx: 2,
      ctl: {
        toggle: () => {},
        seek: () => {},
        speed: () => {},
        volume: () => {},
        paused: () => false,
        time: () => 0,
        duration: () => (meta && meta.duration) || 0,
        fullscreen: () => { try { frame.requestFullscreen(); } catch (e) {} },
      },
    };
    const bar = buildEmbedBar(doc, d, card);
    card.bar = bar;
    slot.appendChild(bar);

    let idle = 0;
    const show = () => { bar.style.opacity = '1'; bar.style.pointerEvents = 'auto'; clearTimeout(idle); idle = setTimeout(hide, 2600); };
    const hide = () => { bar.style.opacity = '0'; bar.style.pointerEvents = 'none'; };
    slot.addEventListener('mouseenter', () => { d.focused = card; show(); });
    slot.addEventListener('mouseleave', hide);
    slot.addEventListener('mousemove', show);

    attachCardGeometry(doc, d, card);
    d.cards.push(card);
    d.body.appendChild(slot);
    syncDockGeometry(d);
    log('embed card added:', url.slice(0, 60));
    return card;
  }

  /** Minimal bar for embed cards: title + fullscreen + recall (the inner
   *  player owns its own playback controls). */
  function buildEmbedBar(doc, d, card) {
    const bar = doc.createElement('div');
    Object.assign(bar.style, {
      position: 'absolute', left: '6px', right: '6px', bottom: '6px',
      display: 'flex', alignItems: 'center', gap: '6px',
      padding: '4px 8px', borderRadius: '10px',
      background: 'rgba(0,0,0,.72)', color: '#fff',
      font: '12px/1.2 system-ui, Microsoft YaHei, sans-serif',
      opacity: '0', transition: 'opacity .2s', pointerEvents: 'none', zIndex: '10',
    });
    const mk = makeBarButton;
    const title = doc.createElement('span');
    title.textContent = (card.meta && card.meta.title) || '\u89c6\u9891';
    Object.assign(title.style, { flex: '1', opacity: '.85', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    const fsBtn = mk(doc, '\u5168\u5c4f', 'iframe \u5168\u5c4f', () => { try { card.media.requestFullscreen(); } catch (e) {} });
    const recallBtn = mk(doc, '\u00d7', '\u4ece\u575e\u91cc\u79fb\u9664', () => recallCard(d, card));
    bar.append(title, fsBtn, recallBtn);
    return bar;
  }

  /** Shared small button factory for dock bars. */
  function makeBarButton(doc, text, title, fn) {
    const b = doc.createElement('button');
    b.textContent = text;
    b.title = title || '';
    Object.assign(b.style, {
      cursor: 'pointer', border: '1px solid rgba(255,255,255,.25)',
      background: 'rgba(255,255,255,.08)', color: '#fff', borderRadius: '8px',
      padding: '3px 8px', font: 'inherit', whiteSpace: 'nowrap',
    });
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  }

  function protectSourceVideo(video) {
    if (!video || video._mpProtected) return;
    video._mpProtected = true;
    video._mpAllowPause = false;
    const origPause = video.pause;
    video._mpOrigPause = origPause;
    video.pause = function() {
      if (video._mpAllowPause || (!dockCrossPopped.has(video) && !companionPopped.has(video))) {
        return origPause.apply(this, arguments);
      }
      log('prevented background tab auto-pause on popped video');
    };
  }

  function unprotectSourceVideo(video) {
    if (!video || !video._mpProtected) return;
    video._mpProtected = false;
    if (video._mpOrigPause) {
      video.pause = video._mpOrigPause;
    }
  }

  function playSourceVideo(v) {
    if (!v) return;
    v._mpAllowPause = false;
    const p = v.play();
    if (p && p.catch) {
      p.catch((err) => {
        log('play failed in background tab, retrying with muted bypass:', err);
        const origMuted = v.muted;
        v.muted = true;
        const p2 = v.play();
        if (p2 && p2.catch) p2.catch(() => {});
        setTimeout(() => {
          try { v.muted = origMuted; } catch (e) {}
        }, 500);
      });
    }
  }

  function pauseSourceVideo(v) {
    if (!v) return;
    v._mpAllowPause = true;
    try {
      if (v._mpOrigPause) v._mpOrigPause.call(v);
      else v.pause();
    } catch (e) {}
    v._mpAllowPause = false;
  }

  function hideCrossSourceVideo(video) {
    if (!video || video._mpCrossHidden) return;
    video._mpCrossHidden = true;
    video._mpOrigOpacity = video.style.opacity;
    video._mpOrigMuted = video.muted;

    // 1. 原页面自身静音，杜绝原页面和小窗双重声音
    video.muted = true;

    // 2. 原视频画面透明（保留解码与 captureStream 捕获），避免原页面和小窗双重画面
    video.style.opacity = '0';

    // 3. 原视频位置放置占位提示
    const placeholder = document.createElement('div');
    placeholder.setAttribute('data-mp-cross-ph', '1');
    placeholder.textContent = '\u89c6\u9891\u5df2\u5f39\u51fa\u5230\u7f6e\u9876\u5c0f\u7a97\u64ad\u653e \u00b7 \u70b9\u51fb\u53ec\u56de';
    Object.assign(placeholder.style, {
      position: 'absolute',
      inset: '0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0,0,0,.75)',
      color: '#fff',
      font: '14px/1.5 system-ui, "Microsoft YaHei", sans-serif',
      cursor: 'pointer',
      zIndex: '9999',
      userSelect: 'none',
    });
    placeholder.addEventListener('click', () => {
      if (companionPopped.has(video)) recallCompanion(video);
      else recallCrossDock(video);
    });

    const parent = video.parentNode;
    if (parent) {
      const pPos = (typeof window !== 'undefined' && window.getComputedStyle)
        ? window.getComputedStyle(parent).position
        : parent.style.position;
      if (!pPos || pPos === 'static') {
        parent.style.position = 'relative';
        parent._mpResetPos = true;
      }
      parent.appendChild(placeholder);
    }
    video._mpCrossPh = placeholder;
  }

  function restoreCrossSourceVideo(video) {
    if (!video || !video._mpCrossHidden) return;
    video._mpCrossHidden = false;

    if (video._mpOrigOpacity !== undefined) video.style.opacity = video._mpOrigOpacity;
    else video.style.opacity = '';
    if (video._mpOrigMuted !== undefined) video.muted = video._mpOrigMuted;

    if (video._mpCrossPh) {
      if (typeof video._mpCrossPh.remove === 'function') {
        video._mpCrossPh.remove();
      } else if (video._mpCrossPh.parentNode) {
        video._mpCrossPh.parentNode.removeChild(video._mpCrossPh);
      }
      video._mpCrossPh = null;
    }
    const parent = video.parentNode;
    if (parent && parent._mpResetPos) {
      parent.style.position = '';
      delete parent._mpResetPos;
    }
  }

  /** The dock is owned by another tab: relay this video's stream to it. */
  /** Universal cross-tab video streaming via local WebRTC PeerConnection.
   *  Works across all websites with a <video> element (Bilibili, Tencent, Youku,
   *  iQiyi, YouTube, online courses, live streams, etc.) without needing embed players. */
  async function popOutCrossTabWebRTC(video) {
    if (typeof RTCPeerConnection === 'undefined') {
      log('RTCPeerConnection not supported in this context, falling back to embed');
      popOutEmbed(video);
      return;
    }

    let stream = null;
    try {
      if (typeof video.captureStream === 'function') stream = video.captureStream();
      else if (typeof video.mozCaptureStream === 'function') stream = video.mozCaptureStream();
    } catch (e) {
      log('captureStream error:', e);
    }

    const vTracks = stream && stream.getVideoTracks ? stream.getVideoTracks().length : 0;
    log('cross-tab WebRTC: captured video tracks:', vTracks);

    if (!stream || vTracks === 0) {
      log('captureStream produced no tracks, falling back to embed player');
      popOutEmbed(video);
      return;
    }
    prepareHighQualityStream(stream);

    const connId = nextDockSourceId++;
    const pc = new RTCPeerConnection({ iceServers: [] });
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));

    let dockOwnerId = null;
    const who = await bgSend({ type: 'mp-dock-who' });
    if (who && who.ok && who.ownerTabId != null) {
      dockOwnerId = who.ownerTabId;
    }

    pc.onicecandidate = (e) => {
      if (e.candidate && dockOwnerId != null) {
        const rawCand = typeof e.candidate.toJSON === 'function' ? e.candidate.toJSON() : {
          candidate: e.candidate.candidate,
          sdpMid: e.candidate.sdpMid,
          sdpMLineIndex: e.candidate.sdpMLineIndex,
        };
        expandLoopbackCandidates(rawCand).forEach((cand) => {
          bgSend({
            type: 'mp-rtc-ice',
            toTab: dockOwnerId,
            connId,
            candidate: cand,
          });
        });
      }
    };

    // Keep source video playing so captureStream continues generating frames.
    // Audio is played natively by the source page for pristine quality and zero latency!
    const syncTimer = setInterval(() => {
      if (!rtcConnections.has(connId)) {
        clearInterval(syncTimer);
        return;
      }
      if (dockOwnerId != null) {
        bgSend({
          type: 'mp-dock-meta-sync',
          toTab: dockOwnerId,
          connId,
          currentTime: video.currentTime,
          duration: Number.isFinite(video.duration) ? video.duration : 0,
          paused: video.paused,
          playbackRate: video.playbackRate,
          volume: video.volume,
        });
      }
    }, 400);

    rtcConnections.set(connId, { pc, video, stream, syncTimer, dockOwnerId });
    dockCrossPopped.add(video);
    dockCrossIds.set(video, connId);
    protectSourceVideo(video);
    playSourceVideo(video);
    refreshStates();

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const resp = await bgSend({
        type: 'mp-rtc-offer',
        connId,
        offer: { type: offer.type, sdp: offer.sdp },
        meta: {
          id: connId,
          title: (document.title || '').slice(0, 60),
          width: video.videoWidth || 640,
          height: video.videoHeight || 360,
          duration: Number.isFinite(video.duration) ? video.duration : 0,
        },
      });

      if (!resp || !resp.ok) {
        clearInterval(syncTimer);
        pc.close();
        rtcConnections.delete(connId);
        restoreCrossSourceVideo(video);
        dockCrossPopped.delete(video);
        dockCrossIds.delete(video);
        refreshStates();
        log('mp-rtc-offer send failed, trying embed fallback');
        popOutEmbed(video);
      } else {
        hideCrossSourceVideo(video);
      }
    } catch (err) {
      clearInterval(syncTimer);
      pc.close();
      rtcConnections.delete(connId);
      restoreCrossSourceVideo(video);
      dockCrossPopped.delete(video);
      dockCrossIds.delete(video);
      refreshStates();
      log('WebRTC offer negotiation error:', err);
      popOutEmbed(video);
    }
  }

  /** Close local WebRTC connection and cleanup timers */
  function cleanupRtcSource(connId) {
    const conn = rtcConnections.get(connId);
    if (!conn) return;
    if (conn.syncTimer) clearInterval(conn.syncTimer);
    if (conn.stream && conn.stream.getTracks) {
      conn.stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
    }
    try { conn.pc.close(); } catch (e) {}
    rtcConnections.delete(connId);
    if (conn.video) {
      restoreCrossSourceVideo(conn.video);
      unprotectSourceVideo(conn.video);
      dockCrossPopped.delete(conn.video);
      dockCrossIds.delete(conn.video);
    }
    refreshStates();
  }

  /** Best player URL for embedding: Bilibili/YouTube watch pages become
   *  their embed players; anything else is sent as-is. */
  function bestEmbedUrl(pageUrl, currentTime) {
    const t = Math.floor(currentTime || 0);
    let m = pageUrl.match(/bilibili\.com\/video\/(BV[\w]+)/);
    if (m) return 'https://player.bilibili.com/player.html?bvid=' + m[1] + '&autoplay=1' + (t > 5 ? '&t=' + t : '');
    m = pageUrl.match(/youtube\.com\/watch\?.*?[?&]v=([\w-]+)/) || pageUrl.match(/youtu\.be\/([\w-]+)/);
    if (m) return 'https://www.youtube.com/embed/' + m[1] + '?autoplay=1' + (t > 5 ? '&start=' + t : '');
    return pageUrl; // other sites: the page URL (some may refuse framing)
  }

  /** Cross-tab merge: the dock owner embeds this page's player via iframe
   *  (MediaStream cloning loses video tracks in Chrome, so we relay the
   *  URL instead - a fresh real player, full quality, its own controls). */
  function popOutEmbed(video) {
    const url = bestEmbedUrl(location.href, video.currentTime || 0);
    const id = nextDockSourceId++;
    const wasPlaying = !video.paused;
    dockStreamSources.set(id, { video, wasPlaying });
    dockCrossPopped.add(video);
    dockCrossIds.set(video, id);
    if (wasPlaying) video.pause(); // the dock copy takes over: no double audio
    bgSend({
      type: 'mp-dock-embed',
      url,
      meta: {
        id,
        title: (document.title || '').slice(0, 60),
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
      },
    }).then((resp) => {
      if (!resp || !resp.ok) {
        dockCrossPopped.delete(video);
        dockCrossIds.delete(video);
        dockStreamSources.delete(id);
        if (wasPlaying) { const p = video.play(); if (p && p.catch) p.catch(() => {}); }
        log('cross-tab embed: relay FAILED', resp);
        toast('\u8de8\u6807\u7b7e\u5408\u5e76\u5931\u8d25\uff0c\u6539\u7528\u72ec\u7acb\u7a97\u53e3\u6253\u5f00');
        popOutOwnWindow(video);
        return;
      }
      log('cross-tab embed: relay ok, id =', id);
      refreshStates();
    });
  }

  /** Source tab panel recall: tell the owner to drop that card. */
  function recallCrossDock(video) {
    const id = dockCrossIds.get(video);
    restoreCrossSourceVideo(video);
    dockCrossPopped.delete(video);
    dockCrossIds.delete(video);
    if (id != null) {
      cleanupRtcSource(id);
      bgSend({ type: 'mp-dock-recall-card', id });
    }
    refreshStates();
  }

  function buildOwnWindowPlayer(win, video) {
    const doc = win.document;
    doc.body.style.cssText = 'margin:0;padding:0;overflow:hidden;background:#000;';

    const home = saveHome(video, { win });
    const stage = doc.createElement('div');
    Object.assign(stage.style, {
      position: 'fixed',
      inset: '0',
      background: '#000',
    });

    video.controls = true;
    video.style.cssText =
      'width:100%;height:100%;object-fit:contain;background:#000;display:block;';
    stage.appendChild(doc.adoptNode(video));

    doc.body.appendChild(stage);
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') restoreVideo(video);
    });
    win.addEventListener('pagehide', () => restoreVideo(video, { keepWindow: true }));
    lastPopped = video;
    insertPlaceholder(video, home);
    log('popped to own window:', (video.currentSrc || '').slice(0, 60));
  }

  /** Cycle playback speed of the "active" video: the one in native PiP,
   *  else the last popped one. Returns true when a video was found. */
  function cycleSpeedOfActive() {
    const v = document.pictureInPictureElement || lastPopped;
    if (!v || v.tagName !== 'VIDEO') return false;
    const cur = v.playbackRate || 1;
    let idx = SPEED_RATES.findIndex((r) => Math.abs(r - cur) < 0.01);
    if (idx < 0) idx = SPEED_RATES.indexOf(1);
    v.playbackRate = SPEED_RATES[(idx + 1) % SPEED_RATES.length];
    refreshStates();
    toast('\u500d\u901f ' + v.playbackRate + 'x', 1200);
    return true;
  }

  /* ------------------------------ hover badge ------------------------------ */
  const overlay = document.createElement('div');
  overlay.id = NS + 'overlay';
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    pointerEvents: 'none',
    zIndex: '2147483646',
  });
  (document.documentElement || document.body).appendChild(overlay);

  const badges = new Map();
  let rafId = 0;
  let currentVideo = null;
  let cachedVideos = [];
  let cachedVideosAt = 0;

  function getCachedVideos() {
    const now = Date.now();
    if (now - cachedVideosAt > 1000) {
      cachedVideos = collectVideos();
      cachedVideosAt = now;
    }
    return cachedVideos;
  }

  function ensureBadge(video) {
    let b = badges.get(video);
    if (b) return b;
    b = document.createElement('div');
    b.textContent = '\u72ec\u7acb\u64ad\u653e';
    Object.assign(b.style, {
      position: 'absolute',
      display: 'none',
      pointerEvents: 'auto',
      cursor: 'pointer',
      padding: '4px 10px',
      borderRadius: '8px',
      whiteSpace: 'nowrap',
      background: 'rgba(12,12,20,.78)',
      backdropFilter: 'blur(6px)',
      color: '#fff',
      font: '12px/1.5 system-ui, "Microsoft YaHei", sans-serif',
      border: '1px solid rgba(255,255,255,.2)',
      boxShadow: '0 2px 12px rgba(0,0,0,.35)',
      userSelect: 'none',
      opacity: '0',
      transition: 'opacity .15s ease',
    });
    b.addEventListener('mouseenter', () => {
      b.dataset.hover = '1';
      b.style.background = 'rgba(109,92,255,.92)';
    });
    b.addEventListener('mouseleave', () => {
      b.dataset.hover = '';
      b.style.background = 'rgba(12,12,20,.78)';
      hideBadge(b);
    });
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      hideBadge(b);
      popOut(video);
    });
    overlay.appendChild(b);
    badges.set(video, b);
    return b;
  }

  function showBadge(b) {
    if (b.style.display === 'none') {
      b.style.display = 'block';
      requestAnimationFrame(() => { b.style.opacity = '1'; });
    } else {
      b.style.opacity = '1';
    }
  }

  function hideBadge(b) {
    b.style.opacity = '0';
    b.style.display = 'none';
  }

  function hideAllBadges(except) {
    for (const [v, b] of badges) {
      if (v !== except && b.dataset.hover !== '1') hideBadge(b);
    }
  }

  function isVideoPopped(v) {
    return homes.has(v) || nativePopped.has(v) || companionPopped.has(v) || dockCrossPopped.has(v);
  }

  /** 仅当鼠标真正移入有效视频画面的「右上角小热区」时才返回该视频；
   *  全屏播放、已弹出视频、过小预览缩略图或鼠标在视频中央/进度条区域时一律返回 null */
  function findTopRightCornerVideo(clientX, clientY) {
    if (document.fullscreenElement || document.webkitFullscreenElement) return null;
    const list = getCachedVideos();
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v.isConnected || isVideoPopped(v)) continue;
      const r = v.getBoundingClientRect();
      // 过滤过小的封面动图、表情包或微小预览视频
      if (r.width < 220 || r.height < 130) continue;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      // 右上角热区：距右边缘 128px 以内、距上边缘 54px 以内
      const zoneW = Math.min(128, r.width * 0.35);
      const zoneH = Math.min(54, r.height * 0.3);
      if (
        clientX >= r.right - zoneW &&
        clientX <= r.right &&
        clientY >= r.top &&
        clientY <= r.top + zoneH
      ) {
        return v;
      }
    }
    return null;
  }

  function trackBadges() {
    rafId = 0;
    let anyVisible = false;
    for (const [v, b] of badges) {
      if (b.style.display === 'none') continue;
      if (document.fullscreenElement || isVideoPopped(v)) {
        hideBadge(b);
        continue;
      }
      const r = v.getBoundingClientRect();
      if (
        r.width < 220 || r.height < 130 ||
        r.bottom < 0 || r.top > innerHeight ||
        r.right < 0 || r.left > innerWidth
      ) {
        hideBadge(b);
        continue;
      }
      const bw = b.offsetWidth || 72;
      b.style.left = Math.max(4, Math.round(r.right - bw - 10)) + 'px';
      b.style.top = Math.round(r.top + 10) + 'px';
      anyVisible = true;
    }
    if (anyVisible) rafId = requestAnimationFrame(trackBadges);
  }

  let moveScheduled = false;
  let lastMouseX = -1;
  let lastMouseY = -1;

  document.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    if (moveScheduled) return;
    moveScheduled = true;
    requestAnimationFrame(() => {
      moveScheduled = false;
      // 如果鼠标正悬停在按钮本身上，保持显示
      for (const [v, b] of badges) {
        if (b.dataset.hover === '1') {
          currentVideo = v;
          return;
        }
      }
      const v = findTopRightCornerVideo(lastMouseX, lastMouseY);
      currentVideo = v;
      if (!v) {
        hideAllBadges(null);
        return;
      }
      const b = ensureBadge(v);
      hideAllBadges(v);
      showBadge(b);
      if (!rafId) rafId = requestAnimationFrame(trackBadges);
    });
  }, { passive: true });

  document.addEventListener('mouseleave', () => {
    currentVideo = null;
    hideAllBadges(null);
  });

  /* --------------------------- bottom-right panel --------------------------- */
  // 是否为顶层主页面（iframe / 内嵌小弹窗不显示右下角常驻悬浮按钮，仅保留视频右上角悬停按钮）
  const isTopFrame = (() => {
    try { return window.self === window.top; } catch (e) { return false; }
  })();
  let fabDismissed = false;
  let fabHovered = false;

  const fab = document.createElement('div');
  fab.id = NS + 'fab';
  Object.assign(fab.style, {
    position: 'fixed',
    right: '0px',
    bottom: '20px',
    zIndex: '2147483647',
    display: 'none', // 默认隐藏，仅在顶层页面检测到有效视频时自动显现
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '8px',
    font: '13px/1.5 system-ui, "Microsoft YaHei", sans-serif',
    pointerEvents: 'none',
  });

  const fabPill = document.createElement('div');
  Object.assign(fabPill.style, {
    display: 'inline-flex',
    alignItems: 'center',
    pointerEvents: 'auto',
    borderRadius: '999px 0 0 999px',
    background: 'linear-gradient(135deg,#6d5cff,#3aa0ff)',
    boxShadow: '0 4px 16px rgba(60,60,220,.32)',
    transform: 'translateX(calc(100% - 28px))',
    opacity: '0.45',
    transition: 'transform .24s cubic-bezier(.2,.8,.2,1), opacity .24s ease, box-shadow .24s ease',
    overflow: 'hidden',
    userSelect: 'none',
  });

  const fabBtn = document.createElement('button');
  fabBtn.textContent = '\ud83c\udfac \u591a\u7a97\u64ad\u653e';
  fabBtn.title = '\u5c55\u5f00/\u6536\u8d77\u591a\u7a97\u64ad\u653e\u9762\u677f';
  Object.assign(fabBtn.style, {
    cursor: 'pointer',
    border: 'none',
    padding: '7px 8px 7px 11px',
    color: '#fff',
    fontWeight: '600',
    fontSize: '12.5px',
    fontFamily: 'inherit',
    background: 'transparent',
    whiteSpace: 'nowrap',
  });

  const fabCloseBtn = document.createElement('button');
  fabCloseBtn.textContent = '\u00d7';
  fabCloseBtn.title = '\u9690\u85cf\u6b64\u60ac\u6d6e\u6309\u94ae\uff08\u4ecd\u53ef\u901a\u8fc7\u60ac\u505c\u89c6\u9891\u53f3\u4e0a\u89d2\u300c\u72ec\u7acb\u64ad\u653e\u300d\u6216 Alt+Shift+S \u4f7f\u7528\uff09';
  Object.assign(fabCloseBtn.style, {
    cursor: 'pointer',
    border: 'none',
    borderLeft: '1px solid rgba(255,255,255,.22)',
    padding: '7px 9px 7px 7px',
    color: 'rgba(255,255,255,.85)',
    fontSize: '14px',
    lineHeight: '1',
    fontFamily: 'inherit',
    background: 'transparent',
  });
  fabCloseBtn.addEventListener('mouseenter', () => { fabCloseBtn.style.color = '#fff'; fabCloseBtn.style.background = 'rgba(0,0,0,.15)'; });
  fabCloseBtn.addEventListener('mouseleave', () => { fabCloseBtn.style.color = 'rgba(255,255,255,.85)'; fabCloseBtn.style.background = 'transparent'; });

  fabPill.append(fabBtn, fabCloseBtn);
  fab.appendChild(fabPill);

  const panel = document.createElement('div');
  Object.assign(panel.style, {
    display: 'none',
    pointerEvents: 'auto',
    marginRight: '12px',
    width: '320px',
    maxHeight: '60vh',
    overflow: 'auto',
    background: 'rgba(16,16,24,.96)',
    color: '#eee',
    border: '1px solid rgba(255,255,255,.14)',
    borderRadius: '12px',
    padding: '10px',
    boxShadow: '0 10px 40px rgba(0,0,0,.5)',
  });
  fab.appendChild(panel);
  if (isTopFrame) {
    (document.documentElement || document.body).appendChild(fab);
  }

  function syncFabDockState() {
    const isOpen = panel.style.display !== 'none';
    if (fabHovered || isOpen) {
      fabPill.style.transform = 'translateX(0)';
      fabPill.style.opacity = '1';
      fabPill.style.boxShadow = '0 6px 20px rgba(80,80,255,.45)';
    } else {
      fabPill.style.transform = 'translateX(calc(100% - 28px))';
      fabPill.style.opacity = '0.45';
      fabPill.style.boxShadow = '0 4px 16px rgba(60,60,220,.32)';
    }
  }

  function updateFabVisibility(videoCount) {
    if (!isTopFrame) return;
    if (fabDismissed) {
      fab.style.display = 'none';
      return;
    }
    // 排除面积过小的弹窗窗口（如小登录窗）
    if (window.innerWidth < 300 || window.innerHeight < 200) {
      fab.style.display = 'none';
      return;
    }
    const hasActivePop = Boolean(
      (dock && !dock.win.closed) ||
      nativePopped.size > 0 ||
      companionPopped.size > 0 ||
      dockCrossPopped.size > 0
    );
    const count = typeof videoCount === 'number' ? videoCount : collectVideos().length;
    if (count > 0 || hasActivePop) {
      fab.style.display = 'flex';
      syncFabDockState();
    } else {
      panel.style.display = 'none';
      fab.style.display = 'none';
    }
  }

  fab.addEventListener('mouseenter', () => {
    fabHovered = true;
    syncFabDockState();
  });
  fab.addEventListener('mouseleave', () => {
    fabHovered = false;
    syncFabDockState();
  });

  let panelRows = []; // [{ v, info, btn, recallBtn, speedBtn }]
  let lastCount = -1;

  fabBtn.addEventListener('click', () => {
    const show = panel.style.display === 'none';
    panel.style.display = show ? 'block' : 'none';
    syncFabDockState();
    if (show) renderPanel();
  });

  fabCloseBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    fabDismissed = true;
    panel.style.display = 'none';
    fab.style.display = 'none';
  });

  /* Mode switch: native dock / native video PiP / frameless companion window */
  const MODE_HINT = {
    dock: '\u539f\u751f\u5c0f\u7a97\uff08\u591a\u89c6\u9891\u575e\uff09\uff1a\u540c\u9875\u53ca\u8de8\u6807\u7b7e\u9875\u591a\u4e2a\u89c6\u9891\u5408\u5165\u540c\u4e00\u4e2a\u7f6e\u9876\u7a97\uff0c\u652f\u6301\u4e94\u79cd\u5e03\u5c40\uff08\u542b\u81ea\u7531\u62d6\u62fd\u7f29\u653e\uff09\u4e0e\u72ec\u7acb\u5361\u7247\u63a7\u4ef6\uff08\u8fdb\u5ea6/\u97f3\u91cf/\u500d\u901f/\u5168\u5c4f\uff09',
    native: '\u539f\u751f\u753b\u4e2d\u753b\uff1a\u6d4f\u89c8\u5668\u81ea\u5e26\u7684\u89c6\u9891\u753b\u4e2d\u753b\u7a97\u53e3\uff08\u65e0\u6807\u9898\u680f\u3001\u7eaf\u539f\u751f\u5f62\u6001\uff09\u3002\u500d\u901f\u7528\u9762\u677f\u6309\u94ae\u6216\u5feb\u6377\u952e Alt+Shift+S\u3002\u6ce8\uff1aChrome \u5168\u5c40\u53ea\u5141\u8bb8\u4e00\u4e2a\u753b\u4e2d\u753b\u7a97',
    window: '\u72ec\u7acb\u7a97\u53e3\uff1a\u6bcf\u4e2a\u89c6\u9891\u4e00\u4e2a\u72ec\u7acb\u6d4f\u89c8\u7a97\u53e3\uff08\u4e0d\u7f6e\u9876\u3001\u5e26\u5730\u5740\u680f\u3001\u53ef\u591a\u5f00\uff09',
    companion: '\u65e0\u8fb9\u6846\u539f\u751f\u7a97\uff1a\u771f\u6b63\u7684\u65e0\u8fb9\u6846\u7f6e\u9876\u7a97\uff0c\u652f\u6301\u65e0\u9650\u591a\u5f00\u3001\u591a\u7a97\u4e00\u952e\u5e73\u94fa\u6392\u7248\u3001\u5916\u6302 SRT/VTT \u5b57\u5e55\u4e0e\u957f\u6309\u53f3\u952e 2.5x \u500d\u901f\uff08\u9996\u6b21\u4f7f\u7528\u8bf7\u53cc\u51fb companion/register_host.bat\uff09',
  };
  const SPEED_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

  const modeBar = document.createElement('div');
  Object.assign(modeBar.style, {
    display: 'flex',
    gap: '6px',
    marginBottom: '8px',
  });

  const statusText = document.createElement('span');
  Object.assign(statusText.style, { flex: '1' });
  const newTabBtn = document.createElement('button');
  newTabBtn.textContent = '\u65b0\u6807\u7b7e\u9875\u6253\u5f00';
  newTabBtn.title = '\u5728\u65b0\u6807\u7b7e\u9875\u6253\u5f00\u5f53\u524d\u9875\u9762\uff08\u590d\u5236\u4e00\u4efd\u672c\u9875\uff09';
  Object.assign(newTabBtn.style, {
    cursor: 'pointer',
    border: '1px solid rgba(255,255,255,.25)',
    background: 'rgba(255,255,255,.08)',
    color: '#fff',
    borderRadius: '8px',
    padding: '4px 10px',
    font: 'inherit',
    whiteSpace: 'nowrap',
  });
  newTabBtn.addEventListener('click', () => {
    try { window.open(location.href, '_blank'); } catch (err) { toast('\u6253\u5f00\u65b0\u6807\u7b7e\u9875\u5931\u8d25'); }
  });
  const statusRow = document.createElement('div');
  Object.assign(statusRow.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    margin: '0 4px 8px',
    fontSize: '12px',
    opacity: '.9',
  });
  statusRow.append(statusText, newTabBtn);

  // ------------------------- 无边框原生窗智能多窗自动平铺布局 -------------------------
  const companionLayoutBar = document.createElement('div');
  Object.assign(companionLayoutBar.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    margin: '0 4px 8px',
    padding: '6px',
    background: 'rgba(255,255,255,0.06)',
    borderRadius: '8px',
  });

  const layoutLabel = document.createElement('span');
  layoutLabel.textContent = '多窗排版:';
  Object.assign(layoutLabel.style, { fontSize: '12px', opacity: '.8', whiteSpace: 'nowrap' });
  companionLayoutBar.appendChild(layoutLabel);

  async function applyCompanionLayout(mode) {
    // 跨标签页全局获取所有已打开的无边框伴侣窗口 ID
    const listResp = await bgSend({ type: 'mp-companion-list' });
    let ids = listResp && listResp.ok && Array.isArray(listResp.ids) ? listResp.ids : [];
    // 若后台列表为空，退回使用本地记录的窗口 ID
    if (!ids.length) {
      ids = Array.from(companionPopped.values());
    }
    const count = ids.length;
    if (count === 0) {
      toast('当前没有打开的无边框原生窗');
      return;
    }

    const screenW = window.screen.availWidth || window.innerWidth || 1920;
    const screenH = window.screen.availHeight || window.innerHeight || 1040;
    const windows = [];

    if (mode === 'grid') {
      // 智能均分平铺（2开 1x2，3开 1x3，4开 2x2，5-6开 3x2，7-9开 3x3）
      let cols = 1;
      let rows = 1;
      if (count === 2) { cols = 2; rows = 1; }
      else if (count === 3) { cols = 3; rows = 1; }
      else if (count === 4) { cols = 2; rows = 2; }
      else if (count <= 6) { cols = 3; rows = 2; }
      else { cols = 3; rows = Math.ceil(count / 3); }

      const w = Math.floor(screenW / cols);
      const h = Math.floor(screenH / rows);
      ids.forEach((id, i) => {
        const r = Math.floor(i / cols);
        const c = i % cols;
        windows.push({ id, x: c * w, y: r * h, width: w, height: h });
      });
    } else if (mode === 'split_v') {
      // 左右垂直平分（并排等宽无缝排列）
      const w = Math.floor(screenW / count);
      ids.forEach((id, i) => {
        windows.push({ id, x: i * w, y: 0, width: w, height: screenH });
      });
    } else if (mode === 'split_h') {
      // 上下水平平分
      const h = Math.floor(screenH / count);
      ids.forEach((id, i) => {
        windows.push({ id, x: 0, y: i * h, width: screenW, height: h });
      });
    } else if (mode === 'top2_bot1') {
      // 经典三开：上面 2 个平分，下面 1 个独占主屏
      if (count === 1) {
        windows.push({ id: ids[0], x: 0, y: 0, width: screenW, height: screenH });
      } else if (count === 2) {
        const topH = Math.floor(screenH * 0.5);
        windows.push({ id: ids[0], x: 0, y: 0, width: screenW, height: topH });
        windows.push({ id: ids[1], x: 0, y: topH, width: screenW, height: screenH - topH });
      } else {
        const topCount = count - 1;
        const topH = Math.floor(screenH * 0.5);
        const botH = screenH - topH;
        const topW = Math.floor(screenW / topCount);
        for (let i = 0; i < topCount; i++) {
          windows.push({ id: ids[i], x: i * topW, y: 0, width: topW, height: topH });
        }
        windows.push({ id: ids[count - 1], x: 0, y: topH, width: screenW, height: botH });
      }
    } else if (mode === 'left1_right2') {
      // 演播室模式：左侧主视频大屏展示，右侧副视频上下排列
      if (count === 1) {
        windows.push({ id: ids[0], x: 0, y: 0, width: screenW, height: screenH });
      } else {
        const mainW = Math.floor(screenW * 0.55);
        const sideW = screenW - mainW;
        windows.push({ id: ids[0], x: 0, y: 0, width: mainW, height: screenH });
        const sideCount = count - 1;
        const sideH = Math.floor(screenH / sideCount);
        for (let i = 1; i < count; i++) {
          windows.push({ id: ids[i], x: mainW, y: (i - 1) * sideH, width: sideW, height: sideH });
        }
      }
    }

    bgSend({ type: 'mp-companion-layout', windows }).then((r) => {
      log('companion layout sent to', windows.length, 'windows, resp:', r);
    });
    toast('已完成 ' + count + ' 窗自动排版！');
  }

  [
    ['均分平铺', 'grid', '将当前所有无边框窗按网格平分整个屏幕（如 2x2 四开、3x2 六开）'],
    ['左右对分', 'split_v', '左右等宽平分屏幕'],
    ['上分下独', 'top2_bot1', '上方多视频平分，下方视频独占大屏'],
    ['左大右辅', 'left1_right2', '左侧主视频大屏展示，右侧副视频排列'],
  ].forEach(([txt, mode, tip]) => {
    const btn = document.createElement('button');
    btn.textContent = txt;
    btn.title = tip;
    Object.assign(btn.style, {
      flex: '1',
      cursor: 'pointer',
      border: '1px solid rgba(255,255,255,.2)',
      background: 'rgba(255,255,255,.1)',
      color: '#fff',
      borderRadius: '6px',
      padding: '4px 6px',
      fontSize: '11px',
      whiteSpace: 'nowrap',
    });
    btn.onmouseover = () => btn.style.background = 'rgba(255,255,255,.25)';
    btn.onmouseout = () => btn.style.background = 'rgba(255,255,255,.1)';
    btn.onclick = () => applyCompanionLayout(mode);
    companionLayoutBar.appendChild(btn);
  });

  function renderModeBar() {
    modeBar.textContent = '';
    const cur = modeStore.get();
    [['dock', '\u539f\u751f\u5c0f\u7a97'], ['native', '\u539f\u751f\u753b\u4e2d\u753b'], ['companion', '\u65e0\u8fb9\u6846\u7a97']].forEach(([key, label]) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = MODE_HINT[key];
      Object.assign(b.style, {
        flex: '1',
        cursor: 'pointer',
        border: 'none',
        borderRadius: '8px',
        padding: '6px 0',
        font: 'inherit',
        color: '#fff',
        background:
          cur === key
            ? 'linear-gradient(135deg,#6d5cff,#3aa0ff)'
            : 'rgba(255,255,255,.12)',
      });
      b.addEventListener('click', () => {
        modeStore.set(key);
        renderModeBar();
        toast(MODE_HINT[key], 3600);
      });
      modeBar.appendChild(b);
    });
  }

  function renderPanel() {
    panelRows = [];
    panel.textContent = '';
    panel.appendChild(modeBar);
    renderModeBar();
    panel.appendChild(statusRow);
    panel.appendChild(companionLayoutBar);

    const head = document.createElement('div');
    head.textContent = '\u672c\u9875\u68c0\u6d4b\u5230\u7684\u89c6\u9891\uff08\u70b9\u51fb\u6761\u76ee\u5b9a\u4f4d\uff0c\u70b9\u51fb\u300c\u5f39\u51fa\u300d\u64ad\u653e\uff09';
    Object.assign(head.style, {
      opacity: '.75',
      margin: '2px 4px 8px',
      fontSize: '12px',
    });
    panel.appendChild(head);

    const videos = collectVideos();
    lastCount = videos.length;

    if (!videos.length) {
      const empty = document.createElement('div');
      empty.textContent = '\u672c\u9875\u8fd8\u6ca1\u68c0\u6d4b\u5230 <video> \u5143\u7d20\uff1b\u64ad\u653e\u89c6\u9891\u540e\u56de\u6765\u770b\u770b\u3002';
      Object.assign(empty.style, { padding: '8px 4px', opacity: '.8' });
      panel.appendChild(empty);
      return;
    }

    videos.forEach((v, i) => {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 4px',
        borderTop: '1px solid rgba(255,255,255,.08)',
      });

      const info = document.createElement('div');
      Object.assign(info.style, {
        flex: '1',
        fontSize: '12px',
        opacity: '.9',
        wordBreak: 'break-all',
        cursor: 'pointer',
      });
      info.title = '\u70b9\u51fb\u5b9a\u4f4d\u5230\u89c6\u9891';
      info.addEventListener('click', () => {
        v.scrollIntoView({ block: 'center', behavior: 'smooth' });
        v.style.outline = '2px solid #6d5cff';
        setTimeout(() => { v.style.outline = ''; }, 1500);
      });

      const btn = document.createElement('button');
      Object.assign(btn.style, {
        cursor: 'pointer',
        border: 'none',
        borderRadius: '8px',
        padding: '5px 12px',
        font: 'inherit',
        color: '#fff',
        whiteSpace: 'nowrap',
      });
      btn.addEventListener('click', () => popOut(v));

      const mkMiniBtn = (text) => {
        const b = document.createElement('button');
        b.textContent = text;
        Object.assign(b.style, {
          display: 'none',
          cursor: 'pointer',
          border: '1px solid rgba(255,255,255,.25)',
          background: 'rgba(255,255,255,.08)',
          color: '#fff',
          borderRadius: '8px',
          padding: '4px 10px',
          font: 'inherit',
          whiteSpace: 'nowrap',
        });
        return b;
      };
      const recallBtn = mkMiniBtn('\u53ec\u56de');
      recallBtn.title = homes.has(v)
        ? '\u628a\u89c6\u9891\u653e\u56de\u539f\u9875\u9762'
        : nativePopped.has(v)
          ? '\u9000\u51fa\u7cfb\u7edf\u753b\u4e2d\u753b'
          : dockCrossPopped.has(v)
            ? '\u4ece\u575e\u91cc\u79fb\u9664'
            : '\u5173\u95ed\u65e0\u8fb9\u6846\u7a97';
      recallBtn.addEventListener('click', () => {
        if (homes.has(v)) restoreVideo(v);
        else if (nativePopped.has(v)) recallNative(v);
        else if (dockCrossPopped.has(v)) recallCrossDock(v);
        else recallCompanion(v);
        refreshStates();
      });
      const speedBtn = mkMiniBtn('\u500d\u901f');
      speedBtn.title = '\u5faa\u73af\u5207\u6362\u500d\u901f 0.5/0.75/1/1.25/1.5/2\uff08\u7a97\u53e3\u5185\u4e5f\u53ef\u7528\u539f\u751f\u300c...\u300d\u83dc\u5355\u8c03\u500d\u901f\uff09';
      speedBtn.addEventListener('click', () => {
        const cur = v.playbackRate || 1;
        let idx = SPEED_RATES.findIndex((r) => Math.abs(r - cur) < 0.01);
        if (idx < 0) idx = SPEED_RATES.indexOf(1);
        v.playbackRate = SPEED_RATES[(idx + 1) % SPEED_RATES.length];
        refreshStates();
      });

      row.append(info, btn, recallBtn, speedBtn);
      panel.appendChild(row);
      panelRows.push({ v, info, btn, recallBtn, speedBtn });
    });

    refreshStates();
  }

  function refreshStates() {
    const open = !!(dock && !dock.win.closed);
    statusText.textContent = open
      ? '\u7f6e\u9876\u7a97\uff1a' + (dock.cards ? dock.cards.length : dock.list.length) + ' \u4e2a\u89c6\u9891'
      : nativePopped.size
        ? '\u7cfb\u7edf\u753b\u4e2d\u753b\uff1a' + nativePopped.size + ' \u4e2a\u89c6\u9891'
        : companionPopped.size
          ? '\u65e0\u8fb9\u6846\u7a97\uff1a' + companionPopped.size + ' \u4e2a\u89c6\u9891'
          : '\u672a\u5f00\u542f';
    if (companionLayoutBar) {
      companionLayoutBar.style.display = 'flex';
    }
    panelRows.forEach(({ v, info, btn, recallBtn, speedBtn }, i) => {
      const size = v.videoWidth ? `${v.videoWidth}x${v.videoHeight}` : '\u5c3a\u5bf8\u672a\u77e5';
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? fmtTime(v.duration) : '\u65f6\u957f\u672a\u77e5';
      const popped = homes.has(v) || nativePopped.has(v) || companionPopped.has(v) || dockCrossPopped.has(v);
      info.textContent = `#${i + 1} \u00b7 ${size} \u00b7 ${dur}${popped ? ' \u00b7 \u5df2\u5f39\u51fa' : ''}`;
      btn.textContent = popped ? '\u5df2\u5f39\u51fa' : '\u5f39\u51fa';
      btn.disabled = popped;
      btn.style.background = popped
        ? 'rgba(255,255,255,.15)'
        : 'linear-gradient(135deg,#6d5cff,#3aa0ff)';
      btn.style.cursor = popped ? 'default' : 'pointer';
      if (recallBtn) recallBtn.style.display = popped ? '' : 'none';
      if (speedBtn) {
        speedBtn.style.display = popped ? '' : 'none';
        speedBtn.textContent = (v.playbackRate || 1) + '\u00d7';
      }
    });
  }

  // 定时检测当前页面是否有有效视频，控制边缘悬浮球显隐，并在面板展开时自动刷新状态
  updateFabVisibility();
  setInterval(() => {
    const n = collectVideos().length;
    updateFabVisibility(n);
    if (panel.style.display === 'none') return;
    if (n !== lastCount) renderPanel();
    else refreshStates();
  }, 1200);

  // Speed shortcut from the service worker (Alt+Shift+S)
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'mp-cycle-speed') {
        sendResponse({ ok: cycleSpeedOfActive() });
        return true;
      }
      // WebRTC Dock Owner: receive offer from source tab
      if (msg && msg.type === 'mp-rtc-offer') {
        if (dock && !dock.win.closed && typeof RTCPeerConnection !== 'undefined') {
          const fromTab = msg.fromTab;
          const connId = msg.connId;
          const remotePc = new RTCPeerConnection({ iceServers: [] });
          const card = addRtcCard(dock, remotePc, msg.meta, fromTab, connId);

          remotePc.ontrack = (event) => {
            log('dock owner: WebRTC track received:', event.track ? event.track.kind : 'unknown');
            if (event.streams && event.streams[0]) {
              card.media.srcObject = event.streams[0];
            } else if (event.track) {
              if (!card.media.srcObject) {
                card.media.srcObject = new MediaStream([event.track]);
              } else {
                try { card.media.srcObject.addTrack(event.track); } catch (e) {}
              }
            }
            if (typeof card.media.play === 'function') {
              const p = card.media.play();
              if (p && p.catch) p.catch((err) => log('card media play caught:', err));
            }
          };

          remotePc.onicecandidate = (event) => {
            if (event.candidate && fromTab != null) {
              const rawCand = typeof event.candidate.toJSON === 'function' ? event.candidate.toJSON() : {
                candidate: event.candidate.candidate,
                sdpMid: event.candidate.sdpMid,
                sdpMLineIndex: event.candidate.sdpMLineIndex,
              };
              expandLoopbackCandidates(rawCand).forEach((cand) => {
                bgSend({
                  type: 'mp-rtc-ice',
                  toTab: fromTab,
                  connId,
                  candidate: cand,
                });
              });
            }
          };

          remotePc.setRemoteDescription(new RTCSessionDescription(msg.offer)).then(async () => {
            const answer = await remotePc.createAnswer();
            await remotePc.setLocalDescription(answer);
            bgSend({
              type: 'mp-rtc-answer',
              toTab: fromTab,
              connId,
              answer: { type: answer.type, sdp: answer.sdp },
            });
            refreshStates();
          }).catch((err) => {
            log('dock owner: failed to negotiate offer:', err);
          });
        }
      }

      // WebRTC Source Tab: receive answer from dock owner
      if (msg && msg.type === 'mp-rtc-answer') {
        const conn = rtcConnections.get(msg.connId);
        if (conn && conn.pc && msg.answer) {
          const hqAnswer = {
            type: msg.answer.type,
            sdp: boostWebRtcVideoSdp(msg.answer.sdp),
          };
          conn.pc.setRemoteDescription(new RTCSessionDescription(hqAnswer)).then(() => {
            applyHighQualityRtcSenders(conn.pc);
            log('WebRTC HQ connection established between tabs for connId:', msg.connId);
          }).catch((err) => {
            log('setRemoteDescription on answer failed:', err);
          });
        }
      }

      // WebRTC: receive ICE candidate
      if (msg && msg.type === 'mp-rtc-ice') {
        expandLoopbackCandidates(msg.candidate).forEach((candObj) => {
          const candidate = new RTCIceCandidate(candObj);
          // Check if dock owner card
          if (dock && dock.cards) {
            const card = dock.cards.find((c) =>
              (msg.fromTab != null ? c.sourceTabId === msg.fromTab : true) &&
              (c.connId === msg.connId || (c.meta && c.meta.id === msg.connId))
            );
            if (card && card.remotePc) {
              card.remotePc.addIceCandidate(candidate).catch(() => {});
            }
          }
          // Check if source tab
          const conn = rtcConnections.get(msg.connId);
          if (conn && conn.pc) {
            conn.pc.addIceCandidate(candidate).catch(() => {});
          }
        });
      }

      // Dock Owner: receive playback state sync from source tab
      if (msg && msg.type === 'mp-dock-meta-sync') {
        if (dock && dock.cards) {
          const card = dock.cards.find((c) =>
            (msg.fromTab != null ? c.sourceTabId === msg.fromTab : true) &&
            (c.connId === msg.connId || (c.meta && c.meta.id === msg.connId))
          );
          if (card) {
            card.lastSync = {
              currentTime: Number(msg.currentTime) || 0,
              duration: Number(msg.duration) || 0,
              paused: Boolean(msg.paused),
              playbackRate: Number(msg.playbackRate) || 1,
              volume: Number(msg.volume) || 1,
            };
            if (card.bar && card.bar._sync) card.bar._sync();
          }
        }
      }

      if (msg && msg.type === 'mp-dock-add-embed') {
        log('dock owner: received embed url:', (msg.url || '').slice(0, 60));
        if (dock && !dock.win.closed && msg.url) {
          addEmbedCard(dock, msg.url, msg.meta, msg.fromTab);
          refreshStates();
        } else {
          log('dock owner: no open dock here, embed dropped');
        }
      }
      if (msg && msg.type === 'mp-dock-recall-card') {
        if (dock) {
          const card = (dock.cards || []).find((c) => (c.meta && c.meta.id === msg.id) || c.connId === msg.id);
          if (card) recallCard(dock, card);
        }
        // If this tab was the source of that card, clean it up
        if (msg.id != null) {
          cleanupRtcSource(msg.id);
        }
      }
      if (msg && msg.type === 'mp-dock-ctl') {
        let v = null;
        const rtc = msg.id != null ? rtcConnections.get(msg.id) : null;
        if (rtc && rtc.video) v = rtc.video;
        else {
          const entry = msg.id != null ? dockStreamSources.get(msg.id) : null;
          if (entry) v = entry.video;
        }
        if (v) {
          if (msg.op === 'toggle') {
            if (v.paused) playSourceVideo(v);
            else pauseSourceVideo(v);
          }
          else if (msg.op === 'seek') {
            try { v.currentTime = Number(msg.value) || 0; } catch (e) {}
            if (!v.paused) playSourceVideo(v);
          }
          else if (msg.op === 'speed') { v.playbackRate = Number(msg.value) || 1; }
          else if (msg.op === 'volume') { const x = Number(msg.value); if (!isNaN(x)) { v.volume = Math.min(1, Math.max(0, x)); v.muted = x <= 0; } }
        }
      }
      if (msg && msg.type === 'mp-dock-recall') {
        const entry = msg.id != null ? dockStreamSources.get(msg.id) : null;
        if (entry) {
          if (entry.wasPlaying) { const p = entry.video.play(); if (p && p.catch) p.catch(() => {}); }
          dockStreamSources.delete(msg.id);
        }
      }
      if (msg && msg.type === 'mp-companion-signal-recv') {
        const conn = companionConnections.get(msg.id);
        const data = msg.data;
        if (!conn || !data) return;
        if (data.cmd === 'rtc-answer') {
          conn.answerReceived = true;
          if (conn.retryTimer) {
            clearInterval(conn.retryTimer);
            conn.retryTimer = null;
          }
          if (conn.pc.signalingState === 'have-local-offer' && data.answer) {
            const hqAnswer = {
              type: data.answer.type,
              sdp: boostWebRtcVideoSdp(data.answer.sdp),
            };
            conn.pc.setRemoteDescription(new RTCSessionDescription(hqAnswer)).then(() => {
              applyHighQualityRtcSenders(conn.pc);
              if (conn.iceCandidates && conn.iceCandidates.length) {
                conn.iceCandidates.forEach((cand) => {
                  bgSend({
                    type: 'mp-companion-signal',
                    id: msg.id,
                    data: { cmd: 'rtc-ice', candidate: cand }
                  });
                });
              }
            }).catch((e) => {
              log('companion setRemoteDescription error:', e);
            });
          }
        } else if (data.cmd === 'rtc-ice') {
          expandLoopbackCandidates(data.candidate).forEach((cand) => {
            conn.pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
          });
        } else if (data.cmd === 'ctl') {
          const v = conn.video;
          if (v) {
            if (data.op === 'toggle-play') {
              if (v.paused) playSourceVideo(v);
              else pauseSourceVideo(v);
            } else if (data.op === 'seek') {
              try { v.currentTime = Number(data.value) || 0; } catch (e) {}
              if (!v.paused) playSourceVideo(v);
            } else if (data.op === 'step-seek') {
              try {
                const target = Math.max(0, Math.min(v.duration || 0, v.currentTime + (Number(data.delta) || 0)));
                v.currentTime = target;
              } catch (e) {}
              if (!v.paused) playSourceVideo(v);
            } else if (data.op === 'speed') {
              try { v.playbackRate = Number(data.value) || 1; } catch (e) {}
            } else if (data.op === 'cycle-speed') {
              const rates = [0.5, 0.75, 1, 1.25, 1.5, 2];
              const cur = v.playbackRate || 1;
              const idx = rates.findIndex((r) => Math.abs(r - cur) < 0.05);
              const next = idx < 0 ? 1 : rates[(idx + 1) % rates.length];
              v.playbackRate = next;
            }
          }
        }
      }

      if (msg && msg.type === 'mp-companion-closed') {
        for (const [v, id] of companionPopped) {
          if (id === msg.id) {
            companionPopped.delete(v);
            restoreCrossSourceVideo(v);
            unprotectSourceVideo(v);
            const conn = companionConnections.get(id);
            if (conn) {
              if (conn.syncTimer) clearInterval(conn.syncTimer);
              if (conn.retryTimer) clearInterval(conn.retryTimer);
              if (conn.stream && conn.stream.getTracks) {
                conn.stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
              }
              try { conn.pc.close(); } catch (e) {}
              companionConnections.delete(id);
            }
          }
        }
        refreshStates();
      }
    });
  }
})();
