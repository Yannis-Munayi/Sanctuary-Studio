// EasyWorship-style presenter: Schedule | Preview | Live on top, resource tabs below.
import { h, $, $$, uid, clone, modal, toast, confirmDialog, promptDialog, contextMenu, makeSortable, fmtTime, basename, isVideo, debounce } from '../util.js';
import { settings, saveSettings, bus, worshipLive } from '../state.js';
import { resolveTheme } from '../slide-render.js';
import { lyricsToSlides, openSongEditor } from './songs.js';
import { BOOKS } from './bible.js';
import { paintSlide, videoPoster, openThemeEditor } from './themes.js';
import { buildTabs } from './tabs.js';

const ICONS = { song: '♪', scripture: '✝', media: '▶', custom: '☰' };

export class Worship {
  constructor(root, { songs, themes, bibles }) {
    this.root = root;
    this.songs = songs;
    this.themes = themes;
    this.bibles = bibles;
    this.schedule = { name: 'Untitled schedule', items: [] };
    this.preview = null; // { item, slides, index, theme }
    this.live = null;
    this.mode = 'normal';
    this.seq = 0;
    this.mediaStatus = null;
    this.saveSchedule = debounce(() => window.api.store.write('schedule', this.schedule), 400);
  }

  async init() {
    this.schedule = (await window.api.store.read('schedule', null)) || this.schedule;
    this.build();
    this.renderSchedule();
    this.renderPane('preview');
    this.renderPane('live');
    await window.api.output.setTarget(settings.worship.target);
    await this.refreshDisplays();
    window.api.output.onStatus((st) => this.onOutputStatus(st));
    window.api.output.onMediaStatus((st) => { this.mediaStatus = st; this.renderTransport(); });
    if (settings.worship.netOutput) this.startNet(true);
    this.pushOutput();
  }

  // ------------------------------------------------ layout ------------------------------------------------
  build() {
    const w = settings.worship;
    this.targetSel = h('select', { class: 'target-select', title: 'Where lyrics & scripture are displayed', onchange: (e) => this.setTarget(e.target.value) });
    this.outStatus = h('span', { class: 'out-status' });
    this.netBtn = h('button', { class: 'btn sm toggle' + (w.netOutput ? ' on' : ''), title: 'Network output (browser/NDI capture) — see Settings › Worship', onclick: () => this.startNet(!settings.worship.netOutput) }, 'Network');
    this.streamBtn = h('button', { class: 'btn sm toggle stream-toggle' + (w.streamOverlay ? ' on' : ''), title: 'Show scripture/lyrics on the livestream (S)', onclick: () => this.toggleStreamOverlay() }, '📡 On stream');

    const toolbar = h('div', { class: 'w-toolbar' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, '✦'), 'Presenter'),
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Output'), this.targetSel, this.outStatus,
        h('button', { class: 'btn sm', title: 'Show a number on every monitor', onclick: () => window.api.output.identify() }, 'Identify')),
      h('div', { class: 'tb-group' }, this.netBtn),
      h('div', { class: 'tb-spacer' }),
      h('div', { class: 'tb-group' }, this.streamBtn,
        h('button', { class: 'btn sm icon', title: 'Stream overlay style', onclick: () => bus.emit('edit-worship-overlay') }, '⚙')));

    // Schedule pane
    this.schedList = h('div', { class: 'sched-list', tabindex: 0 });
    this.schedName = h('span', { class: 'pane-sub' });
    const schedPane = h('div', { class: 'pane sched-pane' },
      h('div', { class: 'pane-head' }, h('span', { class: 'pane-title' }, 'Schedule'), this.schedName,
        h('div', { class: 'pane-actions' },
          h('button', { class: 'icon-btn', title: 'Schedule menu', onclick: (e) => this.scheduleMenu(e) }, '☰'))),
      this.schedList);
    makeSortable(this.schedList, '.sched-item', (from, to) => {
      const [it] = this.schedule.items.splice(from, 1);
      this.schedule.items.splice(to, 0, it);
      this.saveSchedule(); this.renderSchedule();
    });
    this.schedList.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-ss-item') || e.dataTransfer.types.includes('Files')) e.preventDefault(); });
    this.schedList.addEventListener('drop', (e) => this.onScheduleDrop(e));

    const pane = (kind) => {
      const monitor = h('canvas', { class: 'monitor', width: 480, height: 270 });
      const list = h('div', { class: 'slide-list', tabindex: 0 });
      const title = h('span', { class: 'pane-sub' });
      const foot = h('div', { class: 'pane-foot' });
      const el = h('div', { class: `pane ${kind}-pane` },
        h('div', { class: 'pane-head' }, h('span', { class: 'pane-title' + (kind === 'live' ? ' live-title' : '') }, kind === 'live' ? 'Live' : 'Preview'), title),
        h('div', { class: 'monitor-wrap' }, monitor), list, foot);
      this[kind + 'El'] = { el, monitor, list, title, foot };
      return el;
    };
    const previewPane = pane('preview');
    const livePane = pane('live');

    this.previewEl.foot.append(
      h('button', { class: 'btn sm', title: 'Add to schedule', onclick: () => this.preview && this.addToSchedule(this.preview.item) }, '+ Schedule'),
      h('div', { class: 'tb-spacer' }),
      h('button', { class: 'btn primary go-live', title: 'Send preview to the screens (Enter)', onclick: () => this.goLive() }, 'Go Live ▶'));

    this.transport = h('div', { class: 'transport' });
    this.btns = {
      black: h('button', { class: 'btn sm mode-btn', title: 'Black screen (B)', onclick: () => this.setMode('black') }, 'Black'),
      clear: h('button', { class: 'btn sm mode-btn', title: 'Clear text, keep background (C)', onclick: () => this.setMode('clear') }, 'Clear'),
      logo: h('button', { class: 'btn sm mode-btn', title: 'Show logo (L)', onclick: () => this.setMode('logo') }, 'Logo'),
    };
    this.liveEl.foot.append(this.btns.black, this.btns.clear, this.btns.logo, h('div', { class: 'tb-spacer' }),
      h('button', { class: 'btn sm', title: 'Previous slide (←)', onclick: () => this.step(-1) }, '◀'),
      h('button', { class: 'btn sm', title: 'Next slide (→)', onclick: () => this.step(1) }, '▶'));
    this.liveEl.el.insertBefore(this.transport, this.liveEl.foot);

    const top = h('div', { class: 'w-top' }, schedPane, previewPane, livePane);
    const resizer = h('div', { class: 'w-resizer', title: 'Drag to resize' });
    const bottom = h('div', { class: 'w-bottom' });
    this.root.append(toolbar, top, resizer, bottom);
    this.tabs = buildTabs(bottom, this);

    // vertical resizer between top panes and resource tabs
    const saved = Number(localStorage.getItem('w-bottom-h')) || 0;
    if (saved) bottom.style.height = saved + 'px';
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY, startH = bottom.getBoundingClientRect().height;
      const move = (ev) => { const nh = Math.max(160, Math.min(this.root.clientHeight - 260, startH - (ev.clientY - startY))); bottom.style.height = nh + 'px'; };
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); try { localStorage.setItem('w-bottom-h', parseInt(bottom.style.height)); } catch {} this.repaintMonitors(); };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    });
    new ResizeObserver(() => this.repaintMonitors()).observe(this.previewEl.monitor.parentElement);
  }

  // ------------------------------------------------ outputs ------------------------------------------------
  async refreshDisplays() {
    const st = await window.api.output.displays();
    this.onOutputStatus(st);
  }

  onOutputStatus(st) {
    this.displays = st.displays;
    const sel = this.targetSel;
    const cur = st.target;
    sel.innerHTML = '';
    const secondaryCount = st.displays.filter((d) => !d.primary).length;
    const opt = (v, l) => sel.appendChild(h('option', { value: v, selected: v === cur }, l));
    opt('off', 'Off');
    opt('secondary', `Secondary monitors (${secondaryCount})`);
    opt('primary', 'Primary (this laptop)');
    for (const d of st.displays) opt('display:' + d.id, `Only display ${d.index}${d.primary ? ' (primary)' : ''} · ${d.size}`);
    const n = st.active.length;
    this.outStatus.textContent = n ? `● ${n} screen${n > 1 ? 's' : ''}` : '○ no screens';
    this.outStatus.className = 'out-status' + (n ? ' on' : '');
    if (cur !== settings.worship.target) { settings.worship.target = cur; saveSettings(); }
  }

  async setTarget(t) {
    settings.worship.target = t; saveSettings();
    if (t === 'primary') toast('Output will cover this laptop screen. Press Esc on the output (or Alt+Tab) to get back.', 'warn', 6000);
    await window.api.output.setTarget(t);
    this.pushOutput();
  }

  async startNet(on) {
    const w = settings.worship;
    w.netOutput = on; saveSettings();
    this.netBtn.classList.toggle('on', on);
    if (!on) { await window.api.output.netStop(); return; }
    const r = await window.api.output.netStart(w.netPort, w.netLan);
    if (!r.ok) { toast('Network output failed: ' + r.error, 'error'); this.netBtn.classList.remove('on'); w.netOutput = false; return; }
    this.netBtn.title = 'Network output running:\n' + r.urls.join('\n');
    toast('Network output: ' + r.urls[0], 'ok');
  }

  toggleStreamOverlay(force) {
    const w = settings.worship;
    w.streamOverlay = force ?? !w.streamOverlay; saveSettings();
    this.streamBtn.classList.toggle('on', w.streamOverlay);
    bus.emit('worship-overlay', w.streamOverlay);
  }

  // ------------------------------------------------ schedule ------------------------------------------------
  scheduleMenu(e) {
    const r = e.target.getBoundingClientRect();
    contextMenu(r.left, r.bottom, [
      { label: 'New schedule', onClick: () => this.newSchedule() },
      { label: 'Open schedule…', onClick: () => this.openSchedule() },
      { label: 'Save schedule as…', onClick: () => this.saveScheduleAs() },
      '-',
      { label: 'Add custom slide…', onClick: () => this.tabs.newPresentation(true) },
      { label: 'Add media…', onClick: () => this.tabs.addMediaFiles(true) },
      '-',
      { label: 'Rename schedule…', onClick: async () => { const n = await promptDialog('Schedule name', this.schedule.name); if (n) { this.schedule.name = n; this.saveSchedule(); this.renderSchedule(); } } },
    ]);
  }

  async newSchedule() {
    if (this.schedule.items.length && !(await confirmDialog('Start a new, empty schedule? (Save first if you want to keep this one.)', { ok: 'New schedule' }))) return;
    this.schedule = { name: 'Untitled schedule', items: [] };
    this.saveSchedule(); this.renderSchedule();
  }

  async openSchedule() {
    const [p] = await window.api.dialog.open({ filters: [{ name: 'Schedule', extensions: ['ssched', 'json'] }] });
    if (!p) return;
    try {
      const j = JSON.parse(await window.api.fs.readText(p));
      if (!Array.isArray(j.items)) throw new Error('Not a schedule file');
      // Songs travel with the schedule so it opens on another computer
      if (Array.isArray(j.songs)) for (const s of j.songs) if (!this.songs.get(s.id)) this.songs.upsert(s);
      this.schedule = { name: j.name || basename(p), items: j.items };
      this.saveSchedule(); this.renderSchedule();
    } catch (e) { toast('Could not open schedule: ' + e.message, 'error'); }
  }

  async saveScheduleAs() {
    const p = await window.api.dialog.save({ defaultPath: this.schedule.name + '.ssched', filters: [{ name: 'Schedule', extensions: ['ssched'] }] });
    if (!p) return;
    const songs = this.schedule.items.filter((i) => i.type === 'song').map((i) => this.songs.get(i.songId)).filter(Boolean);
    this.schedule.name = basename(p).replace(/\.[^.]+$/, '');
    await window.api.fs.writeText(p, JSON.stringify({ ...this.schedule, songs }, null, 1));
    this.saveSchedule(); this.renderSchedule();
    toast('Schedule saved');
  }

  addToSchedule(item, { select = false } = {}) {
    const copy = { ...clone(item), id: uid('i') };
    this.schedule.items.push(copy);
    this.saveSchedule(); this.renderSchedule();
    if (select) this.selectScheduleItem(copy);
    return copy;
  }

  onScheduleDrop(e) {
    const data = e.dataTransfer.getData('application/x-ss-item');
    if (data) { e.preventDefault(); this.addToSchedule(JSON.parse(data)); return; }
    if (e.dataTransfer.files.length) {
      e.preventDefault();
      for (const f of e.dataTransfer.files) {
        const p = window.api.pathForFile(f);
        if (p) this.addToSchedule(this.tabs.mediaItem(p));
      }
    }
  }

  itemTitle(it) {
    if (it.type === 'song') return (this.songs.get(it.songId) || {}).title || it.title || '(missing song)';
    return it.title || 'Untitled';
  }

  renderSchedule() {
    this.schedName.textContent = this.schedule.name;
    const list = this.schedList;
    list.innerHTML = '';
    if (!this.schedule.items.length) list.appendChild(h('div', { class: 'empty-hint' }, 'Drag songs, scriptures or media here — or double-click them in the tabs below.'));
    this.schedule.items.forEach((it, i) => {
      const row = h('div', {
        class: 'sched-item' + (this.preview && this.preview.item.id === it.id ? ' selected' : '') + (this.live && this.live.item.id === it.id ? ' is-live' : ''),
        draggable: true,
        onclick: () => this.selectScheduleItem(it),
        ondblclick: () => { this.selectScheduleItem(it); this.goLive(); },
        oncontextmenu: (e) => { e.preventDefault(); this.scheduleItemMenu(e, it, i); },
      }, h('span', { class: 'sched-icon t-' + it.type }, ICONS[it.type] || '•'), h('span', { class: 'sched-title' }, this.itemTitle(it)),
      it.themeId ? h('span', { class: 'sched-badge', title: 'Custom theme' }, '◐') : null);
      list.appendChild(row);
    });
  }

  scheduleItemMenu(e, it, i) {
    const themes = this.themes.themes.map((t) => ({ label: t.name, checked: it.themeId === t.id, onClick: () => { it.themeId = t.id; this.itemChanged(it); } }));
    contextMenu(e.clientX, e.clientY, [
      { label: 'Preview', onClick: () => this.selectScheduleItem(it) },
      { label: 'Go live', onClick: () => { this.selectScheduleItem(it); this.goLive(); } },
      '-',
      it.type === 'song' ? { label: 'Edit song…', onClick: () => this.editSong(it.songId) } : null,
      it.type === 'custom' ? { label: 'Edit slides…', onClick: () => this.tabs.editCustomItem(it, () => this.itemChanged(it)) } : null,
      { label: 'Theme', submenu: [{ label: 'Default', checked: !it.themeId, onClick: () => { delete it.themeId; this.itemChanged(it); } }, '-', ...themes] },
      { label: 'Rename…', onClick: async () => { const n = await promptDialog('Title', this.itemTitle(it)); if (n) { it.title = n; this.itemChanged(it); } } },
      '-',
      { label: 'Move up', disabled: i === 0, onClick: () => { this.schedule.items.splice(i - 1, 0, ...this.schedule.items.splice(i, 1)); this.saveSchedule(); this.renderSchedule(); } },
      { label: 'Move down', disabled: i === this.schedule.items.length - 1, onClick: () => { this.schedule.items.splice(i + 1, 0, ...this.schedule.items.splice(i, 1)); this.saveSchedule(); this.renderSchedule(); } },
      { label: 'Remove from schedule', onClick: () => { this.schedule.items.splice(i, 1); this.saveSchedule(); this.renderSchedule(); } },
    ]);
  }

  async itemChanged(it) {
    this.saveSchedule(); this.renderSchedule();
    if (this.preview && this.preview.item.id === it.id) await this.showInPreview(it, this.preview.index);
    if (this.live && this.live.item.id === it.id) {
      const built = await this.buildSlides(it);
      this.live = { ...this.live, ...built, index: Math.min(this.live.index, built.slides.length - 1) };
      this.renderPane('live'); this.pushOutput();
    }
  }

  editSong(songId) {
    const song = this.songs.get(songId);
    if (!song) return toast('Song not found in library', 'warn');
    openSongEditor(song, {
      themes: this.themes.themes, onSave: (s) => {
        this.songs.upsert({ ...song, ...s });
        this.tabs.refreshSongs();
        for (const it of this.schedule.items) if (it.songId === songId) this.itemChanged(it);
        if (this.preview && this.preview.item.songId === songId) this.showInPreview(this.preview.item, this.preview.index);
      },
    });
  }

  selectScheduleItem(it) { this.showInPreview(it, 0); }

  // ------------------------------------------------ slides ------------------------------------------------
  themeFor(item) {
    const w = settings.worship;
    let id = item.themeId;
    if (!id && item.type === 'song') id = (this.songs.get(item.songId) || {}).themeId;
    if (!id) id = item.type === 'scripture' ? w.scriptureThemeId : w.songThemeId;
    return this.themes.resolve(id, item.type === 'scripture' ? 'scripture' : 'lyrics');
  }

  async buildSlides(item) {
    const theme = this.themeFor(item);
    let slides = [];
    if (item.type === 'song') {
      const song = this.songs.get(item.songId);
      slides = song ? lyricsToSlides(song.lyrics) : [{ label: '!', text: '(Song missing from library)' }];
    } else if (item.type === 'custom') {
      slides = String(item.text || '').replace(/\r/g, '').split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean).map((text, i) => ({ label: `Slide ${i + 1}`, text }));
      if (item.bgPath) theme.bg = { ...theme.bg, type: isVideo(item.bgPath) ? 'video' : 'image', path: item.bgPath };
    } else if (item.type === 'scripture') {
      slides = await this.scriptureSlides(item);
    } else if (item.type === 'media') {
      slides = [{ label: item.mediaType === 'video' ? 'Video' : 'Image', text: '', media: { path: item.path, type: item.mediaType, title: item.title, loop: !!item.loop, fit: item.fit || 'contain', volume: item.volume ?? 1, autoplay: item.autoplay !== false } }];
    }
    if (!slides.length) slides = [{ label: '—', text: '' }];
    return { item, slides, theme };
  }

  async scriptureSlides(item) {
    const w = settings.worship;
    const bible = await this.bibles.get(item.translation || w.defaultTranslation);
    if (!bible) return [{ label: '!', text: 'No Bible translation installed' }];
    const verses = this.bibles.passage(bible, item.ref);
    const per = Math.max(1, Number(w.versesPerSlide) || 1);
    const tr = bible.id;
    const slides = [];
    for (let i = 0; i < verses.length; i += per) {
      const group = verses.slice(i, i + per);
      const a = group[0], b = group.at(-1);
      const book = BOOKS[a.book].name;
      const ref = a.chapter !== b.chapter ? `${book} ${a.chapter}:${a.verse}-${b.chapter}:${b.verse}`
        : a.verse !== b.verse ? `${book} ${a.chapter}:${a.verse}-${b.verse}` : `${book} ${a.chapter}:${a.verse}`;
      const text = group.map((v) => (w.verseNumbers || per > 1 ? `${v.verse} ` : '') + v.text).join(per > 1 ? '  ' : '');
      slides.push({ label: `${a.chapter}:${a.verse}${b !== a ? '-' + b.verse : ''}`, text, reference: w.showTranslation ? `${ref} (${tr})` : ref });
    }
    return slides;
  }

  async showInPreview(item, index = 0) {
    const built = await this.buildSlides(item);
    this.preview = { ...built, index: Math.max(0, Math.min(index, built.slides.length - 1)) };
    this.renderPane('preview');
    this.renderSchedule();
  }

  goLive(index) {
    if (!this.preview) return;
    this.live = { ...this.preview, index: index ?? this.preview.index };
    if (this.mode === 'logo' || this.mode === 'black') this.mode = 'normal';
    this.mediaStatus = null;
    this.renderPane('live');
    this.renderSchedule();
    this.pushOutput();
  }

  setLiveIndex(i) {
    if (!this.live) return;
    const n = this.live.slides.length;
    const idx = Math.max(0, Math.min(n - 1, i));
    if (idx === this.live.index && this.mode === 'normal') return;
    this.live.index = idx;
    if (this.mode === 'clear') this.mode = 'normal';
    this.renderPane('live', true);
    this.pushOutput();
  }

  step(d) {
    if (!this.live) { if (this.preview && d > 0) this.goLive(); return; }
    this.setLiveIndex(this.live.index + d);
  }

  setMode(m) {
    this.mode = this.mode === m ? 'normal' : m;
    if (this.mode === 'logo' && !settings.worship.logoPath) toast('Set a logo image in Settings › Worship', 'warn');
    this.updateModeButtons();
    this.paintMonitor('live');
    this.pushOutput();
  }

  updateModeButtons() {
    for (const [k, b] of Object.entries(this.btns)) b.classList.toggle('active', this.mode === k);
    this.liveEl.el.classList.toggle('mode-black', this.mode === 'black');
  }

  // ------------------------------------------------ panes ------------------------------------------------
  renderPane(kind, onlySelection = false) {
    const P = this[kind];
    const E = this[kind + 'El'];
    if (kind === 'live') this.updateModeButtons();
    E.title.textContent = P ? this.itemTitle(P.item) : '';
    if (onlySelection && P) {
      $$('.slide-row', E.list).forEach((r, i) => r.classList.toggle('current', i === P.index));
      const cur = E.list.children[P.index];
      if (cur) cur.scrollIntoView({ block: 'nearest' });
      this.paintMonitor(kind);
      return;
    }
    E.list.innerHTML = '';
    if (!P) {
      E.list.appendChild(h('div', { class: 'empty-hint' }, kind === 'live' ? 'Nothing live. Select a slide in Preview and press Go Live.' : 'Click a schedule item, song or verse to preview it.'));
      this.paintMonitor(kind);
      this.renderTransport();
      return;
    }
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { const c = en.target; io.unobserve(c); this.paintThumb(c, P, Number(c.dataset.i)); }
    }, { root: E.list });
    P.slides.forEach((s, i) => {
      const thumb = h('canvas', { class: 'slide-thumb', width: 128, height: 72, dataset: { i } });
      const row = h('div', {
        class: 'slide-row' + (i === P.index ? ' current' : ''),
        onclick: () => {
          if (kind === 'live') this.setLiveIndex(i);
          else { this.preview.index = i; this.renderPane('preview', true); }
        },
        ondblclick: () => { if (kind === 'preview') { this.preview.index = i; this.goLive(i); } },
      }, thumb, h('div', { class: 'slide-info' }, h('div', { class: 'slide-label' }, s.label || ''), h('div', { class: 'slide-text' }, s.media ? basename(s.media.path) : s.text)));
      E.list.appendChild(row);
      io.observe(thumb);
    });
    const cur = E.list.children[P.index];
    if (cur) cur.scrollIntoView({ block: 'nearest' });
    this.paintMonitor(kind);
    if (kind === 'live') this.renderTransport();
  }

  paintThumb(canvas, P, i) {
    const s = P.slides[i];
    paintSlide(canvas, P.theme, s, { media: s.media });
  }

  paintMonitor(kind) {
    const E = this[kind + 'El'];
    const c = E.monitor;
    const wrap = c.parentElement;
    const w = Math.max(160, Math.round(wrap.clientWidth * devicePixelRatio));
    const hgt = Math.round((w * 9) / 16);
    if (c.width !== w) { c.width = w; c.height = hgt; }
    const P = this[kind];
    const ctx = c.getContext('2d');
    if (!P) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height); return; }
    const s = P.slides[P.index];
    if (kind === 'live' && this.mode === 'black') { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height); return; }
    if (kind === 'live' && this.mode === 'logo') {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
      if (settings.worship.logoPath) paintSlide(c, P.theme, null, { media: { type: 'image', path: settings.worship.logoPath } });
      return;
    }
    paintSlide(c, P.theme, s, { media: s.media, hideText: kind === 'live' && this.mode === 'clear' });
  }

  repaintMonitors() { this.paintMonitor('preview'); this.paintMonitor('live'); }

  renderTransport() {
    const t = this.transport;
    const s = this.live && this.live.slides[this.live.index];
    if (!s || !s.media || s.media.type !== 'video') { t.style.display = 'none'; return; }
    t.style.display = '';
    const st = this.mediaStatus || { time: 0, duration: 0, paused: s.media.autoplay === false };
    if (!t.firstChild) {
      this.tPlay = h('button', { class: 'btn sm', onclick: () => window.api.output.media({ action: 'toggle' }) }, '⏯');
      this.tSeek = h('input', { type: 'range', min: 0, max: 1000, value: 0, class: 'seek', oninput: (e) => {
        const d = (this.mediaStatus && this.mediaStatus.duration) || 0;
        window.api.output.media({ action: 'seek', time: (Number(e.target.value) / 1000) * d });
      } });
      this.tTime = h('span', { class: 'time' });
      this.tLoop = h('button', { class: 'btn sm toggle', title: 'Loop', onclick: () => { const m = this.live.slides[this.live.index].media; m.loop = !m.loop; this.live.item.loop = m.loop; this.pushOutput(); this.renderTransport(); } }, '⟲');
      t.append(h('button', { class: 'btn sm', title: 'Restart', onclick: () => window.api.output.media({ action: 'restart' }) }, '⏮'), this.tPlay, this.tSeek, this.tTime, this.tLoop);
    }
    this.tPlay.textContent = st.paused ? '▶' : '⏸';
    if (document.activeElement !== this.tSeek) this.tSeek.value = st.duration ? Math.round((st.time / st.duration) * 1000) : 0;
    this.tTime.textContent = `${fmtTime(st.time)} / ${fmtTime(st.duration)}`;
    this.tLoop.classList.toggle('on', !!s.media.loop);
  }

  // ------------------------------------------------ output ------------------------------------------------
  pushOutput() {
    const L = this.live;
    const s = L ? L.slides[L.index] : null;
    const state = {
      seq: ++this.seq,
      mode: this.mode,
      slide: s && !s.media ? { text: s.text, reference: s.reference || '', label: s.label } : null,
      theme: L ? L.theme : resolveTheme(this.themes.get(settings.worship.songThemeId)),
      media: s && s.media ? { ...s.media, nonce: L.item.id } : null,
      logoPath: settings.worship.logoPath || '',
      transition: Number(settings.worship.transition) || 0,
    };
    window.api.output.state(state);
    Object.assign(worshipLive, {
      slide: state.slide, mode: this.mode, kind: L ? L.item.type : '', theme: state.theme, seq: state.seq,
      media: state.media,
    });
    bus.emit('worship-live', worshipLive);
    this.renderSchedule();
  }

  // Hotkey entry points
  hotkey(action) {
    switch (action) {
      case 'slideNext': this.step(1); return true;
      case 'slidePrev': this.step(-1); return true;
      case 'black': this.setMode('black'); return true;
      case 'clear': this.setMode('clear'); return true;
      case 'logo': this.setMode('logo'); return true;
      case 'streamOverlay': this.toggleStreamOverlay(); return true;
      case 'goLiveWorship': this.goLive(); return true;
    }
    return false;
  }
}
