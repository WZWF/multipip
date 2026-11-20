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

  /* ------------- Phase 0: WebRTC performance telemetry (diagnostics) -------------
   * 只读诊断：关闭时零开销（不建定时器、不调 getStats）。
   *
   * 打开（任选其一）：
   *   1) 视频页面的 DevTools 控制台执行 localStorage.setItem('__multipip__:stats','1') 后刷新页面；
   *   2) 把 DevTools 控制台上下文切到 content script，执行 mpStats.on()。
   * 关闭：localStorage.removeItem('__multipip__:stats') 后刷新，或 mpStats.off()。
   * 汇总：mpStats.report()        导出可粘贴到表格的 CSV：mpStats.csv()
   * --------------------------------------------------------------------------- */
  const mpStats = (() => {
    const KEY = NS + ':stats';
    const INTERVAL = 2000;
    const MAX_SAMPLES = 400;
    const watched = new Map();
    let enabled = false;
    let pulse = null;
    try { enabled = localStorage.getItem(KEY) === '1'; } catch (e) {}

    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const r1 = (v) => Math.round(v * 10) / 10;
    const r2 = (v) => Math.round(v * 100) / 100;

    function mediaQuality(media) {
      const out = { w: 0, h: 0, frames: 0, drop: 0, paused: true };
      if (!media) return out;
      try {
        out.w = n(media.videoWidth);
        out.h = n(media.videoHeight);
        out.paused = !!media.paused;
        const q = media.getVideoPlaybackQuality ? media.getVideoPlaybackQuality() : null;
        if (q) { out.frames = n(q.totalVideoFrames); out.drop = n(q.droppedVideoFrames); }
      } catch (e) {}
      if (!out.frames && media.webkitDecodedFrameCount) out.frames = n(media.webkitDecodedFrameCount);
      return out;
    }

    function pickRtp(reports, dir) {
      const type = dir === 'in' ? 'inbound-rtp' : 'outbound-rtp';
      let best = null;
      reports.forEach((r) => {
        if (!r || r.type !== type) return;
        if (r.kind !== 'video' && r.mediaType !== 'video') return;
        if (!best) best = r;
      });
      return best;
    }

    /** 当前 sender 的有效参数，用来确认「改了参数到底生效没有」 */
    function senderParams(pc) {
      try {
        const sender = (pc.getSenders() || []).find((s) => s.track && s.track.kind === 'video');
        if (!sender || typeof sender.getParameters !== 'function') return '';
        const p = sender.getParameters() || {};
        const e = (p.encodings && p.encodings[0]) || {};
        const parts = [];
        if (e.scaleResolutionDownBy != null) parts.push('down=' + r2(e.scaleResolutionDownBy));
        if (e.maxBitrate != null) parts.push('cap=' + Math.round(e.maxBitrate / 1000) + 'k');
        if (e.maxFramerate != null) parts.push('fps<' + e.maxFramerate);
        if (p.degradationPreference) parts.push(String(p.degradationPreference).replace('maintain-', ''));
        const codecs = (p.codecs || []).map((c) => String(c.mimeType || '').replace('video/', '')).filter(Boolean);
        if (codecs.length) parts.push(codecs.join('+'));
        return parts.join(' ');
      } catch (e) { return ''; }
    }

    function startPulse() {
      if (pulse || !enabled) return;
      pulse = setInterval(() => { watched.forEach((_, key) => take(key)); }, INTERVAL);
    }
    function stopPulseIfIdle() {
      if (!pulse || watched.size) return;
      clearInterval(pulse);
      pulse = null;
    }

    function take(key) {
      const entry = watched.get(key);
      if (!entry) return;
      const { pc, media, dir } = entry;
      if (!pc || pc.connectionState === 'closed') { unwatch(key); return; }
      pc.getStats().then((reports) => {
        const rtp = pickRtp(reports, dir);
        if (!rtp) return;
        const now = performance.now();
        const prev = entry.prev;
        const dt = prev ? (now - prev.t) / 1000 : 0;
        const mq = mediaQuality(media);
        const bytes = dir === 'in' ? n(rtp.bytesReceived) : n(rtp.bytesSent);
        const frames = dir === 'in' ? n(rtp.framesDecoded) : n(rtp.framesEncoded);
        const spent = dir === 'in' ? n(rtp.totalDecodeTime) : n(rtp.totalEncodeTime);
        const qpSum = n(rtp.qpSum);
        let codec = '';
        try {
          const c = rtp.codecId ? reports.get(rtp.codecId) : null;
          if (c && c.mimeType) codec = String(c.mimeType).replace('video/', '');
        } catch (e) {}
        const s = {
          t: new Date().toISOString().slice(11, 19),
          key, dir,
          w: n(rtp.frameWidth), h: n(rtp.frameHeight),
          fps: 0, kbps: 0, msPerFrame: 0, qp: 0,
          enc: rtp.encoderImplementation || rtp.decoderImplementation || '',
          codec,
          limit: rtp.qualityLimitationReason || '',
          srcW: mq.w, srcH: mq.h, srcFps: 0, srcDrop: 0, paused: mq.paused,
          hidden: (typeof document !== 'undefined' && document.visibilityState !== 'visible') ? 1 : 0,
          jitterMs: dir === 'in' ? r2(n(rtp.jitter) * 1000) : 0,
          params: senderParams(pc),
        };
        if (prev && dt > 0.2) {
          const dFrames = frames - prev.frames;
          const dBytes = bytes - prev.bytes;
          const dSpent = spent - prev.spent;
          s.fps = r1(dFrames / dt);
          s.kbps = Math.round((dBytes * 8) / dt / 1000);
          s.msPerFrame = dFrames > 0 ? r2((dSpent / dFrames) * 1000) : 0;
          s.qp = dFrames > 0 ? Math.round((qpSum - prev.qpSum) / dFrames) : 0;
          s.srcFps = r1((mq.frames - prev.srcFrames) / dt);
          s.srcDrop = mq.drop - prev.srcDrop;
        }
        entry.prev = { t: now, bytes, frames, spent, qpSum, srcFrames: mq.frames, srcDrop: mq.drop };
        entry.samples.push(s);
        if (entry.samples.length > MAX_SAMPLES) entry.samples.shift();
        if (prev && dt > 0.2) {
          const tag = s.dir === 'in' ? 'IN ' : 'OUT';
          log(
            '[mp-stats]', key, tag,
            s.w + 'x' + s.h + '@' + s.fps,
            '| src', s.srcW + 'x' + s.srcH + '@' + s.srcFps,
            '| ' + s.kbps + 'kbps',
            '| ' + s.msPerFrame + 'ms/f',
            s.qp ? '| qp=' + s.qp : '',
            s.codec ? '| codec=' + s.codec : '',
            s.enc ? '| ' + s.enc : '',
            s.limit ? '| limit=' + s.limit : '',
            s.srcDrop ? '| srcDrop=' + s.srcDrop : '',
            s.paused ? '| SRC-PAUSED' : '',
            s.hidden ? '| TAB-HIDDEN' : '',
            s.params ? '| ' + s.params : ''
          );
        }
      }).catch(() => {});
    }

    function watch(key, pc, media, dir) {
      if (!enabled || !pc) return;
      if (watched.has(key)) unwatch(key);
      watched.set(key, { pc, media, dir: dir || 'out', prev: null, samples: [] });
      log('[mp-stats] start watching', key, dir || 'out');
      startPulse();
    }

    function unwatch(key) {
      watched.delete(key);
      stopPulseIfIdle();
    }

    function average(samples, field) {
      const vals = samples.map((s) => s[field]).filter((v) => typeof v === 'number' && v > 0);
      if (!vals.length) return 0;
      return r1(vals.reduce((a, b) => a + b, 0) / vals.length);
    }

    /** 每个连接给一句结论，免得只会看数字的人误判方向 */
    function verdict(samples) {
      if (!samples.length) return 'no samples';
      const k = samples[samples.length - 1];
      const srcFps = average(samples, 'srcFps');
      const outFps = average(samples, 'fps');
      const ms = average(samples, 'msPerFrame');
      const soft = /libvpx|libaom|openh264|ffmpeg/i.test(k.enc || '');
      const tally = [];
      if (k.dir === 'out' && srcFps > 0 && srcFps < 20) tally.push('源端只吐 ' + srcFps + 'fps -> 后台节流/源视频本身低帧，改 WebRTC 参数无用');
      if (k.dir === 'out' && srcFps >= 20 && outFps < srcFps * 0.7) tally.push('采集 ' + srcFps + 'fps 但只编码出 ' + outFps + 'fps -> 编码侧跟不上（降分辨率/限帧/换硬编）');
      if (!k.dir || k.dir === 'out') { if (soft) tally.push('编码器 ' + k.enc + ' 是软编 -> setCodecPreferences 优先 H.264 收益最大'); }
      if (ms >= 10) tally.push('单帧 ' + ms + 'ms（健康 <6ms）-> 编码器过载');
      if (/cpu/i.test(k.limit || '')) tally.push('qualityLimitation=cpu');
      if (k.dir === 'in' && outFps > 0 && outFps < 20) tally.push('接收侧只显示 ' + outFps + 'fps -> 解码/合成瓶颈或渲染被节流');
      return tally.length ? tally.join(' / ') : 'ok（未发现明显瓶颈）';
    }

    function report() {
      if (!watched.size) { log('[mp-stats] 没有任何被监听的连接'); return; }
      watched.forEach((entry, key) => {
        const s = entry.samples;
        if (!s.length) { log('[mp-stats]', key, 'no samples yet'); return; }
        const k = s[s.length - 1];
        console.log(
          '[mp-stats] === ' + key + ' (' + k.dir + ') ===\n' +
          '  samples=' + s.length +
          '  outAvg=' + k.w + 'x' + k.h + '@' + average(s, 'fps') + 'fps ' + average(s, 'kbps') + 'kbps ' + average(s, 'msPerFrame') + 'ms/f qp=' + average(s, 'qp') + '\n' +
          '  srcAvg=' + k.srcW + 'x' + k.srcH + '@' + average(s, 'srcFps') + 'fps drop=' + average(s, 'srcDrop') + ' hidden=' + (k.hidden ? 'yes' : 'no') + '\n' +
          '  encoder=' + (k.enc || '-') + '  codec=' + (k.codec || '-') + '  limit=' + (k.limit || '-') + '  params=' + (k.params || '-') + '\n' +
          '  verdict: ' + verdict(s)
        );
      });
    }

    function csv() {
      const head = 'time,key,dir,outW,outH,outFps,kbps,msPerFrame,qp,codec,encoder,limit,srcW,srcH,srcFps,srcDrop,paused,params';
      const rows = [head];
      watched.forEach((entry, key) => {
        entry.samples.forEach((s) => {
          rows.push([s.t, key, s.dir, s.w, s.h, s.fps, s.kbps, s.msPerFrame, s.qp, s.codec, s.enc, s.limit, s.srcW, s.srcH, s.srcFps, s.srcDrop, s.paused ? 1 : 0, '"' + (s.params || '') + '"'].join(','));
        });
      });
      return rows.join('\n');
    }

    function setEnabled(v) {
      enabled = !!v;
      try {
        if (enabled) localStorage.setItem(KEY, '1');
        else localStorage.removeItem(KEY);
      } catch (e) {}
      if (enabled) { startPulse(); log('[mp-stats] enabled'); }
      else { if (pulse) { clearInterval(pulse); pulse = null; } watched.clear(); log('[mp-stats] disabled'); }
    }

    return {
      watch, unwatch, report, csv,
      on: () => setEnabled(true),
      off: () => setEnabled(false),
      get enabled() { return enabled; },
      get size() { return watched.size; },
      __take: take,
    };
  })();
  try { window.mpStats = mpStats; } catch (e) {}

  /* 页面世界桥接：不用把 DevTools 控制台切到扩展上下文，也能在默认 console 里驱动遥测。
   *   document.dispatchEvent(new CustomEvent('mp-stats', { detail: 'report' }))
   *   document.dispatchEvent(new CustomEvent('mp-stats', { detail: 'csv' }))
   *   copy(document.documentElement.dataset.mpStatsCsv) */
  try {
    document.addEventListener('mp-stats', (ev) => {
      const cmd = String((ev && ev.detail) || 'report');
      if (cmd === 'on') mpStats.on();
      else if (cmd === 'off') mpStats.off();
      else if (cmd === 'report') mpStats.report();
      else if (cmd === 'csv') {
        const text = mpStats.csv();
        try { document.documentElement.setAttribute('data-mp-stats-csv', text); } catch (e) {}
        log('[mp-stats] CSV 已写入 document.documentElement.dataset.mpStatsCsv（' + text.length + ' 字符），复制：copy(document.documentElement.dataset.mpStatsCsv)');
      }
    }, false);
  } catch (e) {}

  /* ------------------------------- settings ------------------------------- */
  let currentMode = 'dock';
  try {
    const saved = localStorage.getItem(NS + ':mode');
    if (saved) currentMode = saved;
  } catch (e) {}

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['multipip_mode'], (res) => {
      if (res && res.multipip_mode) {
        currentMode = res.multipip_mode;
        try { localStorage.setItem(NS + ':mode', currentMode); } catch (e) {}
        if (typeof renderModeBar === 'function') renderModeBar();
        if (typeof updateAllBadgesUI === 'function') updateAllBadgesUI();
        if (typeof refreshStates === 'function') refreshStates();
      }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.multipip_mode) {
        currentMode = changes.multipip_mode.newValue || 'dock';
        try { localStorage.setItem(NS + ':mode', currentMode); } catch (e) {}
        if (typeof renderModeBar === 'function') renderModeBar();
        if (typeof updateAllBadgesUI === 'function') updateAllBadgesUI();
        if (typeof refreshStates === 'function') refreshStates();
      }
    });
  }

  const modeStore = {
    get() {
      return currentMode;
    },
    set(v) {
      currentMode = v;
      try { localStorage.setItem(NS + ':mode', v); } catch (e) {}
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ multipip_mode: v });
      }
      if (typeof renderModeBar === 'function') renderModeBar();
      if (typeof updateAllBadgesUI === 'function') updateAllBadgesUI();
      if (typeof refreshStates === 'function') refreshStates();
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
  const launching = new Set();

  /** videos currently living in the browser's NATIVE video PiP window */
  const nativePopped = new Set();

  /** cross-tab dock sources: id -> { video, wasPlaying } (this tab) */
  const dockStreamSources = new Map();
  let nextDockSourceId = Date.now() % 1000000;

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
    if (typeof video.requestPictureInPicture === 'function') {
      video.requestPictureInPicture().then(() => {
        nativePopped.add(video);
        lastPopped = video;
        video.addEventListener('leavepictureinpicture', () => {
          nativePopped.delete(video);
          refreshStates();
        });
        log('native PiP fallback success');
        refreshStates();
      }).catch((e) => {
        log('native PiP failed, fallback to standalone window:', e);
        popOutOwnWindow(video);
      });
      return;
    }
    popOutOwnWindow(video);
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
    div.tabIndex = 0;
    div.textContent = '\u89c6\u9891\u5df2\u5f39\u51fa\u64ad\u653e \u00b7 \u70b9\u51fb\u6216\u6309\u7a7a\u683c/Esc\u53ec\u56de';
    Object.assign(div.style, {
      padding: '18px 12px',
      textAlign: 'center',
      borderRadius: '8px',
      background: 'rgba(0,0,0,.55)',
      color: '#fff',
      font: '13px/1.5 system-ui, "Microsoft YaHei", sans-serif',
      cursor: 'pointer',
      outline: 'none',
    });
    const doRecall = () => restoreVideo(video);
    div.addEventListener('click', doRecall);
    div.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        doRecall();
      }
    });
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
  async function popOut(video, preferredMode) {
    if (homes.has(video)) {
      toast('\u8fd9\u4e2a\u89c6\u9891\u5df2\u7ecf\u5728\u591a\u89c6\u9891\u575e\u91cc\u4e86');
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
    if (pending.has(video) || launching.has(video)) {
      toast('\u6b63\u5728\u6253\u5f00\u7a97\u53e3\uff0c\u8bf7\u7a0d\u5019...', 1000);
      return;
    }
    pending.add(video);
    launching.add(video);
    try { bgSend({ type: 'mp-note' }); } catch (e) {} // remember this tab for the speed shortcut
    try {
      const mode = preferredMode || modeStore.get() || 'dock';
      if (mode === 'companion') {
        await popOutCompanion(video);
        return;
      }
      if (mode === 'native') {
        popOutNative(video);
        return;
      }
      if (mode === 'window') {
        popOutOwnWindow(video);
        return;
      }
      if (mode === 'solo') {
        await popOutSolo(video);
        return;
      }

      // Default: Dock mode (原生多视频坞)
      await popOutToDock(video);
    } finally {
      pending.delete(video);
      setTimeout(() => { launching.delete(video); }, 800);
    }
  }

  /** Native mode: hand the video to the browser's own video PiP window
   *  (pure native look, no title strip at all). NOTE: Chrome keeps only
   *  ONE PiP window globally (video or Document PiP), so this is the
   *  cleanest SINGLE always-on-top window experience. */
  function popOutNative(video) {
    if (typeof video.requestPictureInPicture !== 'function') {
      toast('\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u7cfb\u7edf\u753b\u4e2d\u753b\uff0c\u4f7f\u7528\u72ec\u7acb\u7a97\u53e3\u6253\u5f00');
      popOutOwnWindow(video);
      return;
    }
    video.requestPictureInPicture().then(() => {
      nativePopped.add(video);
      lastPopped = video;
      video.addEventListener('leavepictureinpicture', onLeave);
      log('native piP:', (video.currentSrc || '').slice(0, 60));
      refreshStates();
    }).catch((e) => {
      log('native PiP failed, fallback to own window', e);
      popOutOwnWindow(video);
    });
    function onLeave() {
      nativePopped.delete(video);
      video.removeEventListener('leavepictureinpicture', onLeave);
      log('native piP exited');
      refreshStates();
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

  /** 为本地回环 WebRTC 配置高清与低 CPU 开销兼顾的自适应码率（最高 6Mbps，兼顾 1080p 超清与普通低配核显 CPU 多开流畅） */
  function boostWebRtcVideoSdp(sdp) {
    if (!sdp || typeof sdp !== 'string') return sdp;
    const lines = sdp.split('\r\n');
    const out = [];
    let inVideo = false;
    const videoPts = new Map();
    const hasFmtp = new Set();
    for (const line of lines) {
      if (line.indexOf('m=') === 0) inVideo = line.indexOf('m=video') === 0;
      if (inVideo) {
        const m = line.match(/^a=rtpmap:(\d+)\s+(VP9|VP8|H264|AV1)\/90000/i);
        if (m) videoPts.set(m[1], m[2].toUpperCase());
      }
    }
    for (const line of lines) {
      const fm = line.match(/^a=fmtp:(\d+)\s+/);
      if (fm && videoPts.has(fm[1])) hasFmtp.add(fm[1]);
    }
    inVideo = false;
    // 兼顾 1080p 纯净画质与普通核显性能：起步 2Mbps，上限 6Mbps（开 4 个总码率仅约 16Mbps，不冲垮总线与 CPU）
    // 最小码率不能写高：静止画面/小窗会逼编码器空吐比特，这里交给 setParameters 动态控制
    const br = 'x-google-min-bitrate=300;x-google-start-bitrate=1200;x-google-max-bitrate=6000';
    for (const line of lines) {
      if (line.indexOf('m=') === 0) inVideo = line.indexOf('m=video') === 0;
      if (inVideo && line.indexOf('c=IN ') === 0) {
        out.push(line);
        out.push('b=AS:6000');
        continue;
      }
      const fm = line.match(/^a=fmtp:(\d+)\s+(.*)$/);
      if (inVideo && fm && videoPts.has(fm[1]) && videoPts.get(fm[1]) !== 'H264') {
        if (fm[2].indexOf('x-google-max-bitrate') < 0) {
          out.push('a=fmtp:' + fm[1] + ' ' + fm[2] + ';' + br);
        } else {
          out.push(line);
        }
        continue;
      }
      out.push(line);
      const rm = line.match(/^a=rtpmap:(\d+)\s+/);
      if (inVideo && rm && videoPts.has(rm[1]) && videoPts.get(rm[1]) !== 'H264' && !hasFmtp.has(rm[1])) {
        out.push('a=fmtp:' + rm[1] + ' ' + br);
      }
    }
    return out.join('\r\n');
  }

  /** 用标准 API 把硬编覆盖率最高的 H.264 排到最前。
   *  必须用 `setCodecPreferences`，不要再手改 SDP 字符串（1c5fb7c 就是那样把 offer/answer 协商弄坏才回退的）。
   *  未做任何过滤的默认情况下 Chromium 本地回环会落到 VP8（libvpx 纯 CPU 软编），这是多开卡的主因之一。 */
  function preferHardwareH264(pc) {
    try {
      if (!pc || typeof pc.getTransceivers !== 'function') return;
      const caps = (typeof RTCRtpSender !== 'undefined' && RTCRtpSender.getCapabilities)
        ? RTCRtpSender.getCapabilities('video') : null;
      if (!caps || !caps.codecs || !caps.codecs.length) return;

      const all = caps.codecs.slice();
      const rank = (c) => {
        const mime = String(c.mimeType || '').toLowerCase();
        if (mime !== 'video/h264') return null;
        const fmtp = String(c.sdpFmtpLine || '').toLowerCase();
        const plid = (fmtp.match(/profile-level-id=([0-9a-f]{6})/) || [])[1] || '';
        const profile = plid.slice(0, 4);
        // 42e0=Constrained Baseline / 4d00=Main / 6400=High，Windows 核显 QSV、NVENC、AMF 三者均覆盖
        const base = profile === '42e0' ? 0 : profile === '4d00' ? 10 : 20;
        return base + (fmtp.indexOf('level-asymmetry-allowed=1') >= 0 ? 0 : 1);
      };
      const h264 = all.filter((c) => rank(c) != null).sort((a, b) => rank(a) - rank(b));
      if (!h264.length) return;
      const chosen = new Set(h264);
      const ordered = h264.concat(all.filter((c) => !chosen.has(c)));

      pc.getTransceivers().forEach((t) => {
        try {
          if (typeof t.setCodecPreferences !== 'function') return;
          if (!t.sender || !t.sender.track || t.sender.track.kind !== 'video') return;
          t.setCodecPreferences(ordered);
        } catch (e) { log('setCodecPreferences failed:', e && e.message); }
      });
      log('codec preference: H.264 first (' + h264.length + ' h264 profiles ordered)');
    } catch (e) { log('preferHardwareH264 error:', e && e.message); }
  }

  const r2s = (v) => Math.round(v * 100) / 100;

  /** 按「小窗实际显示尺寸 + 源分辨率 + 当前路数」配置编码器。
   *  目标：小窗里根本看不到的像素不去编，多开时逐级減负。
   *  targetW 为小窗显示宽度（CSS px），未知时按 1280 兜底；activeCount 为当前同时推送的路数。 */
  /** 挂起/恢复某一路的编码：encodings[0].active=false 完全停止编码与发包，
   *  不拆 PeerConnection，恢复是毫秒级（坞窗全屏独占某一路时，其余路零开销）。 */
  function setRtcSenderActive(pc, active) {
    if (!pc || typeof pc.getSenders !== 'function') return;
    try {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (!sender || typeof sender.getParameters !== 'function') return;
      const params = sender.getParameters() || {};
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].active = !!active;
      const p = sender.setParameters(params);
      if (p && p.catch) p.catch(() => {});
      log('rtc sender', active ? 'resumed' : 'suspended');
    } catch (e) {}
  }

  /** 向 background 取"所有标签页加起来"的并发路数；拿不到就退回本页计数。 */
  async function globalStreamCount(fallback) {
    try {
      const r = await bgSend({ type: 'mp-active-count' });
      if (r && typeof r.count === 'number' && r.count > 0) return r.count;
    } catch (e) {}
    return Math.max(1, fallback || 1);
  }

  /** 路数变化后把已建立的所有 WebRTC 发送端重新分档（新开一路会让旧路降档）。 */
  async function retuneAllRtcSenders() {
    const n = await globalStreamCount(1);
    try {
      companionConnections.forEach((conn) => {
        if (conn && conn.pc) applyHighQualityRtcSenders(conn.pc, conn.video, conn.targetW, n);
      });
      rtcConnections.forEach((conn) => {
        if (conn && conn.pc) applyHighQualityRtcSenders(conn.pc, conn.video, conn.targetW, n);
      });
    } catch (e) {}
    return n;
  }

  function applyHighQualityRtcSenders(pc, video, targetW, activeCount) {
    if (!pc || typeof pc.getSenders !== 'function') return;
    const count = Math.max(1, activeCount || 1);
    const srcW = (video && video.videoWidth) || 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let capW = targetW ? Math.round(targetW * dpr) : 1280;
    capW = Math.max(640, Math.min(capW, srcW || 1920, 1920));
    if (count >= 3) capW = Math.min(capW, 960);

    const tier = count >= 3 ? { maxBitrate: 2500000, maxFramerate: 25 }
      : count === 2 ? { maxBitrate: 4000000, maxFramerate: 30 }
        : { maxBitrate: 6000000, maxFramerate: 30 };

    pc.getSenders().forEach((sender) => {
      try {
        if (!sender.track || sender.track.kind !== 'video' || typeof sender.getParameters !== 'function') return;
        const params = sender.getParameters() || {};
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        const enc = params.encodings[0];
        enc.scaleResolutionDownBy = (srcW && srcW > capW) ? Math.min(16, srcW / capW) : 1;
        enc.maxBitrate = tier.maxBitrate;
        enc.maxFramerate = tier.maxFramerate;
        // 卡顿时优先降分辨率保流畅（而不是死保分辨率、狂掉帧）
        params.degradationPreference = 'maintain-framerate';
        const p = sender.setParameters(params);
        if (p && p.catch) p.catch(() => {});
      } catch (e) {}
    });
    log('rtc sender tuned: streams=' + count + ' srcW=' + (srcW || '?') + ' capW=' + capW +
      ' down=' + (srcW && srcW > capW ? r2s(srcW / capW) : 1) +
      ' cap=' + Math.round(tier.maxBitrate / 1000) + 'k fps<' + tier.maxFramerate);
  }

  function prepareHighQualityStream(stream) {
    if (!stream || typeof stream.getVideoTracks !== 'function') return;
    stream.getVideoTracks().forEach((vt) => {
      try {
        if ('contentHint' in vt) vt.contentHint = 'motion';
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
    // 必须在 createOffer 之前设定：本地回环默认选 VP8（纯 CPU 软编）
    preferHardwareH264(pc);
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

    const connEntry = { pc, video, stream, syncTimer, iceCandidates, answerReceived: false, retryTimer: null, targetW: size.width };
    companionConnections.set(winId, connEntry);
    mpStats.watch('companion#' + winId, pc, video, 'out');

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
      mpStats.unwatch('companion#' + id);
    }
    bgSend({ type: 'mp-companion-close', id });
    refreshStates();
    retuneAllRtcSenders();
  }

  /* ------------------- Solo mode: 原生拆窗（零重编码置顶窗） ------------------- */

  /** video -> { token, origTitle, bar } */
  const soloPopped = new Map();

  /** 裁边（SetWindowRgn 切掉 Chrome 工具栏）默认开启，可在工具条上一键关掉 */
  const SOLO_CUT_KEY = NS + ':cut';
  function soloCutPref() {
    try { return localStorage.getItem(SOLO_CUT_KEY) !== '0'; } catch (e) { return true; }
  }
  function setSoloCutPref(on) {
    try { localStorage.setItem(SOLO_CUT_KEY, on ? '1' : '0'); } catch (e) {}
  }

  function soloWindowSize(video) {
    const availW = (typeof screen !== 'undefined' && screen.availWidth) || 1280;
    const availH = (typeof screen !== 'undefined' && screen.availHeight) || 720;
    const vw = video.videoWidth || 16;
    const vh = video.videoHeight || 9;
    let w = clamp(Math.round(availW * 0.42), 480, 1600);
    let h = Math.round(w * (vh / vw));
    if (h > availH * 0.85) {
      h = Math.round(availH * 0.85);
      w = Math.round(h * (vw / vh));
    }
    return { width: Math.max(240, w), height: Math.max(140, h) };
  }

  /* 隔离实现：直接改 CSSOM（setProperty + important），不用注入 <style>。
   * 原因：注入的 style 元素受页面 CSP 限制，且拿不到站点用 !important 写的行内样式。
   * 另一条关键策略是“隐藏旁系节点”：只保留从 <body> 到视频的这条祖先链，
   * 页面其它内容（顶栏/侧栏/评论区/推荐位）一律 display:none。 */

  /** 是否隐藏"旁系节点"（页面其余内容）。默认开；
   *  某些站点把播放控制条放在视频容器的兄弟节点上，关掉就不再隐藏任何东西。 */
  const SOLO_HIDE_KEY = NS + ':hideOthers';
  function soloHidePref() {
    try { return localStorage.getItem(SOLO_HIDE_KEY) !== '0'; } catch (e) { return true; }
  }
  function setSoloHidePref(on) {
    try { localStorage.setItem(SOLO_HIDE_KEY, on ? '1' : '0'); } catch (e) {}
  }

  /** 判断一个节点像不像播放器控制条（进度条/音量/按钮）。命中的不隐藏。 */
  const SOLO_CONTROL_SEL = [
    '[class*="control" i]', '[class*="progress" i]', '[class*="slider" i]',
    '[class*="seek" i]', '[class*="timeline" i]', '[class*="playbar" i]',
    '[class*="danmaku" i]', '[class*="subtitle" i]',
    'input[type="range"]', '[role="slider"]',
  ].join(',');

  function looksLikePlayerControls(el) {
    if (!el || !el.querySelectorAll || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.height > window.innerHeight * 0.5) return false; // 大容器不动（避免把整页留下）
    if (r.width < 80 || r.height < 8) return false;
    // 控制条几乎总在画面下半部分；顶部条多半是站点导航，照旧隐藏
    if (window.innerHeight && r.top < window.innerHeight * 0.35) return false;
    try {
      if (el.matches && el.matches(SOLO_CONTROL_SEL)) return true;
      return !!el.querySelector(SOLO_CONTROL_SEL);
    } catch (e) {
      return false;
    }
  }

  /** 被保留的控制条要能压在铺满的视频之上 */
  function raiseAboveVideo(el) {
    try {
      const pos = window.getComputedStyle ? window.getComputedStyle(el).position : 'static';
      if (!pos || pos === 'static') soloSet(el, 'position', 'relative');
      soloSet(el, 'z-index', '2147483601');
      soloSet(el, 'pointer-events', 'auto');
    } catch (e) {}
  }

  /** el -> 修改前的 style.cssText，用于精确还原 */
  const soloSaved = new Map();

  function soloSet(el, prop, value) {
    if (!el || !el.style) return;
    if (!soloSaved.has(el)) soloSaved.set(el, el.style.cssText);
    try { el.style.setProperty(prop, value, 'important'); } catch (e) {}
  }

  function soloRestoreAll() {
    for (const [el, css] of soloSaved) {
      try { el.style.cssText = css; } catch (e) {}
    }
    soloSaved.clear();
  }

  /** parentElement 不跨 Shadow DOM，这里补上 host，兼容 shadow 里的播放器 */
  function soloParent(n) {
    if (!n) return null;
    if (n.parentElement) return n.parentElement;
    try {
      const root = n.getRootNode ? n.getRootNode() : null;
      if (root && root.host) return root.host;
    } catch (e) {}
    return null;
  }

  const SOLO_FULL = {
    position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
    width: '100vw', height: '100vh',
    'max-width': 'none', 'max-height': 'none', 'min-width': '0', 'min-height': '0',
    margin: '0', padding: '0',
    transform: 'none', filter: 'none', contain: 'none',
    overflow: 'hidden', 'z-index': '2147483600', background: '#000',
    'border-radius': '0', 'box-shadow': 'none',
  };

  const SOLO_ANC = {
    transform: 'none', filter: 'none', perspective: 'none', 'backdrop-filter': 'none',
    contain: 'none', overflow: 'visible', 'clip-path': 'none',
    'will-change': 'auto', isolation: 'auto', 'transform-style': 'flat',
  };

  /** 让任意元素铺满视口：解掉祖先的包含块/裁剪，并隐藏这一层的所有旁系兄弟。 */
  function soloFillViewport(el) {
    for (const k in SOLO_FULL) soloSet(el, k, SOLO_FULL[k]);
    if (el.tagName === 'VIDEO') soloSet(el, 'object-fit', 'contain');
    if (el.tagName === 'IFRAME') {
      soloSet(el, 'border', '0');
      soloSet(el, 'object-fit', 'contain');
    }

    for (let n = soloParent(el); n && n !== document.documentElement; n = soloParent(n)) {
      for (const k in SOLO_ANC) soloSet(n, k, SOLO_ANC[k]);
    }

    // 隐藏旁系节点：只留“通往视频的这一条链”（可在工具条上一键关掉）
    let hidden = 0;
    let keptControls = 0;
    if (soloHidePref()) {
      for (let n = el; n && n !== document.documentElement; n = soloParent(n)) {
        const p = soloParent(n);
        if (!p) break;
        for (const sib of Array.from(p.children)) {
          if (sib === n) continue;
          const tag = sib.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'TEMPLATE') continue;
          const sid = sib.id || '';
          if (sid.indexOf('__multipip__') === 0 || sid.indexOf('mp-solo') === 0) continue;
          // 播放器控制条（进度条/音量/弹幕层）保留，并抬到铺满的视频之上
          if (looksLikePlayerControls(sib)) {
            raiseAboveVideo(sib);
            keptControls++;
            continue;
          }
          soloSet(sib, 'display', 'none');
          hidden++;
        }
      }
    }

    soloSet(document.documentElement, 'overflow', 'hidden');
    if (document.body) soloSet(document.body, 'overflow', 'hidden');
    return { hidden, keptControls };
  }

  /** 向上找一层“播放器容器”（含控制条/弹幕层），但不把带评论/侧栏的整页容器当视频容器。 */
  function soloTargetNode(video) {
    let node = video;
    for (let i = 0; i < 5; i++) {
      const p = node.parentElement;
      if (!p || p === document.body || p === document.documentElement) break;
      const r = p.getBoundingClientRect();
      // 只往上爬到"仍然是播放器"的那一层：面积不能小于 1/4 视口，且不能把别的视频也圈进来
      if (!(r.width >= window.innerWidth * 0.25 && r.height >= window.innerHeight * 0.2)) break;
      if (p.querySelectorAll('video').length > 1) break;
      node = p;
    }
    return node;
  }

  /* 兜底隔离：把 <video> 直接搬进自建全屏舞台，并隐藏 body 下其它一切。
   * 同文档内移动媒体元素是零拷贝的（不重新加载、不重编码），
   * 用于容器探测失败的站点（视频被包在小盒子里、或用 shadow/特殊定位壳）。 */

  const SOLO_ADOPT_KEY = NS + ':adopt:';
  function soloAdoptPref() {
    try {
      return localStorage.getItem(SOLO_ADOPT_KEY + location.hostname) === '1';
    } catch (e) { return false; }
  }
  function setSoloAdoptPref(on) {
    try { localStorage.setItem(SOLO_ADOPT_KEY + location.hostname, on ? '1' : '0'); } catch (e) {}
  }

  /** 把 stage/video 的样式铺满（adopt 模式下每次 resize 只要重刷这个） */
  function paintSoloStage(stage, video) {
    if (stage) {
      soloSet(stage, 'position', 'fixed');
      soloSet(stage, 'top', '0');
      soloSet(stage, 'left', '0');
      soloSet(stage, 'right', '0');
      soloSet(stage, 'bottom', '0');
      soloSet(stage, 'width', '100vw');
      soloSet(stage, 'height', '100vh');
      soloSet(stage, 'margin', '0');
      soloSet(stage, 'padding', '0');
      soloSet(stage, 'background', '#000');
      soloSet(stage, 'overflow', 'hidden');
      soloSet(stage, 'z-index', '2147483600');
      soloSet(stage, 'display', 'block');
    }
    if (video) {
      soloSet(video, 'width', '100%');
      soloSet(video, 'height', '100%');
      soloSet(video, 'max-width', 'none');
      soloSet(video, 'max-height', 'none');
      soloSet(video, 'position', 'static');
      soloSet(video, 'transform', 'none');
      soloSet(video, 'object-fit', 'contain');
      soloSet(video, 'background', '#000');
      soloSet(video, 'z-index', 'auto');
    }
  }

  function hideBodyExceptStage(stage) {
    if (!document.body) return;
    if (!soloHidePref()) return; // 用户关掉了"隐藏页面"：舞台本身就是不透明全屏，无需再藏
    for (const child of Array.from(document.body.children)) {
      if (child === stage) continue;
      const sid = child.id || '';
      if (sid.indexOf('__multipip__') === 0 || sid.indexOf('mp-solo') === 0) continue;
      soloSet(child, 'display', 'none');
    }
    soloSet(document.documentElement, 'overflow', 'hidden');
    soloSet(document.body, 'overflow', 'hidden');
  }

  /** 建舞台并把 video 搬进去；原位置用注释节点占位，召回时原样搬回。 */
  function applySoloAdopt(video, rec) {
    saveHome(video);
    let stage = rec && rec.stage;
    if (!stage || !stage.isConnected) {
      stage = document.createElement('div');
      stage.id = 'mp-solo-stage';
      (document.documentElement || document.body).appendChild(stage);
    }
    try {
      stage.appendChild(video);
    } catch (e) {
      log('solo adopt append failed', e);
    }
    paintSoloStage(stage, video);
    hideBodyExceptStage(stage);
    if (rec) {
      rec.adopted = true;
      rec.stage = stage;
    }
    log('solo adopt stage:', video.videoWidth + 'x' + video.videoHeight,
      'children hidden =', document.body ? document.body.children.length : 0);
    return stage;
  }

  function applySoloIsolation(video) {
    const target = soloTargetNode(video);
    const info = soloFillViewport(target);
    const inFrame = window.self !== window.top;
    log('solo isolate:', target.tagName + '.' + (target.className || '').toString().slice(0, 40),
      'rect=', target.getBoundingClientRect().width + 'x' + target.getBoundingClientRect().height,
      'hiddenSiblings=', info.hidden, 'keptControls=', info.keptControls,
      'hidePref=', soloHidePref(), 'inFrame=', inFrame);

    // 视频在跨域 iframe 里：让顶层把承载它的 <iframe> 也铺满
    if (inFrame) {
      try {
        window.parent.postMessage({ __mpSolo: 'fill-frame' }, '*');
      } catch (e) {}
    }
    return target;
  }

  // 顶层帧：收到子帧求助后，把承载它的 <iframe> 元素本身铺满视口
  window.addEventListener('message', (ev) => {
    const d = ev && ev.data;
    if (!d || typeof d !== 'object' || d.__mpSolo !== 'fill-frame' || !ev.source) return;
    const frames = document.querySelectorAll('iframe, frame');
    for (const f of frames) {
      if (f.contentWindow === ev.source) {
        log('solo isolate: framing <iframe> for child frame', f.src ? String(f.src).slice(0, 60) : '');
        soloFillViewport(f);
        break;
      }
    }
  }, false);

  function soloVideoByToken(token) {
    for (const [video, rec] of soloPopped) {
      if (rec.token === token) return video;
    }
    return null;
  }

  function buildSoloBar(token, hooks) {
    const bar = document.createElement('div');
    bar.id = 'mp-solo-bar';
    Object.assign(bar.style, {
      position: 'fixed', top: '10px', right: '10px', zIndex: '2147483647',
      display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 6px',
      borderRadius: '9px', background: 'rgba(14,16,22,.84)',
      backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,.18)',
      boxShadow: '0 6px 18px rgba(0,0,0,.5)',
      font: '12px/1 system-ui, "Segoe UI", sans-serif', color: '#fff',
      opacity: '0', transition: 'opacity .18s', pointerEvents: 'none',
    });

    const mkBtn = (label, title) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      Object.assign(b.style, {
        cursor: 'pointer', border: '1px solid rgba(255,255,255,.22)',
        background: 'rgba(255,255,255,.1)', color: '#fff',
        borderRadius: '6px', padding: '4px 8px', font: 'inherit', whiteSpace: 'nowrap',
      });
      return b;
    };

    const recall = mkBtn('\u53ec\u56de\u539f\u7a97\u53e3', '\u628a\u7f51\u9875\u6807\u7b7e\u539f\u8def\u79fb\u56de\u539f\u6765\u7684\u6d4f\u89c8\u5668\u7a97\u53e3');
    recall.onclick = () => {
      bgSend({ type: 'mp-solo-recall', token }).then((r) => {
        if (!r || !r.ok) toast('\u53ec\u56de\u5931\u8d25\uff1a' + ((r && r.error) || '\u672a\u77e5\u539f\u56e0'));
      });
    };

    let topmostOn = true;
    const pin = mkBtn('\u53d6\u6d88\u7f6e\u9876', '\u5207\u6362\u8fd9\u4e2a\u7a97\u53e3\u662f\u5426\u59cb\u7ec8\u7f6e\u9876');
    pin.onclick = () => {
      const next = !topmostOn;
      bgSend({ type: 'mp-solo-topmost', token, on: next }).then((r) => {
        if (!r || !r.ok) {
          toast('\u7f6e\u9876\u5207\u6362\u5931\u8d25\uff1a' + ((r && r.error) || '\u8bf7\u5148\u8fd0\u884c companion/register_host.bat'), 6000);
          return;
        }
        topmostOn = next;
        pin.textContent = next ? '\u53d6\u6d88\u7f6e\u9876' : '\u6062\u590d\u7f6e\u9876';
      });
    };

    const repave = mkBtn('重新铺满', '页面重排后画面不对时点一下，重新把视频铺满窗口');
    repave.onclick = () => { if (hooks && typeof hooks.repave === 'function') hooks.repave(); };

    // 裁边后窗口没有边框可拖/可缩放，必须由宿主接管
    const grip = document.createElement('span');
    grip.textContent = '⣿';
    grip.title = '按住拖动窗口';
    grip.style.cssText = 'cursor:move;padding:4px 6px;border-radius:6px;background:rgba(255,255,255,.1);user-select:none;';
    grip.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      bgSend({ type: 'mp-solo-drag', token });
    });

    const sizeGrip = document.createElement('span');
    sizeGrip.textContent = '◢';
    sizeGrip.title = '按住拖动等比缩放窗口';
    sizeGrip.style.cssText = 'cursor:nwse-resize;padding:4px 6px;border-radius:6px;background:rgba(255,255,255,.1);user-select:none;';
    sizeGrip.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      bgSend({ type: 'mp-solo-resize', token, aspect: hooks && hooks.aspect ? hooks.aspect() : 0 });
    });

    let hideOn = soloHidePref();
    const hideBtn = mkBtn(hideOn ? '◉ 已隐藏页面' : '○ 不隐藏页面', '切换是否隐藏视频之外的页面内容（隐藏后可能会把播放控制条也藏掉，那就点它关掉）');
    hideBtn.onclick = () => {
      const next = !hideOn;
      setSoloHidePref(next);
      hideOn = next;
      hideBtn.textContent = next ? '◉ 已隐藏页面' : '○ 不隐藏页面';
      if (hooks && typeof hooks.repave === 'function') hooks.repave();
      toast(next ? '已隐藏页面内容' : '已显示页面内容（控制条应该回来了）', 2400);
    };

    let cutOn = !!(hooks && hooks.cutPref);
    const cut = mkBtn(cutOn ? '✂ 已裁边' : '✂ 裁边', '切换是否裁掉 Chrome 工具栏（真无边框）');
    cut.onclick = () => {
      const next = !cutOn;
      bgSend({ type: 'mp-solo-setcut', token, cut: next }).then((r) => {
        if (!r || !r.ok) { toast('裁边切换失败：' + ((r && r.error) || '宿主未连接'), 6000); return; }
        cutOn = next;
        setSoloCutPref(next);
        cut.textContent = next ? '✂ 已裁边' : '✂ 裁边';
      });
    };

    // 容器探测失败的站点：手动把 <video> 搬进全屏舞台（同文档零拷贝）
    let adoptBtn = null;
    if (hooks && typeof hooks.adopt === 'function' && !(hooks.adopted && hooks.adopted())) {
      adoptBtn = mkBtn('⤓ 接管画面', '页面剩余内容遮不干净时点一下：把视频直接搬进全屏舞台（不重载、不编码）');
      adoptBtn.onclick = () => {
        hooks.adopt();
        if (adoptBtn) { adoptBtn.remove(); adoptBtn = null; }
      };
    }

    const hint = document.createElement('span');
    hint.textContent = '\u539f\u751f\u62c6\u7a97 \u00b7 \u96f6\u91cd\u7f16\u7801';
    hint.style.cssText = 'color:#9aa4ad;font-size:11px;';

    bar.appendChild(hint);
    if (adoptBtn) bar.appendChild(adoptBtn);
    bar.appendChild(grip);
    bar.appendChild(sizeGrip);
    bar.appendChild(cut);
    bar.appendChild(hideBtn);
    bar.appendChild(repave);
    bar.appendChild(pin);
    bar.appendChild(recall);

    let hideTimer = null;
    const show = () => {
      bar.style.opacity = '1';
      bar.style.pointerEvents = 'auto';
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (bar.matches(':hover')) return;
        bar.style.opacity = '0';
        bar.style.pointerEvents = 'none';
      }, 1800);
    };
    bar.addEventListener('mouseenter', () => { if (hideTimer) clearTimeout(hideTimer); });
    bar.addEventListener('mouseleave', show);
    document.addEventListener('mousemove', (ev) => {
      if (ev.clientY < 100 || ev.clientX > window.innerWidth - 320) show();
    }, true);

    (document.body || document.documentElement).appendChild(bar);
    return {
      remove() { bar.remove(); },
      setTopmostState(ok, error) {
        topmostOn = ok;
        pin.textContent = ok ? '\u53d6\u6d88\u7f6e\u9876' : '\u6062\u590d\u7f6e\u9876';
        if (!ok && error) toast('\u7f6e\u9876\u5931\u8d25\uff1a' + error + '\uff08\u8bf7\u5148\u8fd0\u884c companion/register_host.bat\uff09', 7000);
      },
    };
  }

  /** 原生拆窗：把视频所在的标签页整体挑进置顶 popup 窗口，页面本身直接铺满。
   *  零重编码、零拷贝、支持 DRM；多开等价于多开普通标签页（各自硬件解码）。 */
  async function popOutSolo(video) {
    if (soloPopped.has(video)) {
      toast('\u8fd9\u4e2a\u89c6\u9891\u5df2\u7ecf\u5728\u62c6\u7a97\u6a21\u5f0f\u4e0b\u4e86');
      return;
    }
    const token = 'MP' + Math.random().toString(36).slice(2, 9).toUpperCase();
    const size = soloWindowSize(video);
    const origTitle = document.title;

    // 必须先把 token 写进标题：宿主是按窗口标题里的 token 认领 HWND 的
    try { document.title = token + ' \u00b7 ' + origTitle; } catch (e) {}

    const cutPref = soloCutPref();
    const resp = await bgSend({
      type: 'mp-solo-open', token, width: size.width, height: size.height,
      cut: cutPref, radius: 10,
    });
    if (!resp || !resp.ok) {
      try { document.title = origTitle; } catch (e) {}
      toast('\u62c6\u7a97\u5931\u8d25\uff1a' + ((resp && resp.error) || '\u672a\u77e5\u539f\u56e0'), 6000);
      return;
    }

    const rec = { token, origTitle, bar: null, titleObserver: null, reapply: null, adopted: false, stage: null };

    // 先探测容器：若它明显不是"整屏播放器"（或该站点上次用过兜底），直接走 adopt
    const probe = soloTargetNode(video);
    const pr = probe.getBoundingClientRect();
    const looksSmall = probe === video ||
      pr.width < window.innerWidth * 0.55 ||
      pr.height < window.innerHeight * 0.4;
    let target;
    if (looksSmall || soloAdoptPref()) {
      target = applySoloAdopt(video, rec);
      log('solo: adopt fallback (looksSmall=' + looksSmall + ')');
    } else {
      target = applySoloIsolation(video);
    }

    const barHooks = {
      repave: null,
      cutPref: cutPref,
      adopt: () => {
        soloRestoreAll();
        applySoloAdopt(video, rec);
        setSoloAdoptPref(true);
        toast('已接管画面：本机该站点下次拆窗会直接走兜底模式', 3000);
      },
      adopted: () => !!rec.adopted,
      aspect: () => {
        if (video.videoWidth && video.videoHeight) return video.videoWidth / video.videoHeight;
        if (window.innerHeight > 0) return window.innerWidth / window.innerHeight;
        return 0;
      },
    };
    const bar = buildSoloBar(token, barHooks);

    // 部分站点会自己重写 document.title，持续把 token 顶在最前面（宿主靠它认领 HWND）
    let titleObserver = null;
    const titleTag = document.querySelector('title');
    if (titleTag && typeof MutationObserver !== 'undefined') {
      titleObserver = new MutationObserver(() => {
        const t = document.title;
        if (t.indexOf(token) < 0) {
          try { document.title = token + ' · ' + t; } catch (e) {}
        }
      });
      titleObserver.observe(titleTag, { childList: true, characterData: true, subtree: true });
    }

    // 站点常因尺寸变化重排甚至重建 DOM：窗口 resize 后重新铺一次
    const reapply = () => {
      if (!soloPopped.has(video)) return;
      try {
        soloRestoreAll();
        if (rec.adopted) {
          paintSoloStage(rec.stage, video);
          hideBodyExceptStage(rec.stage);
        } else if (video.isConnected) {
          soloFillViewport(soloTargetNode(video));
        }
        if (window.self !== window.top) {
          window.parent.postMessage({ __mpSolo: 'fill-frame' }, '*');
        }
      } catch (e) {}
    };
    window.addEventListener('resize', reapply);
    barHooks.repave = reapply;

    // 守护：站点可能自己重排/重设行内样式，把视频又挤出视口。发现"没铺满"就自动重铺。
    const guard = setInterval(() => {
      if (!soloPopped.has(video)) { clearInterval(guard); return; }
      if (!video.isConnected) return;
      try {
        const r = video.getBoundingClientRect();
        const covered = r.width >= window.innerWidth * 0.92 && r.height >= window.innerHeight * 0.78;
        const stray = rec.adopted ? !(rec.stage && rec.stage.contains(video)) : false;
        if (!covered || stray) {
          log('solo guard: drift detected -> re-apply',
            Math.round(r.width) + 'x' + Math.round(r.height));
          reapply();
        }
      } catch (e) {}
    }, 1200);
    rec.guard = guard;

    rec.bar = bar;
    rec.titleObserver = titleObserver;
    rec.reapply = reapply;
    soloPopped.set(video, rec);

    // 页面自己的播放器可能会因尺寸突变暂停，兜底拉一次播放
    setTimeout(() => {
      try {
        if (video.paused) {
          const p = video.play();
          if (p && p.catch) p.catch(() => {});
        }
      } catch (e) {}
    }, 300);

    refreshStates();
    retuneAllRtcSenders();
    log('solo window opened:', resp.winId, token, 'target:', target && target.tagName);
  }

  function teardownSolo(video) {
    const rec = soloPopped.get(video);
    if (rec) {
      soloPopped.delete(video);
      if (rec.titleObserver) { try { rec.titleObserver.disconnect(); } catch (e) {} }
      if (rec.reapply) { try { window.removeEventListener('resize', rec.reapply); } catch (e) {} }
      if (rec.guard) { try { clearInterval(rec.guard); } catch (e) {} }
      if (rec.bar) { try { rec.bar.remove(); } catch (e) {} }
      try {
        if (document.title.indexOf(rec.token) === 0) document.title = rec.origTitle;
      } catch (e) {}
    }
    if (video && rec && rec.adopted) {
      try {
        if (rec.stage) rec.stage.remove();
        restoreVideo(video);   // 借助已有的 saveHome/restoreVideo 把元素搬回原位
      } catch (e) { log('solo adopt restore failed', e); }
    }
    if (soloPopped.size === 0) {
      soloRestoreAll();
      const st = document.getElementById('mp-solo-style'); // 兼容旧版本注入的样式
      if (st) st.remove();
    }
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
    if (window.self !== window.top) {
      // 检查顶层或其他标签页是否已有开启的小窗坞
      const who = await bgSend({ type: 'mp-dock-who' });
      if (who && who.ok && who.ownerTabId != null) {
        await popOutCrossTabWebRTC(video);
        return;
      }
      // 当前尚无开启的坞：优先尝试由顶层开启 Document PiP 坞
      const size = guessWindowSize([video]);
      let win = await tryTopLevelPiP(size);
      if (win) {
        setupDockWindow(win, video);
        return;
      }
      // 若受同源策略阻止，以独立小窗承载多视频坞（具备多视频合并与排版功能）
      try {
        win = window.open('', '_blank', `popup=yes,width=${size.width},height=${size.height}`);
      } catch (e) {}
      if (win) {
        setupDockWindow(win, video);
        return;
      }
      fallbackNativePiP(video);
      return;
    }

    if (dock && dock.win.closed) dock = null;
    if (dock) {
      addToDock(video, dock);
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
      if (typeof window.documentPictureInPicture?.requestWindow === 'function') {
        win = await window.documentPictureInPicture.requestWindow(opts);
      }
    } catch (err) {
      log('requestWindow failed', err);
    }
    if (!win) {
      win = await tryTopLevelPiP(size);
    }
    // 若系统/环境限制无法使用 Document PiP，平滑以独立弹窗承载多视频坞（100% 具备多视频合一、宫格排版与独立控制条功能）
    if (!win) {
      try {
        win = window.open('', '_blank', `popup=yes,width=${size.width},height=${size.height}`);
      } catch (e) {}
    }
    if (!win) {
      bgSend({ type: 'mp-release' });
      log('dock window unavailable, graceful fallback to native PiP');
      fallbackNativePiP(video);
      return;
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
    watchDockVisibility(d);
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
        e.preventDefault();
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
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (card.ctl) {
          card.ctl.toggle();
          if (card.bar && typeof card.bar._sync === 'function') card.bar._sync();
        }
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (card.ctl) {
          card.ctl.seek(Math.max(0, card.ctl.time() - 5));
          if (card.bar && typeof card.bar._sync === 'function') card.bar._sync();
        }
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (card.ctl) {
          card.ctl.seek(card.ctl.time() + 5);
          if (card.bar && typeof card.bar._sync === 'function') card.bar._sync();
        }
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const i = d.cards.indexOf(card);
        const j = (i + (e.key === 'ArrowDown' ? 1 : -1) + d.cards.length) % d.cards.length;
        d.focused = d.cards[j];
      }
    });
  }

  /** Clean & unobtrusive layout switcher: collapsed into a single gear icon button at top-right.
   *  Clicking it opens a neatly organized popup menu for layouts, snapping, window sizes, and fullscreen. */
  function makeLayoutBar(d) {
    const doc = d.doc;
    const wrap = doc.createElement('div');
    Object.assign(wrap.style, {
      position: 'absolute', top: '8px', right: '8px', zIndex: '999999',
      display: 'inline-flex', alignItems: 'center', pointerEvents: 'auto',
    });

    const triggerBtn = doc.createElement('button');
    triggerBtn.textContent = '⚙';
    triggerBtn.title = '窗口布局与分屏设置';
    Object.assign(triggerBtn.style, {
      width: '28px', height: '28px', borderRadius: '50%', cursor: 'pointer',
      border: '1px solid rgba(255,255,255,0.25)', background: 'rgba(0,0,0,0.65)',
      color: 'rgba(255,255,255,0.85)', fontSize: '15px', lineHeight: '26px', textAlign: 'center',
      boxShadow: '0 2px 10px rgba(0,0,0,0.45)', backdropFilter: 'blur(6px)',
      opacity: '0.45', transition: 'all .2s ease', padding: '0',
    });
    triggerBtn.addEventListener('mouseenter', () => {
      triggerBtn.style.opacity = '1';
      triggerBtn.style.background = 'rgba(20,20,30,0.88)';
      triggerBtn.style.borderColor = 'rgba(255,255,255,0.5)';
    });
    triggerBtn.addEventListener('mouseleave', () => {
      if (popMenu.style.display !== 'block') {
        triggerBtn.style.opacity = '0.45';
        triggerBtn.style.background = 'rgba(0,0,0,0.65)';
        triggerBtn.style.borderColor = 'rgba(255,255,255,0.25)';
      }
    });

    const popMenu = doc.createElement('div');
    Object.assign(popMenu.style, {
      position: 'absolute', top: '34px', right: '0', display: 'none',
      width: '220px', padding: '10px', borderRadius: '12px',
      background: 'rgba(16,18,26,0.94)', border: '1px solid rgba(255,255,255,0.22)',
      boxShadow: '0 10px 30px rgba(0,0,0,0.7)', backdropFilter: 'blur(10px)',
      color: '#fff', font: '12px system-ui, "Microsoft YaHei", sans-serif',
      userSelect: 'none',
    });

    const mkSectionTitle = (txt) => {
      const t = doc.createElement('div');
      t.textContent = txt;
      Object.assign(t.style, {
        fontSize: '11px', color: 'rgba(255,255,255,0.5)', margin: '6px 0 4px',
        fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px'
      });
      return t;
    };

    const mkBtn = (label, title, fn, active) => {
      const b = doc.createElement('button');
      b.textContent = label;
      b.title = title || '';
      Object.assign(b.style, {
        cursor: 'pointer', border: '1px solid rgba(255,255,255,0.18)',
        background: active ? 'rgba(58,160,255,0.35)' : 'rgba(255,255,255,0.08)',
        color: '#fff', borderRadius: '6px', padding: '4px 6px',
        fontSize: '11px', textAlign: 'center', transition: 'background .15s',
      });
      b.onmouseover = () => { if (!active) b.style.background = 'rgba(255,255,255,0.2)'; };
      b.onmouseout = () => { if (!active) b.style.background = 'rgba(255,255,255,0.08)'; };
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      return b;
    };

    // 1. 排版布局 (stack / grid / bigLeft / bigRight / free)
    popMenu.appendChild(mkSectionTitle('多画面排版'));
    const layoutGrid = doc.createElement('div');
    Object.assign(layoutGrid.style, { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px' });
    [
      ['stack', '堆叠', '纵向堆叠'],
      ['grid', '等分', '均分宫格'],
      ['bigLeft', '大左', '主画面居左'],
      ['bigRight', '大右', '主画面居右'],
      ['free', '自由', '自由拖拽缩放'],
    ].forEach(([k, name, tip]) => {
      layoutGrid.appendChild(mkBtn(name, tip, () => {
        d.free = k === 'free';
        if (k === 'free') syncDockGeometry(d);
        else applyLayout(d);
      }));
    });
    const fsBtn = mkBtn('全屏', '窗口全屏/退出', () => toggleWindowFullscreen(d));
    d.fsBtn = fsBtn;
    layoutGrid.appendChild(fsBtn);
    popMenu.appendChild(layoutGrid);

    // 2. 屏幕贴靠分屏 (Win10/11 Aero Snap)
    popMenu.appendChild(mkSectionTitle('屏幕贴靠 (1/2 · 1/4)'));
    const snapGrid = doc.createElement('div');
    Object.assign(snapGrid.style, { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '4px' });
    [
      ['◧ 左半屏', 'left'],   ['◨ 右半屏', 'right'],
      ['⬒ 上半屏', 'top'],    ['⬓ 下半屏', 'bottom'],
      ['▛ 左上 1/4', 'tl'],   ['▜ 右上 1/4', 'tr'],
      ['▙ 左下 1/4', 'bl'],   ['▟ 右下 1/4', 'br'],
      ['↺ 还原原状', 'restore'], ['⛶ 铺满全屏', 'max'],
    ].forEach(([label, zone]) => {
      snapGrid.appendChild(mkBtn(label, '', () => {
        popMenu.style.display = 'none';
        snapDockWindow(d, zone);
      }));
    });
    popMenu.appendChild(snapGrid);

    // 3. 尺寸缩放
    popMenu.appendChild(mkSectionTitle('窗口预设尺寸'));
    const sizeRow = doc.createElement('div');
    Object.assign(sizeRow.style, { display: 'flex', gap: '4px' });
    sizeRow.appendChild(mkBtn('小(480p)', '', () => resizeDock(d, 480, 270)));
    sizeRow.appendChild(mkBtn('中(820p)', '', () => resizeDock(d, 820, 462)));
    sizeRow.appendChild(mkBtn('大(1180p)', '', () => resizeDock(d, 1180, 664)));
    sizeRow.appendChild(mkBtn('＋', '放大', () => stepResize(d, 120)));
    sizeRow.appendChild(mkBtn('－', '缩小', () => stepResize(d, -120)));
    popMenu.appendChild(sizeRow);

    triggerBtn.onclick = (e) => {
      e.stopPropagation();
      const show = popMenu.style.display === 'none';
      popMenu.style.display = show ? 'block' : 'none';
      triggerBtn.style.opacity = show ? '1' : '0.45';
      triggerBtn.style.background = show ? 'rgba(20,20,30,0.88)' : 'rgba(0,0,0,0.65)';
    };

    doc.addEventListener('mousedown', (e) => {
      if (!wrap.contains(e.target)) {
        popMenu.style.display = 'none';
        triggerBtn.style.opacity = '0.45';
        triggerBtn.style.background = 'rgba(0,0,0,0.65)';
        triggerBtn.style.borderColor = 'rgba(255,255,255,0.25)';
      }
    });

    wrap.appendChild(triggerBtn);
    wrap.appendChild(popMenu);
    doc.body.appendChild(wrap);
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


  function snapDockWindow(d, zone) {
    const win = d.win;
    if (!win) return;
    if (zone === 'restore') {
      if (d.snapSavedBounds) {
        const b = d.snapSavedBounds;
        try {
          if (win.moveTo && b.left != null && b.top != null) win.moveTo(b.left, b.top);
          if (win.resizeTo && b.width && b.height) win.resizeTo(b.width, b.height);
        } catch (e) {}
        d.isMaximized = false;
        if (d.fsBtn) { d.fsBtn.textContent = '\u5168\u5c4f'; d.fsBtn.title = '\u575e\u7a97\u53e3\u5168\u5c4f / \u9000\u51fa\u5168\u5c4f'; }
      }
      return;
    }

    if (!d.snapSavedBounds) {
      d.snapSavedBounds = {
        left: (typeof win.screenX === 'number' ? win.screenX : win.screenLeft) ?? 100,
        top: (typeof win.screenY === 'number' ? win.screenY : win.screenTop) ?? 100,
        width: win.outerWidth || win.innerWidth || 820,
        height: win.outerHeight || win.innerHeight || 462,
      };
    }

    const screenObj = (win && win.screen) || (typeof screen !== 'undefined' ? screen : null);
    const sw = (screenObj && (screenObj.availWidth || screenObj.width)) || 1920;
    const sh = (screenObj && (screenObj.availHeight || screenObj.height)) || 1080;
    const sl = (screenObj && screenObj.availLeft !== undefined ? screenObj.availLeft : 0) || 0;
    const st = (screenObj && screenObj.availTop !== undefined ? screenObj.availTop : 0) || 0;
    const hw = Math.floor(sw / 2);
    const hh = Math.floor(sh / 2);

    let target = null;
    if (zone === 'left')        target = { x: sl,      y: st,      w: hw,     h: sh };
    else if (zone === 'right')  target = { x: sl + hw, y: st,      w: sw - hw, h: sh };
    else if (zone === 'top')    target = { x: sl,      y: st,      w: sw,     h: hh };
    else if (zone === 'bottom') target = { x: sl,      y: st + hh, w: sw,     h: sh - hh };
    else if (zone === 'tl')     target = { x: sl,      y: st,      w: hw,     h: hh };
    else if (zone === 'tr')     target = { x: sl + hw, y: st,      w: sw - hw, h: hh };
    else if (zone === 'bl')     target = { x: sl,      y: st + hh, w: hw,     h: sh - hh };
    else if (zone === 'br')     target = { x: sl + hw, y: st + hh, w: sw - hw, h: sh - hh };
    else if (zone === 'max')    target = { x: sl,      y: st,      w: sw,     h: sh };

    if (!target) return;
    try {
      if (win.moveTo) win.moveTo(target.x, target.y);
      if (win.resizeTo) win.resizeTo(target.w, target.h);
      setTimeout(() => {
        try {
          if (win.moveTo) win.moveTo(target.x, target.y);
          if (win.resizeTo) win.resizeTo(target.w, target.h);
        } catch (e) {}
      }, 60);
    } catch (e) {
      log('snapDockWindow failed', e);
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

    // 绑定原生 video 自身事件，严格只刷新此 card 内部的 bar，互不干扰
    const sync = () => { if (card.bar && card.bar._sync) card.bar._sync(); };
    media.addEventListener('timeupdate', (e) => {
      e.stopPropagation();
      sync();
    });
    media.addEventListener('play', (e) => {
      e.stopPropagation();
      sync();
    });
    media.addEventListener('pause', (e) => {
      e.stopPropagation();
      sync();
    });
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
        seek: (t) => {
          try {
            if (Number.isFinite(t)) {
              v.currentTime = Math.max(0, t);
              v.dispatchEvent(new Event('seeking'));
            }
          } catch (e) {
            log('seek error:', e);
          }
        },
        speed: (r) => { v.playbackRate = r; },
        volume: (x) => { v.volume = Math.min(1, Math.max(0, x)); }, // 不要动 muted：源页静音由 hideCrossSourceVideo 统一管
        paused: () => v.paused,
        time: () => v.currentTime,
        duration: () => v.duration,
      };
    }
    return {
      toggle: () => relay('toggle'),
      seek: (t) => {
        try { card.lastSync.currentTime = t; } catch (e) {}
        relay('seek', Math.max(0, t));
      },
      speed: (r) => relay('speed', r),
      volume: (x) => {
        try {
          card.media.volume = Math.min(1, Math.max(0, x));
          card.media.muted = x <= 0;
        } catch (e) {}
        relay('volume', x);
      },
      paused: () => (card.lastSync ? card.lastSync.paused : card.media.paused),
      time: () => (card.lastSync ? card.lastSync.currentTime : card.media.currentTime),
      duration: () => (card.lastSync && card.lastSync.duration) || (card.meta && card.meta.duration) || card.media.duration || 0,
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

    let isSeeking = false;
    const commitSeek = () => {
      const dur = ctl.duration();
      if (dur > 0 && Number.isFinite(dur)) {
        const target = (Number(seek.value) / 1000) * dur;
        ctl.seek(target);
      }
    };

    seek.addEventListener('mousedown', (e) => { e.stopPropagation(); isSeeking = true; });
    seek.addEventListener('touchstart', (e) => { e.stopPropagation(); isSeeking = true; }, { passive: true });
    seek.addEventListener('input', (e) => {
      e.stopPropagation();
      const dur = ctl.duration();
      if (dur > 0 && Number.isFinite(dur)) {
        const preview = (Number(seek.value) / 1000) * dur;
        timeLabel.textContent = fmtTime(preview) + ' / ' + fmtTime(dur);
      }
      commitSeek();
    });
    seek.addEventListener('change', (e) => {
      e.stopPropagation();
      isSeeking = false;
      commitSeek();
      sync();
    });
    seek.addEventListener('mouseup', (e) => {
      e.stopPropagation();
      if (isSeeking) {
        isSeeking = false;
        commitSeek();
        sync();
      }
    });
    seek.addEventListener('touchend', (e) => {
      e.stopPropagation();
      if (isSeeking) {
        isSeeking = false;
        commitSeek();
        sync();
      }
    });

    vol.addEventListener('click', (e) => e.stopPropagation());
    vol.addEventListener('input', (e) => {
      e.stopPropagation();
      ctl.volume(Number(vol.value));
    });

    const sync = () => {
      if (isSeeking) return; // 正在拖动进度条时不被播放回调强制打断
      const dur = ctl.duration();
      const t = ctl.time();
      playBtn.textContent = ctl.paused() ? '\u25b6' : '\u23f8';
      if (dur > 0 && Number.isFinite(dur)) {
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
  /** 坞窗整窗不可见（最小化/被完全遮挡）时，把所有 WebRTC 卡片一起挂起。
   *  与单卡全屏挂起共用 wasSuspended 标记，避免互相"误唤醒"。 */
  function setAllRtcSuspended(d, on) {
    if (!d) return;
    const changed = d.allSuspended !== on;
    d.allSuspended = on;
    (d.cards || []).forEach((c) => {
      if (c.kind !== 'rtc' || !c.ctl || !c.ctl.suspend) return;
      if (on) c.ctl.suspend(true);
      else if (!c.wasSuspended) c.ctl.suspend(false);
    });
    if (changed) log('dock window', on ? 'hidden -> suspend all rtc cards' : 'visible -> resume');
  }

  function watchDockVisibility(d) {
    const doc = d && d.doc;
    if (!doc || typeof doc.addEventListener !== 'function') return;
    const sync = () => setAllRtcSuspended(d, doc.visibilityState === 'hidden');
    doc.addEventListener('visibilitychange', sync, false);
    try {
      if (d.win && typeof d.win.addEventListener === 'function') {
        d.win.addEventListener('pagehide', () => setAllRtcSuspended(d, true), false);
        d.win.addEventListener('pageshow', sync, false);
      }
    } catch (e) { /* cross-origin guard */ }
    sync();
  }

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
        // 隐藏的 WebRTC 卡片不要继续全速采集+编码
        if (c.kind === 'rtc' && c.ctl && c.ctl.suspend) {
          c.wasSuspended = true;
          c.ctl.suspend(true);
        }
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
      if (c.kind === 'rtc' && c.wasSuspended && c.ctl && c.ctl.suspend) {
        c.wasSuspended = false;
        c.ctl.suspend(false);
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
      seek: (t) => {
        try { card.lastSync.currentTime = t; } catch (e) {}
        relay('seek', Math.max(0, t));
      },
      speed: (r) => relay('speed', r),
      volume: (x) => {
        try {
          card.media.volume = Math.min(1, Math.max(0, x));
          card.media.muted = x <= 0;
        } catch (e) {}
        relay('volume', x);
      },
      suspend: (on) => relay('suspend', !!on),
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
    if (d.allSuspended && card.ctl && card.ctl.suspend) card.ctl.suspend(true);
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
    if (d.allSuspended && card.ctl && card.ctl.suspend) card.ctl.suspend(true);
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

  /* ---------------- 源端"后台降帧"对策（默认关闭，可测量再开） ----------------
   * 疑似链路：原视频被 muted=true + opacity:0 且标签页不可见时，Chrome 会把它当作
   * "无声的后台视频"，把解码降到 1~5fps，captureStream 抓到幻灯片。
   * 打开方式（视频页控制台执行后刷新页面）：
   *   localStorage.setItem('__multipip__:audioKeepAlive','gain')  // WebAudio 零增益
   *   localStorage.setItem('__multipip__:audioKeepAlive','tiny')  // 保留音量 0.001
   *   localStorage.removeItem('__multipip__:audioKeepAlive')      // 关闭（默认）
   * 风险：WebAudio 接管后，部分 DRM 站点或 captureStream 的音轨可能失效 —— 所以默认不开。
   * 判断依据：mpStats 打印的 src 帧率（见 README「性能诊断」）。 */
  const AUDIO_KEEPALIVE = (() => {
    try { return (localStorage.getItem(NS + ':audioKeepAlive') || '').toLowerCase(); } catch (e) { return ''; }
  })();
  const silentAudio = new WeakMap();

  function applySilentMute(video, silent) {
    const mode = AUDIO_KEEPALIVE;
    if (!mode) {
      video.muted = silent;
      return;
    }
    if (mode === 'tiny') {
      video.muted = false;
      if (silent) {
        if (video._mpOrigVolume === undefined) video._mpOrigVolume = video.volume;
        video.volume = 0.001;
      } else if (video._mpOrigVolume !== undefined) {
        video.volume = video._mpOrigVolume;
        video._mpOrigVolume = undefined;
      }
      return;
    }
    let rec = silentAudio.get(video);
    if (silent) {
      if (rec) { try { rec.gain.gain.value = 0; } catch (e) {} return; }
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { video.muted = true; return; }
        const ctx = new AC();
        const src = ctx.createMediaElementSource(video);
        const gain = ctx.createGain();
        gain.gain.value = 0;
        src.connect(gain);
        gain.connect(ctx.destination);
        if (ctx.state === 'suspended') {
          const pr = ctx.resume();
          if (pr && pr.catch) pr.catch(() => {});
        }
        silentAudio.set(video, { ctx, src, gain });
        video.muted = false;
        log('audio keep-alive: zero-gain WebAudio mute');
      } catch (e) {
        log('audio keep-alive failed, fallback muted=true:', e && e.message);
        video.muted = true;
      }
      return;
    }
    if (rec) {
      try { rec.gain.gain.value = 1; } catch (e) {}
      return;
    }
    video.muted = false;
  }

  /* 音频唯一性原则（审计结论）：
   *   - 走 WebRTC 的模式（坞窗跨标签 / 无边框伴侣窗）：音频随 stream 进入小窗播放，
   *     源页由 applySilentMute(true) 静音 —— 只有小窗出声。
   *   - 同页 adopt（坞窗 direct / 拆窗）：不搬家、不静音，源页自己出声。
   *   - 因此任何控制指令都【不能】去解除源页静音，否则立刻变成双声。
   *     （历史上 volume 指令里的 v.muted = x <= 0 就是这个坑，已移除。） */
  function hideCrossSourceVideo(video) {
    if (!video || video._mpCrossHidden) return;
    video._mpCrossHidden = true;
    video._mpOrigOpacity = video.style.opacity;
    video._mpOrigMuted = video.muted;

    // 1. 原页面自身静音，杜绝原页面和小窗双重声音
    applySilentMute(video, true);

    // 2. 原视频画面透明（保留解码与 captureStream 捕获），避免原页面和小窗双重画面
    video.style.opacity = '0';

    // 3. 原视频位置放置占位提示
    const placeholder = document.createElement('div');
    placeholder.tabIndex = 0;
    placeholder.setAttribute('data-mp-cross-ph', '1');
    placeholder.textContent = '\u89c6\u9891\u5df2\u5f39\u51fa\u5230\u7f6e\u9876\u5c0f\u7a97\u64ad\u653e \u00b7 \u70b9\u51fb\u6216\u6309\u7a7a\u683c/Esc\u53ec\u56de';
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
      outline: 'none',
    });
    const doRecall = () => {
      if (companionPopped.has(video)) recallCompanion(video);
      else recallCrossDock(video);
    };
    placeholder.addEventListener('click', doRecall);
    placeholder.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        doRecall();
      }
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
    if (video._mpOrigMuted !== undefined) {
      if (AUDIO_KEEPALIVE) applySilentMute(video, false);
      else video.muted = video._mpOrigMuted;
    }

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
    // 必须在 createOffer 之前设定：本地回环默认选 VP8（纯 CPU 软编）
    preferHardwareH264(pc);

    let dockOwnerId = null;
    const who = await bgSend({ type: 'mp-dock-who' });
    if (who && who.ok && who.ownerTabId != null) {
      dockOwnerId = who.ownerTabId;
    }

    if (dockOwnerId == null) {
      log('no open dock window found for cross-tab WebRTC stream, fallback to native PiP');
      try { pc.close(); } catch (e) {}
      popOutNative(video);
      toast('\u5f53\u524d\u65e0\u5df2\u5f00\u542f\u7684\u7f6e\u9876\u5c0f\u7a97\uff0c\u5df2\u4f7f\u7528\u753b\u4e2d\u753b\u5f39\u51fa', 3200);
      return;
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

    rtcConnections.set(connId, { pc, video, stream, syncTimer, dockOwnerId, targetW: 0 });
    mpStats.watch('dock-src#' + connId, pc, video, 'out');
    retuneAllRtcSenders();
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
        mpStats.unwatch('dock-src#' + connId);
        restoreCrossSourceVideo(video);
        dockCrossPopped.delete(video);
        dockCrossIds.delete(video);
        refreshStates();
        log('mp-rtc-offer send failed, falling back to native PiP');
        popOutNative(video);
      } else {
        hideCrossSourceVideo(video);
      }
    } catch (err) {
      clearInterval(syncTimer);
      pc.close();
      rtcConnections.delete(connId);
      mpStats.unwatch('dock-src#' + connId);
      restoreCrossSourceVideo(video);
      dockCrossPopped.delete(video);
      dockCrossIds.delete(video);
      refreshStates();
      log('WebRTC offer negotiation error, falling back to native PiP:', err);
      popOutNative(video);
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
    mpStats.unwatch('dock-src#' + connId);
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
      if (e.key === 'Escape') {
        e.preventDefault();
        restoreVideo(video);
      }
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (video.paused) video.play().catch(() => {});
        else video.pause();
      }
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

  /* ---------------------- keyboard shortcuts on page ---------------------- */
  document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

    // 1. ESC: 召回当前弹出的视频（取消弹出）
    if (e.key === 'Escape') {
      const hasActive = Boolean(
        (dock && !dock.win.closed) ||
        nativePopped.size > 0 ||
        companionPopped.size > 0 ||
        dockCrossPopped.size > 0
        || soloPopped.size > 0
      );
      if (hasActive) {
        e.preventDefault();
        recallDock();
        for (const v of Array.from(nativePopped)) recallNative(v);
        for (const v of Array.from(companionPopped.keys())) recallCompanion(v);
        for (const v of Array.from(dockCrossPopped)) recallCrossDock(v);
        for (const [sv, srec] of Array.from(soloPopped)) {
          bgSend({ type: 'mp-solo-recall', token: srec.token });
          teardownSolo(sv);
        }
        refreshStates();
        toast('\u5df2\u53ec\u56de\u89c6\u9891\u81f3\u539f\u9875\u9762', 1500);
        return;
      }
    }

    // 2. 空格键: 切换当前已弹出视频的播放 / 暂停
    if (e.key === ' ' || e.code === 'Space') {
      if (dock && !dock.win.closed && dock.cards && dock.cards.length > 0) {
        e.preventDefault();
        const card = dock.focused || dock.cards[0];
        if (card && card.ctl) {
          card.ctl.toggle();
          if (card.bar && typeof card.bar._sync === 'function') card.bar._sync();
          toast(card.ctl.paused() ? '\u5df2\u6682\u505c \u23f8' : '\u7ee7\u7eed\u64ad\u653e \u25b6', 1000);
        }
        return;
      }
      if (lastPopped && (nativePopped.has(lastPopped) || companionPopped.has(lastPopped) || homes.has(lastPopped))) {
        e.preventDefault();
        if (lastPopped.paused) {
          playSourceVideo(lastPopped);
          toast('\u7ee7\u7eed\u64ad\u653e \u25b6', 1000);
        } else {
          pauseSourceVideo(lastPopped);
          toast('\u5df2\u6682\u505c \u23f8', 1000);
        }
        return;
      }
    }

    // 3. 方向键左右: 快退 / 快进 5 秒
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const delta = e.key === 'ArrowLeft' ? -5 : 5;
      if (dock && !dock.win.closed && dock.cards && dock.cards.length > 0) {
        e.preventDefault();
        const card = dock.focused || dock.cards[0];
        if (card && card.ctl) {
          card.ctl.seek(Math.max(0, card.ctl.time() + delta));
          if (card.bar && typeof card.bar._sync === 'function') card.bar._sync();
          toast(delta < 0 ? '\u5feb\u9000 -5s ⏪' : '\u5feb\u8fdb +5s ⏩', 800);
        }
        return;
      }
      if (lastPopped && (nativePopped.has(lastPopped) || companionPopped.has(lastPopped) || homes.has(lastPopped))) {
        e.preventDefault();
        try {
          lastPopped.currentTime = Math.max(0, lastPopped.currentTime + delta);
          toast(delta < 0 ? '\u5feb\u9000 -5s ⏪' : '\u5feb\u8fdb +5s ⏩', 800);
        } catch (err) {}
        return;
      }
    }
  }, true);

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

  const MODE_TITLES = {
    dock: '❖ 原生小窗 (多视频坞)',
    native: '🗔 原生画中画',
    companion: '🗗 无边框原生窗',
    solo: '原生拆窗：把视频所在的标签页整体挑进置顶 popup 小窗（同一个页面实例，不重载、不编码）：零重编码、零画质损耗、支持 DRM、可无限多开。代价：整个标签页被搬走（不能同时留在原页刷评论）',
    solo: '🧲 原生拆窗',
  };

  function updateAllBadgesUI() {
    for (const b of badges.values()) {
      if (b && typeof b._updateUI === 'function') b._updateUI();
    }
  }

  function ensureBadge(video) {
    let b = badges.get(video);
    if (b) return b;
    b = document.createElement('div');
    b.className = NS + 'badge-wrap';
    Object.assign(b.style, {
      position: 'absolute',
      display: 'none',
      pointerEvents: 'auto',
      zIndex: '2147483646',
      userSelect: 'none',
      font: '12px/1.5 system-ui, "Microsoft YaHei", sans-serif',
      opacity: '0',
      transition: 'opacity .15s ease',
    });

    const pill = document.createElement('div');
    Object.assign(pill.style, {
      display: 'inline-flex',
      alignItems: 'center',
      borderRadius: '8px',
      background: 'rgba(12,12,20,.88)',
      backdropFilter: 'blur(8px)',
      border: '1px solid rgba(255,255,255,.24)',
      boxShadow: '0 3px 14px rgba(0,0,0,.5)',
      overflow: 'hidden',
    });

    const cur = modeStore.get();
    const btnMain = document.createElement('button');
    btnMain.textContent = (cur === 'dock' ? '🎬 原生小窗' : cur === 'native' ? '🗔 原生画中画' : '🗗 无边框窗');
    btnMain.title = '弹出播放（当前：' + (MODE_TITLES[cur] || '原生小窗') + '）';
    Object.assign(btnMain.style, {
      cursor: 'pointer',
      border: 'none',
      background: 'transparent',
      color: '#fff',
      padding: '4px 8px 4px 10px',
      font: 'inherit',
      fontWeight: '600',
      fontSize: '12px',
      whiteSpace: 'nowrap',
    });
    btnMain.addEventListener('mouseenter', () => { btnMain.style.background = 'rgba(109,92,255,.8)'; });
    btnMain.addEventListener('mouseleave', () => { btnMain.style.background = 'transparent'; });
    btnMain.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      menu.style.display = 'none';
      hideBadge(b);
      popOut(video);
    });

    const btnArrow = document.createElement('button');
    btnArrow.textContent = '▾';
    btnArrow.title = '选择弹出模式（小窗/画中画/无边框）';
    Object.assign(btnArrow.style, {
      cursor: 'pointer',
      border: 'none',
      borderLeft: '1px solid rgba(255,255,255,.2)',
      background: 'transparent',
      color: 'rgba(255,255,255,.85)',
      padding: '4px 8px',
      font: 'inherit',
      fontSize: '11px',
    });
    btnArrow.addEventListener('mouseenter', () => { btnArrow.style.background = 'rgba(255,255,255,.2)'; });
    btnArrow.addEventListener('mouseleave', () => { btnArrow.style.background = 'transparent'; });

    const menu = document.createElement('div');
    Object.assign(menu.style, {
      position: 'absolute',
      top: 'calc(100% + 4px)',
      right: '0',
      display: 'none',
      width: '185px',
      padding: '5px',
      borderRadius: '8px',
      background: 'rgba(16,18,26,0.96)',
      backdropFilter: 'blur(10px)',
      border: '1px solid rgba(255,255,255,.25)',
      boxShadow: '0 8px 24px rgba(0,0,0,.65)',
      zIndex: '999999',
    });

    function renderMenu() {
      menu.innerHTML = '';
      const cur = modeStore.get();
      [
        ['dock', '❖ 原生小窗 (多视频坞)'],
        ['native', '🗔 原生画中画'],
        ['companion', '🗗 无边框原生窗'],
        ['solo', '🧲 原生拆窗 (零重编码置顶)'],
      ].forEach(([k, label]) => {
        const item = document.createElement('div');
        item.textContent = (cur === k ? '✓ ' : '  ') + label;
        Object.assign(item.style, {
          padding: '6px 8px',
          borderRadius: '5px',
          color: '#fff',
          cursor: 'pointer',
          fontSize: '11.5px',
          fontWeight: cur === k ? '600' : 'normal',
          background: cur === k ? 'rgba(109,92,255,.35)' : 'transparent',
          whiteSpace: 'nowrap',
        });
        item.addEventListener('mouseenter', () => { item.style.background = 'rgba(255,255,255,.18)'; });
        item.addEventListener('mouseleave', () => {
          item.style.background = cur === k ? 'rgba(109,92,255,.35)' : 'transparent';
        });
        item.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          modeStore.set(k);
          menu.style.display = 'none';
          hideBadge(b);
          popOut(video, k);
        });
        menu.appendChild(item);
      });
    }

    const toggleMenu = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const show = menu.style.display === 'none';
      if (show) renderMenu();
      menu.style.display = show ? 'block' : 'none';
    };

    btnArrow.addEventListener('click', toggleMenu);
    b.addEventListener('contextmenu', toggleMenu);

    b.addEventListener('mouseenter', () => { b.dataset.hover = '1'; });
    b.addEventListener('mouseleave', () => {
      b.dataset.hover = '';
      menu.style.display = 'none';
      hideBadge(b);
    });

    pill.append(btnMain, btnArrow);
    b.append(pill, menu);
    b._updateUI = () => {
      const c = modeStore.get();
      btnMain.textContent = (c === 'dock' ? '🎬 原生小窗' : c === 'native' ? '🗔 原生画中画' : '🗗 无边框窗');
      btnMain.title = '弹出播放（当前：' + (MODE_TITLES[c] || '原生小窗') + '）';
    };

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
    if (typeof b._updateUI === 'function') b._updateUI();
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

  /** 鼠标移入有效视频画面的「右上角区域」时显示控制气泡 */
  function findTopRightCornerVideo(clientX, clientY) {
    if (document.fullscreenElement || document.webkitFullscreenElement) return null;
    const list = getCachedVideos();
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v.isConnected || isVideoPopped(v)) continue;
      const r = v.getBoundingClientRect();
      if (r.width < 160 || r.height < 90) continue;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      // 容错度更好的右上区域热区：右侧 45% 或 280px，上方 35% 或 120px
      const zoneW = Math.max(160, Math.min(280, r.width * 0.45));
      const zoneH = Math.max(64, Math.min(120, r.height * 0.35));
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
        r.width < 160 || r.height < 90 ||
        r.bottom < 0 || r.top > innerHeight ||
        r.right < 0 || r.left > innerWidth
      ) {
        hideBadge(b);
        continue;
      }
      const bw = b.offsetWidth || 110;
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
  let reportedTabVideoCount = 0;

  const fab = document.createElement('div');
  fab.id = NS + 'fab';
  Object.assign(fab.style, {
    position: 'fixed',
    right: '16px',
    bottom: '22px',
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
    borderRadius: '999px',
    background: 'linear-gradient(135deg,#6d5cff,#3aa0ff)',
    boxShadow: '0 4px 18px rgba(60,60,220,.4)',
    opacity: '0.85',
    transition: 'all .2s cubic-bezier(.2,.8,.2,1)',
    overflow: 'hidden',
    userSelect: 'none',
  });

  const fabBtn = document.createElement('button');
  fabBtn.textContent = '\ud83c\udfac \u591a\u7a97\u64ad\u653e';
  fabBtn.title = '\u5c55\u5f00/\u6536\u8d77\u591a\u7a97\u64ad\u653e\u9762\u677f';
  Object.assign(fabBtn.style, {
    cursor: 'pointer',
    border: 'none',
    padding: '8px 10px 8px 13px',
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
    padding: '8px 10px 8px 8px',
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
    marginRight: '0px',
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
      fabPill.style.opacity = '1';
      fabPill.style.transform = 'scale(1.04)';
      fabPill.style.boxShadow = '0 6px 22px rgba(80,80,255,.55)';
    } else {
      fabPill.style.opacity = '0.85';
      fabPill.style.transform = 'scale(1)';
      fabPill.style.boxShadow = '0 4px 18px rgba(60,60,220,.4)';
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
    const count = typeof videoCount === 'number'
      ? videoCount
      : Math.max(collectVideos().length, reportedTabVideoCount);
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

  // ------------------------- 原生拆窗：窗口平铺 + 宿主状态 -------------------------
  const soloTools = document.createElement('div');
  Object.assign(soloTools.style, {
    display: 'none',
    alignItems: 'center',
    gap: '6px',
    margin: '0 4px 8px',
    padding: '6px',
    background: 'rgba(255,255,255,0.06)',
    borderRadius: '8px',
    flexWrap: 'wrap',
  });

  const soloLabel = document.createElement('span');
  soloLabel.textContent = '拆窗窗口:';
  Object.assign(soloLabel.style, { fontSize: '12px', opacity: '.8', whiteSpace: 'nowrap' });
  soloTools.appendChild(soloLabel);

  const soloCountText = document.createElement('span');
  soloCountText.textContent = '0 个';
  Object.assign(soloCountText.style, { fontSize: '12px', opacity: '.9', whiteSpace: 'nowrap' });
  soloTools.appendChild(soloCountText);

  const mkSoloTool = (label, title, onClick) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    Object.assign(b.style, {
      cursor: 'pointer',
      border: '1px solid rgba(255,255,255,.2)',
      background: 'rgba(255,255,255,.1)',
      color: '#fff',
      borderRadius: '6px',
      padding: '4px 8px',
      font: 'inherit',
      fontSize: '11.5px',
      whiteSpace: 'nowrap',
    });
    b.addEventListener('click', onClick);
    return b;
  };

  soloTools.appendChild(mkSoloTool('\u5bab\u683c\u5e73\u94fa', '\u628a\u6240\u6709\u62c6\u7a97\u7a97\u53e3\u6309\u5bab\u683c\u5e73\u94fa\u5230\u5f53\u524d\u5c4f\u5e55', () => {
    bgSend({ type: 'mp-solo-tile', mode: 'grid' }).then((r) => {
      if (!r || !r.ok) toast('\u5e73\u94fa\u5931\u8d25\uff1a' + ((r && r.error) || '\u5bbf\u4e3b\u672a\u8fde\u63a5'), 5000);
      else toast('\u5df2\u5e73\u94fa ' + r.count + ' \u4e2a\u62c6\u7a97\u7a97\u53e3');
    });
  }));

  soloTools.appendChild(mkSoloTool('\u6a2a\u6392', '\u6240\u6709\u62c6\u7a97\u7a97\u53e3\u4e00\u5b57\u6a2a\u5411\u6392\u5f00', () => {
    bgSend({ type: 'mp-solo-tile', mode: 'row' }).then((r) => {
      if (!r || !r.ok) toast('\u6392\u5217\u5931\u8d25\uff1a' + ((r && r.error) || '\u5bbf\u4e3b\u672a\u8fde\u63a5'), 5000);
      else toast('\u5df2\u6392\u5217 ' + r.count + ' \u4e2a\u62c6\u7a97\u7a97\u53e3');
    });
  }));

  // 宿主没装/没连上时，直接把状态顶在面板上，省得去翻控制台
  const soloHostState = document.createElement('span');
  Object.assign(soloHostState.style, { fontSize: '11px', opacity: '.75', whiteSpace: 'nowrap' });
  soloTools.appendChild(soloHostState);

  async function refreshSoloTools() {
    const info = await bgSend({ type: 'mp-solo-info' });
    const n = info && typeof info.count === 'number' ? info.count : 0;
    soloCountText.textContent = n + ' \u4e2a';
    soloTools.style.display = n > 0 ? 'flex' : 'none';
    if (n <= 0) return;
    const ping = await bgSend({ type: 'mp-win-ping' });
    const ok = !!(ping && ping.ok);
    soloHostState.textContent = ok
      ? '\u5bbf\u4e3b\u5df2\u8fde\u63a5'
      : '\u5bbf\u4e3b\u672a\u8fde\u63a5\uff08\u8bf7\u8fd0\u884c companion/register_host.bat\uff09';
    soloHostState.style.color = ok ? '#7fd7a5' : '#ff9b9b';
  }

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
    } else if (mode === 'snap_half_left') {
      // 单窗或多窗贴靠左半屏
      const w = Math.floor(screenW * 0.5);
      const h = Math.floor(screenH / count);
      ids.forEach((id, i) => windows.push({ id, x: 0, y: i * h, width: w, height: h }));
    } else if (mode === 'snap_half_right') {
      // 单窗或多窗贴靠右半屏
      const w = Math.floor(screenW * 0.5);
      const h = Math.floor(screenH / count);
      ids.forEach((id, i) => windows.push({ id, x: w, y: i * h, width: screenW - w, height: h }));
    } else if (mode === 'snap_quarter_tl') {
      // 贴靠左上角 1/4
      const w = Math.floor(screenW * 0.5);
      const h = Math.floor(screenH * 0.5);
      windows.push({ id: ids[0], x: 0, y: 0, width: w, height: h });
    } else if (mode === 'snap_quarter_tr') {
      // 贴靠右上角 1/4
      const w = Math.floor(screenW * 0.5);
      const h = Math.floor(screenH * 0.5);
      windows.push({ id: ids[0], x: w, y: 0, width: screenW - w, height: h });
    } else if (mode === 'snap_quarter_br') {
      // 贴靠右下角 1/4
      const w = Math.floor(screenW * 0.5);
      const h = Math.floor(screenH * 0.5);
      windows.push({ id: ids[0], x: w, y: h, width: screenW - w, height: screenH - h });
    }

    bgSend({ type: 'mp-companion-layout', windows }).then((r) => {
      log('companion layout sent to', windows.length, 'windows, resp:', r);
    });
    toast('已完成 ' + count + ' 窗自动排版！');
  }

  [
    ['均分平铺', 'grid', '将当前所有无边框窗按网格平分整个屏幕（如 2x2 四开、3x2 六开）'],
    ['左右对分', 'split_v', '左右等宽平分屏幕'],
    ['左半', 'snap_half_left', '将当前窗口贴靠至屏幕左半边 (1/2)'],
    ['右半', 'snap_half_right', '将当前窗口贴靠至屏幕右半边 (1/2)'],
    ['右上1/4', 'snap_quarter_tr', '将当前窗口贴靠至右上角 (1/4)'],
    ['右下1/4', 'snap_quarter_br', '将当前窗口贴靠至右下角 (1/4)'],
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
    [['dock', '❖ \u539f\u751f\u5c0f\u7a97'], ['native', '🗔 \u539f\u751f\u753b\u4e2d\u753b'], ['companion', '🗗 \u65e0\u8fb9\u6846\u7a97'], ['solo', '🧲 拆窗']].forEach(([key, label]) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = MODE_HINT[key];
      const active = cur === key;
      Object.assign(b.style, {
        flex: '1',
        cursor: 'pointer',
        border: 'none',
        borderRadius: '8px',
        padding: '7px 0',
        font: 'inherit',
        fontSize: '11.5px',
        fontWeight: active ? '600' : 'normal',
        color: '#fff',
        background:
          active
            ? 'linear-gradient(135deg,#6d5cff,#3aa0ff)'
            : 'rgba(255,255,255,.12)',
        boxShadow: active ? '0 2px 10px rgba(109,92,255,.45)' : 'none',
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
    panel.appendChild(soloTools);
    refreshSoloTools();
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
        else if (soloPopped.has(v)) bgSend({ type: 'mp-solo-recall', token: soloPopped.get(v).token });
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
        : soloPopped.size
          ? '原生拆窗：' + soloPopped.size + ' 个视频'
        : companionPopped.size
          ? '\u65e0\u8fb9\u6846\u7a97\uff1a' + companionPopped.size + ' \u4e2a\u89c6\u9891'
          : '\u672a\u5f00\u542f';
    if (companionLayoutBar) {
      companionLayoutBar.style.display = 'flex';
    }
    panelRows.forEach(({ v, info, btn, recallBtn, speedBtn }, i) => {
      const size = v.videoWidth ? `${v.videoWidth}x${v.videoHeight}` : '\u5c3a\u5bf8\u672a\u77e5';
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? fmtTime(v.duration) : '\u65f6\u957f\u672a\u77e5';
      const popped = homes.has(v) || nativePopped.has(v) || companionPopped.has(v) || dockCrossPopped.has(v) || soloPopped.has(v);
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
    refreshSoloTools();
  }

  // 定时检测当前页面是否有有效视频，控制边缘悬浮球显隐，并在面板展开时自动刷新状态
  function reportVideosToBg() {
    try {
      const n = collectVideos().length;
      bgSend({ type: 'mp-report-videos', count: n });
    } catch (e) {}
  }
  updateFabVisibility();
  reportVideosToBg();
  setInterval(() => {
    const n = collectVideos().length;
    reportVideosToBg();
    updateFabVisibility(n);
    if (panel.style.display === 'none') return;
    if (n !== lastCount) renderPanel();
    else refreshStates();
  }, 1200);

  // Speed shortcut & popup commands from service worker / toolbar popup
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'mp-cycle-speed') {
        sendResponse({ ok: cycleSpeedOfActive() });
        return true;
      }
      // 原生拆窗：召回时撤销 CSS 隔离；置顶状态回报用来点亮/提示按钮
      if (msg && msg.type === 'mp-solo-restore') {
        const hit = soloVideoByToken(msg.token);
        if (hit) teardownSolo(hit);
        return true;
      }
      if (msg && msg.type === 'mp-solo-error') {
        toast(String(msg.message || '拆窗操作失败'), 6000);
        return true;
      }
      if (msg && msg.type === 'mp-solo-topmost-state') {
        const hit = soloVideoByToken(msg.token);
        const rec = hit ? soloPopped.get(hit) : null;
        if (rec && rec.bar && rec.bar.setTopmostState) rec.bar.setTopmostState(!!msg.ok, msg.error || '');
        return true;
      }
      if (msg && msg.type === 'mp-tab-video-count') {
        reportedTabVideoCount = Number(msg.total) || 0;
        updateFabVisibility();
        return true;
      }
      if (msg && msg.type === 'mp-set-mode') {
        if (msg.mode) {
          modeStore.set(msg.mode);
        }
        return true;
      }
      if (msg && msg.type === 'mp-pop-first') {
        const list = collectVideos();
        if (list.length > 0) popOut(list[0]);
        else toast('\u672c\u9875\u9762\u672a\u53d1\u73b0\u53ef\u5f39\u51fa\u7684\u6709\u6548\u89c6\u9891');
        return true;
      }
      if (msg && msg.type === 'mp-recall-all') {
        recallDock();
        for (const v of Array.from(nativePopped)) recallNative(v);
        for (const v of Array.from(companionPopped.keys())) recallCompanion(v);
        for (const v of Array.from(dockCrossPopped)) recallCrossDock(v);
        for (const [sv, srec] of Array.from(soloPopped)) {
          bgSend({ type: 'mp-solo-recall', token: srec.token });
          teardownSolo(sv);
        }
        refreshStates();
        toast('\u5df2\u53ec\u56de\u5168\u90e8\u89c6\u9891');
        return true;
      }
      // WebRTC Dock Owner: receive offer from source tab
      if (msg && msg.type === 'mp-rtc-offer') {
        if (dock && !dock.win.closed && typeof RTCPeerConnection !== 'undefined') {
          const fromTab = msg.fromTab;
          const connId = msg.connId;
          const remotePc = new RTCPeerConnection({ iceServers: [] });
          const card = addRtcCard(dock, remotePc, msg.meta, fromTab, connId);
          mpStats.watch('dock-in#' + connId, remotePc, card.media, 'in');

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
          conn.pc.setRemoteDescription(new RTCSessionDescription(hqAnswer)).then(async () => {
            const n = await globalStreamCount(rtcConnections.size);
            applyHighQualityRtcSenders(conn.pc, conn.video, conn.targetW, n);
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
            c.kind === 'rtc' &&
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
            try {
              const val = Number(msg.value);
              if (Number.isFinite(val)) {
                v.currentTime = Math.max(0, val);
                v.dispatchEvent(new Event('seeking'));
              }
            } catch (e) {}
            if (!v.paused) playSourceVideo(v);
          }
          else if (msg.op === 'speed') { v.playbackRate = Number(msg.value) || 1; }
          else if (msg.op === 'suspend') {
            // 坞窗里该卡片被隐藏（例如另一张卡片全屏）时，停掉这一路的编码
            const rc = msg.id != null ? rtcConnections.get(msg.id) : null;
            if (rc && rc.pc) setRtcSenderActive(rc.pc, msg.value === false);
          }
          else if (msg.op === 'volume') {
            // 只改音量：源页此时是 opacity:0 的隐藏播放器，一旦被解除静音就会和卡片双声
            const x = Number(msg.value);
            if (!isNaN(x)) v.volume = Math.min(1, Math.max(0, x));
          }
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
            conn.pc.setRemoteDescription(new RTCSessionDescription(hqAnswer)).then(async () => {
              const n = await globalStreamCount(companionPopped.size);
              applyHighQualityRtcSenders(conn.pc, conn.video, conn.targetW, n);
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
              mpStats.unwatch('companion#' + id);
            }
          }
        }
        refreshStates();
      }
    });
  }
})();
