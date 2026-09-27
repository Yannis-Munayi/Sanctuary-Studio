// Worship themes (backgrounds + text styling) and the theme editor.
import { h, uid, modal, buildForm, clone, debounce, fileUrl, isVideo, toast } from '../util.js';
import { DEFAULT_THEME, resolveTheme, drawBackground, drawSlideText, loadImage } from '../slide-render.js';

const BUILTIN = [
  { id: 'lyrics', name: 'Lyrics — Deep Blue', bg: { type: 'gradient', color: '#0c1a33', color2: '#2b4f82', angle: 135 }, font: { size: 84, bold: true } },
  { id: 'scripture', name: 'Scripture — Midnight', bg: { type: 'gradient', color: '#111317', color2: '#2d2a24', angle: 160 },
    font: { size: 66, bold: false, align: 'center', lineHeight: 1.25 }, ref: { show: true, size: 42, color: '#f2d27a', position: 'bottom', align: 'right', bold: true } },
  { id: 'black', name: 'Plain — Black', bg: { type: 'color', color: '#000000' }, font: { size: 80, bold: true }, shadow: { enabled: false } },
  { id: 'lowerthird', name: 'Projector Lower Third', bg: { type: 'color', color: '#000000' },
    font: { size: 60, bold: true, valign: 'bottom' }, margin: { l: 5, r: 5, t: 60, b: 6 }, box: { enabled: true, color: '#000000', opacity: 0.55, radius: 14 } },
  { id: 'warm', name: 'Lyrics — Warm Sunrise', bg: { type: 'gradient', color: '#3b1d0f', color2: '#b0602a', angle: 120 }, font: { size: 84, bold: true },
    outline: { enabled: true, color: '#2a1206', width: 2 } },
];

export class ThemeLibrary {
  constructor() { this.themes = []; this.save = debounce(() => window.api.store.write('themes', this.themes), 400); }
  async load() {
    const saved = (await window.api.store.read('themes', null)) || [];
    const map = new Map(saved.map((t) => [t.id, t]));
    for (const b of BUILTIN) if (!map.has(b.id)) map.set(b.id, { ...clone(b), builtin: true });
    this.themes = [...map.values()];
  }
  get(id) { return this.themes.find((t) => t.id === id); }
  resolve(id, fallbackId) { return resolveTheme(this.get(id) || this.get(fallbackId) || this.themes[0]); }
  upsert(t) {
    const i = this.themes.findIndex((x) => x.id === t.id);
    if (i >= 0) this.themes[i] = t; else this.themes.push(t);
    this.save();
  }
  remove(id) { this.themes = this.themes.filter((t) => t.id !== id); this.save(); }
}

// Draw a theme + slide into a canvas (used for thumbnails / monitors)
export function paintSlide(canvas, theme, slide, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  let media = null;
  if (opts.media) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (opts.media.type === 'image') {
      const img = loadImage(fileUrl(opts.media.path), () => paintSlide(canvas, theme, slide, opts));
      if (img && img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, W, H);
    } else if (opts.videoFrame) {
      try { ctx.drawImage(opts.videoFrame, 0, 0, W, H); } catch {}
    } else {
      ctx.fillStyle = '#1b2230'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#9fb3d1'; ctx.font = `${Math.round(H / 7)}px Segoe UI`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('▶ ' + (opts.media.title || 'Video'), W / 2, H / 2);
    }
    return;
  }
  if (theme.bg.type === 'image') media = loadImage(fileUrl(theme.bg.path), () => paintSlide(canvas, theme, slide, opts));
  else if (theme.bg.type === 'video') media = opts.videoFrame || videoPoster(theme.bg.path, () => paintSlide(canvas, theme, slide, opts));
  drawBackground(ctx, W, H, theme, media && (media.complete !== false) ? media : null);
  if (slide && !opts.hideText) drawSlideText(ctx, W, H, slide, theme);
}

// First frame of a video as a poster image (cached)
const posters = new Map();
export function videoPoster(path, onReady) {
  if (!path) return null;
  let p = posters.get(path);
  if (p) { if (!p.ready && onReady) p.waiters.push(onReady); return p.ready ? p.canvas : null; }
  p = { ready: false, canvas: document.createElement('canvas'), waiters: onReady ? [onReady] : [] };
  posters.set(path, p);
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.src = fileUrl(path);
  v.addEventListener('loadeddata', () => { v.currentTime = Math.min(1, (v.duration || 2) / 3); });
  v.addEventListener('seeked', () => {
    p.canvas.width = 320; p.canvas.height = Math.round(320 * (v.videoHeight / v.videoWidth || 9 / 16));
    p.canvas.getContext('2d').drawImage(v, 0, 0, p.canvas.width, p.canvas.height);
    p.ready = true; v.removeAttribute('src'); v.load();
    p.waiters.forEach((f) => f()); p.waiters = [];
  }, { once: true });
  return null;
}

export const THEME_FIELDS = [
  { type: 'heading', label: 'Background' },
  { key: 'bg.type', label: 'Type', type: 'select', options: [
    { value: 'gradient', label: 'Gradient' }, { value: 'color', label: 'Solid colour' }, { value: 'image', label: 'Image' }, { value: 'video', label: 'Motion video (loops)' }] },
  { key: 'bg.color', label: 'Colour', type: 'color', showIf: (t) => t.bg.type === 'color' || t.bg.type === 'gradient' },
  { key: 'bg.color2', label: 'Colour 2', type: 'color', showIf: (t) => t.bg.type === 'gradient' },
  { key: 'bg.angle', label: 'Angle', type: 'range', min: 0, max: 360, unit: '°', showIf: (t) => t.bg.type === 'gradient' },
  { key: 'bg.path', label: 'File', type: 'file', filters: [{ name: 'Media', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'mp4', 'webm', 'mov', 'mkv', 'm4v'] }], showIf: (t) => t.bg.type === 'image' || t.bg.type === 'video' },
  { key: 'bg.fit', label: 'Fit', type: 'select', options: [{ value: 'cover', label: 'Fill (crop)' }, { value: 'contain', label: 'Fit (letterbox)' }, { value: 'stretch', label: 'Stretch' }], showIf: (t) => t.bg.type === 'image' || t.bg.type === 'video' },
  { key: 'bg.dim', label: 'Darken', type: 'range', min: 0, max: 0.9, step: 0.05, format: (v) => Math.round(v * 100) + '%' },
  { type: 'heading', label: 'Text' },
  { key: 'font.family', label: 'Font', type: 'font' },
  { key: 'font.size', label: 'Max size', type: 'range', min: 24, max: 200, unit: 'px', help: 'Text shrinks automatically to fit' },
  { key: 'font.minSize', label: 'Min size', type: 'range', min: 12, max: 100, unit: 'px' },
  { key: 'font.color', label: 'Colour', type: 'color' },
  { key: 'font.bold', label: 'Bold', type: 'checkbox' },
  { key: 'font.italic', label: 'Italic', type: 'checkbox' },
  { key: 'font.caps', label: 'ALL CAPS', type: 'checkbox' },
  { key: 'font.align', label: 'Align', type: 'select', options: ['left', 'center', 'right'] },
  { key: 'font.valign', label: 'Vertical', type: 'select', options: ['top', 'middle', 'bottom'] },
  { key: 'font.lineHeight', label: 'Line spacing', type: 'range', min: 0.9, max: 2, step: 0.02 },
  { key: 'outline.enabled', label: 'Outline', type: 'checkbox' },
  { key: 'outline.color', label: 'Outline colour', type: 'color', showIf: (t) => t.outline.enabled },
  { key: 'outline.width', label: 'Outline width', type: 'range', min: 1, max: 12, showIf: (t) => t.outline.enabled },
  { key: 'shadow.enabled', label: 'Shadow', type: 'checkbox' },
  { key: 'shadow.color', label: 'Shadow colour', type: 'color', showIf: (t) => t.shadow.enabled },
  { key: 'shadow.blur', label: 'Shadow blur', type: 'range', min: 0, max: 40, showIf: (t) => t.shadow.enabled },
  { key: 'box.enabled', label: 'Box behind text', type: 'checkbox' },
  { key: 'box.color', label: 'Box colour', type: 'color', showIf: (t) => t.box.enabled },
  { key: 'box.opacity', label: 'Box opacity', type: 'range', min: 0, max: 1, step: 0.05, showIf: (t) => t.box.enabled },
  { type: 'heading', label: 'Margins (% of screen)' },
  { key: 'margin.l', label: 'Left', type: 'range', min: 0, max: 45 },
  { key: 'margin.r', label: 'Right', type: 'range', min: 0, max: 45 },
  { key: 'margin.t', label: 'Top', type: 'range', min: 0, max: 80 },
  { key: 'margin.b', label: 'Bottom', type: 'range', min: 0, max: 80 },
  { type: 'heading', label: 'Scripture reference / footer' },
  { key: 'ref.show', label: 'Show reference', type: 'checkbox' },
  { key: 'ref.position', label: 'Position', type: 'select', options: [{ value: 'bottom', label: 'Bottom of screen' }, { value: 'top', label: 'Top of screen' }, { value: 'after', label: 'Under the text' }], showIf: (t) => t.ref.show },
  { key: 'ref.align', label: 'Align', type: 'select', options: ['left', 'center', 'right'], showIf: (t) => t.ref.show },
  { key: 'ref.size', label: 'Size', type: 'range', min: 16, max: 100, unit: 'px', showIf: (t) => t.ref.show },
  { key: 'ref.color', label: 'Colour', type: 'color', showIf: (t) => t.ref.show },
  { key: 'ref.bold', label: 'Bold', type: 'checkbox', showIf: (t) => t.ref.show },
];

export function openThemeEditor(theme, library, onSaved) {
  const t = resolveTheme(clone(theme || { ...DEFAULT_THEME, id: uid('t'), name: 'New Theme' }));
  if (!theme || theme.builtin) { if (theme && theme.builtin) { t.id = uid('t'); t.name = theme.name + ' (copy)'; } delete t.builtin; }
  const canvas = h('canvas', { width: 640, height: 360, class: 'theme-preview' });
  let sample = 'lyrics';
  const samples = {
    lyrics: { text: 'Amazing grace how sweet the sound\nThat saved a wretch like me\nI once was lost but now am found\nWas blind but now I see', label: 'Verse 1' },
    scripture: { text: 'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.', reference: 'John 3:16 (KJV)' },
  };
  const draw = () => paintSlide(canvas, t, samples[sample]);
  const name = h('input', { type: 'text', value: t.name, oninput: (e) => { t.name = e.target.value; } });
  const form = buildForm(THEME_FIELDS, t, () => draw());
  const body = h('div', { class: 'theme-editor' },
    h('div', { class: 'theme-editor-left' },
      h('label', { class: 'fld' }, h('span', null, 'Theme name'), name),
      canvas,
      h('div', { class: 'seg' }, ['lyrics', 'scripture'].map((k) => h('button', { class: 'btn sm', onclick: () => { sample = k; draw(); } }, k === 'lyrics' ? 'Lyric sample' : 'Scripture sample')))),
    h('div', { class: 'theme-editor-right' }, form));
  draw();
  modal({
    title: 'Theme Editor', body, width: 'min(1060px, 95vw)', className: 'tall',
    buttons: [{ label: 'Cancel' }, {
      label: 'Save theme', primary: true, onClick: () => {
        if (t.bg.type === 'video' && t.bg.path && !isVideo(t.bg.path)) { toast('That file does not look like a video', 'warn'); }
        library.upsert(t); onSaved && onSaved(t);
      },
    }],
  });
}
