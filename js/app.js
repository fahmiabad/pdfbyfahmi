/**
 * PocketPDF Scanner — mobile document scanner (static, offline-capable PWA)
 *  - Lazy-loaded, self-hosted OpenCV.js for edge detection + perspective dewarp
 *  - Pure-JS fallbacks; heavy pixel work runs in a Web Worker
 *  - Non-destructive pages persisted in IndexedDB (survive reloads / tab kills)
 *  - jsPDF export (lazy-loaded), Web Share API on phones
 */
(function () {
  'use strict';

  // ==================== CONSTANTS ====================
  const APP_VERSION = 'v2.1.0'; // must match sw.js, index.html and css/app.css (see set-version.sh)
  const MAX_SOURCE_DIM = 2200;
  const PROXY_MAX_DIM = 1000;
  const DETECT_MAX_DIM = 500;
  const OPENCV_INIT_TIMEOUT = 60000;
  const OPENCV_IMPORT_WAIT = 25000;

  const OPENCV_URLS = [
    'vendor/opencv.js',
    'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.8.0-release.1/dist/opencv.js',
  ];
  const LIB_URLS = {
    jspdf: 'vendor/jspdf.umd.min.js',
    heic: 'vendor/heic2any.min.js',
  };

  const FILTER_LABELS = {
    original: 'Original',
    magic: 'Bright',
    bw: 'Black & white',
    grayscale: 'Grey',
    lighten: 'Lighter',
  };

  const QUALITY_PRESETS = {
    high: { key: 'high', quality: 0.92, maxDim: 2200, label: 'High' },
    balanced: { key: 'balanced', quality: 0.8, maxDim: 1800, label: 'Balanced' },
    small: { key: 'small', quality: 0.6, maxDim: 1400, label: 'Small File' },
  };

  const PAGE_SIZES_MM = {
    a4: { w: 210, h: 297, label: 'A4' },
    letter: { w: 215.9, h: 279.4, label: 'Letter' },
    fit: { w: 0, h: 0, label: 'Fit' },
  };

  const ASPECTS = {
    auto: { label: 'auto', ratio: 0 },
    a4: { label: 'A4', ratio: 297 / 210 },
    letter: { label: 'Letter', ratio: 11 / 8.5 },
  };
  const ASPECT_ORDER = ['auto', 'a4', 'letter'];

  const SETTINGS_KEY = 'pocketpdf.settings.v1';

  // ==================== STATE ====================
  const state = {
    cvReady: false,
    pages: [],
    lastPdf: null,
    pdfInProgress: false,
  };

  const studio = {
    isOpen: false,
    opening: false,
    pageId: null,
    fromCamera: false,
    step: 'crop',
    rotation: 0,
    corners: defaultInsetCorners(),
    aspect: 'auto',
    filter: 'magic',
    brightness: 0,
    contrast: 0,
    rotatedSourceCanvas: null,
    dewarpedProxyCanvas: null,
    displayRect: { w: 0, h: 0, dpr: 1 },
    drag: null, // { type: 'corner'|'edge', index, pointerId, start:{x,y}, startCorners }
    preview: { running: false, pending: false },
    lastFocus: null,
  };

  // ==================== DOM ====================
  const $ = (id) => document.getElementById(id);
  const el = {
    cameraInput: $('cameraInput'),
    galleryInput: $('galleryInput'),
    takePhotoBtn: $('takePhotoBtn'),
    addPhotosBtn: $('addPhotosBtn'),
    autoScanToggle: $('autoScanToggle'),
    clearAllBtn: $('clearAllBtn'),
    engineStatusPill: $('engineStatusPill'),
    engineStatusDot: $('engineStatusDot'),
    engineStatusText: $('engineStatusText'),
    settingsToggleBtn: $('settingsToggleBtn'),
    settingsBody: $('settingsBody'),
    settingsChevron: $('settingsChevron'),
    settingsSummary: $('settingsSummary'),
    filenameInput: $('filenameInput'),
    pageSizeSelect: $('pageSizeSelect'),
    orientationSelect: $('orientationSelect'),
    marginSelect: $('marginSelect'),
    qualitySelect: $('qualitySelect'),
    mainArea: $('mainArea'),
    emptyState: $('emptyState'),
    queueHeader: $('queueHeader'),
    queueCountLabel: $('queueCountLabel'),
    pageList: $('pageList'),
    createPdfBtn: $('createPdfBtn'),
    createPdfLabel: $('createPdfLabel'),

    studioModal: $('studioModal'),
    studioCloseBtn: $('studioCloseBtn'),
    tabCropBtn: $('tabCropBtn'),
    tabFilterBtn: $('tabFilterBtn'),
    studioPrimaryBtn: $('studioPrimaryBtn'),
    studioCropPane: $('studioCropPane'),
    studioFilterPane: $('studioFilterPane'),
    cropStage: $('cropStage'),
    cropCanvas: $('cropCanvas'),
    cropLoading: $('cropLoading'),
    loupeContainer: $('loupeContainer'),
    loupeCanvas: $('loupeCanvas'),
    cropAutoBtn: $('cropAutoBtn'),
    cropFullBtn: $('cropFullBtn'),
    cropRotateBtn: $('cropRotateBtn'),
    cropAspectBtn: $('cropAspectBtn'),
    cropAspectLabel: $('cropAspectLabel'),
    filterPreviewCanvas: $('filterPreviewCanvas'),
    filterLoadingBadge: $('filterLoadingBadge'),
    filterPills: document.querySelectorAll('.filter-pill'),
    brightnessSlider: $('brightnessSlider'),
    contrastSlider: $('contrastSlider'),
    brightnessVal: $('brightnessVal'),
    contrastVal: $('contrastVal'),
    saveNextBtn: $('saveNextBtn'),

    progressModal: $('progressModal'),
    progressTitle: $('progressTitle'),
    progressStatus: $('progressStatus'),
    progressBar: $('progressBar'),
    confirmClearModal: $('confirmClearModal'),
    cancelClearBtn: $('cancelClearBtn'),
    confirmClearBtn: $('confirmClearBtn'),
    pdfReadyModal: $('pdfReadyModal'),
    pdfReadyMeta: $('pdfReadyMeta'),
    pdfShareBtn: $('pdfShareBtn'),
    pdfDownloadAgainBtn: $('pdfDownloadAgainBtn'),
    pdfReadyCloseBtn: $('pdfReadyCloseBtn'),
    toastContainer: $('toastContainer'),
  };

  // ==================== GENERIC UTILITIES ====================
  function defaultInsetCorners() {
    return [{ x: 0.08, y: 0.08 }, { x: 0.92, y: 0.08 }, { x: 0.92, y: 0.92 }, { x: 0.08, y: 0.92 }];
  }
  function fullPageCorners() {
    return [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  }
  function cloneCorners(c) {
    return c.map((p) => ({ x: p.x, y: p.y }));
  }
  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function nextFrame() {
    return new Promise((r) => setTimeout(r, 25));
  }
  function formatBytes(bytes) {
    if (!bytes) return '0 KB';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1048576).toFixed(2)} MB`;
  }
  function makeId() {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
  function releaseCanvas(c) {
    if (!c) return;
    c.width = 0;
    c.height = 0;
  }
  function ctx2d(canvas) {
    return canvas.getContext('2d', { willReadFrequently: true });
  }
  function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.92) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas export failed'))), type, quality);
    });
  }
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to decode image'));
      img.src = url;
    });
  }

  /** Serial job queue: imports, saves, rotations and PDF export never overlap and never drop input. */
  let jobQueue = Promise.resolve();
  function enqueue(fn) {
    const run = jobQueue.then(() => fn());
    jobQueue = run.catch(() => {});
    return run;
  }

  // ==================== TOASTS (with optional action) ====================
  function showToast(message, type = 'info', duration = 3200, action = null) {
    const colors = {
      info: 'bg-graphite text-white',
      success: 'bg-graphite text-white',
      warning: 'bg-graphite text-white',
      error: 'bg-danger text-white',
    };
    const marks = { success: 'bg-hilite', warning: 'bg-hilite', info: 'bg-white/40', error: 'bg-white' };
    const toast = document.createElement('div');
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.className = `pointer-events-auto pl-4 pr-2 py-2 min-h-[48px] rounded-2xl text-sm font-medium transition-all duration-200 opacity-0 -translate-y-2 flex items-center justify-between gap-3 ${colors[type] || colors.info}`;
    toast.style.boxShadow = '0 12px 28px -10px rgba(30,34,48,0.5)';
    const mark = document.createElement('span');
    mark.className = `w-2 h-2 rounded-full shrink-0 ${marks[type] || marks.info}`;
    toast.appendChild(mark);
    const text = document.createElement('span');
    text.className = 'flex-1 py-1';
    text.textContent = message;
    toast.appendChild(text);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      toast.classList.add('opacity-0', '-translate-y-2');
      setTimeout(() => toast.remove(), 220);
      if (action && action.onExpire) action.onExpire();
    };

    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'shrink-0 min-h-[36px] px-4 rounded-xl bg-hilite text-graphite font-bold text-sm';
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        const onExpire = action.onExpire;
        action.onExpire = null;
        action.onClick();
        close();
        if (onExpire) action.onExpire = onExpire;
      });
      toast.appendChild(btn);
    }

    el.toastContainer.appendChild(toast);
    requestAnimationFrame(() => toast.classList.remove('opacity-0', '-translate-y-2'));
    setTimeout(close, duration);
  }

  function showProgress(title, status, percent) {
    el.progressTitle.textContent = title;
    el.progressStatus.textContent = status;
    const p = Math.max(0, Math.min(100, percent));
    el.progressBar.style.width = `${p}%`;
    el.progressBar.parentElement.setAttribute('aria-valuenow', String(Math.round(p)));
    el.progressModal.classList.remove('hidden');
  }
  function hideProgress() {
    el.progressModal.classList.add('hidden');
  }

  // ==================== MODAL FOCUS MANAGEMENT ====================
  const modalFocus = new Map();
  function openModal(modal, focusTarget) {
    modalFocus.set(modal, document.activeElement);
    modal.classList.remove('hidden');
    requestAnimationFrame(() => {
      const target = focusTarget || modal.querySelector('button:not([disabled]):not(.hidden)');
      if (target) target.focus({ preventScroll: true, focusVisible: false });
    });
  }
  function closeModal(modal) {
    modal.classList.add('hidden');
    const prev = modalFocus.get(modal);
    modalFocus.delete(modal);
    if (prev && document.contains(prev) && typeof prev.focus === 'function') prev.focus({ preventScroll: true });
  }
  function trapFocus(e) {
    if (e.key !== 'Tab') return;
    const modal = [el.confirmClearModal, el.pdfReadyModal, el.studioModal].find((m) => !m.classList.contains('hidden'));
    if (!modal) return;
    const items = Array.from(modal.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])')).filter(
      (n) => !n.disabled && n.offsetParent !== null
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    } else if (!modal.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  }

  // ==================== LAZY SCRIPT LOADING ====================
  const scriptPromises = {};
  function loadScript(src) {
    if (!scriptPromises[src]) {
      scriptPromises[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => {
          delete scriptPromises[src];
          s.remove();
          reject(new Error(`Failed to load ${src}`));
        };
        document.head.appendChild(s);
      });
    }
    return scriptPromises[src];
  }

  // ==================== OPENCV (LAZY) ====================
  function setEngineStatus(mode) {
    const base = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold ';
    const modes = {
      idle: ['bg-sheet text-muted', 'bg-line', 'Auto-crop starts on first scan'],
      loading: ['bg-sheet text-muted', 'bg-ultra animate-pulse', 'Starting auto-crop'],
      ready: ['bg-hilite text-graphite', 'bg-graphite', 'Auto-crop ready'],
      manual: ['bg-sheet text-muted', 'bg-line', 'Manual crop'],
    };
    const [pill, dot, text] = modes[mode] || modes.idle;
    el.engineStatusPill.className = base + pill;
    el.engineStatusDot.className = 'w-2 h-2 rounded-full ' + dot;
    el.engineStatusText.textContent = text;
    state.cvReady = mode === 'ready';
  }

  function waitForCvRuntime(timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        resolve(ok);
      };
      const c = window.cv;
      if (!c) return finish(false);
      if (typeof c.Mat === 'function') return finish(true);

      // Never resolve a Promise *with* the Emscripten module (its .then causes an infinite loop)
      if (typeof c.then === 'function') {
        try {
          c.then((mod) => {
            if (mod && typeof mod.Mat === 'function') window.cv = mod;
            finish(!!(window.cv && typeof window.cv.Mat === 'function'));
          });
        } catch (_) { /* fall back to polling */ }
      } else {
        const prev = c.onRuntimeInitialized;
        c.onRuntimeInitialized = () => {
          if (typeof prev === 'function') prev();
          finish(true);
        };
      }

      const start = Date.now();
      timer = setInterval(() => {
        if (window.cv && typeof window.cv.Mat === 'function') finish(true);
        else if (Date.now() - start > timeoutMs) finish(false);
      }, 200);
    });
  }

  let cvPromise = null;
  /** Loads OpenCV once. Falls back to the next URL only on a network error, never after a successful download. */
  function ensureOpenCV() {
    if (cvPromise) return cvPromise;
    setEngineStatus('loading');
    cvPromise = (async () => {
      for (const url of OPENCV_URLS) {
        try {
          await loadScript(url);
        } catch (_) {
          continue;
        }
        const ok = await waitForCvRuntime(OPENCV_INIT_TIMEOUT);
        setEngineStatus(ok ? 'ready' : 'manual');
        return ok;
      }
      setEngineStatus('manual');
      return false;
    })();
    return cvPromise;
  }

  /**
   * Auto-crop is on by default: start loading OpenCV as soon as the page has settled.
   * After the first visit it comes from the offline cache, so it's ready in a second or two.
   * Skipped only when the phone's Data Saver is on (it then loads on the first scan instead).
   */
  function preloadOpenCV() {
    const conn = navigator.connection;
    if (conn && conn.saveData) return;
    const start = () => ensureOpenCV();
    const schedule = () => {
      if ('requestIdleCallback' in window) window.requestIdleCallback(start, { timeout: 2000 });
      else setTimeout(start, 800);
    };
    if (document.readyState === 'complete') schedule();
    else window.addEventListener('load', schedule, { once: true });
  }

  // ==================== WEB WORKER ====================
  const worker = {
    w: null,
    seq: 0,
    jobs: new Map(),
    init() {
      if (location.protocol === 'file:' || typeof Worker === 'undefined') return;
      try {
        this.w = new Worker('js/worker.js');
        this.w.onmessage = (e) => {
          const { id, ok, result, error } = e.data || {};
          const job = this.jobs.get(id);
          if (!job) return;
          this.jobs.delete(id);
          ok ? job.resolve(result) : job.reject(new Error(error));
        };
        this.w.onerror = (e) => {
          console.warn('Worker error, falling back to main thread', e);
          this.jobs.forEach((j) => j.reject(new Error('worker failed')));
          this.jobs.clear();
          try { this.w.terminate(); } catch (_) {}
          this.w = null;
        };
      } catch (err) {
        console.warn('Worker unavailable:', err);
        this.w = null;
      }
    },
    call(op, args, transfer) {
      if (!this.w) return Promise.reject(new Error('no worker'));
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.jobs.set(id, { resolve, reject });
        this.w.postMessage({ id, op, args }, transfer || []);
      });
    },
  };

  /** Filter src canvas into target canvas (worker when possible). */
  async function filterCanvas(src, target, filterType, brightness = 0, contrast = 0) {
    const w = src.width;
    const h = src.height;
    if (filterType === 'original' && !brightness && !contrast) {
      target.width = w;
      target.height = h;
      target.getContext('2d').drawImage(src, 0, 0);
      return;
    }
    const sctx = ctx2d(src);
    let out = null;
    if (worker.w) {
      try {
        const img = sctx.getImageData(0, 0, w, h);
        const res = await worker.call(
          'filter',
          { buffer: img.data.buffer, w, h, filter: filterType, brightness, contrast },
          [img.data.buffer]
        );
        out = new Uint8ClampedArray(res.buffer);
      } catch (err) {
        console.warn('Worker filter failed, retrying on main thread:', err);
      }
    }
    if (!out) {
      const img = sctx.getImageData(0, 0, w, h);
      window.Imaging.filter(img.data, w, h, filterType, brightness, contrast);
      out = img.data;
    }
    target.width = w;
    target.height = h;
    ctx2d(target).putImageData(new ImageData(out, w, h), 0, 0);
  }

  // ==================== GEOMETRY ====================
  async function createRotatedCanvas(url, rotation, maxDim = MAX_SOURCE_DIM) {
    const img = await loadImage(url);
    const rot = ((rotation % 360) + 360) % 360;
    const swap = rot === 90 || rot === 270;
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    const scale = longest > maxDim ? maxDim / longest : 1;
    const drawW = Math.max(1, Math.round(img.naturalWidth * scale));
    const drawH = Math.max(1, Math.round(img.naturalHeight * scale));

    const c = document.createElement('canvas');
    c.width = swap ? drawH : drawW;
    c.height = swap ? drawW : drawH;
    const ctx = ctx2d(c);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    return c;
  }

  function rotateCornersCW(corners) {
    const r = corners.map((p) => ({ x: 1 - p.y, y: p.x }));
    return [r[3], r[0], r[1], r[2]];
  }

  /** Orders 4 points as [TL, TR, BR, BL] by angle around the centroid (robust for tilted pages). */
  function orderCorners(pts) {
    const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
    const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
    const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    // sorted is clockwise in screen coords starting near -180°; rotate so TL (min x+y) comes first
    let start = 0;
    for (let i = 1; i < 4; i++) {
      if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
    }
    return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]);
  }

  function quadArea(c) {
    let a = 0;
    for (let i = 0; i < 4; i++) {
      const p = c[i], q = c[(i + 1) % 4];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  }

  function isFullPage(c) {
    const e = 0.002;
    return Math.abs(c[0].x) < e && Math.abs(c[0].y) < e && Math.abs(c[1].x - 1) < e && Math.abs(c[1].y) < e &&
      Math.abs(c[2].x - 1) < e && Math.abs(c[2].y - 1) < e && Math.abs(c[3].x) < e && Math.abs(c[3].y - 1) < e;
  }

  // ==================== EDGE DETECTION (OpenCV) ====================
  function detectDocumentCorners(sourceCanvas) {
    if (!state.cvReady || typeof window.cv === 'undefined') {
      return { corners: defaultInsetCorners(), detected: false };
    }
    const cv = window.cv;
    const scale = Math.min(1, DETECT_MAX_DIM / Math.max(sourceCanvas.width, sourceCanvas.height));
    const w = Math.max(1, Math.round(sourceCanvas.width * scale));
    const h = Math.max(1, Math.round(sourceCanvas.height * scale));
    const small = document.createElement('canvas');
    small.width = w;
    small.height = h;
    ctx2d(small).drawImage(sourceCanvas, 0, 0, w, h);

    const minArea = w * h * 0.15;
    const maxArea = w * h * 0.98;
    let src = null, gray = null, blurred = null, edged = null, dilated = null, kernel = null, contours = null, hierarchy = null;

    try {
      src = cv.imread(small);
      gray = new cv.Mat();
      blurred = new cv.Mat();
      edged = new cv.Mat();
      dilated = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

      const passes = [{ low: 50, high: 150, kSize: 3 }, { low: 25, high: 90, kSize: 5 }];
      for (const pass of passes) {
        cv.Canny(blurred, edged, pass.low, pass.high);
        if (kernel) kernel.delete();
        kernel = cv.Mat.ones(pass.kSize, pass.kSize, cv.CV_8U);
        cv.dilate(edged, dilated, kernel);
        if (contours) contours.delete();
        if (hierarchy) hierarchy.delete();
        contours = new cv.MatVector();
        hierarchy = new cv.Mat();
        cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

        const candidates = [];
        for (let i = 0; i < contours.size(); i++) {
          const cnt = contours.get(i);
          const area = cv.contourArea(cnt);
          if (area >= minArea && area <= maxArea) candidates.push({ index: i, area });
          cnt.delete();
        }
        candidates.sort((a, b) => b.area - a.area);

        for (let j = 0; j < Math.min(8, candidates.length); j++) {
          const cnt = contours.get(candidates[j].index);
          const approx = new cv.Mat();
          try {
            cv.approxPolyDP(cnt, approx, 0.02 * cv.arcLength(cnt, true), true);
            if (approx.rows === 4 && cv.isContourConvex(approx)) {
              const pts = [];
              for (let k = 0; k < 4; k++) {
                pts.push({ x: clamp01(approx.data32S[k * 2] / w), y: clamp01(approx.data32S[k * 2 + 1] / h) });
              }
              return { corners: orderCorners(pts), detected: true };
            }
          } finally {
            approx.delete();
            cnt.delete();
          }
        }
      }
      return { corners: defaultInsetCorners(), detected: false };
    } catch (err) {
      console.warn('OpenCV edge detection error:', err);
      return { corners: defaultInsetCorners(), detected: false };
    } finally {
      [src, gray, blurred, edged, dilated, kernel, contours, hierarchy].forEach((m) => m && m.delete());
      releaseCanvas(small);
    }
  }

  // ==================== PERSPECTIVE DEWARP ====================
  /** Output size from edge lengths, optionally snapped to a real paper ratio. */
  function computeOutputSize(pts, maxOutDim, aspect) {
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let outW = Math.max(10, Math.max(dist(pts[0], pts[1]), dist(pts[3], pts[2])));
    let outH = Math.max(10, Math.max(dist(pts[0], pts[3]), dist(pts[1], pts[2])));
    const ratio = (ASPECTS[aspect] || ASPECTS.auto).ratio;
    if (ratio) {
      // Keep the longer measured side, derive the other from the paper ratio
      if (outW >= outH) outH = outW / ratio;
      else outW = outH / ratio;
    }
    const scale = Math.min(1, maxOutDim / Math.max(outW, outH));
    return {
      outW: Math.max(10, Math.round(outW * scale)),
      outH: Math.max(10, Math.round(outH * scale)),
    };
  }

  async function perspectiveDewarp(sourceCanvas, corners, maxOutDim = MAX_SOURCE_DIM, aspect = 'auto') {
    const sw = sourceCanvas.width;
    const sh = sourceCanvas.height;
    const pts = corners.map((p) => ({ x: p.x * sw, y: p.y * sh }));
    const { outW, outH } = computeOutputSize(pts, maxOutDim, aspect);

    const out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;

    if (isFullPage(corners)) {
      const ctx = ctx2d(out);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(sourceCanvas, 0, 0, outW, outH);
      return out;
    }

    if (state.cvReady && window.cv) {
      const cv = window.cv;
      let srcMat = null, dstMat = null, srcTri = null, dstTri = null, M = null;
      try {
        srcMat = cv.imread(sourceCanvas);
        dstMat = new cv.Mat();
        srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, pts.flatMap((p) => [p.x, p.y]));
        dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]);
        M = cv.getPerspectiveTransform(srcTri, dstTri);
        cv.warpPerspective(srcMat, dstMat, M, new cv.Size(outW, outH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
        cv.imshow(out, dstMat);
        return out;
      } catch (err) {
        console.warn('OpenCV warpPerspective failed, using JS fallback:', err);
      } finally {
        [srcMat, dstMat, srcTri, dstTri, M].forEach((m) => m && m.delete());
      }
    }

    // Pure-JS homography (in the worker when available)
    let data = null;
    if (worker.w) {
      try {
        const srcImg = ctx2d(sourceCanvas).getImageData(0, 0, sw, sh);
        const res = await worker.call('dewarp', { buffer: srcImg.data.buffer, sw, sh, pts, outW, outH }, [srcImg.data.buffer]);
        data = new Uint8ClampedArray(res.buffer);
      } catch (err) {
        console.warn('Worker dewarp failed, retrying on main thread:', err);
      }
    }
    if (!data) {
      const srcImg = ctx2d(sourceCanvas).getImageData(0, 0, sw, sh);
      data = window.Imaging.dewarp(srcImg.data, sw, sh, pts, outW, outH);
    }
    ctx2d(out).putImageData(new ImageData(data, outW, outH), 0, 0);
    return out;
  }

  // ==================== PERSISTENCE (IndexedDB + localStorage) ====================
  const DB = (() => {
    let dbPromise = null;
    let warned = false;
    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
        const req = indexedDB.open('pocketpdf', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbPromise;
    }
    async function run(storeNames, mode, fn) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, mode);
        let result;
        try {
          result = fn(tx);
        } catch (e) {
          reject(e);
          return;
        }
        tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }
    function safe(p) {
      return p.catch((err) => {
        if (!warned) {
          warned = true;
          console.warn('Storage unavailable — pages will not survive a reload.', err);
          showToast('This browser can’t store pages, so they’ll be lost if you close the app.', 'warning', 4500);
        }
      });
    }
    function serialize(p) {
      return {
        id: p.id, name: p.name, sourceBlob: p.sourceBlob, rotation: p.rotation, corners: p.corners,
        aspect: p.aspect, filter: p.filter, brightness: p.brightness, contrast: p.contrast,
        processedBlob: p.processedBlob, processedWidth: p.processedWidth, processedHeight: p.processedHeight,
      };
    }
    return {
      savePage: (p) => safe(run(['pages'], 'readwrite', (tx) => tx.objectStore('pages').put(serialize(p)))),
      deletePage: (id) => safe(run(['pages'], 'readwrite', (tx) => tx.objectStore('pages').delete(id))),
      saveOrder: (ids) => safe(run(['meta'], 'readwrite', (tx) => tx.objectStore('meta').put(ids, 'order'))),
      clear: () => safe(run(['pages', 'meta'], 'readwrite', (tx) => {
        tx.objectStore('pages').clear();
        tx.objectStore('meta').clear();
      })),
      async loadAll() {
        const pages = await run(['pages'], 'readonly', (tx) => tx.objectStore('pages').getAll());
        const order = await run(['meta'], 'readonly', (tx) => tx.objectStore('meta').get('order'));
        return { pages: pages || [], order: order || [] };
      },
    };
  })();

  function persistOrder() {
    DB.saveOrder(state.pages.map((p) => p.id));
  }

  async function restoreSession() {
    try {
      const { pages, order } = await DB.loadAll();
      if (!pages.length) return;
      const byId = new Map(pages.map((p) => [p.id, p]));
      const ordered = order.filter((id) => byId.has(id)).map((id) => byId.get(id));
      pages.forEach((p) => { if (!order.includes(p.id)) ordered.push(p); });

      ordered.forEach((rec) => {
        if (!rec.sourceBlob || !rec.processedBlob) return;
        state.pages.push({
          ...rec,
          aspect: rec.aspect || 'auto',
          sourceUrl: URL.createObjectURL(rec.sourceBlob),
          processedUrl: URL.createObjectURL(rec.processedBlob),
          processedSize: rec.processedBlob.size,
          processedType: rec.processedBlob.type,
        });
      });
      if (state.pages.length) {
        renderPageList();
        showToast(`Restored ${state.pages.length} ${state.pages.length === 1 ? 'page' : 'pages'} from your last session`, 'info', 3000);
      }
    } catch (err) {
      console.warn('Could not restore session:', err);
    }
  }

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      if (s.pageSize && PAGE_SIZES_MM[s.pageSize]) el.pageSizeSelect.value = s.pageSize;
      if (s.orientation) el.orientationSelect.value = s.orientation;
      if (s.margin != null) el.marginSelect.value = String(s.margin);
      if (s.quality && QUALITY_PRESETS[s.quality]) el.qualitySelect.value = s.quality;
      if (typeof s.autoScan === 'boolean') el.autoScanToggle.checked = s.autoScan;
    } catch (_) { /* ignore */ }
  }
  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        pageSize: el.pageSizeSelect.value,
        orientation: el.orientationSelect.value,
        margin: el.marginSelect.value,
        quality: el.qualitySelect.value,
        autoScan: el.autoScanToggle.checked,
      }));
    } catch (_) { /* private mode */ }
  }

  // ==================== PAGE RENDERING ====================
  /** Renders a page's non-destructive settings into its processed output (JPEG, or lossless PNG for B&W). */
  async function renderPageOutput(page, prebuiltRotatedCanvas = null) {
    const rot = prebuiltRotatedCanvas || (await createRotatedCanvas(page.sourceUrl, page.rotation, MAX_SOURCE_DIM));
    let dewarped = null;
    let filtered = null;
    try {
      dewarped = await perspectiveDewarp(rot, page.corners, MAX_SOURCE_DIM, page.aspect);
      filtered = document.createElement('canvas');
      await filterCanvas(dewarped, filtered, page.filter, page.brightness, page.contrast);
      const isBW = page.filter === 'bw';
      const blob = await canvasToBlob(filtered, isBW ? 'image/png' : 'image/jpeg', 0.92);
      if (page.processedUrl) URL.revokeObjectURL(page.processedUrl);
      page.processedBlob = blob;
      page.processedUrl = URL.createObjectURL(blob);
      page.processedWidth = filtered.width;
      page.processedHeight = filtered.height;
      page.processedSize = blob.size;
      page.processedType = blob.type;
    } finally {
      if (!prebuiltRotatedCanvas) releaseCanvas(rot);
      releaseCanvas(dewarped);
      releaseCanvas(filtered);
    }
  }

  // ==================== IMPORT PIPELINE ====================
  function isHeicFile(file) {
    const type = (file.type || '').toLowerCase();
    const name = (file.name || '').toLowerCase();
    return type === 'image/heic' || type === 'image/heif' || name.endsWith('.heic') || name.endsWith('.heif');
  }

  function handleIncomingFiles(fileList, fromCamera = false) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    return enqueue(() => importFiles(files, fromCamera));
  }

  async function importFiles(files, fromCamera) {
    const autoScan = el.autoScanToggle.checked;
    const wantDetect = autoScan || fromCamera;
    const added = [];
    let failed = 0;

    showProgress('Adding pages', `Page 1 of ${files.length}`, 6);
    await nextFrame();

    try {
      if (wantDetect && !state.cvReady) {
        showProgress('Starting auto-crop', 'This only takes a moment the first time.', 8);
        await Promise.race([ensureOpenCV(), sleep(OPENCV_IMPORT_WAIT)]);
      }

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const heic = isHeicFile(file);
        showProgress(
          heic ? 'Converting photo' : wantDetect && state.cvReady ? 'Cleaning up' : 'Adding photo',
          `Page ${i + 1} of ${files.length}`,
          Math.round(((i + 0.4) / files.length) * 90)
        );
        await nextFrame();

        let workingBlob = file;
        let displayName = file.name || `scan_${Date.now()}.jpg`;

        if (heic) {
          try {
            await loadScript(LIB_URLS.heic);
            const conv = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
            workingBlob = Array.isArray(conv) ? conv[0] : conv;
            displayName = displayName.replace(/\.(heic|heif)$/i, '.jpg');
          } catch (err) {
            console.warn('HEIC conversion failed:', err);
            failed++;
            continue;
          }
        } else if (file.type && !file.type.startsWith('image/')) {
          failed++;
          continue;
        }

        const rawUrl = URL.createObjectURL(workingBlob);
        let sourceCanvas = null;
        try {
          sourceCanvas = await createRotatedCanvas(rawUrl, 0, MAX_SOURCE_DIM);
          const sourceBlob = await canvasToBlob(sourceCanvas, 'image/jpeg', 0.93);

          let corners = fullPageCorners();
          let filter = 'original';
          if (wantDetect && state.cvReady) {
            corners = detectDocumentCorners(sourceCanvas).corners;
            filter = 'magic';
          } else if (autoScan) {
            filter = 'magic';
          }

          const page = {
            id: makeId(),
            name: displayName,
            sourceBlob,
            sourceUrl: URL.createObjectURL(sourceBlob),
            rotation: 0,
            corners,
            aspect: 'auto',
            filter,
            brightness: 0,
            contrast: 0,
            processedUrl: null,
            processedBlob: null,
            processedWidth: sourceCanvas.width,
            processedHeight: sourceCanvas.height,
            processedSize: sourceBlob.size,
            processedType: 'image/jpeg',
          };
          await renderPageOutput(page, sourceCanvas);
          state.pages.push(page);
          added.push(page);
          DB.savePage(page);
        } catch (err) {
          console.warn('Failed to import photo:', err);
          failed++;
        } finally {
          URL.revokeObjectURL(rawUrl);
          releaseCanvas(sourceCanvas);
        }
      }
    } finally {
      hideProgress();
      renderPageList();
      persistOrder();
    }

    if (fromCamera && added.length === 1) {
      openStudio(added[0].id, { fromCamera: true });
    } else if (added.length > 0) {
      const note = failed > 0 ? ` (${failed} skipped)` : '';
      showToast(`Added ${added.length} ${added.length === 1 ? 'page' : 'pages'}${note}`, 'success', 2600);
    } else if (failed > 0) {
      showToast('Those files couldn’t be opened. Try JPG, PNG or HEIC photos.', 'error', 3500);
    }
  }

  // ==================== STUDIO ====================
  async function openStudio(pageId, opts = {}) {
    if (studio.isOpen || studio.opening) return;
    const page = state.pages.find((p) => p.id === pageId);
    if (!page) return;
    studio.opening = true;

    studio.pageId = pageId;
    studio.fromCamera = !!opts.fromCamera;
    studio.step = 'crop';
    studio.rotation = page.rotation;
    studio.corners = cloneCorners(page.corners);
    studio.aspect = page.aspect || 'auto';
    studio.filter = page.filter;
    studio.brightness = page.brightness;
    studio.contrast = page.contrast;
    studio.drag = null;

    el.brightnessSlider.value = String(studio.brightness);
    el.contrastSlider.value = String(studio.contrast);
    el.brightnessVal.textContent = String(studio.brightness);
    el.contrastVal.textContent = String(studio.contrast);
    el.saveNextBtn.classList.toggle('hidden', !studio.fromCamera);
    updateFilterPillUI();
    updateAspectUI();

    // Show the modal immediately with a spinner, then decode
    releaseCanvas(studio.rotatedSourceCanvas);
    releaseCanvas(studio.dewarpedProxyCanvas);
    studio.rotatedSourceCanvas = null;
    studio.dewarpedProxyCanvas = null;
    el.cropCanvas.width = 0;
    el.cropCanvas.height = 0;
    el.cropLoading.classList.remove('hidden');
    openModal(el.studioModal, el.studioPrimaryBtn);
    document.body.style.overflow = 'hidden';
    studio.isOpen = true;
    setStudioStep('crop', { skipDraw: true });

    try {
      studio.rotatedSourceCanvas = await createRotatedCanvas(page.sourceUrl, studio.rotation, MAX_SOURCE_DIM);
      if (!studio.isOpen) {
        releaseCanvas(studio.rotatedSourceCanvas);
        studio.rotatedSourceCanvas = null;
        return;
      }
      el.cropLoading.classList.add('hidden');
      requestAnimationFrame(resizeAndDrawCropCanvas);
    } catch (err) {
      console.error('Could not open page:', err);
      showToast('This page couldn’t be opened. Try scanning it again.', 'error', 3000);
      closeStudio();
    } finally {
      studio.opening = false;
    }

    // Warm up OpenCV in the background for the Auto-Detect button
    ensureOpenCV();
  }

  function closeStudio() {
    studio.isOpen = false;
    studio.pageId = null;
    studio.drag = null;
    el.loupeContainer.classList.add('hidden');
    el.cropLoading.classList.add('hidden');
    closeModal(el.studioModal);
    document.body.style.overflow = '';
    releaseCanvas(studio.rotatedSourceCanvas);
    releaseCanvas(studio.dewarpedProxyCanvas);
    studio.rotatedSourceCanvas = null;
    studio.dewarpedProxyCanvas = null;
  }

  async function setStudioStep(step, opts = {}) {
    studio.step = step;
    const isCrop = step === 'crop';
    el.studioCropPane.classList.toggle('hidden', !isCrop);
    el.studioFilterPane.classList.toggle('hidden', isCrop);
    el.tabCropBtn.setAttribute('aria-selected', String(isCrop));
    el.tabFilterBtn.setAttribute('aria-selected', String(!isCrop));
    el.studioPrimaryBtn.textContent = isCrop ? 'Next' : 'Save page';

    if (opts.skipDraw) return;
    if (isCrop) requestAnimationFrame(resizeAndDrawCropCanvas);
    else await prepareFilterPreview();
  }

  function updateAspectUI() {
    const label = ASPECTS[studio.aspect].label;
    el.cropAspectLabel.textContent = `Shape: ${label}`;
    el.cropAspectBtn.setAttribute('aria-label', `Page shape: ${studio.aspect === 'auto' ? 'as photographed' : label}. Tap to change`);
  }

  function resizeAndDrawCropCanvas() {
    if (!studio.isOpen || studio.step !== 'crop' || !studio.rotatedSourceCanvas) return;
    const stageRect = el.cropStage.getBoundingClientRect();
    const maxW = Math.max(100, stageRect.width - 24);
    const maxH = Math.max(100, stageRect.height - 24);
    const src = studio.rotatedSourceCanvas;
    const ratio = src.width / src.height;
    let dispW = maxW;
    let dispH = dispW / ratio;
    if (dispH > maxH) {
      dispH = maxH;
      dispW = dispH * ratio;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.cropCanvas.style.width = `${Math.round(dispW)}px`;
    el.cropCanvas.style.height = `${Math.round(dispH)}px`;
    el.cropCanvas.width = Math.round(dispW * dpr);
    el.cropCanvas.height = Math.round(dispH * dpr);
    studio.displayRect = { w: dispW, h: dispH, dpr };
    drawCropOverlay();
  }

  function edgeMidpoints(corners) {
    return corners.map((c, i) => {
      const n = corners[(i + 1) % 4];
      return { x: (c.x + n.x) / 2, y: (c.y + n.y) / 2 };
    });
  }

  function drawCropOverlay() {
    const src = studio.rotatedSourceCanvas;
    if (!src) return;
    const { w, h, dpr } = studio.displayRect;
    const ctx = el.cropCanvas.getContext('2d');
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.drawImage(src, 0, 0, w, h);

    const pts = studio.corners.map((p) => ({ x: p.x * w, y: p.y * h }));

    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(23, 27, 38, 0.66)';
    ctx.fill('evenodd');

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.strokeStyle = '#FFE14D';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    const drag = studio.drag;

    // Edge midpoint handles (pill shaped, aligned to the edge)
    edgeMidpoints(studio.corners).forEach((m, i) => {
      const a = pts[i];
      const b = pts[(i + 1) % 4];
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const active = drag && drag.type === 'edge' && drag.index === i;
      ctx.save();
      ctx.translate(m.x * w, m.y * h);
      ctx.rotate(angle);
      ctx.beginPath();
      const rw = active ? 30 : 26;
      const rh = active ? 12 : 10;
      if (ctx.roundRect) ctx.roundRect(-rw / 2, -rh / 2, rw, rh, rh / 2);
      else ctx.rect(-rw / 2, -rh / 2, rw, rh);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = active ? '#FFFFFF' : '#FFE14D';
      ctx.stroke();
      ctx.restore();
    });

    // Corner handles
    pts.forEach((p, idx) => {
      const active = drag && drag.type === 'corner' && drag.index === idx;
      ctx.beginPath();
      ctx.arc(p.x, p.y, active ? 17 : 14, 0, Math.PI * 2);
      ctx.fillStyle = active ? 'rgba(255, 225, 77, 0.45)' : 'rgba(255, 225, 77, 0.25)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, active ? 9 : 8, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = active ? '#FFFFFF' : '#FFE14D';
      ctx.stroke();
    });
    ctx.restore();
  }

  /** Floating 2.5x magnifier. focus = normalized point; neighbors = normalized points to draw lines toward. */
  function updateLoupe(clientX, clientY, focus, neighbors) {
    const src = studio.rotatedSourceCanvas;
    if (!src || !focus) return;
    const size = 116;
    const half = size / 2;

    let left = clientX - half;
    let top = clientY - size - 42;
    left = Math.max(10, Math.min(window.innerWidth - size - 10, left));
    if (top < 64) top = clientY + 46;
    el.loupeContainer.style.left = `${left}px`;
    el.loupeContainer.style.top = `${top}px`;
    el.loupeContainer.classList.remove('hidden');

    const lCtx = el.loupeCanvas.getContext('2d');
    const { w, h } = studio.displayRect;
    const zoom = 2.5;
    const cropW = (size / zoom) * (src.width / w);
    const cropH = (size / zoom) * (src.height / h);
    const kx = size / cropW;
    const ky = size / cropH;

    // Clamp the source rect to the image (Safari draws nothing for out-of-bounds source rects)
    let sx = focus.x * src.width - cropW / 2;
    let sy = focus.y * src.height - cropH / 2;
    let sw = cropW, sh = cropH, dx = 0, dy = 0, dw = size, dh = size;
    if (sx < 0) { dx = -sx * kx; dw -= dx; sw += sx; sx = 0; }
    if (sy < 0) { dy = -sy * ky; dh -= dy; sh += sy; sy = 0; }
    if (sx + sw > src.width) { const o = sx + sw - src.width; sw -= o; dw -= o * kx; }
    if (sy + sh > src.height) { const o = sy + sh - src.height; sh -= o; dh -= o * ky; }

    lCtx.fillStyle = '#171B26';
    lCtx.fillRect(0, 0, size, size);
    if (sw > 0 && sh > 0 && dw > 0 && dh > 0) lCtx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);

    lCtx.strokeStyle = '#FFE14D';
    lCtx.lineWidth = 2;
    neighbors.forEach((nb) => {
      lCtx.beginPath();
      lCtx.moveTo(half, half);
      lCtx.lineTo(half + (nb.x - focus.x) * w * zoom, half + (nb.y - focus.y) * h * zoom);
      lCtx.stroke();
    });

    lCtx.strokeStyle = 'rgba(255,255,255,0.9)';
    lCtx.lineWidth = 1.5;
    lCtx.beginPath();
    lCtx.moveTo(half - 14, half); lCtx.lineTo(half + 14, half);
    lCtx.moveTo(half, half - 14); lCtx.lineTo(half, half + 14);
    lCtx.stroke();
    lCtx.beginPath();
    lCtx.arc(half, half, 3, 0, Math.PI * 2);
    lCtx.fillStyle = '#FFE14D';
    lCtx.fill();
  }

  function loupeForDrag(clientX, clientY) {
    const d = studio.drag;
    if (!d) return;
    const c = studio.corners;
    if (d.type === 'corner') {
      updateLoupe(clientX, clientY, c[d.index], [c[(d.index + 3) % 4], c[(d.index + 1) % 4]]);
    } else {
      const a = c[d.index];
      const b = c[(d.index + 1) % 4];
      updateLoupe(clientX, clientY, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, [a, b]);
    }
  }

  function onCropPointerDown(e) {
    if (!studio.isOpen || studio.step !== 'crop' || !studio.rotatedSourceCanvas || studio.drag) return;
    const rect = el.cropCanvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    let best = null;
    let bestDist = 44;
    studio.corners.forEach((c, i) => {
      const d = Math.hypot(c.x * rect.width - px, c.y * rect.height - py);
      if (d < bestDist) { bestDist = d; best = { type: 'corner', index: i }; }
    });
    if (!best) {
      bestDist = 36;
      edgeMidpoints(studio.corners).forEach((m, i) => {
        const d = Math.hypot(m.x * rect.width - px, m.y * rect.height - py);
        if (d < bestDist) { bestDist = d; best = { type: 'edge', index: i }; }
      });
    }
    if (!best) return;

    e.preventDefault();
    studio.drag = {
      ...best,
      pointerId: e.pointerId,
      start: { x: px / rect.width, y: py / rect.height },
      startCorners: cloneCorners(studio.corners),
    };
    el.cropCanvas.setPointerCapture(e.pointerId);
    drawCropOverlay();
    loupeForDrag(e.clientX, e.clientY);
  }

  function onCropPointerMove(e) {
    const d = studio.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    e.preventDefault();
    const rect = el.cropCanvas.getBoundingClientRect();
    const nx = clamp01((e.clientX - rect.left) / rect.width);
    const ny = clamp01((e.clientY - rect.top) / rect.height);

    if (d.type === 'corner') {
      studio.corners[d.index] = { x: nx, y: ny };
    } else {
      const i = d.index;
      const j = (i + 1) % 4;
      const a = d.startCorners[i];
      const b = d.startCorners[j];
      let dx = nx - d.start.x;
      let dy = ny - d.start.y;
      dx = Math.max(Math.max(-a.x, -b.x), Math.min(Math.min(1 - a.x, 1 - b.x), dx));
      dy = Math.max(Math.max(-a.y, -b.y), Math.min(Math.min(1 - a.y, 1 - b.y), dy));
      studio.corners[i] = { x: a.x + dx, y: a.y + dy };
      studio.corners[j] = { x: b.x + dx, y: b.y + dy };
    }
    drawCropOverlay();
    loupeForDrag(e.clientX, e.clientY);
  }

  function onCropPointerUp(e) {
    const d = studio.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    studio.drag = null;
    el.loupeContainer.classList.add('hidden');
    const ordered = orderCorners(studio.corners);
    // Reject collapsed quads (e.g. all corners dragged to one spot)
    studio.corners = quadArea(ordered) < 0.002 ? d.startCorners : ordered;
    drawCropOverlay();
  }

  /** Live filter preview on a <=1000px proxy; latest-wins so slider drags stay smooth. */
  async function prepareFilterPreview() {
    if (!studio.rotatedSourceCanvas) return;
    el.filterLoadingBadge.classList.remove('hidden');
    await nextFrame();
    try {
      releaseCanvas(studio.dewarpedProxyCanvas);
      studio.dewarpedProxyCanvas = await perspectiveDewarp(studio.rotatedSourceCanvas, studio.corners, PROXY_MAX_DIM, studio.aspect);
      await renderLiveFilterPreview();
    } finally {
      el.filterLoadingBadge.classList.add('hidden');
    }
  }

  async function renderLiveFilterPreview() {
    if (!studio.dewarpedProxyCanvas) return;
    if (studio.preview.running) {
      studio.preview.pending = true;
      return;
    }
    studio.preview.running = true;
    try {
      do {
        studio.preview.pending = false;
        const src = studio.dewarpedProxyCanvas;
        if (!src) break;
        const tmp = document.createElement('canvas');
        await filterCanvas(src, tmp, studio.filter, studio.brightness, studio.contrast);
        if (studio.isOpen && studio.step === 'filter') {
          el.filterPreviewCanvas.width = tmp.width;
          el.filterPreviewCanvas.height = tmp.height;
          el.filterPreviewCanvas.getContext('2d').drawImage(tmp, 0, 0);
        }
        releaseCanvas(tmp);
      } while (studio.preview.pending);
    } finally {
      studio.preview.running = false;
    }
  }

  function updateFilterPillUI() {
    el.filterPills.forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.filter === studio.filter)));
  }

  function saveStudioEdits() {
    const page = state.pages.find((p) => p.id === studio.pageId);
    if (!page) {
      closeStudio();
      return Promise.resolve();
    }
    // Snapshot the edits + source canvas, then close the studio straight away
    const edits = {
      rotation: studio.rotation,
      corners: cloneCorners(studio.corners),
      aspect: studio.aspect,
      filter: studio.filter,
      brightness: studio.brightness,
      contrast: studio.contrast,
    };
    const rotCanvas = studio.rotatedSourceCanvas;
    studio.rotatedSourceCanvas = null; // hand ownership to the job
    closeStudio();

    return enqueue(async () => {
      showProgress('Saving page', 'Applying your changes', 55);
      await nextFrame();
      try {
        Object.assign(page, edits);
        await renderPageOutput(page, rotCanvas);
        DB.savePage(page);
        renderPageList();
        showToast('Page saved', 'success', 1800);
      } catch (err) {
        console.error('Save page failed:', err);
        showToast('Changes weren’t saved. Try again.', 'error', 3500);
      } finally {
        releaseCanvas(rotCanvas);
        hideProgress();
      }
    });
  }

  // ==================== PAGE LIST ====================
  function movePage(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= state.pages.length) return;
    [state.pages[index], state.pages[target]] = [state.pages[target], state.pages[index]];
    renderPageList();
    persistOrder();
    const btn = el.pageList.children[target] && el.pageList.children[target].querySelector(delta < 0 ? '[data-act="left"]' : '[data-act="right"]');
    if (btn && !btn.disabled) btn.focus({ preventScroll: true });
  }

  function rotatePageCard(pageId) {
    return enqueue(async () => {
      const index = state.pages.findIndex((p) => p.id === pageId);
      const page = state.pages[index];
      if (!page) return;
      showProgress('Rotating page', `Page ${index + 1}`, 50);
      await nextFrame();
      try {
        page.rotation = (page.rotation + 90) % 360;
        page.corners = rotateCornersCW(page.corners);
        await renderPageOutput(page);
        DB.savePage(page);
        renderPageList();
      } catch (err) {
        console.error('Rotate failed:', err);
        showToast('The page couldn’t be rotated. Try again.', 'error', 3000);
      } finally {
        hideProgress();
      }
    });
  }

  function revokePage(p) {
    if (p.sourceUrl) URL.revokeObjectURL(p.sourceUrl);
    if (p.processedUrl) URL.revokeObjectURL(p.processedUrl);
  }

  function deletePage(pageId) {
    const index = state.pages.findIndex((p) => p.id === pageId);
    if (index < 0) return;
    const [removed] = state.pages.splice(index, 1);
    renderPageList();
    persistOrder();
    DB.deletePage(removed.id);

    let restored = false;
    showToast(`Page ${index + 1} removed`, 'info', 5000, {
      label: 'Undo',
      onClick: () => {
        restored = true;
        state.pages.splice(Math.min(index, state.pages.length), 0, removed);
        DB.savePage(removed);
        renderPageList();
        persistOrder();
      },
      onExpire: () => {
        if (!restored) revokePage(removed);
      },
    });
  }

  function clearAllPages() {
    state.pages.forEach(revokePage);
    state.pages = [];
    DB.clear();
    renderPageList();
    showToast('All pages removed', 'info', 2000);
  }

  const ICONS = {
    rotate: '<path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />',
    left: '<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />',
    right: '<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />',
    del: '<path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />',
  };

  function renderPageList() {
    const count = state.pages.length;
    el.emptyState.classList.toggle('hidden', count > 0);
    el.queueHeader.classList.toggle('hidden', count === 0);
    el.clearAllBtn.classList.toggle('hidden', count === 0);
    const hint = document.getElementById('reorderHint');
    if (hint) hint.classList.toggle('hidden', count === 0);
    el.queueCountLabel.textContent = String(count);
    el.createPdfBtn.disabled = count === 0 || state.pdfInProgress;
    el.createPdfLabel.textContent = count === 0 ? 'Create PDF' : `Create PDF from ${count} ${count === 1 ? 'page' : 'pages'}`;

    el.pageList.innerHTML = '';
    state.pages.forEach((page, idx) => {
      const card = document.createElement('article');
      card.className = 'min-w-0';
      card.dataset.id = page.id;
      card.setAttribute('aria-label', `Page ${idx + 1}`);

      const sheet = document.createElement('div');
      sheet.className = 'page-sheet';
      sheet.setAttribute('role', 'button');
      sheet.tabIndex = 0;
      sheet.setAttribute('aria-label', `Edit page ${idx + 1}`);
      sheet.addEventListener('click', () => openStudio(page.id));
      sheet.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openStudio(page.id);
        }
      });
      const img = document.createElement('img');
      img.src = page.processedUrl;
      img.alt = '';
      img.decoding = 'async';
      img.draggable = false;
      img.className = 'w-full h-full object-contain';
      sheet.appendChild(img);

      const caption = document.createElement('div');
      caption.className = 'mt-2.5 flex items-baseline justify-between gap-2 px-0.5';
      const num = document.createElement('span');
      num.className = 'font-display text-[15px] font-extrabold';
      num.textContent = `Page ${idx + 1}`;
      const look = document.createElement('span');
      look.className = 'text-xs font-medium text-muted truncate';
      look.textContent = `${FILTER_LABELS[page.filter] || 'Original'}, ${formatBytes(page.processedSize)}`;
      caption.append(num, look);

      const tools = document.createElement('div');
      tools.className = 'mt-1 flex items-center justify-between';
      tools.append(
        makeCardBtn('left', `Move page ${idx + 1} earlier`, ICONS.left, idx === 0, false, () => movePage(idx, -1)),
        makeCardBtn('rotate', `Rotate page ${idx + 1}`, ICONS.rotate, false, false, () => rotatePageCard(page.id)),
        makeCardBtn('delete', `Remove page ${idx + 1}`, ICONS.del, false, true, () => deletePage(page.id)),
        makeCardBtn('right', `Move page ${idx + 1} later`, ICONS.right, idx === count - 1, false, () => movePage(idx, 1))
      );

      card.append(sheet, caption, tools);
      el.pageList.appendChild(card);
    });
  }

  function makeCardBtn(act, aria, svgPath, disabled, danger, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.act = act;
    btn.disabled = disabled;
    btn.setAttribute('aria-label', aria);
    btn.title = aria;
    btn.className = `page-tool ${danger ? 'text-danger' : ''}`;
    btn.innerHTML = `<svg class="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">${svgPath}</svg>`;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function initSortable() {
    if (typeof window.Sortable === 'undefined') return;
    window.Sortable.create(el.pageList, {
      animation: 180,
      delay: 220,
      delayOnTouchOnly: true,
      touchStartThreshold: 6,
      filter: 'button',
      preventOnFilter: false,
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      onEnd: (evt) => {
        if (evt.oldIndex === evt.newIndex) return;
        const [moved] = state.pages.splice(evt.oldIndex, 1);
        state.pages.splice(evt.newIndex, 0, moved);
        renderPageList();
        persistOrder();
      },
    });
  }

  // ==================== PDF EXPORT ====================
  function updateSettingsSummary() {
    const sizeKey = el.pageSizeSelect.value;
    const isFit = sizeKey === 'fit';
    el.orientationSelect.disabled = isFit;
    const size = { a4: 'A4', letter: 'US Letter', fit: 'Fit to photo' }[sizeKey];
    const orient = isFit ? '' : `, ${el.orientationSelect.value === 'auto' ? 'auto' : el.orientationSelect.value} orientation`;
    const margin = el.marginSelect.value === '0' ? 'no margins' : `${el.marginSelect.value} mm margins`;
    const quality = { high: 'high quality', balanced: 'balanced quality', small: 'smallest file' }[el.qualitySelect.value];
    el.settingsSummary.textContent = `${size}${orient}, ${margin}, ${quality}`;
  }

  async function blobBytes(blob) {
    return new Uint8Array(await blob.arrayBuffer());
  }

  /** Prepares one page for jsPDF, avoiding needless re-compression. */
  async function preparePageForPdf(page, preset) {
    const isPng = page.processedType === 'image/png';
    const longest = Math.max(page.processedWidth, page.processedHeight);

    // B&W: keep the lossless PNG as-is (two-tone PNGs are small and razor sharp)
    if (isPng) {
      return { data: await blobBytes(page.processedBlob), format: 'PNG', width: page.processedWidth, height: page.processedHeight };
    }
    // High quality and already within size: embed the processed JPEG directly (no 3rd encode)
    if (preset.key === 'high' && longest <= preset.maxDim) {
      return { data: await blobBytes(page.processedBlob), format: 'JPEG', width: page.processedWidth, height: page.processedHeight };
    }
    const canvas = await createRotatedCanvas(page.processedUrl, 0, preset.maxDim);
    try {
      const blob = await canvasToBlob(canvas, 'image/jpeg', preset.quality);
      return { data: await blobBytes(blob), format: 'JPEG', width: canvas.width, height: canvas.height };
    } finally {
      releaseCanvas(canvas);
    }
  }

  function triggerDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function createPDF() {
    if (state.pages.length === 0 || state.pdfInProgress) return;
    state.pdfInProgress = true;
    el.createPdfBtn.disabled = true;
    return enqueue(buildPdf).finally(() => {
      state.pdfInProgress = false;
      el.createPdfBtn.disabled = state.pages.length === 0;
    });
  }

  async function buildPdf() {
    const pages = state.pages.slice();
    const total = pages.length;
    if (!total) return;

    showProgress('Making your PDF', 'Getting ready', 3);
    try {
      await loadScript(LIB_URLS.jspdf);
    } catch (_) {
      hideProgress();
      showToast('The PDF maker didn’t load. Connect to the internet once, then try again.', 'error', 4500);
      return;
    }
    const { jsPDF } = window.jspdf;

    const pageSizeKey = el.pageSizeSelect.value;
    const orientSetting = el.orientationSelect.value;
    const marginMm = Number(el.marginSelect.value) || 0;
    const preset = QUALITY_PRESETS[el.qualitySelect.value] || QUALITY_PRESETS.balanced;

    let filename = (el.filenameInput.value || '').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') || 'scan';
    if (!filename.toLowerCase().endsWith('.pdf')) filename += '.pdf';

    try {
      let pdf = null;
      for (let i = 0; i < total; i++) {
        showProgress('Making your PDF', `Page ${i + 1} of ${total}`, Math.round(((i + 0.35) / total) * 90) + 4);
        await nextFrame();
        const img = await preparePageForPdf(pages[i], preset);

        let pageW, pageH, imgX, imgY, imgW, imgH;
        if (pageSizeKey === 'fit') {
          const pxToMm = 25.4 / 150;
          imgW = img.width * pxToMm;
          imgH = img.height * pxToMm;
          pageW = imgW + marginMm * 2;
          pageH = imgH + marginMm * 2;
          imgX = marginMm;
          imgY = marginMm;
        } else {
          const base = PAGE_SIZES_MM[pageSizeKey];
          const isLandscape = orientSetting === 'landscape' ? true : orientSetting === 'portrait' ? false : img.width > img.height;
          pageW = isLandscape ? base.h : base.w;
          pageH = isLandscape ? base.w : base.h;
          const availW = Math.max(10, pageW - marginMm * 2);
          const availH = Math.max(10, pageH - marginMm * 2);
          const imgRatio = img.width / img.height;
          if (imgRatio > availW / availH) {
            imgW = availW;
            imgH = availW / imgRatio;
          } else {
            imgH = availH;
            imgW = availH * imgRatio;
          }
          imgX = marginMm + (availW - imgW) / 2;
          imgY = marginMm + (availH - imgH) / 2;
        }

        const orient = pageW > pageH ? 'l' : 'p';
        if (i === 0) pdf = new jsPDF({ orientation: orient, unit: 'mm', format: [pageW, pageH], compress: true });
        else pdf.addPage([pageW, pageH], orient);
        pdf.addImage(img.data, img.format, imgX, imgY, imgW, imgH, `p${i}`, 'FAST');
      }

      showProgress('Making your PDF', 'Almost done', 96);
      await nextFrame();
      pdf.setProperties({ title: filename.replace(/\.pdf$/i, ''), creator: 'PocketPDF by BigPharmi', author: 'BigPharmi' });
      const pdfBlob = pdf.output('blob');
      if (state.lastPdf && state.lastPdf.url) URL.revokeObjectURL(state.lastPdf.url);
      const url = URL.createObjectURL(pdfBlob);
      state.lastPdf = { blob: pdfBlob, filename, url };

      let canShareFile = false;
      try {
        const testFile = new File([pdfBlob], filename, { type: 'application/pdf' });
        canShareFile = !!(navigator.canShare && navigator.canShare({ files: [testFile] }));
      } catch (_) {
        canShareFile = false;
      }

      // Phones: offer Share (no surprise download). Desktop: download straight away.
      if (!canShareFile) triggerDownload(url, filename);

      hideProgress();
      el.pdfReadyMeta.textContent = `${filename}, ${formatBytes(pdfBlob.size)}`;
      el.pdfShareBtn.classList.toggle('hidden', !canShareFile);
      openModal(el.pdfReadyModal, canShareFile ? el.pdfShareBtn : el.pdfReadyCloseBtn);
    } catch (err) {
      console.error('PDF creation error:', err);
      hideProgress();
      showToast('The PDF couldn’t be made. Set Quality to “Smallest file” and try again.', 'error', 4500);
    }
  }

  // ==================== SERVICE WORKER ====================
  /** True when the app is between tasks, so switching to a new version can't interrupt anything. */
  function isIdle() {
    return !studio.isOpen && el.progressModal.classList.contains('hidden') && !state.pdfInProgress;
  }

  /**
   * Self-heal: if this script and the page it runs in are from different versions (a phone that
   * saved a half-updated copy), drop the saved copy and reload once from the network.
   */
  function healVersionMismatch() {
    const meta = document.querySelector('meta[name="app-version"]');
    const pageVersion = meta ? meta.content : 'none';
    if (pageVersion === APP_VERSION) return false;
    try {
      if (sessionStorage.getItem('pocketpdf.healed') === APP_VERSION) return false;
      sessionStorage.setItem('pocketpdf.healed', APP_VERSION);
    } catch (_) { /* private mode */ }
    console.warn(`Page ${pageVersion} and script ${APP_VERSION} differ; refreshing the offline copy.`);
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k.startsWith('pocketpdf-shell-')).map((k) => caches.delete(k)));
        const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
        if (reg) await reg.update().catch(() => {});
      } catch (_) { /* ignore */ }
      location.reload();
    })();
    return true;
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (location.protocol !== 'https:' && !local) return;
    const hadController = !!navigator.serviceWorker.controller;

    let updateRequested = false;
    const applyUpdate = (worker) => {
      updateRequested = true;
      worker.postMessage('skipWaiting');
    };
    const offerUpdate = (worker) => {
      // Switch straight away when nothing is in progress; pages are saved, so a reload loses nothing.
      if (isIdle()) {
        applyUpdate(worker);
        return;
      }
      showToast('A new version of PocketPDF is ready.', 'info', 30000, { label: 'Update', onClick: () => applyUpdate(worker) });
    };

    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(nw);
          });
        });
        // Check for a new version whenever the app comes back to the foreground
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
      }).catch((err) => console.warn('Service worker registration failed:', err));

      // Reload when a version is replaced, but not when the very first install takes control
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded || (!hadController && !updateRequested)) return;
        reloaded = true;
        location.reload();
      });
    });
  }

  // ==================== EVENTS ====================
  function bindEvents() {
    el.takePhotoBtn.addEventListener('click', () => {
      el.cameraInput.click();
      ensureOpenCV(); // start loading while the camera is open
    });
    el.addPhotosBtn.addEventListener('click', () => {
      el.galleryInput.click();
      if (el.autoScanToggle.checked) ensureOpenCV();
    });
    el.cameraInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      handleIncomingFiles(files, true);
    });
    el.galleryInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      handleIncomingFiles(files, false);
    });
    el.autoScanToggle.addEventListener('change', saveSettings);

    el.settingsToggleBtn.addEventListener('click', () => {
      const hidden = el.settingsBody.classList.toggle('hidden');
      el.settingsToggleBtn.setAttribute('aria-expanded', String(!hidden));
      el.settingsChevron.classList.toggle('rotate-180', !hidden);
    });
    [el.pageSizeSelect, el.orientationSelect, el.marginSelect, el.qualitySelect].forEach((s) =>
      s.addEventListener('change', () => {
        updateSettingsSummary();
        saveSettings();
      })
    );

    el.clearAllBtn.addEventListener('click', () => {
      if (state.pages.length) openModal(el.confirmClearModal, el.cancelClearBtn);
    });
    el.cancelClearBtn.addEventListener('click', () => closeModal(el.confirmClearModal));
    el.confirmClearBtn.addEventListener('click', () => {
      closeModal(el.confirmClearModal);
      clearAllPages();
    });
    el.confirmClearModal.addEventListener('click', (e) => {
      if (e.target === el.confirmClearModal) closeModal(el.confirmClearModal);
    });

    el.createPdfBtn.addEventListener('click', createPDF);
    el.pdfDownloadAgainBtn.addEventListener('click', () => {
      if (state.lastPdf) triggerDownload(state.lastPdf.url, state.lastPdf.filename);
    });
    el.pdfShareBtn.addEventListener('click', async () => {
      if (!state.lastPdf) return;
      try {
        const file = new File([state.lastPdf.blob], state.lastPdf.filename, { type: 'application/pdf' });
        await navigator.share({ files: [file], title: state.lastPdf.filename });
      } catch (err) {
        if (err && err.name !== 'AbortError') showToast('Sharing isn’t available here. Use Download PDF instead.', 'info', 2800);
      }
    });
    el.pdfReadyCloseBtn.addEventListener('click', () => closeModal(el.pdfReadyModal));
    el.pdfReadyModal.addEventListener('click', (e) => {
      if (e.target === el.pdfReadyModal) closeModal(el.pdfReadyModal);
    });

    // Studio navigation
    el.studioCloseBtn.addEventListener('click', closeStudio);
    el.tabCropBtn.addEventListener('click', () => studio.rotatedSourceCanvas && setStudioStep('crop'));
    el.tabFilterBtn.addEventListener('click', () => studio.rotatedSourceCanvas && setStudioStep('filter'));
    el.studioPrimaryBtn.addEventListener('click', () => {
      if (!studio.rotatedSourceCanvas) return;
      if (studio.step === 'crop') setStudioStep('filter');
      else saveStudioEdits();
    });
    el.saveNextBtn.addEventListener('click', () => {
      if (!studio.rotatedSourceCanvas) return;
      // Open the camera synchronously (needs the tap's user activation), save in the background.
      el.cameraInput.click();
      saveStudioEdits();
    });

    // Crop interactions
    el.cropCanvas.addEventListener('pointerdown', onCropPointerDown);
    el.cropCanvas.addEventListener('pointermove', onCropPointerMove);
    el.cropCanvas.addEventListener('pointerup', onCropPointerUp);
    el.cropCanvas.addEventListener('pointercancel', onCropPointerUp);

    el.cropAutoBtn.addEventListener('click', async () => {
      if (!studio.rotatedSourceCanvas) return;
      if (!state.cvReady) {
        showToast('Starting auto-crop', 'info', 2000);
        const ok = await ensureOpenCV();
        if (!ok) {
          showToast('Auto-crop isn’t available. Drag the handles to the page corners.', 'warning', 3000);
          return;
        }
        if (!studio.isOpen || !studio.rotatedSourceCanvas) return;
      }
      const res = detectDocumentCorners(studio.rotatedSourceCanvas);
      studio.corners = res.corners;
      drawCropOverlay();
      showToast(res.detected ? 'Found the page edges' : 'No clear edges found. Drag the handles to the page corners.', res.detected ? 'success' : 'info', 2600);
    });

    el.cropFullBtn.addEventListener('click', () => {
      studio.corners = fullPageCorners();
      drawCropOverlay();
    });

    el.cropRotateBtn.addEventListener('click', async () => {
      const page = state.pages.find((p) => p.id === studio.pageId);
      if (!page || !studio.rotatedSourceCanvas || studio.opening) return;
      studio.opening = true;
      try {
        studio.rotation = (studio.rotation + 90) % 360;
        studio.corners = rotateCornersCW(studio.corners);
        const next = await createRotatedCanvas(page.sourceUrl, studio.rotation, MAX_SOURCE_DIM);
        releaseCanvas(studio.rotatedSourceCanvas);
        studio.rotatedSourceCanvas = next;
        releaseCanvas(studio.dewarpedProxyCanvas);
        studio.dewarpedProxyCanvas = null;
        resizeAndDrawCropCanvas();
      } finally {
        studio.opening = false;
      }
    });

    el.cropAspectBtn.addEventListener('click', () => {
      const i = ASPECT_ORDER.indexOf(studio.aspect);
      studio.aspect = ASPECT_ORDER[(i + 1) % ASPECT_ORDER.length];
      updateAspectUI();
      showToast(
        studio.aspect === 'auto' ? 'Page shape: as photographed' : `Page shape set to ${ASPECTS[studio.aspect].label}`,
        'info',
        1800
      );
    });

    // Filters
    el.filterPills.forEach((btn) =>
      btn.addEventListener('click', () => {
        studio.filter = btn.dataset.filter;
        updateFilterPillUI();
        renderLiveFilterPreview();
      })
    );
    el.brightnessSlider.addEventListener('input', (e) => {
      studio.brightness = Number(e.target.value);
      el.brightnessVal.textContent = String(studio.brightness);
      renderLiveFilterPreview();
    });
    el.contrastSlider.addEventListener('input', (e) => {
      studio.contrast = Number(e.target.value);
      el.contrastVal.textContent = String(studio.contrast);
      renderLiveFilterPreview();
    });

    window.addEventListener('resize', () => {
      if (studio.isOpen && studio.step === 'crop') resizeAndDrawCropCanvas();
    });

    // Keyboard: Escape closes the top-most dialog, Tab stays inside it
    document.addEventListener('keydown', (e) => {
      trapFocus(e);
      if (e.key !== 'Escape') return;
      if (!el.progressModal.classList.contains('hidden')) return;
      if (!el.confirmClearModal.classList.contains('hidden')) closeModal(el.confirmClearModal);
      else if (!el.pdfReadyModal.classList.contains('hidden')) closeModal(el.pdfReadyModal);
      else if (studio.isOpen) closeStudio();
    });

    // Drag & drop (desktop) anywhere on the main area
    let dragDepth = 0;
    el.mainArea.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragDepth++;
      el.emptyState.classList.add('border-fh-blue', 'bg-fh-rule');
    });
    el.mainArea.addEventListener('dragover', (e) => e.preventDefault());
    el.mainArea.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) el.emptyState.classList.remove('border-fh-blue', 'bg-fh-rule');
    });
    el.mainArea.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      el.emptyState.classList.remove('border-fh-blue', 'bg-fh-rule');
      if (e.dataTransfer && e.dataTransfer.files.length) {
        if (el.autoScanToggle.checked) ensureOpenCV();
        handleIncomingFiles(e.dataTransfer.files, false);
      }
    });
  }

  // ==================== INIT ====================
  function init() {
    if (healVersionMismatch()) return;
    const now = new Date();
    el.filenameInput.value = `scan_${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    loadSettings();
    worker.init();
    bindEvents();
    initSortable();
    updateSettingsSummary();
    setEngineStatus(navigator.connection && navigator.connection.saveData ? 'idle' : 'loading');
    renderPageList();
    restoreSession();
    registerServiceWorker();
    preloadOpenCV();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  init();

  // Small test hook (harmless in production)
  window.__pocketpdf = { state, studio, ensureOpenCV, handleIncomingFiles, createPDF, openStudio, saveStudioEdits };
})();
