// Projector output page. Runs inside an Electron output window (outputBridge) or in any
// browser via the network output (Server-Sent Events).
import { resolveTheme, drawBackground, drawSlideText } from './slide-render.js';

const bridge = window.outputBridge;
let audioMaster = !bridge ? false : true;
let state = null;
let bgKey = '', textKey = '', mediaKey = '', logoKey = '';
let fadeMs = 300;
const $ = (id) => document.getElementById(id);

const url = (p) => {
  if (!p) return '';
  if (/^(\/media|https?:|file:|data:|blob:)/i.test(p)) return p;
  return 'file:///' + p.replace(/\\/g, '/').split('/').map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/');
};

function crossfade(layer, el) {
  const old = [...layer.children];
  el.classList.add('fade');
  el.style.transition = `opacity ${fadeMs}ms ease`;
  layer.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('fade')));
  setTimeout(() => old.forEach((o) => { if (o.tagName === 'VIDEO') { o.pause(); o.removeAttribute('src'); o.load(); } o.remove(); }), fadeMs + 60);
}

function canvasEl() {
  const c = document.createElement('canvas');
  c.width = Math.round(innerWidth * devicePixelRatio);
  c.height = Math.round(innerHeight * devicePixelRatio);
  return c;
}

function renderBackground(force) {
  const t = resolveTheme(state && state.theme);
  const bg = t.bg;
  const key = JSON.stringify(bg) + (force ? Math.random() : '');
  if (key === bgKey) return;
  bgKey = key;
  let el;
  if (bg.type === 'image' || bg.type === 'video') {
    const wrap = document.createElement('div');
    const m = document.createElement(bg.type === 'video' ? 'video' : 'img');
    m.src = url(bg.path);
    if (bg.fit === 'contain') m.className = 'contain';
    if (bg.fit === 'stretch') m.className = 'stretch';
    if (bg.type === 'video') { m.muted = true; m.loop = bg.loop !== false; m.autoplay = true; m.playsInline = true; }
    wrap.appendChild(m);
    if (bg.dim > 0) { const d = document.createElement('div'); d.style.background = `rgba(0,0,0,${bg.dim})`; wrap.appendChild(d); }
    el = wrap;
  } else {
    el = canvasEl();
    drawBackground(el.getContext('2d'), el.width, el.height, t, null);
  }
  crossfade($('bg'), el);
}

function renderText(force) {
  const t = resolveTheme(state && state.theme);
  const slide = state && state.slide && !state.media ? state.slide : null;
  const key = JSON.stringify([slide, t.font, t.outline, t.shadow, t.margin, t.box, t.ref, innerWidth, innerHeight]) + (force ? Math.random() : '');
  if (key === textKey) return;
  textKey = key;
  const c = canvasEl();
  if (slide) drawSlideText(c.getContext('2d'), c.width, c.height, slide, t);
  crossfade($('text'), c);
}

let mediaEl = null;
function renderMedia() {
  const m = state && state.media;
  const key = m ? m.path + '|' + (m.nonce || '') : '';
  if (key === mediaKey) {
    if (mediaEl && m && mediaEl.tagName === 'VIDEO') { mediaEl.loop = !!m.loop; mediaEl.volume = m.volume ?? 1; }
    return;
  }
  mediaKey = key;
  if (!m) { mediaEl = null; crossfade($('media'), document.createElement('div')); return; }
  const isVid = m.type === 'video';
  const el = document.createElement(isVid ? 'video' : 'img');
  el.src = url(m.path);
  el.className = m.fit === 'contain' ? 'contain' : m.fit === 'stretch' ? 'stretch' : '';
  el.style.background = '#000';
  if (isVid) {
    el.loop = !!m.loop;
    el.muted = !audioMaster || !!m.muted;
    el.volume = m.volume ?? 1;
    el.playsInline = true;
    if (m.autoplay !== false) el.autoplay = true;
    if (m.startAt) el.addEventListener('loadedmetadata', () => { el.currentTime = m.startAt; }, { once: true });
  }
  mediaEl = el;
  crossfade($('media'), el);
}

function renderLogo() {
  const p = state && state.logoPath;
  if (p !== logoKey) {
    logoKey = p;
    $('logo').innerHTML = '';
    if (p) { const i = document.createElement('img'); i.src = url(p); $('logo').appendChild(i); }
  }
}

function apply() {
  if (!state) return;
  fadeMs = Math.max(0, Number(state.transition ?? 300));
  document.documentElement.style.setProperty('--fade', fadeMs + 'ms');
  renderBackground();
  renderMedia();
  renderText();
  renderLogo();
  const mode = state.mode || 'normal';
  $('black').style.opacity = mode === 'black' ? 1 : 0;
  $('logo').style.opacity = mode === 'logo' ? 1 : 0;
  $('text').style.opacity = mode === 'clear' ? 0 : 1;
  $('media').style.opacity = mode === 'clear' && !state.media ? 0 : 1;
  if (mediaEl && mediaEl.tagName === 'VIDEO') {
    if (mode === 'black' || mode === 'logo') mediaEl.muted = true;
    else mediaEl.muted = !audioMaster || !!(state.media && state.media.muted);
  }
}

function mediaCommand(cmd) {
  if (!mediaEl || mediaEl.tagName !== 'VIDEO') return;
  if (cmd.action === 'play') mediaEl.play().catch(() => {});
  if (cmd.action === 'pause') mediaEl.pause();
  if (cmd.action === 'toggle') mediaEl.paused ? mediaEl.play().catch(() => {}) : mediaEl.pause();
  if (cmd.action === 'seek') mediaEl.currentTime = cmd.time;
  if (cmd.action === 'restart') { mediaEl.currentTime = 0; mediaEl.play().catch(() => {}); }
  if (cmd.action === 'volume') mediaEl.volume = cmd.value;
}

if (bridge) {
  bridge.onRole((r) => { audioMaster = !!r.audio; apply(); });
  bridge.onState((s) => { state = s; apply(); });
  bridge.onMedia(mediaCommand);
  setInterval(() => {
    if (!audioMaster || !mediaEl || mediaEl.tagName !== 'VIDEO') return;
    bridge.mediaStatus({ path: state && state.media && state.media.path, time: mediaEl.currentTime, duration: mediaEl.duration || 0, paused: mediaEl.paused, ended: mediaEl.ended });
  }, 250);
} else {
  const es = new EventSource('/events');
  es.addEventListener('state', (e) => { state = JSON.parse(e.data); apply(); });
  es.addEventListener('media', (e) => mediaCommand(JSON.parse(e.data)));
}

addEventListener('resize', () => { bgKey = ''; textKey = ''; apply(); });
