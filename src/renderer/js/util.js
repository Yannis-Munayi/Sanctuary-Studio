// Small DOM / UI toolkit shared by every panel.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else if (k === 'value' || k === 'checked' || k === 'selected') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const uid = (p = '') => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function debounce(fn, ms = 300) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  return d;
}

export class Emitter {
  constructor() { this._h = {}; }
  on(ev, fn) { (this._h[ev] ||= new Set()).add(fn); return () => this._h[ev].delete(fn); }
  emit(ev, ...a) { for (const fn of this._h[ev] || []) { try { fn(...a); } catch (e) { console.error(e); } } }
}

export function fileUrl(p) {
  if (!p) return '';
  if (/^(https?|file|data|blob):/i.test(p)) return p;
  const norm = p.replace(/\\/g, '/');
  return 'file:///' + norm.split('/').map((s, i) => (i === 0 && /^[a-z]:$/i.test(s) ? s : encodeURIComponent(s))).join('/');
}

export const basename = (p) => String(p || '').split(/[\\/]/).pop();
export const extname = (p) => (String(p).match(/\.[^.\\/]+$/) || [''])[0].toLowerCase();
export const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
export const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.mkv', '.m4v', '.avi', '.ogv'];
export const AUDIO_EXT = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];
export const isVideo = (p) => VIDEO_EXT.includes(extname(p));
export const isImage = (p) => IMAGE_EXT.includes(extname(p));

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = Math.floor(sec % 60);
  return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0');
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
export function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = (o[keys[i]] ??= {});
  o[keys.at(-1)] = value;
}

export function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]))
      ? deepMerge(base[k], v) : v;
  }
  return out;
}

// ------------------------------------------------ toasts ------------------------------------------------
export function toast(msg, type = 'info', ms = 3500) {
  let host = $('#toasts');
  if (!host) { host = h('div', { id: 'toasts' }); document.body.appendChild(host); }
  const t = h('div', { class: 'toast ' + type }, msg);
  host.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

// ------------------------------------------------ modals ------------------------------------------------
export function modal({ title, body, buttons = [{ label: 'Close' }], width = 520, onClose, className = '' }) {
  const box = h('div', { class: 'modal ' + className, style: { width: typeof width === 'number' ? width + 'px' : width } });
  const back = h('div', { class: 'modal-back' }, box);
  const close = (result) => { back.remove(); document.removeEventListener('keydown', onKey, true); onClose && onClose(result); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
      const p = buttons.find((b) => b.primary);
      if (p) { e.preventDefault(); e.stopPropagation(); click(p); }
    }
  };
  const click = async (b) => {
    if (b.onClick) { const r = await b.onClick(); if (r === false) return; }
    close(b.value);
  };
  const head = h('div', { class: 'modal-head' }, h('span', null, title), h('button', { class: 'icon-btn', title: 'Close', onclick: () => close() }, '✕'));
  const content = h('div', { class: 'modal-body' });
  if (typeof body === 'function') body(content, close); else if (body) append(content, [body]);
  const foot = h('div', { class: 'modal-foot' }, buttons.map((b) =>
    h('button', { class: 'btn ' + (b.primary ? 'primary' : '') + (b.danger ? ' danger' : '') + (b.left ? ' left' : ''), onclick: () => click(b) }, b.label)));
  box.append(head, content, foot);
  document.body.appendChild(back);
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => { const f = content.querySelector('input,textarea,select'); if (f) f.focus(); }, 30);
  return { close, el: box, body: content };
}

export function confirmDialog(message, { title = 'Confirm', ok = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    let v = false;
    modal({
      title, body: h('p', { style: { margin: 0, whiteSpace: 'pre-wrap' } }, message), width: 420,
      buttons: [{ label: 'Cancel' }, { label: ok, primary: true, danger, onClick: () => { v = true; } }],
      onClose: () => resolve(v),
    });
  });
}

export function promptDialog(message, value = '', { title = 'Input', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, placeholder, class: 'full' });
    let v = null;
    modal({
      title, width: 420, body: h('div', null, h('label', { class: 'lbl' }, message), input),
      buttons: [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: () => { v = input.value; } }],
      onClose: () => resolve(v),
    });
    setTimeout(() => input.select(), 40);
  });
}

// ------------------------------------------------ context menu ------------------------------------------------
let openMenu = null;
export function contextMenu(x, y, items) {
  closeMenu();
  const menu = h('div', { class: 'ctx-menu' });
  const build = (host, list) => {
    for (const it of list) {
      if (!it) continue;
      if (it === '-' || it.separator) { host.appendChild(h('div', { class: 'ctx-sep' })); continue; }
      const row = h('div', { class: 'ctx-item' + (it.disabled ? ' disabled' : '') + (it.submenu ? ' has-sub' : '') },
        h('span', { class: 'ctx-check' }, it.checked ? '✓' : ''), h('span', { class: 'ctx-label' }, it.label),
        it.hint ? h('span', { class: 'ctx-hint' }, it.hint) : null);
      if (it.submenu) {
        const sub = h('div', { class: 'ctx-menu sub' });
        build(sub, it.submenu);
        row.appendChild(sub);
      } else if (!it.disabled) {
        row.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); it.onClick && it.onClick(); });
      }
      host.appendChild(row);
    }
  };
  build(menu, items);
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 4) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 4) + 'px';
  openMenu = menu;
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
}
function outside(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
export function closeMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
  document.removeEventListener('mousedown', outside, true);
}

// ------------------------------------------------ fonts ------------------------------------------------
const COMMON_FONTS = ['Segoe UI', 'Arial', 'Arial Black', 'Calibri', 'Cambria', 'Candara', 'Century Gothic', 'Consolas', 'Constantia',
  'Corbel', 'Franklin Gothic Medium', 'Georgia', 'Impact', 'Lucida Sans Unicode', 'Montserrat', 'Open Sans', 'Palatino Linotype',
  'Segoe Print', 'Segoe Script', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Bahnschrift', 'Gabriola', 'Sitka Text'];
let fontList = null;
export async function getFonts() {
  if (fontList) return fontList;
  fontList = [...COMMON_FONTS];
  try {
    if (window.queryLocalFonts) {
      const fonts = await window.queryLocalFonts();
      const fams = new Set(fonts.map((f) => f.family));
      fontList = [...new Set([...COMMON_FONTS.filter((f) => fams.has(f) || f === 'Segoe UI'), ...[...fams].sort()])];
    }
  } catch {}
  return fontList;
}

// ------------------------------------------------ form builder ------------------------------------------------
// fields: [{ key, label, type, options, min, max, step, help, showIf(obj), placeholder, filters, rows }]
export function buildForm(fields, obj, onChange = () => {}) {
  const form = h('div', { class: 'form' });
  const rows = [];
  const refresh = () => {
    for (const r of rows) if (r.f.showIf) r.el.style.display = r.f.showIf(obj) ? '' : 'none';
  };
  const changed = (f, v) => { setPath(obj, f.key, v); onChange(f.key, v, obj); refresh(); };

  for (const f of fields) {
    let control;
    const val = f.key ? getPath(obj, f.key) : undefined;
    switch (f.type) {
      case 'heading': control = null; break;
      case 'note': control = null; break;
      case 'checkbox':
        control = h('label', { class: 'switch' },
          h('input', { type: 'checkbox', checked: !!val, onchange: (e) => changed(f, e.target.checked) }), h('span', { class: 'slider' }));
        break;
      case 'select': {
        const opts = typeof f.options === 'function' ? f.options(obj) : f.options;
        control = h('select', { onchange: (e) => changed(f, f.numeric ? Number(e.target.value) : e.target.value) },
          opts.map((o) => { const ov = typeof o === 'object' ? o.value : o; return h('option', { value: ov, selected: String(ov) === String(val) }, typeof o === 'object' ? o.label : o); }));
        if (f.asyncOptions) f.asyncOptions(obj).then((list) => {
          control.innerHTML = '';
          for (const o of list) control.appendChild(h('option', { value: o.value, selected: String(o.value) === String(getPath(obj, f.key)) }, o.label));
          if (!list.some((o) => String(o.value) === String(getPath(obj, f.key))) && list.length && f.autoSelect) changed(f, list[0].value);
        });
        break;
      }
      case 'range': {
        const out = h('span', { class: 'range-val' }, fmtRange(f, val));
        const inp = h('input', {
          type: 'range', min: f.min ?? 0, max: f.max ?? 100, step: f.step ?? 1, value: val ?? f.min ?? 0,
          oninput: (e) => { out.textContent = fmtRange(f, Number(e.target.value)); changed(f, Number(e.target.value)); },
        });
        control = h('div', { class: 'range-row' }, inp, out);
        break;
      }
      case 'number':
        control = h('input', { type: 'number', value: val ?? '', min: f.min, max: f.max, step: f.step ?? 'any', placeholder: f.placeholder,
          onchange: (e) => changed(f, e.target.value === '' ? '' : Number(e.target.value)) });
        if (f.unit) control = h('div', { class: 'unit-row' }, control, h('span', { class: 'unit' }, f.unit));
        break;
      case 'color':
        control = h('input', { type: 'color', value: val || '#ffffff', oninput: (e) => changed(f, e.target.value) });
        break;
      case 'textarea':
        control = h('textarea', { rows: f.rows || 4, placeholder: f.placeholder || '', oninput: (e) => changed(f, e.target.value) }, val || '');
        break;
      case 'password': {
        const inp = h('input', { type: 'password', value: val || '', placeholder: f.placeholder || '', oninput: (e) => changed(f, e.target.value) });
        control = h('div', { class: 'pw-row' }, inp, h('button', { class: 'btn sm', onclick: () => { inp.type = inp.type === 'password' ? 'text' : 'password'; } }, 'Show'));
        break;
      }
      case 'file':
      case 'folder': {
        const inp = h('input', { type: 'text', value: val || '', placeholder: f.placeholder || '', onchange: (e) => changed(f, e.target.value) });
        control = h('div', { class: 'file-row' }, inp, h('button', {
          class: 'btn sm', onclick: async () => {
            const r = await window.api.dialog.open({ directory: f.type === 'folder', filters: f.filters, defaultPath: inp.value || undefined });
            if (r[0]) { inp.value = r[0]; changed(f, r[0]); }
          },
        }, 'Browse…'), f.clearable ? h('button', { class: 'btn sm', onclick: () => { inp.value = ''; changed(f, ''); } }, 'Clear') : null);
        break;
      }
      case 'font': {
        const listId = 'fonts-' + uid();
        const dl = h('datalist', { id: listId });
        getFonts().then((fs) => fs.forEach((n) => dl.appendChild(h('option', { value: n }))));
        control = h('div', null, h('input', { type: 'text', list: listId, value: val || 'Segoe UI', onchange: (e) => changed(f, e.target.value) }), dl);
        break;
      }
      case 'custom':
        control = f.render(obj, (v) => changed(f, v), refresh);
        break;
      default:
        control = h('input', { type: 'text', value: val ?? '', placeholder: f.placeholder || '', oninput: (e) => changed(f, e.target.value) });
    }
    let el;
    if (f.type === 'heading') el = h('div', { class: 'form-heading' }, f.label);
    else if (f.type === 'note') el = h('div', { class: 'form-note' }, f.label);
    else el = h('div', { class: 'form-row' + (f.wide ? ' wide' : '') },
      h('label', { class: 'form-label', title: f.help || '' }, f.label),
      h('div', { class: 'form-control' }, control, f.help && f.showHelp !== false ? h('div', { class: 'form-help' }, f.help) : null));
    rows.push({ f, el });
    form.appendChild(el);
  }
  refresh();
  return form;
}

function fmtRange(f, v) {
  if (f.format) return f.format(v);
  return (v ?? 0) + (f.unit || '');
}

// Accelerator string from a keyboard event ("Ctrl+Shift+F5")
export function accelFromEvent(e) {
  const k = e.key;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return '';
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = k.length === 1 ? k.toUpperCase() : k;
  if (key === ' ') key = 'Space';
  if (key.startsWith('Arrow')) key = key.slice(5);
  parts.push(key);
  return parts.join('+');
}

export function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

// Reorderable list via drag handles
export function makeSortable(container, itemSelector, onMove) {
  let dragEl = null;
  container.addEventListener('dragstart', (e) => {
    const it = e.target.closest(itemSelector);
    if (!it) return;
    dragEl = it; it.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-sort', '1');
  });
  container.addEventListener('dragend', () => { if (dragEl) dragEl.classList.remove('dragging'); dragEl = null; $$('.drop-before,.drop-after', container).forEach((x) => x.classList.remove('drop-before', 'drop-after')); });
  container.addEventListener('dragover', (e) => {
    if (!dragEl) return;
    const over = e.target.closest(itemSelector);
    e.preventDefault();
    $$('.drop-before,.drop-after', container).forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    if (over && over !== dragEl) {
      const r = over.getBoundingClientRect();
      over.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
    }
  });
  container.addEventListener('drop', (e) => {
    if (!dragEl) return;
    e.preventDefault();
    const items = $$(itemSelector, container);
    const from = items.indexOf(dragEl);
    const over = e.target.closest(itemSelector);
    let to = items.length - 1;
    if (over) {
      const r = over.getBoundingClientRect();
      to = items.indexOf(over) + (e.clientY < r.top + r.height / 2 ? 0 : 1);
      if (from < to) to--;
    }
    if (from !== to && from >= 0) onMove(from, to);
  });
}
