// Resource tabs under the presenter: Songs, Scriptures, Media, Presentations, Themes.
import { h, $$, uid, clone, modal, toast, confirmDialog, contextMenu, basename, isVideo, isImage, fileUrl, debounce, IMAGE_EXT, VIDEO_EXT } from '../util.js';
import { settings, saveSettings } from '../state.js';
import { openSongEditor, runSongImport, exportSongs, lyricsToSlides } from './songs.js';
import { BOOKS, parseReference, bookSuggestions, importBibleText } from './bible.js';
import { paintSlide, videoPoster, openThemeEditor } from './themes.js';

export function buildTabs(root, W) {
  const tabs = [
    { id: 'songs', label: 'Songs' },
    { id: 'scripture', label: 'Scriptures' },
    { id: 'media', label: 'Media' },
    { id: 'pres', label: 'Presentations' },
    { id: 'themes', label: 'Themes' },
  ];
  const bar = h('div', { class: 'tabbar' });
  const body = h('div', { class: 'tab-body' });
  root.append(bar, body);
  const panels = {};
  let active = localStorage.getItem('w-tab') || 'scripture';
  const show = (id) => {
    active = id;
    try { localStorage.setItem('w-tab', id); } catch {}
    $$('.tab', bar).forEach((t) => t.classList.toggle('active', t.dataset.id === id));
    for (const [k, p] of Object.entries(panels)) p.style.display = k === id ? '' : 'none';
    if (id === 'themes') api.refreshThemes();
    if (id === 'scripture') setTimeout(() => api.focusScripture(), 0);
  };
  for (const t of tabs) {
    bar.appendChild(h('div', { class: 'tab', dataset: { id: t.id }, onclick: () => show(t.id) }, t.label));
    panels[t.id] = h('div', { class: 'tab-panel panel-' + t.id });
    body.appendChild(panels[t.id]);
  }

  const api = {};
  Object.assign(api, songsTab(panels.songs, W), scriptureTab(panels.scripture, W), mediaTab(panels.media, W), presTab(panels.pres, W), themesTab(panels.themes, W));
  api.show = show;
  show(active);
  return api;
}

const dragItem = (e, item) => { e.dataTransfer.setData('application/x-ss-item', JSON.stringify(item)); e.dataTransfer.effectAllowed = 'copy'; };

// ------------------------------------------------ SONGS ------------------------------------------------
function songsTab(el, W) {
  const lib = W.songs;
  let selected = null;
  const search = h('input', { type: 'search', class: 'search', placeholder: 'Search titles & lyrics…', oninput: debounce(() => render(), 120) });
  const count = h('span', { class: 'muted' });
  const list = h('div', { class: 'res-list', tabindex: 0 });
  const itemFor = (s) => ({ type: 'song', songId: s.id, title: s.title });
  const edit = (s) => openSongEditor(s, {
    themes: W.themes.themes, onSave: (data) => {
      const saved = lib.upsert({ ...(s || {}), ...data });
      selected = saved.id; render();
      if (W.preview && W.preview.item.songId === saved.id) W.showInPreview(W.preview.item, W.preview.index);
      for (const it of W.schedule.items) if (it.songId === saved.id) W.itemChanged(it);
    },
  });
  const del = async (s) => {
    if (!(await confirmDialog(`Delete "${s.title}" from the song library?`, { ok: 'Delete', danger: true }))) return;
    lib.remove(s.id); render();
  };
  function render() {
    const results = lib.search(search.value);
    count.textContent = `${results.length} of ${lib.songs.length}`;
    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const s of results.slice(0, 800)) {
      frag.appendChild(h('div', {
        class: 'res-row' + (s.id === selected ? ' selected' : ''), draggable: true,
        ondragstart: (e) => dragItem(e, itemFor(s)),
        onclick: (e) => { selected = s.id; $$('.res-row', list).forEach((r) => r.classList.remove('selected')); e.currentTarget.classList.add('selected'); W.showInPreview({ ...itemFor(s), id: 'lib-' + s.id }); },
        ondblclick: () => W.addToSchedule(itemFor(s)),
        oncontextmenu: (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: 'Add to schedule', onClick: () => W.addToSchedule(itemFor(s)) },
            { label: 'Preview', onClick: () => W.showInPreview({ ...itemFor(s), id: 'lib-' + s.id }) },
            { label: 'Go live', onClick: async () => { await W.showInPreview({ ...itemFor(s), id: 'lib-' + s.id }); W.goLive(); } },
            '-', { label: 'Edit…', onClick: () => edit(s) },
            { label: 'Duplicate', onClick: () => { lib.upsert({ ...clone(s), id: uid('s'), title: s.title + ' (copy)' }); render(); } },
            { label: 'Delete', onClick: () => del(s) },
          ]);
        },
      }, h('span', { class: 'res-title' }, s.title), h('span', { class: 'res-sub' }, s.author || ''), s.ccli ? h('span', { class: 'res-tag' }, 'CCLI ' + s.ccli) : null));
    }
    list.appendChild(frag);
    if (!results.length) list.appendChild(h('div', { class: 'empty-hint' }, lib.songs.length ? 'No matches.' : 'No songs yet. Click “New” or “Import”.'));
  }
  const cur = () => lib.get(selected);
  el.append(
    h('div', { class: 'res-toolbar' }, search, count, h('div', { class: 'tb-spacer' }),
      h('button', { class: 'btn sm', onclick: () => edit(null) }, '+ New'),
      h('button', { class: 'btn sm', onclick: () => cur() ? edit(cur()) : toast('Select a song first') }, 'Edit'),
      h('button', { class: 'btn sm', onclick: () => cur() && del(cur()) }, 'Delete'),
      h('button', { class: 'btn sm', onclick: () => runSongImport(lib, render) }, 'Import…'),
      h('button', { class: 'btn sm', title: 'Back up the whole song library', onclick: () => exportSongs(lib.songs) }, 'Export'),
      h('button', { class: 'btn sm primary', onclick: () => cur() ? W.addToSchedule(itemFor(cur())) : toast('Select a song first') }, '+ Schedule')),
    list);
  list.addEventListener('keydown', (e) => {
    const rows = $$('.res-row', list);
    const i = rows.findIndex((r) => r.classList.contains('selected'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]; if (n) { n.click(); n.scrollIntoView({ block: 'nearest' }); } }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (cur()) W.addToSchedule(itemFor(cur())); }
  });
  search.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); list.focus(); const r = list.querySelector('.res-row'); if (r) r.click(); } });
  render();
  return { refreshSongs: render };
}

// ------------------------------------------------ SCRIPTURE ------------------------------------------------
function scriptureTab(el, W) {
  const lib = W.bibles;
  const st = { tr: settings.worship.defaultTranslation, book: 42, chapter: 3, v1: 16, v2: 16, bible: null, results: null };
  const trSel = h('select', { class: 'tr-select', title: 'Translation', onchange: async (e) => { st.tr = e.target.value; settings.worship.defaultTranslation = st.tr; saveSettings(); await load(); renderVerses(); autoPreview(); } });
  const refIn = h('input', { type: 'text', class: 'ref-input', placeholder: 'Type a reference — e.g. jn 3 16 or 1 cor 13:4-7', spellcheck: false });
  const suggest = h('div', { class: 'ref-suggest' });
  const searchIn = h('input', { type: 'search', class: 'search', placeholder: 'Search words…' });
  const cont = h('label', { class: 'chk', title: 'When a single verse is chosen, keep going verse-by-verse through the rest of the chapter' },
    h('input', { type: 'checkbox', checked: settings.worship.continueChapter !== false, onchange: (e) => { settings.worship.continueChapter = e.target.checked; saveSettings(); autoPreview(); } }), 'Continue to end of chapter');
  const books = h('div', { class: 'book-list' });
  const chapters = h('div', { class: 'chapter-grid' });
  const verses = h('div', { class: 'verse-list', tabindex: 0 });

  async function load() {
    st.bible = await lib.get(st.tr);
    if (st.bible) st.tr = st.bible.id;
  }
  function renderTranslations() {
    trSel.innerHTML = '';
    for (const b of lib.list) trSel.appendChild(h('option', { value: b.id, selected: b.id === st.tr }, `${b.id} — ${b.name}`));
    trSel.appendChild(h('option', { value: '__import' }, '＋ Import a translation…'));
  }
  trSel.addEventListener('change', async (e) => { if (e.target.value === '__import') { e.stopImmediatePropagation(); trSel.value = st.tr; await importTranslation(); } }, true);

  async function importTranslation() {
    const paths = await window.api.dialog.open({ title: 'Bible file (Zefania / OSIS / OpenSong XML or JSON)', filters: [{ name: 'Bible', extensions: ['xml', 'json', 'osis', 'zef'] }] });
    if (!paths[0]) return;
    try {
      toast('Importing translation…');
      const bible = importBibleText(await window.api.fs.readText(paths[0]), basename(paths[0]));
      const verses = bible.books.reduce((a, b) => a + b.reduce((x, c) => x + c.length, 0), 0);
      if (verses < 100) throw new Error('Could not read verses from that file.');
      await window.api.bibles.save(bible);
      await lib.refresh();
      lib.cache.delete(bible.id);
      st.tr = bible.id; renderTranslations(); await load(); renderVerses();
      toast(`Installed ${bible.name} (${verses.toLocaleString()} verses)`, 'ok');
    } catch (e) { toast('Import failed: ' + e.message, 'error', 7000); }
  }

  function renderBooks() {
    books.innerHTML = '';
    BOOKS.forEach((b, i) => {
      if (i === 39) books.appendChild(h('div', { class: 'testament' }, 'New Testament'));
      if (i === 0) books.appendChild(h('div', { class: 'testament' }, 'Old Testament'));
      books.appendChild(h('div', { class: 'book' + (i === st.book ? ' selected' : ''), onclick: () => { st.book = i; st.chapter = 1; st.v1 = 1; st.v2 = 1; st.results = null; syncRefInput(); renderAll(); autoPreview(); } }, b.name));
    });
    const s = books.querySelector('.selected'); if (s) s.scrollIntoView({ block: 'nearest' });
  }
  function renderChapters() {
    chapters.innerHTML = '';
    const n = st.bible ? (st.bible.books[st.book] || []).length : 0;
    for (let c = 1; c <= n; c++) chapters.appendChild(h('button', { class: 'ch' + (c === st.chapter ? ' selected' : ''), onclick: () => { st.chapter = c; st.v1 = 1; st.v2 = 1; st.results = null; syncRefInput(); renderAll(); autoPreview(); } }, c));
    const s = chapters.querySelector('.selected'); if (s) s.scrollIntoView({ block: 'nearest' });
  }
  function renderVerses() {
    verses.innerHTML = '';
    if (!st.bible) { verses.appendChild(h('div', { class: 'empty-hint' }, 'No translation loaded')); return; }
    if (st.results) {
      verses.appendChild(h('div', { class: 'search-head' }, `${st.results.length}${st.results.length >= 300 ? '+' : ''} results`, h('button', { class: 'btn xs', onclick: () => { st.results = null; renderVerses(); } }, 'Back to chapter')));
      for (const r of st.results) {
        verses.appendChild(h('div', { class: 'verse', onclick: () => { Object.assign(st, { book: r.book, chapter: r.chapter, v1: r.verse, v2: r.verse, results: null }); syncRefInput(); renderAll(); autoPreview(); } },
          h('span', { class: 'vnum wide' }, `${BOOKS[r.book].name} ${r.chapter}:${r.verse}`), h('span', null, r.text)));
      }
      return;
    }
    const ch = (st.bible.books[st.book] || [])[st.chapter - 1] || [];
    const lo = Math.min(st.v1, st.v2), hi = Math.max(st.v1, st.v2);
    ch.forEach((t, i) => {
      const v = i + 1;
      verses.appendChild(h('div', {
        class: 'verse' + (v >= lo && v <= hi ? ' selected' : ''),
        onclick: (e) => { if (e.shiftKey) st.v2 = v; else { st.v1 = v; st.v2 = v; } syncRefInput(); renderVerses(); autoPreview(); },
        ondblclick: async () => { st.v1 = v; st.v2 = v; syncRefInput(); renderVerses(); await autoPreview(); W.goLive(); },
        draggable: true, ondragstart: (e) => dragItem(e, currentItem()),
      }, h('span', { class: 'vnum' }, v), h('span', null, t)));
    });
    const s = verses.querySelector('.selected'); if (s) s.scrollIntoView({ block: 'center' });
  }
  function renderAll() { renderBooks(); renderChapters(); renderVerses(); }

  function syncRefInput() {
    if (document.activeElement === refIn) return;
    const lo = Math.min(st.v1, st.v2), hi = Math.max(st.v1, st.v2);
    refIn.value = `${BOOKS[st.book].name} ${st.chapter}:${lo}${hi > lo ? '-' + hi : ''}`;
  }

  function currentItem() {
    const lo = Math.min(st.v1, st.v2), hi = Math.max(st.v1, st.v2);
    const single = lo === hi && settings.worship.continueChapter !== false;
    const ranges = st.explicitRanges || [[st.chapter, lo, st.chapter, single ? 999 : hi]];
    const title = `${BOOKS[st.book].name} ${st.chapter}:${lo}${hi > lo ? '-' + hi : ''}${single ? 'ff' : ''} (${st.tr})`;
    return { type: 'scripture', translation: st.tr, ref: { book: st.book, chapter: st.chapter, ranges }, title: st.explicitTitle ? `${st.explicitTitle} (${st.tr})` : title };
  }

  async function autoPreview() {
    await W.showInPreview({ ...currentItem(), id: 'scr-preview' }, 0);
  }

  // Reference typing: live-parse and jump
  const applyTyped = () => {
    st.explicitRanges = null; st.explicitTitle = null;
    const r = parseReference(refIn.value);
    if (!r || !st.bible) return false;
    const bk = st.bible.books[r.book] || [];
    st.book = r.book;
    st.chapter = Math.max(1, Math.min(r.chapter, bk.length || 1));
    if (r.ranges.length) {
      st.v1 = r.ranges[0][1]; st.v2 = r.ranges[0][2] === st.chapter ? r.ranges[0][3] : st.v1;
      if (r.ranges.length > 1 || r.ranges[0][2] !== r.ranges[0][0]) { st.explicitRanges = r.ranges; st.explicitTitle = refIn.value.trim().replace(/^\S+/, BOOKS[r.book].name); }
    } else { st.v1 = 1; st.v2 = 1; }
    st.results = null;
    renderAll();
    return true;
  };
  refIn.addEventListener('input', () => {
    const txt = refIn.value.trim();
    suggest.innerHTML = '';
    const bookPart = txt.match(/^((?:[1-3]\s*)?[a-z .]+)$/i);
    if (bookPart) {
      for (const b of bookSuggestions(bookPart[1])) suggest.appendChild(h('div', { class: 'sugg', onmousedown: (e) => { e.preventDefault(); refIn.value = b.name + ' '; refIn.dispatchEvent(new Event('input')); } }, b.name));
    }
    suggest.style.display = suggest.children.length ? '' : 'none';
    if (applyTyped()) debouncedPreview();
  });
  const debouncedPreview = debounce(() => autoPreview(), 200);
  refIn.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      suggest.style.display = 'none';
      if (applyTyped()) { await autoPreview(); if (e.ctrlKey || e.shiftKey) W.goLive(); }
    }
    if (e.key === 'Tab' && suggest.firstChild) { e.preventDefault(); suggest.firstChild.dispatchEvent(new MouseEvent('mousedown')); }
    if (e.key === 'Escape') { suggest.style.display = 'none'; refIn.blur(); }
  });
  refIn.addEventListener('blur', () => setTimeout(() => { suggest.style.display = 'none'; }, 150));
  refIn.addEventListener('focus', () => refIn.select());

  searchIn.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault(); e.stopPropagation();
    if (!searchIn.value.trim() || !st.bible) return;
    st.results = lib.search(st.bible, searchIn.value.trim());
    renderVerses();
  });

  verses.addEventListener('keydown', (e) => {
    if (st.results) return;
    const n = ((st.bible.books[st.book] || [])[st.chapter - 1] || []).length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      const v = Math.max(1, Math.min(n, (e.key === 'ArrowDown' ? Math.max(st.v1, st.v2) + 1 : Math.min(st.v1, st.v2) - 1)));
      if (e.shiftKey) st.v2 = v; else { st.v1 = v; st.v2 = v; }
      syncRefInput(); renderVerses(); debouncedPreview();
    }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); autoPreview().then(() => W.goLive()); }
  });

  el.append(
    h('div', { class: 'res-toolbar scr-toolbar' }, trSel, h('div', { class: 'ref-wrap' }, refIn, suggest), searchIn),
    h('div', { class: 'scr-body' }, books, chapters, verses),
    h('div', { class: 'res-toolbar scr-foot' }, cont, h('div', { class: 'tb-spacer' }),
      h('button', { class: 'btn sm', onclick: () => W.addToSchedule(currentItem()) }, '+ Schedule'),
      h('button', { class: 'btn sm', onclick: () => autoPreview() }, 'Preview'),
      h('button', { class: 'btn sm primary', title: 'Ctrl+Enter in the reference box also goes live', onclick: async () => { await autoPreview(); W.goLive(); } }, 'Go Live ▶')));

  (async () => {
    await lib.refresh();
    if (!lib.list.some((b) => b.id === st.tr) && lib.list[0]) st.tr = lib.list[0].id;
    renderTranslations();
    await load();
    syncRefInput();
    renderAll();
  })();

  return { focusScripture: () => { if (document.activeElement.tagName !== 'INPUT') refIn.focus(); } };
}

// ------------------------------------------------ MEDIA ------------------------------------------------
function mediaTab(el, W) {
  let items = [];
  let selected = null;
  const grid = h('div', { class: 'media-grid' });
  const save = debounce(() => window.api.store.write('media', items), 300);
  const mediaItem = (p) => ({ type: 'media', path: p, mediaType: isVideo(p) ? 'video' : 'image', title: basename(p), loop: false, fit: 'contain', autoplay: true, volume: 1 });
  async function addMediaFiles(toSchedule = false) {
    const paths = await window.api.dialog.open({ multi: true, filters: [{ name: 'Images & videos', extensions: [...IMAGE_EXT, ...VIDEO_EXT].map((e) => e.slice(1)) }] });
    for (const p of paths) {
      if (!items.some((i) => i.path === p)) items.push({ path: p });
      if (toSchedule) W.addToSchedule(mediaItem(p));
    }
    save(); render();
  }
  function render() {
    grid.innerHTML = '';
    if (!items.length) grid.appendChild(h('div', { class: 'empty-hint' }, 'Add images and videos (announcements, countdowns, motion backgrounds). Drag files here.'));
    for (const it of items) {
      const vid = isVideo(it.path);
      const thumb = h('canvas', { width: 160, height: 90 });
      const ctx = thumb.getContext('2d');
      ctx.fillStyle = '#111'; ctx.fillRect(0, 0, 160, 90);
      const drawThumb = () => {
        const src = vid ? videoPoster(it.path, drawThumb) : null;
        if (vid && src) { ctx.drawImage(src, 0, 0, 160, 90); ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.fillRect(0, 70, 160, 20); ctx.fillStyle = '#fff'; ctx.font = '12px Segoe UI'; ctx.fillText('▶ video', 6, 84); }
        else if (!vid) { const img = new Image(); img.onload = () => { const s = Math.max(160 / img.naturalWidth, 90 / img.naturalHeight); ctx.drawImage(img, (160 - img.naturalWidth * s) / 2, (90 - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s); }; img.src = fileUrl(it.path); }
      };
      drawThumb();
      grid.appendChild(h('div', {
        class: 'media-tile' + (selected === it.path ? ' selected' : ''), draggable: true, title: it.path,
        ondragstart: (e) => dragItem(e, mediaItem(it.path)),
        onclick: (e) => { selected = it.path; $$('.media-tile', grid).forEach((t) => t.classList.remove('selected')); e.currentTarget.classList.add('selected'); W.showInPreview({ ...mediaItem(it.path), id: 'media-' + it.path }); },
        ondblclick: () => W.addToSchedule(mediaItem(it.path)),
        oncontextmenu: (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: 'Add to schedule', onClick: () => W.addToSchedule(mediaItem(it.path)) },
            { label: 'Add to schedule (looping)', disabled: !vid, onClick: () => W.addToSchedule({ ...mediaItem(it.path), loop: true }) },
            { label: 'Create theme with this background', onClick: () => openThemeEditor({ name: basename(it.path), bg: { type: vid ? 'video' : 'image', path: it.path, fit: 'cover', dim: 0.25 } }, W.themes, () => W.tabs.refreshThemes()) },
            { label: 'Show in folder', onClick: () => window.api.showItem(it.path) },
            '-', { label: 'Remove from media list', onClick: () => { items = items.filter((x) => x !== it); save(); render(); } },
          ]);
        },
      }, thumb, h('div', { class: 'media-name' }, basename(it.path))));
    }
  }
  el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    for (const f of e.dataTransfer.files) { const p = window.api.pathForFile(f); if (p && (isVideo(p) || isImage(p)) && !items.some((i) => i.path === p)) items.push({ path: p }); }
    save(); render();
  });
  el.append(h('div', { class: 'res-toolbar' },
    h('button', { class: 'btn sm', onclick: () => addMediaFiles() }, '+ Add media…'),
    h('div', { class: 'tb-spacer' }),
    h('button', { class: 'btn sm primary', onclick: () => selected ? W.addToSchedule(mediaItem(selected)) : toast('Select a media file first') }, '+ Schedule')), grid);
  window.api.store.read('media', []).then((m) => { items = m || []; render(); });
  return { addMediaFiles, mediaItem };
}

// ------------------------------------------------ PRESENTATIONS (custom slides) ------------------------------------------------
function presTab(el, W) {
  let items = [];
  let selected = null;
  const list = h('div', { class: 'res-list' });
  const save = debounce(() => window.api.store.write('presentations', items), 300);
  const toItem = (p) => ({ type: 'custom', title: p.title, text: p.text, themeId: p.themeId || undefined, bgPath: p.bgPath || undefined, presId: p.id });

  function editor(p, onSave) {
    const d = { title: '', text: '', themeId: '', bgPath: '', ...clone(p || {}) };
    const preview = h('div', { class: 'song-slides' });
    const upd = () => {
      preview.innerHTML = '';
      String(d.text).split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean).forEach((t, i) => preview.appendChild(h('div', { class: 'song-slide' }, h('div', { class: 'song-slide-label' }, 'Slide ' + (i + 1)), h('div', { class: 'song-slide-text' }, t))));
    };
    const ta = h('textarea', { class: 'lyrics-input', oninput: (e) => { d.text = e.target.value; upd(); }, placeholder: 'Welcome to our service!\n\nPlease silence your phones\n\n(blank line = new slide)' }, d.text);
    const bg = h('input', { type: 'text', value: d.bgPath, placeholder: '(use theme background)', onchange: (e) => { d.bgPath = e.target.value; } });
    modal({
      title: p ? 'Edit presentation' : 'New presentation', width: 'min(980px,94vw)', className: 'tall',
      body: h('div', { class: 'song-editor' },
        h('div', { class: 'song-meta' },
          h('label', { class: 'fld' }, h('span', null, 'Title'), h('input', { type: 'text', value: d.title, oninput: (e) => { d.title = e.target.value; } })),
          h('label', { class: 'fld' }, h('span', null, 'Theme'), h('select', { onchange: (e) => { d.themeId = e.target.value; } }, h('option', { value: '' }, '(default)'), W.themes.themes.map((t) => h('option', { value: t.id, selected: t.id === d.themeId }, t.name)))),
          h('label', { class: 'fld wide' }, h('span', null, 'Background'), h('div', { class: 'file-row' }, bg, h('button', { class: 'btn sm', onclick: async () => { const [f] = await window.api.dialog.open({ filters: [{ name: 'Media', extensions: [...IMAGE_EXT, ...VIDEO_EXT].map((e) => e.slice(1)) }] }); if (f) { bg.value = f; d.bgPath = f; } } }, 'Browse…')))),
        h('div', { class: 'song-body' }, ta, preview)),
      buttons: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: () => { if (!d.title.trim()) { toast('Add a title'); return false; } onSave(d); } }],
    });
    upd();
  }
  function newPresentation(toSchedule = false) {
    editor(null, (d) => { d.id = uid('p'); items.push(d); save(); render(); if (toSchedule) W.addToSchedule(toItem(d)); });
  }
  function editCustomItem(it, done) {
    editor({ title: it.title, text: it.text, themeId: it.themeId, bgPath: it.bgPath }, (d) => { Object.assign(it, { title: d.title, text: d.text, themeId: d.themeId || undefined, bgPath: d.bgPath || undefined }); done && done(); });
  }
  function render() {
    list.innerHTML = '';
    if (!items.length) list.appendChild(h('div', { class: 'empty-hint' }, 'Custom text slides — announcements, welcome, sermon points, prayer requests.'));
    for (const p of items) {
      list.appendChild(h('div', {
        class: 'res-row' + (selected === p.id ? ' selected' : ''), draggable: true,
        ondragstart: (e) => dragItem(e, toItem(p)),
        onclick: (e) => { selected = p.id; $$('.res-row', list).forEach((r) => r.classList.remove('selected')); e.currentTarget.classList.add('selected'); W.showInPreview({ ...toItem(p), id: 'pres-' + p.id }); },
        ondblclick: () => W.addToSchedule(toItem(p)),
        oncontextmenu: (e) => { e.preventDefault(); contextMenu(e.clientX, e.clientY, [
          { label: 'Add to schedule', onClick: () => W.addToSchedule(toItem(p)) },
          { label: 'Edit…', onClick: () => editor(p, (d) => { Object.assign(p, d); save(); render(); }) },
          { label: 'Delete', onClick: async () => { if (await confirmDialog(`Delete "${p.title}"?`, { danger: true, ok: 'Delete' })) { items = items.filter((x) => x !== p); save(); render(); } } },
        ]); },
      }, h('span', { class: 'res-title' }, p.title), h('span', { class: 'res-sub' }, `${String(p.text).split(/\n\s*\n/).filter((x) => x.trim()).length} slides`)));
    }
  }
  const cur = () => items.find((p) => p.id === selected);
  el.append(h('div', { class: 'res-toolbar' },
    h('button', { class: 'btn sm', onclick: () => newPresentation() }, '+ New'),
    h('button', { class: 'btn sm', onclick: () => cur() && editor(cur(), (d) => { Object.assign(cur(), d); save(); render(); }) }, 'Edit'),
    h('div', { class: 'tb-spacer' }),
    h('button', { class: 'btn sm primary', onclick: () => cur() ? W.addToSchedule(toItem(cur())) : toast('Select a presentation first') }, '+ Schedule')), list);
  window.api.store.read('presentations', []).then((p) => { items = p || []; render(); });
  return { newPresentation, editCustomItem };
}

// ------------------------------------------------ THEMES ------------------------------------------------
function themesTab(el, W) {
  let selected = null;
  const grid = h('div', { class: 'theme-grid' });
  const lib = W.themes;
  const sample = { text: 'Amazing grace how sweet the sound\nThat saved a wretch like me', reference: 'Sample 1:1' };
  function render() {
    grid.innerHTML = '';
    const w = settings.worship;
    for (const t of lib.themes) {
      const c = h('canvas', { width: 192, height: 108 });
      paintSlide(c, lib.resolve(t.id), sample);
      const badges = [];
      if (w.songThemeId === t.id) badges.push(h('span', { class: 'badge' }, 'Songs'));
      if (w.scriptureThemeId === t.id) badges.push(h('span', { class: 'badge' }, 'Scripture'));
      grid.appendChild(h('div', {
        class: 'theme-tile' + (selected === t.id ? ' selected' : ''),
        onclick: (e) => { selected = t.id; $$('.theme-tile', grid).forEach((x) => x.classList.remove('selected')); e.currentTarget.classList.add('selected'); },
        ondblclick: () => openThemeEditor(t, lib, render),
        oncontextmenu: (e) => { e.preventDefault(); selected = t.id; menu(e.clientX, e.clientY, t); },
      }, c, h('div', { class: 'theme-name' }, t.name, ...badges)));
    }
  }
  function menu(x, y, t) {
    contextMenu(x, y, [
      { label: 'Apply to preview item', disabled: !W.preview, onClick: () => applyToPreview(t) },
      { label: 'Default for songs & slides', checked: settings.worship.songThemeId === t.id, onClick: () => { settings.worship.songThemeId = t.id; saveSettings(); render(); refreshOpen(); } },
      { label: 'Default for scripture', checked: settings.worship.scriptureThemeId === t.id, onClick: () => { settings.worship.scriptureThemeId = t.id; saveSettings(); render(); refreshOpen(); } },
      '-', { label: t.builtin ? 'Customise (copy)…' : 'Edit…', onClick: () => openThemeEditor(t, lib, render) },
      { label: 'Duplicate', onClick: () => { lib.upsert({ ...clone(t), id: uid('t'), name: t.name + ' copy', builtin: false }); render(); } },
      { label: 'Delete', disabled: t.builtin, onClick: async () => { if (await confirmDialog(`Delete theme "${t.name}"?`, { danger: true, ok: 'Delete' })) { lib.remove(t.id); render(); } } },
    ]);
  }
  function refreshOpen() {
    if (W.preview) W.showInPreview(W.preview.item, W.preview.index);
    if (W.live) W.itemChanged(W.live.item);
  }
  function applyToPreview(t) {
    const it = W.preview.item;
    const inSched = W.schedule.items.find((x) => x.id === it.id);
    if (inSched) { inSched.themeId = t.id; W.itemChanged(inSched); } else { it.themeId = t.id; W.showInPreview(it, W.preview.index); }
  }
  const cur = () => lib.get(selected);
  el.append(h('div', { class: 'res-toolbar' },
    h('button', { class: 'btn sm', onclick: () => openThemeEditor(null, lib, render) }, '+ New theme'),
    h('button', { class: 'btn sm', onclick: () => cur() && openThemeEditor(cur(), lib, render) }, 'Edit'),
    h('button', { class: 'btn sm', onclick: (e) => { if (!cur()) return toast('Select a theme'); const r = e.target.getBoundingClientRect(); menu(r.left, r.bottom, cur()); } }, 'More ▾'),
    h('div', { class: 'tb-spacer' }),
    h('button', { class: 'btn sm primary', onclick: () => cur() && W.preview ? applyToPreview(cur()) : toast('Select a theme and a preview item') }, 'Apply to preview')), grid);
  render();
  return { refreshThemes: render };
}
