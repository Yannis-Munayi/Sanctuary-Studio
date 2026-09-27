// Streaming studio: scenes, sources, mixer, editing canvas vs. live canvas, go-live controls.
import { h, $$, uid, clone, toast, confirmDialog, contextMenu, makeSortable, fmtTime, basename, isVideo, isImage, debounce, fileUrl } from '../util.js';
import { settings, saveSettings, bus, PLATFORM_PRESETS } from '../state.js';
import { AudioEngine, gainToDb, dbToGain } from './audio.js';
import { SOURCE_TYPES, ADD_MENU_ORDER, createRuntime } from './sources.js';
import { Compositor, TRANSITIONS } from './compositor.js';
import { SceneEditor } from './editor.js';
import { StreamOut } from './streamout.js';
import { openProperties, openFilters, openTransform, openAudioSettings, openRename } from './properties.js';

const TEXTLIKE = new Set(['text', 'countdown']);

export class Studio {
  constructor(root) {
    this.root = root;
    this.runtimes = new Map();
    this.active = new Set();
    this.selectedItemId = null;
    this.saveNow = debounce(() => window.api.store.write('studio', this.data), 600);
    this.thumbEls = new Map();
    this.streamStatus = { active: false };
    this.recStatus = { active: false };
  }

  get W() { return settings.video.baseW; }
  get H() { return settings.video.baseH; }

  async init() {
    this.audio = new AudioEngine(Number(settings.stream.sampleRate) || 48000);
    this.audio.setMonitorDevice(settings.audio.monitorDevice);
    const S = this;
    this.env = {
      audio: this.audio,
      get baseW() { return S.W; }, get baseH() { return S.H; },
      persist: () => this.saveNow(),
      renderNested: (id, ctx, W, H) => this.comp.renderNested(id, ctx, W, H),
      sceneOptions: () => this.data.scenes.filter((s) => s.id !== this.data.editId).map((s) => ({ value: s.id, label: s.name })),
    };
    this.data = (await window.api.store.read('studio', null)) || this.defaultData();
    this.migrate();
    this.comp = new Compositor(this);
    this.out = new StreamOut(this.comp, this.audio);
    this.build();
    for (const src of Object.values(this.data.sources)) this.ensureRuntime(src);
    this.recomputeActive();
    this.renderAll();
    this.comp.onFrame.push(() => { this.editor.draw(); this.updateTransport(); });
    this.onThumb = (id, c) => { const el = this.thumbEls.get(id); if (el) { const x = el.getContext('2d'); x.drawImage(c, 0, 0, el.width, el.height); } };
    this.comp.start();
    this.meterLoop();
    bus.on('edit-worship-overlay', () => this.openProperties(this.data.overlaySourceId));
    bus.on('worship-overlay', () => this.renderStatus());
    bus.on('stream-status', (st) => { this.streamStatus = st; this.renderGoLive(); this.renderStatus(); });
    bus.on('record-status', (st) => { this.recStatus = st; this.renderGoLive(); this.renderStatus(); });
    setInterval(async () => { try { this.metrics = await window.api.metrics(); } catch {} this.renderStatus(); this.renderGoLive(); }, 1000);
  }

  // ------------------------------------------------ data ------------------------------------------------
  defaultData() {
    const W = settings.video.baseW, H = settings.video.baseH;
    const src = (type, name, s = {}, extra = {}) => ({ id: uid('src'), type, name, settings: { ...SOURCE_TYPES[type].defaults, ...s }, filters: [], audioFilters: [], audio: { volume: 1, muted: false, monitor: 'off', syncMs: 0 }, ...extra });
    const cam = src('camera', 'Camera');
    const mic = src('mic', 'Microphone');
    const desk = src('desktopAudio', 'Desktop Audio');
    desk.audio.muted = true;
    const overlay = src('worship', 'Stream overlay (scripture & lyrics)');
    const bg = src('color', 'Background', { color: '#0f1f3d', color2: '#3b1f4f', gradient: true, angle: 135 });
    const welcome = src('text', 'Welcome text', { text: 'Welcome to Sunday Service', size: 96, align: 'center' });
    const countdown = src('countdown', 'Countdown', { size: 64, color: '#f2c14e', bold: true });
    const scripture = src('worship', 'Scripture full screen', { mode: 'fullscreen', showSongs: true });
    const screen = src('display', 'Display capture');
    const item = (s, x, y, w, h, extra = {}) => ({ id: uid('it'), sourceId: s.id, x, y, w, h, rot: 0, fit: 'stretch', crop: { l: 0, t: 0, r: 0, b: 0 }, visible: true, locked: false, opacity: 1, ...extra });
    const scenes = [
      { id: uid('sc'), name: 'Starting Soon', items: [item(bg, 0, 0, W, H), item(welcome, 0, H * 0.34, W, 130, { pendingSize: true, center: true }), item(countdown, 0, H * 0.52, W, 100, { pendingSize: true, center: true })] },
      { id: uid('sc'), name: 'Camera', items: [item(cam, 0, 0, W, H, { fit: 'fill' })] },
      { id: uid('sc'), name: 'Scripture', items: [item(scripture, 0, 0, W, H)] },
      { id: uid('sc'), name: 'Screen Share', items: [item(screen, 0, 0, W, H, { fit: 'fit' })] },
    ];
    return {
      scenes, sources: Object.fromEntries([cam, mic, desk, overlay, bg, welcome, countdown, scripture, screen].map((s) => [s.id, s])),
      globalAudio: [mic.id, desk.id], overlaySourceId: overlay.id, programId: scenes[0].id, editId: scenes[1].id,
    };
  }

  migrate() {
    const d = this.data;
    d.globalAudio ||= [];
    if (!d.overlaySourceId || !d.sources[d.overlaySourceId]) {
      const o = { id: uid('src'), type: 'worship', name: 'Stream overlay (scripture & lyrics)', settings: { ...SOURCE_TYPES.worship.defaults }, filters: [], audioFilters: [], audio: {} };
      d.sources[o.id] = o; d.overlaySourceId = o.id;
    }
    if (!d.scenes.length) d.scenes.push({ id: uid('sc'), name: 'Scene 1', items: [] });
    if (!this.scene(d.programId)) d.programId = d.scenes[0].id;
    if (!this.scene(d.editId)) d.editId = d.scenes[0].id;
    for (const s of Object.values(d.sources)) { s.filters ||= []; s.audioFilters ||= []; s.audio = { volume: 1, muted: false, monitor: 'off', syncMs: 0, ...(s.audio || {}) }; }
  }

  scene(id) { return this.data.scenes.find((s) => s.id === id); }
  typeOf(src) { return SOURCE_TYPES[src.type] || {}; }
  changed() { this.saveNow(); }

  ensureRuntime(src) {
    if (this.runtimes.has(src.id)) return this.runtimes.get(src.id);
    const T = SOURCE_TYPES[src.type];
    if (!T) return null;
    if (T.hasAudio) this.audio.channel(src);
    const rt = createRuntime(src, this.env);
    if (rt) this.runtimes.set(src.id, rt);
    return rt;
  }

  // Which sources are "on air": everything visible in the live scene (incl. nested scenes) + global audio
  recomputeActive() {
    const act = new Set(this.data.globalAudio);
    const seen = new Set();
    const collect = (sceneId) => {
      if (seen.has(sceneId)) return;
      seen.add(sceneId);
      const sc = this.scene(sceneId);
      if (!sc) return;
      for (const it of sc.items) {
        if (!it.visible) continue;
        act.add(it.sourceId);
        const src = this.data.sources[it.sourceId];
        if (src && src.type === 'scene') collect(src.settings.sceneId);
      }
    };
    collect(this.data.programId);
    for (const [id, rt] of this.runtimes) {
      const was = this.active.has(id), is = act.has(id);
      if (is && !was) { try { rt.activate(); } catch (e) { console.error(e); } }
      if (!is && was) { try { rt.deactivate(); } catch (e) { console.error(e); } }
      const ch = this.audio.channels.get(id);
      if (ch && ch.active !== is) ch.setActive(is, (Number(settings.transition.duration) || 300) / 1000);
    }
    this.active = act;
    this.renderMixer();
  }

  autoSize(item, nw, nh) {
    const src = this.data.sources[item.sourceId];
    if (item.pendingSize) {
      const s = Math.min(1, this.W / nw, this.H / nh);
      const w = Math.round(nw * s), hh = Math.round(nh * s);
      if (item.center) { item.x = Math.round((this.W - w) / 2); if (!TEXTLIKE.has(src.type)) item.y = Math.round((this.H - hh) / 2); }
      item.w = w; item.h = hh;
      delete item.pendingSize; delete item.center;
    } else if (src && TEXTLIKE.has(src.type) && item.nat) {
      const sx = item.w / item.nat[0], sy = item.h / item.nat[1];
      const cx = item.x + item.w / 2;
      item.w = Math.round(nw * sx); item.h = Math.round(nh * sy);
      if (src.settings.align === 'center') item.x = Math.round(cx - item.w / 2);
    }
    item.nat = [nw, nh];
    this.changed();
  }

  // ------------------------------------------------ layout ------------------------------------------------
  build() {
    const R = this.root;
    // Toolbar
    this.chips = h('div', { class: 'platform-chips' });
    this.recBtn = h('button', { class: 'btn rec-btn', onclick: () => this.toggleRecord() }, '● REC');
    this.liveBtn = h('button', { class: 'btn go-live-btn', onclick: () => this.toggleStream() }, 'GO LIVE');
    const toolbar = h('div', { class: 's-toolbar' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark live' }, '◉'), 'Studio'),
      this.chips, h('div', { class: 'tb-spacer' }), this.recBtn, this.liveBtn,
      h('button', { class: 'btn icon', title: 'Settings', onclick: () => bus.emit('open-settings') }, '⚙'));

    // Canvases
    this.editTitle = h('span', { class: 'canvas-title' });
    this.editLiveTag = h('span', { class: 'tag-live', title: 'You are editing the scene that is live — changes are visible on the stream' }, 'LIVE');
    this.progTitle = h('span', { class: 'canvas-title' });
    this.trSel = h('select', { class: 'tr-select', title: 'Transition', onchange: (e) => { settings.transition.type = e.target.value; saveSettings(); } },
      TRANSITIONS.map((t) => h('option', { value: t.value, selected: t.value === settings.transition.type }, t.label)));
    this.trDur = h('input', { type: 'number', class: 'tr-dur', min: 0, max: 5000, step: 50, value: settings.transition.duration, title: 'Transition duration (ms)', onchange: (e) => { settings.transition.duration = Number(e.target.value) || 0; saveSettings(); } });
    const overlay = h('canvas', { class: 'edit-overlay' });
    this.transport = h('div', { class: 'media-transport', style: { display: 'none' } });
    const editPanel = h('div', { class: 'canvas-panel edit-panel' },
      h('div', { class: 'canvas-head' }, h('span', { class: 'canvas-kind' }, 'EDITING'), this.editTitle, this.editLiveTag, h('div', { class: 'tb-spacer' }),
        this.trSel, this.trDur, h('span', { class: 'muted small' }, 'ms'),
        h('button', { class: 'btn sm primary', title: 'Send the scene you are editing to the livestream (Ctrl+Enter)', onclick: () => this.transitionEditToLive() }, 'Go Live ▶')),
      h('div', { class: 'canvas-wrap' }, this.comp.preview, overlay), this.transport);
    const progPanel = h('div', { class: 'canvas-panel prog-panel' },
      h('div', { class: 'canvas-head' }, h('span', { class: 'canvas-kind live' }, '● LIVE'), this.progTitle, h('div', { class: 'tb-spacer' }),
        h('button', { class: 'btn sm', title: 'Edit the live scene', onclick: () => this.setEdit(this.data.programId) }, '✎ Edit')),
      h('div', { class: 'canvas-wrap' }, this.comp.program));
    const canvases = h('div', { class: 's-canvases' }, editPanel, progPanel);
    this.canvasWraps = [editPanel, progPanel].map((p) => p.querySelector('.canvas-wrap'));
    this.applyAspect();
    this.editor = new SceneEditor(this, overlay);

    // Docks
    this.sceneGrid = h('div', { class: 'scene-grid' });
    const scenesDock = h('div', { class: 'dock scenes-dock' },
      h('div', { class: 'dock-head' }, h('span', null, 'Scenes'), h('div', { class: 'tb-spacer' }),
        h('button', { class: 'icon-btn', title: 'Add scene', onclick: () => this.addScene() }, '＋')),
      this.sceneGrid);
    this.sourceList = h('div', { class: 'source-list', tabindex: 0 });
    this.sourcesHead = h('span', null, 'Sources');
    const sourcesDock = h('div', { class: 'dock sources-dock' },
      h('div', { class: 'dock-head' }, this.sourcesHead, h('div', { class: 'tb-spacer' }),
        h('button', { class: 'icon-btn', title: 'Add source', onclick: (e) => { const r = e.target.getBoundingClientRect(); this.addMenu(r.left, r.bottom); } }, '＋'),
        h('button', { class: 'icon-btn', title: 'Remove selected', onclick: () => this.selectedItemId && this.removeItem(this.selectedItemId) }, '－'),
        h('button', { class: 'icon-btn', title: 'Properties', onclick: () => { const it = this.selectedItem(); if (it) this.openProperties(it.sourceId); } }, '⚙'),
        h('button', { class: 'icon-btn', title: 'Move up', onclick: () => this.moveItem(1) }, '▲'),
        h('button', { class: 'icon-btn', title: 'Move down', onclick: () => this.moveItem(-1) }, '▼')),
      this.sourceList);
    makeSortable(this.sourceList, '.src-row', (from, to) => {
      const sc = this.scene(this.data.editId);
      const n = sc.items.length;
      const [it] = sc.items.splice(n - 1 - from, 1);
      sc.items.splice(n - 1 - to, 0, it);
      this.changed(); this.renderSources();
    });
    this.sourceList.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' && this.selectedItemId) { e.stopPropagation(); this.removeItem(this.selectedItemId); }
    });
    this.mixer = h('div', { class: 'mixer' });
    const mixerDock = h('div', { class: 'dock mixer-dock' },
      h('div', { class: 'dock-head' }, h('span', null, 'Audio Mixer'), h('div', { class: 'tb-spacer' }),
        h('button', { class: 'icon-btn', title: 'Add audio device', onclick: (e) => { const r = e.target.getBoundingClientRect(); contextMenu(r.left, r.bottom, [
          { label: 'Microphone / audio input (all scenes)', onClick: () => this.addGlobalAudio('mic') },
          { label: 'Desktop audio (all scenes)', onClick: () => this.addGlobalAudio('desktopAudio') }]); } }, '＋')),
      this.mixer);
    const docks = h('div', { class: 's-docks' }, scenesDock, sourcesDock, mixerDock);
    this.statusBar = h('div', { class: 's-status' });
    R.append(toolbar, canvases, docks, this.statusBar);
  }

  renderAll() { this.renderChips(); this.renderScenes(); this.renderSources(); this.renderMixer(); this.renderGoLive(); this.renderStatus(); this.renderTitles(); }

  renderTitles() {
    const ed = this.scene(this.data.editId), pg = this.scene(this.data.programId);
    this.editTitle.textContent = ed ? ed.name : '';
    this.progTitle.textContent = pg ? pg.name : '';
    this.editLiveTag.style.display = this.data.editId === this.data.programId ? '' : 'none';
    this.sourcesHead.textContent = `Sources — ${ed ? ed.name : ''}`;
  }

  // ------------------------------------------------ platforms ------------------------------------------------
  renderChips() {
    const c = this.chips;
    c.innerHTML = '';
    const dests = this.streamStatus.dests || {};
    for (const p of settings.platforms) {
      const preset = PLATFORM_PRESETS[p.kind] || PLATFORM_PRESETS.custom;
      const d = dests[p.id];
      const st = d ? d.state : '';
      const chip = h('button', {
        class: `chip ${p.enabled ? 'on' : ''} ${st ? 'st-' + st : ''}`,
        style: { '--pc': preset.color },
        title: d ? `${p.name}: ${st}${d.kbps ? ` · ${Math.round(d.kbps)} kbps` : ''}${d.error ? '\n' + d.error : ''}` : `${p.name} — click to ${p.enabled ? 'exclude from' : 'include in'} the stream${p.orientation === 'vertical' ? '\n(vertical 9:16)' : ''}`,
        onclick: (e) => {
          if (this.out.streaming && d) {
            contextMenu(e.clientX, e.clientY, [
              { label: `${p.name}: ${st}`, disabled: true },
              { label: 'Reconnect', disabled: st === 'live', onClick: () => window.api.stream.retry(p.id) },
              { label: 'Stop streaming to ' + p.name, onClick: () => window.api.stream.dropDest(p.id) }]);
            return;
          }
          if (this.out.streaming) return toast('Stop the stream to change platforms (or add them before going live)', 'warn');
          p.enabled = !p.enabled; saveSettings(); this.renderChips();
        },
        oncontextmenu: (e) => { e.preventDefault(); bus.emit('open-settings', 'stream'); },
      }, h('span', { class: 'chip-dot' }), p.name, p.orientation === 'vertical' ? h('span', { class: 'chip-v', title: 'Vertical 9:16' }, '9:16') : null);
      c.appendChild(chip);
    }
    c.appendChild(h('button', { class: 'chip add', title: 'Stream keys & platforms', onclick: () => bus.emit('open-settings', 'stream') }, '＋'));
  }

  async toggleStream() {
    if (this.out.streaming || this.streamStatus.active) {
      if (settings.general.confirmStop && !(await confirmDialog('End the livestream on all platforms?', { title: 'Stop streaming', ok: 'End stream', danger: true }))) return;
      await this.out.stopStream();
      this.renderGoLive(); this.renderChips();
      return;
    }
    const secrets = await window.api.secrets.read();
    const dests = settings.platforms.filter((p) => p.enabled).map((p) => ({ id: p.id, name: p.name, server: p.server, orientation: p.orientation }));
    if (!dests.length) { toast('Click a platform (YouTube, Facebook…) to choose where to stream', 'warn'); return; }
    const noKey = dests.filter((d) => !secrets['key:' + d.id]);
    const noServer = dests.filter((d) => !d.server);
    if (noServer.length || noKey.length) {
      toast(`Add ${noServer.length ? 'a server URL' : 'a stream key'} for ${[...noServer, ...noKey].map((d) => d.name).join(', ')} in Settings › Stream`, 'warn', 7000);
      bus.emit('open-settings', 'stream');
      return;
    }
    const names = dests.map((d) => d.name).join(', ');
    if (settings.general.confirmStart && !(await confirmDialog(`Go live on ${names}?\n\nLive scene: ${this.scene(this.data.programId).name}`, { title: 'Go live', ok: 'Go live' }))) return;
    this.liveBtn.textContent = 'Starting…';
    await this.out.startStream(dests);
    this.renderGoLive(); this.renderChips();
  }

  async toggleRecord() {
    if (this.out.recording) await this.out.stopRecord(); else await this.out.startRecord();
    this.renderGoLive();
  }

  renderGoLive() {
    const live = this.out.streaming && this.streamStatus.active;
    this.liveBtn.classList.toggle('on', !!live);
    this.liveBtn.textContent = live ? `■ END  ${fmtTime((Date.now() - this.streamStatus.startedAt) / 1000)}` : (this.out.starting ? 'Starting…' : 'GO LIVE');
    const rec = this.out.recording;
    this.recBtn.classList.toggle('on', rec);
    this.recBtn.textContent = rec && this.recStatus.startedAt ? `■ REC ${fmtTime((Date.now() - this.recStatus.startedAt) / 1000)}` : '● REC';
    if (live) this.renderChips();
  }

  renderStatus() {
    const st = this.streamStatus, parts = [];
    const m = this.metrics;
    if (m) parts.push(h('span', null, `CPU ${Math.round(m.cpu)}%`));
    parts.push(h('span', null, `${this.comp.fps.toFixed(1)} fps`), h('span', null, `render ${this.comp.renderMs.toFixed(1)} ms`));
    if (st.active) {
      for (const [k, e] of Object.entries(st.encoders || {})) {
        const slow = e.speed && e.speed < 0.97;
        parts.push(h('span', { class: slow ? 'warn' : '', title: 'Encoder speed below 1.0× means your computer cannot keep up — lower resolution/bitrate or use a hardware encoder' }, `${k === 'vertical' ? 'vertical ' : ''}enc ${e.speed ? e.speed.toFixed(2) + '×' : '…'}${e.drop ? ` drop ${e.drop}` : ''}`));
      }
      for (const d of Object.values(st.dests || {})) {
        parts.push(h('span', { class: 'dest st-' + d.state, title: d.error || '' }, `${d.name} ${d.state === 'live' ? Math.round(d.kbps) + ' kbps' : d.state}${d.retries && d.state !== 'live' ? ` (retry ${d.retries})` : ''}`));
      }
    }
    if (settings.worship.streamOverlay) parts.push(h('span', { class: 'ok' }, '📡 scripture/lyrics on stream'));
    this.statusBar.replaceChildren(...parts);
  }

  // ------------------------------------------------ scenes ------------------------------------------------
  renderScenes() {
    const g = this.sceneGrid;
    g.innerHTML = '';
    this.thumbEls.clear();
    this.data.scenes.forEach((sc, i) => {
      const thumb = h('canvas', { width: 192, height: 108 });
      const cached = this.comp.thumbs.get(sc.id);
      if (cached) thumb.getContext('2d').drawImage(cached, 0, 0);
      this.thumbEls.set(sc.id, thumb);
      const isLive = sc.id === this.data.programId, isEdit = sc.id === this.data.editId;
      const clickLive = settings.general.sceneClick !== 'edit';
      const tile = h('div', {
        class: 'scene-tile' + (isLive ? ' live' : '') + (isEdit ? ' editing' : ''), draggable: true,
        title: clickLive ? 'Click: send to livestream · ✎: edit without affecting the stream' : 'Click: edit · Double-click: send to livestream',
        onclick: (e) => { if (e.target.closest('.scene-edit')) return; clickLive ? this.setProgram(sc.id) : this.setEdit(sc.id); },
        ondblclick: (e) => { if (e.target.closest('.scene-edit')) return; if (!clickLive) this.setProgram(sc.id); },
        oncontextmenu: (e) => { e.preventDefault(); this.sceneMenu(e.clientX, e.clientY, sc, i); },
      }, thumb,
      h('div', { class: 'scene-name' }, h('span', { class: 'scene-num' }, i + 1), sc.name),
      isLive ? h('span', { class: 'scene-badge live' }, 'LIVE') : null,
      h('button', { class: 'scene-edit' + (isEdit ? ' active' : ''), title: 'Edit this scene (the livestream is not affected)', onclick: () => this.setEdit(sc.id) }, '✎'));
      g.appendChild(tile);
    });
    makeSortableOnce(g, this);
    this.renderTitles();
  }

  sceneMenu(x, y, sc, i) {
    contextMenu(x, y, [
      { label: 'Send to livestream', onClick: () => this.setProgram(sc.id) },
      { label: 'Edit (without affecting stream)', onClick: () => this.setEdit(sc.id) },
      '-',
      { label: 'Rename…', onClick: () => openRename(this, 'Rename scene', sc.name, (n) => { sc.name = n; this.changed(); this.renderScenes(); }) },
      { label: 'Duplicate', onClick: () => { const c = clone(sc); c.id = uid('sc'); c.name = sc.name + ' copy'; c.items.forEach((it) => { it.id = uid('it'); }); this.data.scenes.splice(i + 1, 0, c); this.changed(); this.renderScenes(); } },
      { label: 'Move left', disabled: i === 0, onClick: () => { this.data.scenes.splice(i - 1, 0, this.data.scenes.splice(i, 1)[0]); this.changed(); this.renderScenes(); } },
      { label: 'Move right', disabled: i === this.data.scenes.length - 1, onClick: () => { this.data.scenes.splice(i + 1, 0, this.data.scenes.splice(i, 1)[0]); this.changed(); this.renderScenes(); } },
      '-',
      { label: 'Delete scene', disabled: this.data.scenes.length < 2, onClick: () => this.deleteScene(sc) },
    ]);
  }

  addScene() {
    openRename(this, 'New scene', `Scene ${this.data.scenes.length + 1}`, (name) => {
      const sc = { id: uid('sc'), name, items: [] };
      this.data.scenes.push(sc);
      this.changed();
      this.setEdit(sc.id);
      toast('Scene created — add sources with ＋ in the Sources panel. The livestream is not affected until you send it live.', 'info', 5000);
    });
  }

  async deleteScene(sc) {
    if (!(await confirmDialog(`Delete scene "${sc.name}"?`, { danger: true, ok: 'Delete' }))) return;
    this.data.scenes = this.data.scenes.filter((s) => s !== sc);
    if (this.data.programId === sc.id) this.setProgram(this.data.scenes[0].id, false);
    if (this.data.editId === sc.id) this.data.editId = this.data.scenes[0].id;
    this.cleanupOrphans();
    this.changed(); this.renderAll();
  }

  setEdit(id) {
    this.data.editId = id;
    this.selectedItemId = null;
    this.changed();
    this.renderScenes(); this.renderSources(); this.renderMixer();
  }

  setProgram(id, withTransition = true) {
    const from = this.data.programId;
    if (from === id && !this.comp.transition) return;
    this.data.programId = id;
    if (withTransition) this.comp.transitionTo(from, id, settings.transition.type, Number(settings.transition.duration) || 0);
    this.recomputeActive();
    this.changed();
    this.renderScenes();
  }

  transitionEditToLive() { this.setProgram(this.data.editId); }

  // ------------------------------------------------ sources ------------------------------------------------
  selectedItem() { const sc = this.scene(this.data.editId); return sc && sc.items.find((i) => i.id === this.selectedItemId); }

  select(itemId) {
    this.selectedItemId = itemId;
    $$('.src-row', this.sourceList).forEach((r) => r.classList.toggle('selected', r.dataset.id === itemId));
  }

  renderSources() {
    const sc = this.scene(this.data.editId);
    const L = this.sourceList;
    L.innerHTML = '';
    if (!sc) return;
    if (!sc.items.length) L.appendChild(h('div', { class: 'empty-hint' }, 'No sources. Click ＋ to add a camera, video, image, text… or drop files on the canvas.'));
    [...sc.items].reverse().forEach((it) => {
      const src = this.data.sources[it.sourceId];
      if (!src) return;
      const T = this.typeOf(src);
      const rt = this.runtimes.get(src.id);
      const row = h('div', {
        class: 'src-row' + (it.id === this.selectedItemId ? ' selected' : '') + (it.visible ? '' : ' hidden-item'), draggable: true, dataset: { id: it.id },
        onclick: () => this.select(it.id),
        ondblclick: () => this.openProperties(src.id),
        oncontextmenu: (e) => { e.preventDefault(); this.select(it.id); this.itemMenu(e.clientX, e.clientY, it); },
      },
      h('button', { class: 'icon-btn eye', title: it.visible ? 'Hide' : 'Show', onclick: (e) => { e.stopPropagation(); it.visible = !it.visible; this.itemsChanged(); } }, it.visible ? '👁' : '◌'),
      h('button', { class: 'icon-btn lock', title: it.locked ? 'Unlock' : 'Lock', onclick: (e) => { e.stopPropagation(); it.locked = !it.locked; this.changed(); this.renderSources(); } }, it.locked ? '🔒' : '🔓'),
      h('span', { class: 'src-icon' }, T.icon || '?'),
      h('span', { class: 'src-name' }, src.name),
      rt && rt.error ? h('span', { class: 'src-err', title: rt.error }, '⚠') : null,
      h('button', { class: 'icon-btn', title: 'Properties', onclick: (e) => { e.stopPropagation(); this.openProperties(src.id); } }, '⚙'));
      L.appendChild(row);
    });
    this.renderTitles();
  }

  itemsChanged() {
    this.changed(); this.renderSources();
    if (this.data.editId === this.data.programId || this.isNestedInProgram(this.data.editId)) this.recomputeActive();
    else this.renderMixer();
  }

  isNestedInProgram(sceneId) {
    const pg = this.scene(this.data.programId);
    return !!(pg && pg.items.some((it) => { const s = this.data.sources[it.sourceId]; return s && s.type === 'scene' && s.settings.sceneId === sceneId; }));
  }

  itemMoved() {}

  moveItem(dir) {
    const sc = this.scene(this.data.editId);
    const i = sc.items.findIndex((x) => x.id === this.selectedItemId);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= sc.items.length) return;
    sc.items.splice(j, 0, sc.items.splice(i, 1)[0]);
    this.changed(); this.renderSources();
  }

  itemMenu(x, y, it) {
    const sc = this.scene(this.data.editId);
    const src = this.data.sources[it.sourceId];
    const T = this.typeOf(src);
    const rt = this.runtimes.get(src.id);
    const idx = sc.items.indexOf(it);
    const order = (fn) => () => { fn(); this.changed(); this.renderSources(); };
    const tf = (fn) => () => { fn(); this.changed(); };
    contextMenu(x, y, [
      { label: 'Properties…', onClick: () => this.openProperties(src.id) },
      { label: 'Filters…', onClick: () => openFilters(this, src.id) },
      T.hasAudio ? { label: 'Advanced audio…', onClick: () => openAudioSettings(this, src.id) } : null,
      '-',
      src.type === 'video' ? { label: 'Play / pause', onClick: () => { rt.v.paused ? rt.play() : rt.pause(); } } : null,
      src.type === 'video' ? { label: 'Restart', onClick: () => rt.restart() } : null,
      src.type === 'video' ? '-' : null,
      !T.audioOnly ? { label: 'Transform', submenu: [
        { label: 'Edit transform…', onClick: () => openTransform(this, it) },
        { label: 'Fit to screen', onClick: tf(() => { const nw = rt.w || it.w, nh = rt.h || it.h; const s = Math.min(this.W / nw, this.H / nh); Object.assign(it, { w: Math.round(nw * s), h: Math.round(nh * s), rot: 0 }); it.x = Math.round((this.W - it.w) / 2); it.y = Math.round((this.H - it.h) / 2); }) },
        { label: 'Stretch to screen', onClick: tf(() => Object.assign(it, { x: 0, y: 0, w: this.W, h: this.H, rot: 0 })) },
        { label: 'Center on screen', onClick: tf(() => { it.x = Math.round((this.W - it.w) / 2); it.y = Math.round((this.H - it.h) / 2); }) },
        '-',
        { label: 'Mirror (flip horizontal)', checked: it.flipH, onClick: tf(() => { it.flipH = !it.flipH; }) },
        { label: 'Flip vertical', checked: it.flipV, onClick: tf(() => { it.flipV = !it.flipV; }) },
        { label: 'Rotate 90° clockwise', onClick: tf(() => { it.rot = ((it.rot || 0) + 90) % 360; }) },
        { label: 'Reset crop', onClick: tf(() => { it.crop = { l: 0, t: 0, r: 0, b: 0 }; }) },
        '-',
        { label: 'Picture-in-picture (bottom right)', onClick: tf(() => { const nw = rt.w || 16, nh = rt.h || 9; const w = Math.round(this.W * 0.28); Object.assign(it, { w, h: Math.round((w * nh) / nw), rot: 0 }); it.x = this.W - it.w - 40; it.y = this.H - it.h - 40; }) },
      ] } : null,
      { label: 'Order', submenu: [
        { label: 'Bring to front', onClick: order(() => { sc.items.push(sc.items.splice(idx, 1)[0]); }) },
        { label: 'Move up', onClick: order(() => { if (idx < sc.items.length - 1) sc.items.splice(idx + 1, 0, sc.items.splice(idx, 1)[0]); }) },
        { label: 'Move down', onClick: order(() => { if (idx > 0) sc.items.splice(idx - 1, 0, sc.items.splice(idx, 1)[0]); }) },
        { label: 'Send to back', onClick: order(() => { sc.items.unshift(sc.items.splice(idx, 1)[0]); }) },
      ] },
      { label: it.visible ? 'Hide' : 'Show', onClick: () => { it.visible = !it.visible; this.itemsChanged(); } },
      { label: it.locked ? 'Unlock' : 'Lock', onClick: () => { it.locked = !it.locked; this.changed(); this.renderSources(); } },
      '-',
      { label: 'Rename…', onClick: () => openRename(this, 'Rename source', src.name, (n) => { src.name = n; this.changed(); this.renderSources(); this.renderMixer(); }) },
      { label: 'Copy to scene', submenu: this.data.scenes.filter((s) => s !== sc).map((s) => ({ label: s.name, onClick: () => { s.items.push({ ...clone(it), id: uid('it') }); this.changed(); toast(`Added to "${s.name}"`); } })) },
      { label: 'Duplicate (independent copy)', onClick: () => this.duplicateSource(it) },
      { label: 'Remove from scene', onClick: () => this.removeItem(it.id) },
    ]);
  }

  addMenu(x, y) {
    const used = new Set(this.scene(this.data.editId).items.map((i) => i.sourceId));
    const existing = Object.values(this.data.sources).filter((s) => !used.has(s.id) && s.id !== this.data.overlaySourceId && !(s.type === 'scene' && s.settings.sceneId === this.data.editId));
    contextMenu(x, y, [
      ...ADD_MENU_ORDER.map((t) => ({ label: `${SOURCE_TYPES[t].icon}  ${SOURCE_TYPES[t].label}`, onClick: () => this.addSource(t) })),
      '-',
      { label: 'Add existing source', disabled: !existing.length, submenu: existing.map((s) => ({ label: `${this.typeOf(s).icon} ${s.name}`, onClick: () => this.addExisting(s.id) })) },
    ]);
  }

  newSource(type, name, settingsOver = {}) {
    const T = SOURCE_TYPES[type];
    const count = Object.values(this.data.sources).filter((s) => s.type === type).length;
    const src = {
      id: uid('src'), type, name: name || (T.label.split(' (')[0] + (count ? ' ' + (count + 1) : '')),
      settings: { ...clone(T.defaults), ...settingsOver }, filters: [], audioFilters: [], audio: { volume: 1, muted: false, monitor: 'off', syncMs: 0 },
    };
    this.data.sources[src.id] = src;
    return src;
  }

  addItemFor(src, opts = {}) {
    const sc = this.scene(this.data.editId);
    const T = this.typeOf(src);
    const text = TEXTLIKE.has(src.type);
    const it = {
      id: uid('it'), sourceId: src.id, x: opts.x ?? 0, y: opts.y ?? 0, w: this.W, h: this.H, rot: 0,
      fit: ['camera', 'video', 'display', 'window', 'image'].includes(src.type) ? 'fit' : 'stretch',
      crop: { l: 0, t: 0, r: 0, b: 0 }, visible: true, locked: false, opacity: 1,
      pendingSize: !T.audioOnly && !['color', 'worship', 'scene', 'slideshow'].includes(src.type), center: !text || opts.x === undefined,
    };
    if (text && opts.x === undefined) { it.x = 80; it.y = 80; it.center = false; }
    sc.items.push(it);
    this.ensureRuntime(src);
    this.selectedItemId = it.id;
    this.itemsChanged();
    this.renderMixer();
    return it;
  }

  addSource(type, settingsOver, name) {
    const src = this.newSource(type, name, settingsOver);
    this.addItemFor(src);
    this.openProperties(src.id, { isNew: true });
  }

  addExisting(sourceId) { this.addItemFor(this.data.sources[sourceId]); }

  addGlobalAudio(type) {
    const src = this.newSource(type);
    this.data.globalAudio.push(src.id);
    this.ensureRuntime(src);
    this.recomputeActive();
    this.changed();
    this.openProperties(src.id, { isNew: true });
  }

  duplicateSource(it) {
    const src = this.data.sources[it.sourceId];
    const copy = { ...clone(src), id: uid('src'), name: src.name + ' copy' };
    this.data.sources[copy.id] = copy;
    const sc = this.scene(this.data.editId);
    sc.items.push({ ...clone(it), id: uid('it'), sourceId: copy.id, x: it.x + 30, y: it.y + 30 });
    this.ensureRuntime(copy);
    this.itemsChanged();
  }

  removeItem(itemId) {
    const sc = this.scene(this.data.editId);
    sc.items = sc.items.filter((i) => i.id !== itemId);
    if (this.selectedItemId === itemId) this.selectedItemId = null;
    this.cleanupOrphans();
    this.itemsChanged();
  }

  deleteSource(sourceId) {
    for (const sc of this.data.scenes) sc.items = sc.items.filter((i) => i.sourceId !== sourceId);
    this.data.globalAudio = this.data.globalAudio.filter((x) => x !== sourceId);
    this.destroySource(sourceId);
    this.itemsChanged();
  }

  destroySource(id) {
    const rt = this.runtimes.get(id);
    if (rt) { try { rt.deactivate(); rt.destroy(); } catch {} this.runtimes.delete(id); }
    this.audio.removeChannel(id);
    this.active.delete(id);
    delete this.data.sources[id];
  }

  // Sources no scene uses any more are deleted (like OBS) — except global audio & the stream overlay
  cleanupOrphans() {
    const used = new Set([...this.data.globalAudio, this.data.overlaySourceId]);
    for (const sc of this.data.scenes) for (const it of sc.items) used.add(it.sourceId);
    for (const id of Object.keys(this.data.sources)) if (!used.has(id)) this.destroySource(id);
  }

  openProperties(sourceId, opts) { openProperties(this, sourceId, opts); }

  dropFiles(files, pt) {
    for (const f of files) {
      const p = window.api.pathForFile(f);
      if (!p) continue;
      const type = isVideo(p) ? 'video' : isImage(p) ? 'image' : null;
      if (!type) { toast('Unsupported file: ' + basename(p), 'warn'); continue; }
      const src = this.newSource(type, basename(p), { path: p });
      this.addItemFor(src);
    }
  }

  // ------------------------------------------------ media transport ------------------------------------------------
  updateTransport() {
    const it = this.selectedItem();
    const src = it && this.data.sources[it.sourceId];
    const T = this.transport;
    if (!src || src.type !== 'video') { if (T.dataset.for) { T.dataset.for = ''; T.replaceChildren(); T.style.display = 'none'; } return; }
    const rt = this.runtimes.get(src.id);
    if (!rt) return;
    if (T.dataset.for !== src.id) {
      T.dataset.for = src.id; T.style.display = 'flex';
      this.tp = {
        play: h('button', { class: 'btn xs', onclick: () => (rt.v.paused ? rt.play() : rt.pause()) }, '▶'),
        seek: h('input', { type: 'range', min: 0, max: 1000, value: 0, class: 'seek', oninput: (e) => rt.seek((Number(e.target.value) / 1000) * (rt.v.duration || 0)) }),
        time: h('span', { class: 'time' }),
      };
      T.replaceChildren(h('span', { class: 'muted small' }, '🎞 ' + src.name), h('button', { class: 'btn xs', title: 'Restart', onclick: () => rt.restart() }, '⏮'), this.tp.play, this.tp.seek, this.tp.time,
        h('span', { class: 'muted small', title: 'Controls affect the stream if this video is also in the live scene' }, this.active.has(src.id) ? '● on air' : 'preview only'));
    }
    const m = rt.media();
    this.tp.play.textContent = m.paused ? '▶' : '⏸';
    if (document.activeElement !== this.tp.seek) this.tp.seek.value = m.duration ? Math.round((m.time / m.duration) * 1000) : 0;
    this.tp.time.textContent = `${fmtTime(m.time)} / ${fmtTime(m.duration)}`;
  }

  // ------------------------------------------------ mixer ------------------------------------------------
  mixerSources() {
    const ids = new Set(this.data.globalAudio);
    for (const sid of [this.data.programId, this.data.editId]) {
      const sc = this.scene(sid);
      if (sc) for (const it of sc.items) ids.add(it.sourceId);
    }
    return [...ids].map((id) => this.data.sources[id]).filter((s) => s && this.typeOf(s).hasAudio);
  }

  renderMixer() {
    if (!this.mixer) return;
    const M = this.mixer;
    M.innerHTML = '';
    this.meterEls = [];
    const master = h('canvas', { class: 'meter', width: 300, height: 10 });
    M.appendChild(h('div', { class: 'strip master' }, h('div', { class: 'strip-top' }, h('span', { class: 'strip-name' }, 'Stream mix'), h('span', { class: 'strip-db muted' }, 'master')), master));
    this.meterEls.push({ canvas: master, meter: this.audio.masterMeter });
    for (const src of this.mixerSources()) {
      const ch = this.audio.channel(src);
      const a = src.audio;
      const onAir = this.active.has(src.id);
      const meter = h('canvas', { class: 'meter', width: 300, height: 10 });
      const toDb = (v) => (v <= 0 ? -Infinity : gainToDb(v));
      const sliderVal = (g) => { const d = toDb(g); return d === -Infinity ? -60 : Math.max(-60, Math.min(10, d)); };
      const dbText = h('span', { class: 'strip-db' }, a.muted ? 'muted' : (sliderVal(a.volume) <= -60 ? '-∞' : sliderVal(a.volume).toFixed(1)) + ' dB');
      const fader = h('input', {
        type: 'range', class: 'fader', min: -60, max: 10, step: 0.5, value: sliderVal(a.volume),
        oninput: (e) => { const d = Number(e.target.value); a.volume = d <= -60 ? 0 : dbToGain(d); ch.apply(); dbText.textContent = d <= -60 ? '-∞ dB' : d.toFixed(1) + ' dB'; this.changed(); },
        ondblclick: () => { a.volume = 1; ch.apply(); this.renderMixer(); this.changed(); },
        title: 'Double-click to reset to 0 dB',
      });
      const strip = h('div', { class: 'strip' + (onAir ? ' on-air' : '') + (a.muted ? ' muted' : '') },
        h('div', { class: 'strip-top' },
          h('span', { class: 'air-dot', title: onAir ? 'In the stream mix' : 'Not in the live scene — not heard on stream' }),
          h('span', { class: 'strip-name', title: src.name }, src.name),
          this.data.globalAudio.includes(src.id) ? h('span', { class: 'strip-tag' }, 'all scenes') : null,
          a.monitor && a.monitor !== 'off' ? h('span', { class: 'strip-tag', title: 'Monitoring' }, '🎧') : null,
          dbText),
        meter,
        h('div', { class: 'strip-ctl' }, fader,
          h('button', { class: 'icon-btn' + (a.muted ? ' danger' : ''), title: a.muted ? 'Unmute' : 'Mute', onclick: () => { a.muted = !a.muted; ch.apply(); this.changed(); this.renderMixer(); } }, a.muted ? '🔇' : '🔊'),
          h('button', { class: 'icon-btn', title: 'Audio options', onclick: (e) => contextMenu(e.clientX, e.clientY, [
            { label: 'Filters (EQ, compressor, noise gate)…', onClick: () => openFilters(this, src.id) },
            { label: 'Advanced audio (monitoring, sync)…', onClick: () => openAudioSettings(this, src.id) },
            { label: 'Properties…', onClick: () => this.openProperties(src.id) },
            this.data.globalAudio.includes(src.id) ? { label: 'Remove device', onClick: () => this.deleteSource(src.id) } : null,
          ]) }, '⋮')));
      M.appendChild(strip);
      this.meterEls.push({ canvas: meter, meter: ch.meter });
    }
  }

  meterLoop() {
    const draw = () => {
      for (const { canvas, meter } of this.meterEls || []) {
        if (!canvas.isConnected) continue;
        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height;
        ctx.fillStyle = '#0d0f13'; ctx.fillRect(0, 0, W, H);
        const lv = meter.read();
        lv.forEach((l, i) => {
          const y = i * (H / 2), hh = H / 2 - 1;
          const db = l.level > 0 ? 20 * Math.log10(l.level) : -60;
          const pos = Math.max(0, Math.min(1, (db + 60) / 60));
          const g = ctx.createLinearGradient(0, 0, W, 0);
          g.addColorStop(0, '#2ea043'); g.addColorStop(0.7, '#2ea043'); g.addColorStop(0.85, '#d29922'); g.addColorStop(1, '#f85149');
          ctx.fillStyle = g; ctx.fillRect(0, y, W * pos, hh);
          const hdb = l.hold > 0 ? 20 * Math.log10(l.hold) : -60;
          const hp = Math.max(0, Math.min(1, (hdb + 60) / 60));
          ctx.fillStyle = hp > 0.95 ? '#f85149' : '#c9d1d9'; ctx.fillRect(W * hp - 2, y, 2, hh);
        });
      }
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }

  // ------------------------------------------------ settings changes ------------------------------------------------
  applyAspect() { for (const w of this.canvasWraps) w.style.aspectRatio = `${this.W} / ${this.H}`; }

  videoSettingsChanged() {
    this.applyAspect();
    this.comp.resize();
    this.comp.setFps();
    this.out.canvasStream = null;
    for (const rt of this.runtimes.values()) { try { rt.update(); } catch {} }
    this.editor.fit();
  }

  hotkey(action) {
    const m = action.match(/^scene(\d)$/);
    if (m) { const sc = this.data.scenes[Number(m[1]) - 1]; if (sc) this.setProgram(sc.id); return true; }
    const i = this.data.scenes.findIndex((s) => s.id === this.data.programId);
    switch (action) {
      case 'goLive': this.toggleStream(); return true;
      case 'record': this.toggleRecord(); return true;
      case 'transition': this.transitionEditToLive(); return true;
      case 'sceneNext': if (this.data.scenes[i + 1]) this.setProgram(this.data.scenes[i + 1].id); return true;
      case 'scenePrev': if (i > 0) this.setProgram(this.data.scenes[i - 1].id); return true;
    }
    return false;
  }
}

// scene tiles drag-reorder (bound once)
function makeSortableOnce(grid, S) {
  if (grid.__sortable) return;
  grid.__sortable = true;
  makeSortable(grid, '.scene-tile', (from, to) => {
    const [sc] = S.data.scenes.splice(from, 1);
    S.data.scenes.splice(to, 0, sc);
    S.changed(); S.renderScenes();
  });
}
