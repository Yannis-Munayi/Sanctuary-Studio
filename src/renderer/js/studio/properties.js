// Source Properties / Filters / Transform dialogs. Edits apply live; Cancel restores.
import { h, modal, buildForm, clone, uid, toast } from '../util.js';
import { SOURCE_TYPES } from './sources.js';
import { VIDEO_FILTER_TYPES } from './filters.js';
import { AUDIO_FILTER_TYPES } from './audio.js';

export function openProperties(S, sourceId, { isNew = false, onDone } = {}) {
  const src = S.data.sources[sourceId];
  if (!src) return;
  const T = SOURCE_TYPES[src.type];
  const snapshot = clone(src);
  const rt = () => S.runtimes.get(sourceId);
  let timer;
  const apply = () => { clearTimeout(timer); timer = setTimeout(() => { const r = rt(); if (r) r.update(); S.changed(); S.renderSources(); }, 120); };

  const nameIn = h('input', { type: 'text', value: src.name, oninput: (e) => { src.name = e.target.value; S.renderSources(); S.renderMixer(); } });
  const preview = h('canvas', { class: 'prop-preview', width: 384, height: 216 });
  const form = buildForm(T.fields(S.env), src.settings, apply);
  const body = h('div', { class: 'props' + (T.audioOnly ? ' no-preview' : '') },
    h('div', { class: 'props-left' },
      h('label', { class: 'fld' }, h('span', null, 'Name'), nameIn),
      T.audioOnly ? null : preview,
      h('div', { class: 'prop-err' })),
    h('div', { class: 'props-right' }, form));
  // live preview of just this source
  const draw = () => {
    if (!preview.isConnected) return;
    const ctx = preview.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, preview.width, preview.height);
    const r = rt();
    const errEl = body.querySelector('.prop-err');
    if (errEl) errEl.textContent = r && r.error ? r.error : '';
    const f = r && r.frame();
    if (f) {
      const w = r.w || f.width, hh = r.h || f.height;
      if (w && hh) {
        const s = Math.min(preview.width / w, preview.height / hh);
        // checkerboard for transparency
        ctx.fillStyle = '#1a1a1a';
        for (let y = 0; y < preview.height; y += 12) for (let x = (y / 12) % 2 ? 12 : 0; x < preview.width; x += 24) ctx.fillRect(x, y, 12, 12);
        try { ctx.drawImage(f, (preview.width - w * s) / 2, (preview.height - hh * s) / 2, w * s, hh * s); } catch {}
      }
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
  modal({
    title: `${T.icon} ${T.label} — Properties`, body, width: 'min(920px, 94vw)', className: 'tall',
    buttons: [
      { label: 'Filters…', left: true, onClick: () => { openFilters(S, sourceId); return false; } },
      { label: isNew ? 'Remove' : 'Cancel', onClick: () => {
        if (isNew) { S.deleteSource(sourceId); return; }
        Object.assign(src, clone(snapshot));
        const r = rt(); if (r) r.update();
        S.changed(); S.renderSources(); S.renderMixer();
      } },
      { label: 'OK', primary: true, onClick: () => { clearTimeout(timer); const r = rt(); if (r) r.update(); S.changed(); S.renderSources(); S.renderMixer(); onDone && onDone(); } },
    ],
  });
}

export function openFilters(S, sourceId) {
  const src = S.data.sources[sourceId];
  const T = SOURCE_TYPES[src.type];
  src.filters ||= []; src.audioFilters ||= [];
  const snapshot = { f: clone(src.filters), a: clone(src.audioFilters) };
  let sel = null; // { kind: 'video'|'audio', f }
  const listV = h('div', { class: 'filter-list' });
  const listA = h('div', { class: 'filter-list' });
  const detail = h('div', { class: 'filter-detail' });
  const applyAudio = () => S.env.audio.channel(src).rebuildFilters();
  const changed = (kind) => { if (kind === 'audio') applyAudio(); S.changed(); };

  const renderList = (kind) => {
    const arr = kind === 'audio' ? src.audioFilters : src.filters;
    const types = kind === 'audio' ? AUDIO_FILTER_TYPES : VIDEO_FILTER_TYPES;
    const list = kind === 'audio' ? listA : listV;
    list.innerHTML = '';
    arr.forEach((f, i) => list.appendChild(h('div', { class: 'filter-row' + (sel && sel.f === f ? ' selected' : ''), onclick: () => { sel = { kind, f }; renderAll(); } },
      h('input', { type: 'checkbox', checked: f.enabled, onclick: (e) => e.stopPropagation(), onchange: (e) => { f.enabled = e.target.checked; changed(kind); } }),
      h('span', null, f.name || types[f.type].label),
      h('button', { class: 'icon-btn', title: 'Move up', onclick: (e) => { e.stopPropagation(); if (i) { arr.splice(i - 1, 0, arr.splice(i, 1)[0]); changed(kind); renderAll(); } } }, '↑'),
      h('button', { class: 'icon-btn', title: 'Remove', onclick: (e) => { e.stopPropagation(); arr.splice(i, 1); if (sel && sel.f === f) sel = null; changed(kind); renderAll(); } }, '✕'))));
    const add = h('select', { class: 'add-filter', onchange: (e) => {
      const t = e.target.value; if (!t) return;
      const f = { id: uid('f'), type: t, enabled: true, settings: clone(types[t].defaults) };
      arr.push(f); sel = { kind, f }; changed(kind); renderAll();
    } }, h('option', { value: '' }, '+ Add ' + kind + ' filter…'), Object.entries(types).map(([k, v]) => h('option', { value: k }, v.label)));
    list.appendChild(add);
  };
  const renderDetail = () => {
    detail.innerHTML = '';
    if (!sel) { detail.appendChild(h('div', { class: 'muted pad' }, 'Select or add a filter.')); return; }
    const types = sel.kind === 'audio' ? AUDIO_FILTER_TYPES : VIDEO_FILTER_TYPES;
    detail.appendChild(h('div', { class: 'form-heading' }, types[sel.f.type].label));
    detail.appendChild(buildForm(types[sel.f.type].fields, sel.f.settings, () => changed(sel.kind)));
    if (sel.f.type === 'chroma') detail.appendChild(h('div', { class: 'form-note' }, 'Tip: raise Similarity until the green disappears, then Smoothness to soften edges.'));
  };
  const renderAll = () => { if (T.hasVideo) renderList('video'); if (T.hasAudio) renderList('audio'); renderDetail(); };
  renderAll();
  modal({
    title: `Filters — ${src.name}`, width: 'min(860px, 94vw)',
    body: h('div', { class: 'filters' },
      h('div', { class: 'filters-left' },
        T.hasVideo ? h('div', null, h('div', { class: 'form-heading' }, 'Video filters'), listV) : null,
        T.hasAudio ? h('div', null, h('div', { class: 'form-heading' }, 'Audio filters'), listA) : null),
      detail),
    buttons: [
      { label: 'Cancel', onClick: () => { src.filters = snapshot.f; src.audioFilters = snapshot.a; applyAudio(); S.changed(); } },
      { label: 'Done', primary: true },
    ],
  });
}

export function openTransform(S, item) {
  const snapshot = clone(item);
  item.crop ||= { l: 0, t: 0, r: 0, b: 0 };
  const W = S.W, H = S.H;
  const upd = () => { S.itemMoved(item); S.changed(); };
  let form;
  const rebuild = () => {
    const nf = buildForm(fields, item, upd);
    form.replaceWith(nf); form = nf;
  };
  const natural = () => { const rt = S.runtimes.get(item.sourceId); return rt && rt.w ? [rt.w - item.crop.l - item.crop.r, rt.h - item.crop.t - item.crop.b] : [item.w, item.h]; };
  const fields = [
    { key: 'x', label: 'Position X', type: 'number', unit: 'px' },
    { key: 'y', label: 'Position Y', type: 'number', unit: 'px' },
    { key: 'w', label: 'Width', type: 'number', min: 1, unit: 'px' },
    { key: 'h', label: 'Height', type: 'number', min: 1, unit: 'px' },
    { key: 'rot', label: 'Rotation', type: 'range', min: -180, max: 180, unit: '°' },
    { key: 'fit', label: 'Scaling', type: 'select', options: [{ value: 'stretch', label: 'Stretch to box' }, { value: 'fit', label: 'Fit inside box (keep ratio)' }, { value: 'fill', label: 'Fill box (crop, keep ratio)' }] },
    { key: 'opacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.01, format: (v) => Math.round(v * 100) + '%' },
    { key: 'flipH', label: 'Mirror (flip horizontal)', type: 'checkbox' },
    { key: 'flipV', label: 'Flip vertical', type: 'checkbox' },
    { type: 'heading', label: 'Crop (source pixels) — or Alt+drag a handle on the canvas' },
    { key: 'crop.l', label: 'Left', type: 'number', min: 0 },
    { key: 'crop.r', label: 'Right', type: 'number', min: 0 },
    { key: 'crop.t', label: 'Top', type: 'number', min: 0 },
    { key: 'crop.b', label: 'Bottom', type: 'number', min: 0 },
  ];
  form = buildForm(fields, item, upd);
  const act = (label, fn) => h('button', { class: 'btn sm', onclick: () => { fn(); upd(); rebuild(); } }, label);
  const body = h('div', null,
    h('div', { class: 'btn-row' },
      act('Fit to screen', () => { const [nw, nh] = natural(); const s = Math.min(W / nw, H / nh); Object.assign(item, { w: Math.round(nw * s), h: Math.round(nh * s), rot: 0 }); item.x = Math.round((W - item.w) / 2); item.y = Math.round((H - item.h) / 2); }),
      act('Stretch to screen', () => Object.assign(item, { x: 0, y: 0, w: W, h: H, rot: 0 })),
      act('Center', () => { item.x = Math.round((W - item.w) / 2); item.y = Math.round((H - item.h) / 2); }),
      act('Original size', () => { const [nw, nh] = natural(); Object.assign(item, { w: nw, h: nh }); }),
      act('Reset', () => { Object.assign(item, { rot: 0, flipH: false, flipV: false, opacity: 1, crop: { l: 0, t: 0, r: 0, b: 0 } }); })),
    form);
  modal({
    title: 'Edit Transform', body, width: 560,
    buttons: [{ label: 'Cancel', onClick: () => { Object.assign(item, snapshot); upd(); } }, { label: 'Done', primary: true }],
  });
}

export function openAudioSettings(S, sourceId) {
  const src = S.data.sources[sourceId];
  src.audio ||= { volume: 1, muted: false, monitor: 'off', syncMs: 0 };
  const apply = () => { S.env.audio.channel(src).apply(); S.changed(); S.renderMixer(); };
  const fields = [
    { key: 'monitor', label: 'Audio monitoring', type: 'select', options: [
      { value: 'off', label: 'Monitor off' }, { value: 'monitorAndOutput', label: 'Monitor and output' }, { value: 'monitorOnly', label: 'Monitor only (mute stream)' }],
      help: 'Monitoring plays this source through your speakers/headphones (Settings › Audio › Monitoring device).' },
    { key: 'syncMs', label: 'Sync offset', type: 'number', min: 0, max: 3000, unit: 'ms', help: 'Delay this audio to line up with a camera that lags behind.' },
    { key: 'global', label: 'Always on (all scenes)', type: 'checkbox', help: 'Like OBS "global audio": this source is in the stream mix no matter which scene is live.' },
  ];
  const obj = { ...src.audio, global: S.data.globalAudio.includes(sourceId) };
  modal({
    title: 'Advanced audio — ' + src.name, width: 520,
    body: buildForm(fields, obj, (k, v) => {
      if (k === 'global') {
        S.data.globalAudio = S.data.globalAudio.filter((x) => x !== sourceId);
        if (v) S.data.globalAudio.push(sourceId);
        S.recomputeActive();
      } else { src.audio[k] = v; }
      apply();
    }),
    buttons: [{ label: 'Done', primary: true }],
  });
}

export function openRename(S, title, value, onOk) {
  const input = h('input', { type: 'text', value, class: 'full' });
  modal({ title, width: 400, body: input, buttons: [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: () => { if (!input.value.trim()) { toast('Name required'); return false; } onOk(input.value.trim()); } }] });
  setTimeout(() => input.select(), 40);
}
