// Source types + runtimes. A "source" is persistent config; its runtime owns the live media
// (video element, camera stream, canvas...). Runtimes are shared by every scene that uses the source.
import { h, fileUrl, basename, clamp, IMAGE_EXT, VIDEO_EXT } from '../util.js';
import { worshipLive } from '../state.js';
import { resolveTheme, drawBackground, drawSlideText, layoutText, hexToRgba, roundRect, drawCover } from '../slide-render.js';

// --------------------------------------------------------------------------------------------------
// Shared helpers
// --------------------------------------------------------------------------------------------------
let captureChain = Promise.resolve();
function captureDisplay(id, { audio = false, fps = 30 } = {}) {
  // getDisplayMedia calls are serialised: main hands out the source we pre-select
  const run = async () => {
    await window.api.capture.select(id, audio);
    return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: fps }, audio });
  };
  const p = captureChain.then(run, run);
  captureChain = p.catch(() => {});
  return p;
}

function makeVideo(muted = true) {
  const v = document.createElement('video');
  v.muted = muted; v.playsInline = true; v.autoplay = true; v.preload = 'auto';
  return v;
}

const TEXT_STYLE_FIELDS = [
  { key: 'font', label: 'Font', type: 'font' },
  { key: 'size', label: 'Size', type: 'range', min: 10, max: 300, unit: 'px' },
  { key: 'color', label: 'Colour', type: 'color' },
  { key: 'bold', label: 'Bold', type: 'checkbox' },
  { key: 'italic', label: 'Italic', type: 'checkbox' },
  { key: 'align', label: 'Align', type: 'select', options: ['left', 'center', 'right'] },
  { key: 'lineHeight', label: 'Line spacing', type: 'range', min: 0.8, max: 2.5, step: 0.05 },
  { key: 'outline', label: 'Outline', type: 'checkbox' },
  { key: 'outlineColor', label: 'Outline colour', type: 'color', showIf: (s) => s.outline },
  { key: 'outlineWidth', label: 'Outline width', type: 'range', min: 1, max: 20, showIf: (s) => s.outline },
  { key: 'shadow', label: 'Shadow', type: 'checkbox' },
  { key: 'shadowColor', label: 'Shadow colour', type: 'color', showIf: (s) => s.shadow },
  { key: 'shadowBlur', label: 'Shadow blur', type: 'range', min: 0, max: 40, showIf: (s) => s.shadow },
  { key: 'bgColor', label: 'Background', type: 'color' },
  { key: 'bgOpacity', label: 'Background opacity', type: 'range', min: 0, max: 1, step: 0.05 },
  { key: 'padding', label: 'Padding', type: 'range', min: 0, max: 120, unit: 'px' },
  { key: 'radius', label: 'Corner radius', type: 'range', min: 0, max: 80, unit: 'px', showIf: (s) => s.bgOpacity > 0 },
];
const TEXT_STYLE_DEFAULTS = {
  font: 'Segoe UI', size: 64, color: '#ffffff', bold: true, italic: false, align: 'left', lineHeight: 1.2,
  outline: false, outlineColor: '#000000', outlineWidth: 4, shadow: true, shadowColor: '#000000', shadowBlur: 8,
  bgColor: '#000000', bgOpacity: 0, padding: 12, radius: 0,
};

function renderTextCanvas(canvas, text, s, wrapWidth = 0) {
  const ctx = canvas.getContext('2d');
  const font = `${s.italic ? 'italic ' : ''}${s.bold ? '700 ' : '400 '}${s.size}px "${s.font}", "Segoe UI", sans-serif`;
  ctx.font = font;
  const rawLines = String(text ?? '').split('\n');
  const lines = [];
  for (const l of rawLines) {
    if (!wrapWidth) { lines.push(l); continue; }
    let line = '';
    for (const w of l.split(' ')) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > wrapWidth && line) { lines.push(line); line = w; } else line = t;
    }
    lines.push(line);
  }
  const lh = s.size * (s.lineHeight || 1.2);
  const pad = s.padding || 0;
  const extra = (s.outline ? s.outlineWidth : 0) + (s.shadow ? s.shadowBlur : 0);
  const textW = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
  const W = Math.ceil((wrapWidth || textW) + pad * 2 + extra * 2);
  const H = Math.ceil(lines.length * lh + pad * 2 + extra * 2);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; } else ctx.clearRect(0, 0, W, H);
  if (s.bgOpacity > 0) { ctx.fillStyle = hexToRgba(s.bgColor, s.bgOpacity); roundRect(ctx, 0, 0, W, H, s.radius || 0); ctx.fill(); }
  ctx.font = font;
  ctx.textBaseline = 'top';
  ctx.textAlign = s.align;
  const x = s.align === 'center' ? W / 2 : s.align === 'right' ? W - pad - extra : pad + extra;
  lines.forEach((l, i) => {
    const y = pad + extra + i * lh + (lh - s.size) / 2;
    if (s.shadow) { ctx.shadowColor = s.shadowColor; ctx.shadowBlur = s.shadowBlur; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 2; }
    if (s.outline) { ctx.lineJoin = 'round'; ctx.lineWidth = s.outlineWidth * 2; ctx.strokeStyle = s.outlineColor; ctx.strokeText(l, x, y); ctx.shadowColor = 'transparent'; }
    ctx.fillStyle = s.color; ctx.fillText(l, x, y);
    ctx.shadowColor = 'transparent';
  });
  return canvas;
}

async function deviceOptions(kind) {
  const devs = await navigator.mediaDevices.enumerateDevices();
  const list = devs.filter((d) => d.kind === kind).map((d, i) => ({ value: d.deviceId, label: d.label || `${kind === 'videoinput' ? 'Camera' : 'Input'} ${i + 1}` }));
  return list.length ? list : [{ value: '', label: 'No devices found' }];
}

async function resolveDevice(kind, id, label) {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind);
  if (id && devs.some((d) => d.deviceId === id)) return id;
  const byLabel = label && devs.find((d) => d.label === label);
  return byLabel ? byLabel.deviceId : (devs[0] && devs[0].deviceId) || undefined;
}

function capturePicker(types) {
  return (s, set) => {
    const grid = h('div', { class: 'capture-grid' }, h('div', { class: 'muted' }, 'Loading…'));
    window.api.capture.sources(types).then((list) => {
      grid.innerHTML = '';
      if (!list.length) grid.appendChild(h('div', { class: 'muted' }, 'Nothing to capture found.'));
      list.forEach((src, i) => {
        const label = types[0] === 'screen' ? `Display ${i + 1}${src.primary ? ' (primary)' : ''} ${src.size}` : src.name;
        grid.appendChild(h('div', {
          class: 'capture-tile' + (s.sourceId === src.id ? ' selected' : ''), title: src.name,
          onclick: (e) => {
            grid.querySelectorAll('.capture-tile').forEach((t) => t.classList.remove('selected'));
            e.currentTarget.classList.add('selected');
            s.sourceName = src.name; s.displayId = src.displayId;
            set(src.id);
          },
        }, src.thumbnail ? h('img', { src: src.thumbnail }) : h('div', { class: 'capture-noimg' }, '▢'), h('div', { class: 'capture-name' }, label)));
      });
    });
    return grid;
  };
}

// --------------------------------------------------------------------------------------------------
// Runtimes
// --------------------------------------------------------------------------------------------------
class Runtime {
  constructor(src, env) { this.src = src; this.env = env; this.w = 0; this.h = 0; this.audioNode = null; this.error = ''; }
  get s() { return this.src.settings; }
  frame() { return null; }
  activate() {}
  deactivate() {}
  update() {}
  tick() {}
  destroy() {}
  attachAudio(node) { this.audioNode = node; this.env.audio.channel(this.src).connectInput(node); }
}

class VideoRuntime extends Runtime {
  constructor(src, env) {
    super(src, env);
    const v = makeVideo(false);
    v.autoplay = false;
    this.v = v;
    this.ended = false;
    this.lastSave = 0;
    v.addEventListener('loadedmetadata', () => {
      this.w = v.videoWidth; this.h = v.videoHeight;
      if (this.pendingSeek != null) { v.currentTime = this.pendingSeek; this.pendingSeek = null; }
    });
    v.addEventListener('ended', () => { this.ended = true; this.onEnded(); });
    v.addEventListener('playing', () => { this.ended = false; });
    v.addEventListener('error', () => { if (this.s.path) this.error = 'Could not play this file (unsupported format?)'; });
    this.attachAudio(env.audio.ctx.createMediaElementSource(v));
    this.update();
  }
  update() {
    const s = this.s;
    const url = fileUrl(s.path);
    if (this.url !== url) {
      this.url = url; this.error = '';
      if (url) this.v.src = url; else { this.v.removeAttribute('src'); this.v.load(); }
      this.pendingSeek = s.rememberPosition && s.lastPosition ? s.lastPosition : (s.inPoint || 0) || null;
    }
    this.v.loop = !!s.loop && !(s.outPoint > 0);
    this.v.playbackRate = Number(s.speed) || 1;
  }
  frame() {
    if (!this.s.path || this.v.readyState < 2) return null;
    if (this.ended && this.s.hideWhenEnded) return null;
    return this.v;
  }
  onEnded() { if (this.s.rememberPosition) { this.s.lastPosition = 0; this.env.persist(); } }
  activate() {
    const s = this.s;
    this.active = true;
    if (!s.path) return;
    if (!s.rememberPosition || this.ended) this.seek(s.inPoint || 0);
    else if (s.lastPosition && Math.abs(this.v.currentTime - s.lastPosition) > 0.5) this.seek(s.lastPosition);
    this.ended = false;
    if (s.playOnEnter) this.play();
  }
  deactivate() {
    this.active = false;
    const s = this.s;
    if (s.pauseOnExit !== false) this.v.pause();
    if (s.rememberPosition) { s.lastPosition = this.v.currentTime; this.env.persist(); }
  }
  tick(now) {
    const s = this.s;
    if (s.outPoint > 0 && this.v.currentTime >= s.outPoint && !this.v.paused) {
      if (s.loop) this.v.currentTime = s.inPoint || 0;
      else { this.v.pause(); this.ended = true; this.onEnded(); }
    }
    if (s.rememberPosition && !this.v.paused && now - this.lastSave > 5000) { this.lastSave = now; s.lastPosition = this.v.currentTime; this.env.persist(); }
  }
  seek(t) { if (this.v.readyState >= 1) this.v.currentTime = t; else this.pendingSeek = t; }
  play() { this.ended = false; this.v.play().catch((e) => { this.error = e.message; }); }
  pause() { this.v.pause(); if (this.s.rememberPosition) { this.s.lastPosition = this.v.currentTime; this.env.persist(); } }
  restart() { this.seek(this.s.inPoint || 0); this.play(); }
  media() { return { time: this.v.currentTime, duration: this.v.duration || 0, paused: this.v.paused }; }
  destroy() { this.v.pause(); this.v.removeAttribute('src'); this.v.load(); }
}

class ImageRuntime extends Runtime {
  constructor(src, env) { super(src, env); this.img = new Image(); this.img.onload = () => { this.w = this.img.naturalWidth; this.h = this.img.naturalHeight; }; this.update(); }
  update() { const u = fileUrl(this.s.path); if (u !== this.url) { this.url = u; this.img.src = u || ''; } }
  frame() { return this.img.complete && this.img.naturalWidth ? this.img : null; }
}

class SlideshowRuntime extends Runtime {
  constructor(src, env) {
    super(src, env);
    this.canvas = document.createElement('canvas');
    this.images = [];
    this.index = 0; this.prev = -1; this.changed = 0; this.nextAt = 0;
    this.update();
  }
  update() {
    const s = this.s;
    this.canvas.width = this.w = Number(s.width) || this.env.baseW;
    this.canvas.height = this.h = Number(s.height) || this.env.baseH;
    const files = s.files || [];
    if (JSON.stringify(files) !== this.filesKey) {
      this.filesKey = JSON.stringify(files);
      this.images = files.map((f) => { const i = new Image(); i.src = fileUrl(f); return i; });
      this.index = 0; this.prev = -1;
    }
  }
  activate() { if (this.s.restartOnEnter) { this.index = 0; this.prev = -1; this.nextAt = performance.now() + this.s.interval * 1000; } }
  tick(now) {
    const s = this.s;
    if (!this.images.length) return;
    if (!this.nextAt) this.nextAt = now + s.interval * 1000;
    if (now >= this.nextAt) {
      this.prev = this.index;
      if (s.shuffle && this.images.length > 2) { let n; do { n = Math.floor(Math.random() * this.images.length); } while (n === this.index); this.index = n; }
      else this.index = this.index + 1 >= this.images.length ? (s.loop !== false ? 0 : this.index) : this.index + 1;
      this.changed = now; this.nextAt = now + s.interval * 1000;
    }
    const ctx = this.canvas.getContext('2d');
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    const cur = this.images[this.index];
    const p = s.transition === 'fade' ? clamp((now - this.changed) / (s.fadeMs || 700), 0, 1) : 1;
    const prev = this.images[this.prev];
    if (p < 1 && prev && prev.complete) { ctx.globalAlpha = 1; drawCover(ctx, prev, W, H, s.fit); }
    if (cur && cur.complete && cur.naturalWidth) { ctx.globalAlpha = p; drawCover(ctx, cur, W, H, s.fit); }
    ctx.globalAlpha = 1;
  }
  frame() { return this.images.length ? this.canvas : null; }
}

class CameraRuntime extends Runtime {
  constructor(src, env) { super(src, env); this.v = makeVideo(true); this.v.addEventListener('loadedmetadata', () => { this.w = this.v.videoWidth; this.h = this.v.videoHeight; }); this.open(); }
  async open() {
    this.stop();
    const s = this.s;
    try {
      const id = await resolveDevice('videoinput', s.deviceId, s.deviceLabel);
      const [w, hh] = String(s.resolution || '1920x1080').split('x').map(Number);
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: id ? { exact: id } : undefined, width: { ideal: w }, height: { ideal: hh }, frameRate: { ideal: Number(s.fps) || 30 } }, audio: false,
      });
      const track = this.stream.getVideoTracks()[0];
      s.deviceId = id; s.deviceLabel = track.label;
      this.v.srcObject = this.stream;
      this.error = '';
    } catch (e) { this.error = 'Camera: ' + e.message; }
  }
  update() { const key = [this.s.deviceId, this.s.resolution, this.s.fps].join('|'); if (key !== this.key) { this.key = key; this.open(); } }
  frame() { return this.v.readyState >= 2 ? this.v : null; }
  stop() { if (this.stream) this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
  destroy() { this.stop(); }
}

class MicRuntime extends Runtime {
  constructor(src, env) { super(src, env); this.update(); }
  async open() {
    this.stop();
    const s = this.s;
    try {
      const id = await resolveDevice('audioinput', s.deviceId, s.deviceLabel);
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: {
        deviceId: id ? { exact: id } : undefined, echoCancellation: !!s.echoCancellation, noiseSuppression: !!s.noiseSuppression,
        autoGainControl: !!s.autoGainControl, channelCount: { ideal: 2 }, sampleRate: 48000,
      }, video: false });
      const track = this.stream.getAudioTracks()[0];
      s.deviceId = id; s.deviceLabel = track.label;
      this.attachAudio(this.env.audio.ctx.createMediaStreamSource(this.stream));
      this.error = '';
    } catch (e) { this.error = 'Audio input: ' + e.message; }
  }
  update() { const s = this.s; const key = [s.deviceId, s.echoCancellation, s.noiseSuppression, s.autoGainControl].join('|'); if (key !== this.key) { this.key = key; this.open(); } }
  stop() { if (this.stream) this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
  destroy() { this.stop(); }
}

class DesktopAudioRuntime extends Runtime {
  constructor(src, env) { super(src, env); this.open(); }
  async open() {
    try {
      this.stream = await captureDisplay(null, { audio: true, fps: 1 });
      this.stream.getVideoTracks().forEach((t) => t.stop());
      if (!this.stream.getAudioTracks().length) throw new Error('no system audio track');
      this.attachAudio(this.env.audio.ctx.createMediaStreamSource(new MediaStream(this.stream.getAudioTracks())));
      this.error = '';
    } catch (e) { this.error = 'Desktop audio: ' + e.message; }
  }
  destroy() { if (this.stream) this.stream.getTracks().forEach((t) => t.stop()); }
}

class ScreenRuntime extends Runtime {
  constructor(src, env) { super(src, env); this.v = makeVideo(true); this.v.addEventListener('resize', () => { this.w = this.v.videoWidth; this.h = this.v.videoHeight; }); this.v.addEventListener('loadedmetadata', () => { this.w = this.v.videoWidth; this.h = this.v.videoHeight; }); this.update(); }
  async open() {
    this.stop();
    const s = this.s;
    let id = s.sourceId;
    try {
      // Window IDs change between sessions — find the window again by title
      const list = await window.api.capture.sources([this.src.type === 'display' ? 'screen' : 'window']);
      let match = list.find((x) => x.id === id);
      if (!match && this.src.type === 'display') match = list.find((x) => x.displayId === s.displayId) || list[0];
      if (!match && this.src.type === 'window' && s.sourceName) match = list.find((x) => x.name === s.sourceName) || list.find((x) => x.name.includes(s.sourceName.split(' - ').pop()));
      if (!match) throw new Error(this.src.type === 'window' ? `window "${s.sourceName || '?'}" not found — is it open?` : 'no display');
      id = match.id; s.sourceId = id;
      this.stream = await captureDisplay(id, { fps: Number(s.fps) || 30 });
      this.stream.getVideoTracks()[0].addEventListener('ended', () => { this.error = 'Capture ended (window closed?)'; });
      this.v.srcObject = this.stream;
      this.error = '';
    } catch (e) { this.error = 'Capture: ' + e.message; }
  }
  update() { const key = [this.s.sourceId, this.s.fps].join('|'); if (key !== this.key) { this.key = key; this.open(); } }
  frame() { return this.v.readyState >= 2 ? this.v : null; }
  stop() { if (this.stream) this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
  destroy() { this.stop(); }
}

class TextRuntime extends Runtime {
  constructor(src, env) { super(src, env); this.canvas = document.createElement('canvas'); this.out = document.createElement('canvas'); this.offset = 0; this.last = 0; this.update(); }
  text() { return this.s.text; }
  render() {
    renderTextCanvas(this.canvas, this.text(), this.s, Number(this.s.wrapWidth) || 0);
    this.key = this.text();
    if (!this.s.scrollSpeed) { this.w = this.canvas.width; this.h = this.canvas.height; }
    else { this.w = Number(this.s.scrollWidth) || this.env.baseW; this.h = this.canvas.height; }
  }
  update() { this.render(); }
  tick(now) {
    if (this.text() !== this.key) this.render();
    const sp = Number(this.s.scrollSpeed) || 0;
    if (!sp) return;
    const dt = this.last ? (now - this.last) / 1000 : 0;
    this.last = now;
    const cw = this.canvas.width + (Number(this.s.scrollGap) || 200);
    this.offset = (this.offset + sp * dt) % cw;
    const o = this.out;
    if (o.width !== this.w || o.height !== this.h) { o.width = this.w; o.height = this.h; }
    const ctx = o.getContext('2d');
    ctx.clearRect(0, 0, o.width, o.height);
    for (let x = -this.offset; x < o.width; x += cw) ctx.drawImage(this.canvas, Math.round(x), 0);
  }
  frame() { return this.s.scrollSpeed ? this.out : this.canvas; }
}

class CountdownRuntime extends TextRuntime {
  activate() { if (this.s.mode === 'duration' || this.s.mode === 'stopwatch') { if (this.s.restartOnEnter !== false || !this.startedAt) this.startedAt = Date.now(); } }
  text() {
    const s = this.s;
    const fmt = (sec) => {
      sec = Math.max(0, Math.floor(sec));
      const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
      const p = (n) => String(n).padStart(2, '0');
      return hh || s.format === 'hms' ? `${hh}:${p(mm)}:${p(ss)}` : `${mm}:${p(ss)}`;
    };
    let body;
    if (s.mode === 'clock') {
      const d = new Date();
      body = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: s.showSeconds ? '2-digit' : undefined });
    } else if (s.mode === 'stopwatch') {
      body = fmt((Date.now() - (this.startedAt || Date.now())) / 1000);
    } else {
      let remain;
      if (s.mode === 'time') {
        const [hh, mm] = String(s.targetTime || '10:00').split(':').map(Number);
        const t = new Date(); t.setHours(hh, mm || 0, 0, 0);
        remain = (t - Date.now()) / 1000;
      } else {
        remain = (Number(s.minutes) || 0) * 60 + (Number(s.seconds) || 0) - (Date.now() - (this.startedAt || Date.now())) / 1000;
      }
      if (remain <= 0 && s.endText) return s.endText;
      body = fmt(remain);
    }
    return `${s.prefix || ''}${body}${s.suffix || ''}`;
  }
}

class ColorRuntime extends Runtime {
  constructor(src, env) { super(src, env); this.canvas = document.createElement('canvas'); this.update(); }
  update() {
    const s = this.s;
    this.w = Number(s.width) || this.env.baseW; this.h = Number(s.height) || this.env.baseH;
    const c = this.canvas; c.width = 480; c.height = Math.max(1, Math.round((480 * this.h) / this.w));
    drawBackground(c.getContext('2d'), c.width, c.height, { bg: { type: s.gradient ? 'gradient' : 'color', color: s.color, color2: s.color2, angle: s.angle, dim: 0 } }, null);
  }
  frame() { return this.canvas; }
}

class WorshipRuntime extends Runtime {
  constructor(src, env) {
    super(src, env);
    this.cur = document.createElement('canvas');
    this.prev = document.createElement('canvas');
    this.out = document.createElement('canvas');
    this.seq = -1; this.fadeStart = 0; this.visible = false; this.wasVisible = false;
    this.bgVideo = null;
    this.update();
  }
  update() {
    for (const c of [this.cur, this.prev, this.out]) { c.width = this.env.baseW; c.height = this.env.baseH; }
    this.w = this.env.baseW; this.h = this.env.baseH;
    this.seq = -1;
  }
  shouldShow() {
    const s = this.s, L = worshipLive;
    if (!L.slide) return false;
    if (s.followModes !== false && L.mode !== 'normal') return false;
    if (L.kind === 'song' && s.showSongs === false) return false;
    if (L.kind === 'scripture' && s.showScripture === false) return false;
    if (L.kind === 'custom' && s.showCustom === false) return false;
    return !!(L.slide.text || '').trim();
  }
  render(ctx, W, H) {
    const s = this.s, L = worshipLive, slide = L.slide;
    ctx.clearRect(0, 0, W, H);
    if (!this.visible) return;
    const k = H / 1080;
    if (s.mode === 'fullscreen') {
      const theme = resolveTheme(L.theme);
      let media = null;
      if (theme.bg.type === 'video' && theme.bg.path) {
        if (!this.bgVideo || this.bgVideo.__p !== theme.bg.path) { this.bgVideo = makeVideo(true); this.bgVideo.loop = true; this.bgVideo.src = fileUrl(theme.bg.path); this.bgVideo.__p = theme.bg.path; }
        media = this.bgVideo.readyState >= 2 ? this.bgVideo : null;
      } else if (theme.bg.type === 'image') { this.bgImg = this.bgImg && this.bgImg.__p === theme.bg.path ? this.bgImg : Object.assign(new Image(), { src: fileUrl(theme.bg.path), __p: theme.bg.path }); media = this.bgImg.complete ? this.bgImg : null; }
      drawBackground(ctx, W, H, theme, media);
      drawSlideText(ctx, W, H, slide, theme);
      return;
    }
    const theme = resolveTheme({
      bg: { type: 'transparent' },
      font: { family: s.font, size: s.fontSize, minSize: s.minFontSize, color: s.textColor, bold: s.bold, italic: false, align: s.align, valign: 'middle', lineHeight: 1.15 },
      outline: { enabled: s.outline, color: '#000000', width: 3 },
      shadow: { enabled: s.shadow !== false, color: '#000000', blur: 6, x: 2, y: 2 },
      ref: { show: s.showReference !== false, size: s.refSize, color: s.refColor, position: 'after', align: s.align, bold: true },
    });
    if (s.mode === 'textonly') {
      theme.margin = { l: 6, r: 6, t: 100 - (s.barHeight || 30) - 4, b: 5 };
      if (s.barPosition === 'top') theme.margin = { l: 6, r: 6, t: 4, b: 100 - (s.barHeight || 30) - 4 };
      drawSlideText(ctx, W, H, slide, theme);
      return;
    }
    // Lower third
    const barH = (H * (s.barHeight || 28)) / 100;
    const y = s.barPosition === 'top' ? 0 : H - barH;
    const mx = (W * (s.margin ?? 0)) / 100;
    ctx.fillStyle = hexToRgba(s.barColor, s.barOpacity ?? 0.8);
    roundRect(ctx, mx, s.barPosition === 'top' ? y + (s.marginV || 0) * k : y - (s.marginV || 0) * k, W - mx * 2, barH, (s.radius || 0) * k);
    ctx.fill();
    const by = s.barPosition === 'top' ? y + (s.marginV || 0) * k : y - (s.marginV || 0) * k;
    if (s.accent) { ctx.fillStyle = s.accentColor || '#f2c14e'; ctx.fillRect(mx, s.barPosition === 'top' ? by + barH - 5 * k : by, W - mx * 2, 5 * k); }
    const pad = 28 * k;
    const refH = s.showReference !== false && slide.reference ? s.refSize * k * 1.3 : 0;
    const boxX = mx + pad * 1.5, boxW = W - mx * 2 - pad * 3, boxY = by + pad * 0.8, boxH = barH - pad * 1.6 - refH;
    const f = { family: s.font, bold: s.bold, italic: false };
    const { size, lines } = layoutText(ctx, slide.text, boxW, boxH, f, s.fontSize * k, (s.minFontSize || 22) * k, 1.15);
    const blockH = lines.length * size * 1.15;
    ctx.textAlign = s.align === 'left' ? 'left' : 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `${s.bold ? '700 ' : '400 '}${size}px "${s.font}", "Segoe UI", sans-serif`;
    const tx = s.align === 'left' ? boxX : boxX + boxW / 2;
    const ty = boxY + (boxH - blockH) / 2;
    ctx.fillStyle = s.textColor;
    if (s.shadow !== false) { ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 6 * k; ctx.shadowOffsetY = 2 * k; }
    lines.forEach((l, i) => ctx.fillText(l, tx, ty + i * size * 1.15 + size * 0.86));
    ctx.shadowColor = 'transparent';
    if (refH) {
      ctx.font = `700 ${s.refSize * k}px "${s.font}", "Segoe UI", sans-serif`;
      ctx.fillStyle = s.refColor;
      ctx.textAlign = s.align === 'left' ? 'left' : 'center';
      ctx.fillText(slide.reference, tx, by + barH - pad * 0.7);
    }
  }
  tick(now) {
    const vis = this.shouldShow();
    if (worshipLive.seq !== this.seq || vis !== this.visible || this.s.mode === 'fullscreen') {
      const changed = worshipLive.seq !== this.seq || vis !== this.visible;
      if (changed) { [this.prev, this.cur] = [this.cur, this.prev]; this.fadeStart = now; this.wasVisible = this.visible; }
      this.seq = worshipLive.seq; this.visible = vis;
      this.render(this.cur.getContext('2d'), this.cur.width, this.cur.height);
    }
    const dur = Number(this.s.fade) || 0;
    const p = dur ? clamp((now - this.fadeStart) / dur, 0, 1) : 1;
    this.fading = p < 1;
    if (this.fading) {
      const ctx = this.out.getContext('2d');
      ctx.clearRect(0, 0, this.out.width, this.out.height);
      if (this.wasVisible) { ctx.globalAlpha = 1 - p; ctx.drawImage(this.prev, 0, 0); }
      ctx.globalAlpha = p; ctx.drawImage(this.cur, 0, 0);
      ctx.globalAlpha = 1;
    }
  }
  frame() { if (!this.visible && !this.fading) return null; return this.fading ? this.out : this.cur; }
  destroy() { if (this.bgVideo) { this.bgVideo.pause(); this.bgVideo.removeAttribute('src'); } }
}

class SceneRuntime extends Runtime {
  constructor(src, env) { super(src, env); this.canvas = document.createElement('canvas'); this.update(); }
  update() { this.canvas.width = this.w = this.env.baseW; this.canvas.height = this.h = this.env.baseH; }
  tick() {
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, this.w, this.h);
    this.env.renderNested(this.s.sceneId, ctx, this.w, this.h, this.src.id);
  }
  frame() { return this.canvas; }
}

// --------------------------------------------------------------------------------------------------
// Type registry
// --------------------------------------------------------------------------------------------------
const mediaExts = (list) => list.map((e) => e.slice(1));

export const SOURCE_TYPES = {
  video: {
    label: 'Video file', icon: '🎞', hasVideo: true, hasAudio: true, runtime: VideoRuntime,
    defaults: { path: '', loop: false, playOnEnter: true, rememberPosition: false, pauseOnExit: true, hideWhenEnded: false, speed: 1, inPoint: 0, outPoint: 0, lastPosition: 0 },
    fields: () => [
      { key: 'path', label: 'File', type: 'file', filters: [{ name: 'Video', extensions: mediaExts(VIDEO_EXT) }] },
      { type: 'heading', label: 'Playback' },
      { key: 'playOnEnter', label: 'Play when scene goes live', type: 'checkbox', help: 'Starts playing the moment you switch the livestream to a scene containing this video.' },
      { key: 'rememberPosition', label: 'Remember playback position', type: 'checkbox', help: 'On: resumes where it left off (even after restarting the app). Off: starts from the beginning (or the In point) every time.' },
      { key: 'pauseOnExit', label: 'Pause when scene leaves live', type: 'checkbox', help: 'Off = keeps playing in the background after you switch scenes.' },
      { key: 'loop', label: 'Loop', type: 'checkbox' },
      { key: 'hideWhenEnded', label: 'Hide when finished', type: 'checkbox' },
      { key: 'speed', label: 'Speed', type: 'range', min: 0.25, max: 2, step: 0.05, format: (v) => v + '×' },
      { key: 'inPoint', label: 'Start at (sec)', type: 'number', min: 0, step: 0.1 },
      { key: 'outPoint', label: 'Stop at (sec)', type: 'number', min: 0, step: 0.1, help: '0 = play to the end' },
    ],
  },
  image: {
    label: 'Image', icon: '🖼', hasVideo: true, runtime: ImageRuntime, defaults: { path: '' },
    fields: () => [{ key: 'path', label: 'File', type: 'file', filters: [{ name: 'Images', extensions: mediaExts(IMAGE_EXT) }] }],
  },
  slideshow: {
    label: 'Image slideshow', icon: '🗂', hasVideo: true, runtime: SlideshowRuntime,
    defaults: { files: [], interval: 8, transition: 'fade', fadeMs: 800, loop: true, shuffle: false, fit: 'cover', restartOnEnter: false, width: 0, height: 0 },
    fields: () => [
      { key: 'files', label: 'Images', type: 'custom', render: (s, set) => fileListControl(s.files || [], set, IMAGE_EXT) },
      { key: 'interval', label: 'Seconds per image', type: 'number', min: 1, step: 1 },
      { key: 'transition', label: 'Transition', type: 'select', options: [{ value: 'fade', label: 'Fade' }, { value: 'cut', label: 'Cut' }] },
      { key: 'fit', label: 'Fit', type: 'select', options: [{ value: 'cover', label: 'Fill' }, { value: 'contain', label: 'Fit' }, { value: 'stretch', label: 'Stretch' }] },
      { key: 'loop', label: 'Loop', type: 'checkbox' },
      { key: 'shuffle', label: 'Shuffle', type: 'checkbox' },
      { key: 'restartOnEnter', label: 'Restart when scene goes live', type: 'checkbox' },
    ],
  },
  camera: {
    label: 'Camera', icon: '📷', hasVideo: true, runtime: CameraRuntime,
    defaults: { deviceId: '', deviceLabel: '', resolution: '1920x1080', fps: 30 },
    fields: () => [
      { key: 'deviceId', label: 'Device', type: 'select', options: [{ value: '', label: 'Loading…' }], asyncOptions: () => deviceOptions('videoinput'), autoSelect: true },
      { key: 'resolution', label: 'Resolution', type: 'select', options: ['3840x2160', '2560x1440', '1920x1080', '1280x720', '960x540', '640x480'] },
      { key: 'fps', label: 'Frame rate', type: 'select', numeric: true, options: [15, 24, 25, 30, 50, 60] },
      { type: 'note', label: 'Tip: add a "Microphone" source for the camera\'s audio. Mirror/flip is under Transform (right-click the source).' },
    ],
  },
  mic: {
    label: 'Microphone / audio input', icon: '🎙', hasAudio: true, audioOnly: true, runtime: MicRuntime,
    defaults: { deviceId: 'default', deviceLabel: '', echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    fields: () => [
      { key: 'deviceId', label: 'Device', type: 'select', options: [{ value: 'default', label: 'Default' }], asyncOptions: () => deviceOptions('audioinput') },
      { key: 'noiseSuppression', label: 'Noise suppression', type: 'checkbox', help: 'Good for a speaking mic. Leave OFF for music — it will make singing and instruments sound robotic.' },
      { key: 'echoCancellation', label: 'Echo cancellation', type: 'checkbox' },
      { key: 'autoGainControl', label: 'Auto gain', type: 'checkbox' },
    ],
  },
  desktopAudio: {
    label: 'Desktop audio (everything playing on this PC)', icon: '🔊', hasAudio: true, audioOnly: true, runtime: DesktopAudioRuntime, defaults: {},
    fields: () => [{ type: 'note', label: 'Captures all sound playing on this computer. Don\'t turn on monitoring for this source — it will echo.' }],
  },
  display: {
    label: 'Display capture', icon: '🖥', hasVideo: true, runtime: ScreenRuntime, defaults: { sourceId: '', sourceName: '', displayId: '', fps: 30 },
    fields: () => [
      { key: 'sourceId', label: 'Display', type: 'custom', wide: true, render: capturePicker(['screen']) },
      { key: 'fps', label: 'Frame rate', type: 'select', numeric: true, options: [15, 30, 60] },
    ],
  },
  window: {
    label: 'Window / game capture', icon: '🎮', hasVideo: true, runtime: ScreenRuntime, defaults: { sourceId: '', sourceName: '', fps: 30 },
    fields: () => [
      { key: 'sourceId', label: 'Window', type: 'custom', wide: true, render: capturePicker(['window']) },
      { key: 'fps', label: 'Frame rate', type: 'select', numeric: true, options: [15, 30, 60] },
      { type: 'note', label: 'Games: run them in Borderless / Windowed mode. Exclusive fullscreen games may show black (same as OBS window capture).' },
    ],
  },
  text: {
    label: 'Text', icon: '𝐓', hasVideo: true, runtime: TextRuntime,
    defaults: { text: 'Welcome!', ...TEXT_STYLE_DEFAULTS, wrapWidth: 0, scrollSpeed: 0, scrollWidth: 1920, scrollGap: 200 },
    fields: () => [
      { key: 'text', label: 'Text', type: 'textarea', rows: 3 },
      ...TEXT_STYLE_FIELDS,
      { key: 'wrapWidth', label: 'Wrap width', type: 'number', min: 0, unit: 'px', help: '0 = no wrapping' },
      { type: 'heading', label: 'Scrolling ticker' },
      { key: 'scrollSpeed', label: 'Scroll speed', type: 'range', min: -600, max: 600, step: 10, unit: ' px/s', help: '0 = static' },
      { key: 'scrollWidth', label: 'Ticker width', type: 'number', min: 100, unit: 'px', showIf: (s) => s.scrollSpeed },
      { key: 'scrollGap', label: 'Gap between repeats', type: 'number', min: 0, unit: 'px', showIf: (s) => s.scrollSpeed },
    ],
  },
  countdown: {
    label: 'Countdown / clock', icon: '⏱', hasVideo: true, runtime: CountdownRuntime,
    defaults: { mode: 'duration', minutes: 5, seconds: 0, targetTime: '10:00', format: 'auto', prefix: 'Service starts in ', suffix: '', endText: 'Starting now!', restartOnEnter: true, showSeconds: false, ...TEXT_STYLE_DEFAULTS, size: 72, align: 'center' },
    fields: () => [
      { key: 'mode', label: 'Mode', type: 'select', options: [{ value: 'duration', label: 'Countdown (duration)' }, { value: 'time', label: 'Countdown to time of day' }, { value: 'clock', label: 'Current time' }, { value: 'stopwatch', label: 'Stopwatch (count up)' }] },
      { key: 'minutes', label: 'Minutes', type: 'number', min: 0, showIf: (s) => s.mode === 'duration' },
      { key: 'seconds', label: 'Seconds', type: 'number', min: 0, max: 59, showIf: (s) => s.mode === 'duration' },
      { key: 'targetTime', label: 'Target time', type: 'text', placeholder: '10:30', showIf: (s) => s.mode === 'time', help: '24-hour HH:MM' },
      { key: 'restartOnEnter', label: 'Restart when scene goes live', type: 'checkbox', showIf: (s) => s.mode === 'duration' || s.mode === 'stopwatch' },
      { key: 'format', label: 'Format', type: 'select', options: [{ value: 'auto', label: 'M:SS' }, { value: 'hms', label: 'H:MM:SS' }], showIf: (s) => s.mode !== 'clock' },
      { key: 'showSeconds', label: 'Show seconds', type: 'checkbox', showIf: (s) => s.mode === 'clock' },
      { key: 'prefix', label: 'Text before', type: 'text' },
      { key: 'suffix', label: 'Text after', type: 'text' },
      { key: 'endText', label: 'When finished show', type: 'text', showIf: (s) => s.mode === 'duration' || s.mode === 'time' },
      ...TEXT_STYLE_FIELDS,
    ],
  },
  color: {
    label: 'Colour / gradient', icon: '🎨', hasVideo: true, runtime: ColorRuntime,
    defaults: { color: '#1b2a4a', color2: '#3a1b4a', gradient: false, angle: 135, width: 0, height: 0 },
    fields: () => [
      { key: 'color', label: 'Colour', type: 'color' },
      { key: 'gradient', label: 'Gradient', type: 'checkbox' },
      { key: 'color2', label: 'Colour 2', type: 'color', showIf: (s) => s.gradient },
      { key: 'angle', label: 'Angle', type: 'range', min: 0, max: 360, unit: '°', showIf: (s) => s.gradient },
    ],
  },
  worship: {
    label: 'Scripture & lyrics (from Presenter)', icon: '✝', hasVideo: true, runtime: WorshipRuntime,
    defaults: {
      mode: 'lowerthird', showSongs: true, showScripture: true, showCustom: true, followModes: true, fade: 300,
      font: 'Segoe UI', fontSize: 54, minFontSize: 24, textColor: '#ffffff', bold: true, align: 'center', shadow: true, outline: false,
      showReference: true, refSize: 34, refColor: '#f2c14e',
      barColor: '#0b1220', barOpacity: 0.82, barHeight: 26, barPosition: 'bottom', margin: 4, marginV: 30, radius: 14, accent: true, accentColor: '#f2c14e',
    },
    fields: () => [
      { key: 'mode', label: 'Style', type: 'select', options: [{ value: 'lowerthird', label: 'Lower third (bar)' }, { value: 'textonly', label: 'Text only (over video)' }, { value: 'fullscreen', label: 'Full screen (as projected)' }] },
      { key: 'showScripture', label: 'Show scripture', type: 'checkbox' },
      { key: 'showSongs', label: 'Show song lyrics', type: 'checkbox' },
      { key: 'showCustom', label: 'Show custom slides', type: 'checkbox' },
      { key: 'followModes', label: 'Hide when Black / Clear / Logo', type: 'checkbox' },
      { key: 'fade', label: 'Fade', type: 'range', min: 0, max: 1500, step: 50, unit: ' ms' },
      { type: 'heading', label: 'Text', showIf: (s) => s.mode !== 'fullscreen' },
      { key: 'font', label: 'Font', type: 'font', showIf: (s) => s.mode !== 'fullscreen' },
      { key: 'fontSize', label: 'Max size', type: 'range', min: 20, max: 140, unit: 'px', showIf: (s) => s.mode !== 'fullscreen' },
      { key: 'minFontSize', label: 'Min size', type: 'range', min: 12, max: 80, unit: 'px', showIf: (s) => s.mode !== 'fullscreen' },
      { key: 'textColor', label: 'Colour', type: 'color', showIf: (s) => s.mode !== 'fullscreen' },
      { key: 'bold', label: 'Bold', type: 'checkbox', showIf: (s) => s.mode !== 'fullscreen' },
      { key: 'align', label: 'Align', type: 'select', options: ['center', 'left'], showIf: (s) => s.mode !== 'fullscreen' },
      { key: 'outline', label: 'Outline', type: 'checkbox', showIf: (s) => s.mode === 'textonly' },
      { key: 'showReference', label: 'Show reference', type: 'checkbox', showIf: (s) => s.mode !== 'fullscreen' },
      { key: 'refSize', label: 'Reference size', type: 'range', min: 14, max: 80, unit: 'px', showIf: (s) => s.mode !== 'fullscreen' && s.showReference },
      { key: 'refColor', label: 'Reference colour', type: 'color', showIf: (s) => s.mode !== 'fullscreen' && s.showReference },
      { type: 'heading', label: 'Bar', showIf: (s) => s.mode !== 'fullscreen' },
      { key: 'barPosition', label: 'Position', type: 'select', options: ['bottom', 'top'], showIf: (s) => s.mode !== 'fullscreen' },
      { key: 'barHeight', label: 'Height', type: 'range', min: 10, max: 60, unit: '%', showIf: (s) => s.mode !== 'fullscreen' },
      { key: 'barColor', label: 'Colour', type: 'color', showIf: (s) => s.mode === 'lowerthird' },
      { key: 'barOpacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.05, showIf: (s) => s.mode === 'lowerthird' },
      { key: 'margin', label: 'Side margin', type: 'range', min: 0, max: 20, unit: '%', showIf: (s) => s.mode === 'lowerthird' },
      { key: 'marginV', label: 'Edge distance', type: 'range', min: 0, max: 150, unit: 'px', showIf: (s) => s.mode === 'lowerthird' },
      { key: 'radius', label: 'Corner radius', type: 'range', min: 0, max: 60, unit: 'px', showIf: (s) => s.mode === 'lowerthird' },
      { key: 'accent', label: 'Accent line', type: 'checkbox', showIf: (s) => s.mode === 'lowerthird' },
      { key: 'accentColor', label: 'Accent colour', type: 'color', showIf: (s) => s.mode === 'lowerthird' && s.accent },
    ],
  },
  scene: {
    label: 'Scene (nested)', icon: '🧩', hasVideo: true, runtime: SceneRuntime, defaults: { sceneId: '' },
    fields: (env) => [{ key: 'sceneId', label: 'Scene', type: 'select', options: () => env.sceneOptions() }],
  },
};

export const ADD_MENU_ORDER = ['camera', 'mic', 'video', 'image', 'slideshow', 'display', 'window', 'text', 'countdown', 'worship', 'color', 'desktopAudio', 'scene'];

function fileListControl(files, set, exts) {
  const wrap = h('div', { class: 'file-list' });
  const render = () => {
    wrap.innerHTML = '';
    files.forEach((f, i) => wrap.appendChild(h('div', { class: 'file-list-row' }, h('span', { title: f }, basename(f)),
      h('button', { class: 'icon-btn', title: 'Up', onclick: () => { if (i) { files.splice(i - 1, 0, files.splice(i, 1)[0]); set([...files]); render(); } } }, '↑'),
      h('button', { class: 'icon-btn', title: 'Remove', onclick: () => { files.splice(i, 1); set([...files]); render(); } }, '✕'))));
    wrap.appendChild(h('button', { class: 'btn sm', onclick: async () => {
      const r = await window.api.dialog.open({ multi: true, filters: [{ name: 'Images', extensions: mediaExts(exts) }] });
      files.push(...r); set([...files]); render();
    } }, '+ Add images…'));
  };
  render();
  return wrap;
}

export function createRuntime(src, env) {
  const T = SOURCE_TYPES[src.type];
  if (!T) return null;
  src.settings = { ...T.defaults, ...(src.settings || {}) };
  return new T.runtime(src, env);
}
