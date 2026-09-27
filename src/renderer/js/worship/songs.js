// Song library: storage, lyric → slide parsing, importers, and the song editor dialog.
import { h, uid, modal, toast, confirmDialog, debounce, basename, extname } from '../util.js';

const LABEL_RE = /^\s*[\[(]?\s*((?:pre[- ]?chorus|chorus|verse|refrain|bridge|tag|ending|intro|outro|interlude|vamp|coda|instrumental|misc|hook|prechorus)\s*\d*[a-z]?|(?:v|c|b|pc|t|br)\d+[a-z]?)\s*[\])]?\s*:?\s*$/i;
const SHORT = { v: 'Verse', c: 'Chorus', b: 'Bridge', br: 'Bridge', pc: 'Pre-Chorus', t: 'Tag' };

export function prettyLabel(raw) {
  const s = raw.trim().replace(/^[\[(]|[\])]:?$|:$/g, '').trim();
  const m = s.match(/^(v|c|b|pc|t|br)(\d+[a-z]?)$/i);
  if (m) return `${SHORT[m[1].toLowerCase()]} ${m[2]}`;
  return s.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/Pre[- ]?chorus/i, 'Pre-Chorus');
}

// Lyrics text -> slides. Blank lines separate slides; a label line ("Verse 1", "Chorus"...) names the section.
export function lyricsToSlides(lyrics) {
  const blocks = String(lyrics || '').replace(/\r/g, '').split(/\n\s*\n/);
  const slides = [];
  let label = '';
  let part = 0;
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trimEnd());
    while (lines.length && !lines[0].trim()) lines.shift();
    if (!lines.length) continue;
    if (LABEL_RE.test(lines[0])) {
      label = prettyLabel(lines.shift());
      part = 0;
      if (!lines.filter((l) => l.trim()).length) continue;
    }
    part++;
    const text = lines.filter((l) => !LABEL_RE.test(l)).join('\n').trim();
    if (!text) continue;
    slides.push({ label: label ? (part > 1 ? `${label} (${part})` : label) : `Slide ${slides.length + 1}`, text });
  }
  return slides;
}

export class SongLibrary {
  constructor() { this.songs = []; this.save = debounce(() => window.api.store.write('songs', this.songs), 500); }
  async load() {
    this.songs = (await window.api.store.read('songs', null)) || [];
    if (!this.songs.length) { this.songs = SAMPLE_SONGS.map((s) => ({ ...s, id: uid('s'), created: Date.now(), updated: Date.now() })); this.save(); }
    this.sort();
  }
  sort() { this.songs.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })); }
  get(id) { return this.songs.find((s) => s.id === id); }
  upsert(song) {
    song.updated = Date.now();
    const i = this.songs.findIndex((s) => s.id === song.id);
    if (i >= 0) this.songs[i] = song; else { song.id ||= uid('s'); song.created = Date.now(); this.songs.push(song); }
    this.sort(); this.save();
    return song;
  }
  remove(id) { this.songs = this.songs.filter((s) => s.id !== id); this.save(); }
  addMany(list, skipDuplicates = true) {
    let added = 0, skipped = 0;
    const titles = new Set(this.songs.map((s) => s.title.toLowerCase().trim()));
    for (const s of list) {
      if (!s.title && !s.lyrics) continue;
      if (skipDuplicates && titles.has(String(s.title).toLowerCase().trim())) { skipped++; continue; }
      titles.add(String(s.title).toLowerCase().trim());
      this.songs.push({ author: '', copyright: '', ccli: '', key: '', tags: '', ...s, id: uid('s'), created: Date.now(), updated: Date.now() });
      added++;
    }
    this.sort(); this.save();
    return { added, skipped };
  }
  search(q) {
    q = q.trim().toLowerCase();
    if (!q) return this.songs;
    const t = [], l = [];
    for (const s of this.songs) {
      if (s.title.toLowerCase().includes(q) || (s.author || '').toLowerCase().includes(q) || (s.ccli || '') === q) t.push(s);
      else if ((s.lyrics || '').toLowerCase().includes(q) || (s.tags || '').toLowerCase().includes(q)) l.push(s);
    }
    return [...t, ...l];
  }
}

// ------------------------------------------------ importers ------------------------------------------------
export async function importSongFiles(paths) {
  const out = [];
  const errors = [];
  for (const p of paths) {
    try {
      const ext = extname(p);
      if (/\.(db|ewsx)$/i.test(ext)) { out.push(...(await window.api.songs.importEW(p))); continue; }
      const text = await window.api.fs.readText(p);
      const name = basename(p).replace(/\.[^.]+$/, '');
      if (ext === '.json') { const j = JSON.parse(text); out.push(...(Array.isArray(j) ? j : j.songs || [j])); continue; }
      if (ext === '.xml' && /<song[\s>]/.test(text)) { out.push(parseOpenLyrics(text, name)); continue; }
      if (ext === '.usr') { out.push(parseUsr(text, name)); continue; }
      if (['.cho', '.chopro', '.chordpro', '.pro', '.crd'].includes(ext) || /\{(title|t):/i.test(text)) { out.push(parseChordPro(text, name)); continue; }
      out.push(parsePlainText(text, name));
    } catch (e) { errors.push(`${basename(p)}: ${e.message}`); }
  }
  return { songs: out, errors };
}

function parsePlainText(text, name) {
  const lines = text.replace(/\r/g, '').split('\n');
  // CCLI SongSelect lyrics export: title first line, footer with "CCLI Song #"
  const ccliLine = lines.findIndex((l) => /CCLI Song\s*#/i.test(l));
  if (ccliLine > 0) {
    const title = lines[0].trim();
    const ccli = (lines[ccliLine].match(/#\s*(\d+)/) || [])[1] || '';
    const footer = lines.slice(ccliLine + 1).filter((l) => l.trim());
    const body = lines.slice(1, ccliLine);
    // author line is the last non-empty line before CCLI
    while (body.length && !body.at(-1).trim()) body.pop();
    const author = body.pop() || '';
    return { title, author: author.trim(), ccli, copyright: footer.filter((l) => /©|copyright/i.test(l)).join('; '), lyrics: body.join('\n').trim() };
  }
  let title = name;
  const first = lines.find((l) => l.trim());
  if (first && first.trim().toLowerCase() === name.toLowerCase()) lines.splice(lines.indexOf(first), 1);
  else if (first && lines[lines.indexOf(first) + 1] === '' && !LABEL_RE.test(first) && first.length < 60 && /^title\s*:/i.test(first)) {
    title = first.replace(/^title\s*:/i, '').trim(); lines.splice(lines.indexOf(first), 1);
  }
  return { title, lyrics: lines.join('\n').trim() };
}

function parseUsr(text, name) {
  const get = (k) => (text.match(new RegExp('^' + k + '=(.*)$', 'mi')) || [])[1] || '';
  const fields = get('Fields').split('/t');
  const words = get('Words').split('/t');
  const lyrics = words.map((w, i) => `${fields[i] || ''}\n${w.split('/n').join('\n')}`.trim()).join('\n\n');
  return { title: get('Title') || name, author: get('Author').replace(/\|/g, ', '), copyright: get('Copyright'), ccli: (text.match(/\[S A(\d+)\]/) || [])[1] || '', lyrics };
}

function parseOpenLyrics(text, name) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const q = (sel) => doc.getElementsByTagName(sel);
  const title = q('title')[0]?.textContent || name;
  const author = [...q('author')].map((a) => a.textContent).join(', ');
  const verses = [...q('verse')].map((v) => {
    const nameAttr = v.getAttribute('name') || '';
    const lines = [...v.getElementsByTagName('lines')].map((l) => {
      const clone = l.cloneNode(true);
      [...clone.getElementsByTagName('br')].forEach((br) => br.replaceWith('\n'));
      [...clone.getElementsByTagName('chord')].forEach((c) => c.replaceWith(c.textContent || ''));
      [...clone.getElementsByTagName('comment')].forEach((c) => c.remove());
      return clone.textContent.split('\n').map((x) => x.trim()).join('\n').trim();
    });
    return { key: nameAttr, text: `${prettyLabel(nameAttr) || nameAttr}\n${lines.join('\n\n')}` };
  });
  const order = q('verseOrder')[0]?.textContent.trim().split(/\s+/) || [];
  const seq = order.length ? order.map((k) => verses.find((v) => v.key === k)).filter(Boolean) : verses;
  const uniq = [...new Set(seq)];
  return {
    title, author, copyright: q('copyright')[0]?.textContent || '', ccli: q('ccliNo')[0]?.textContent || '',
    key: q('key')[0]?.textContent || '', lyrics: uniq.map((v) => v.text).join('\n\n'),
  };
}

function parseChordPro(text, name) {
  let title = name, author = '', copyright = '', ccli = '', key = '';
  const out = [];
  for (let line of text.replace(/\r/g, '').split('\n')) {
    const d = line.match(/^\s*\{\s*([a-z_]+)\s*(?::\s*(.*?))?\s*\}\s*$/i);
    if (d) {
      const k = d[1].toLowerCase(), v = d[2] || '';
      if (k === 'title' || k === 't') title = v;
      else if (k === 'artist' || k === 'subtitle' || k === 'st' || k === 'composer') author ||= v;
      else if (k === 'copyright') copyright = v;
      else if (k === 'ccli') ccli = v;
      else if (k === 'key') key = v;
      else if (['comment', 'c', 'ci', 'comment_italic'].includes(k)) { out.push('', v); }
      else if (k === 'soc' || k === 'start_of_chorus') out.push('', 'Chorus');
      else if (k === 'sov' || k === 'start_of_verse') out.push('', v || 'Verse');
      else if (k === 'sob' || k === 'start_of_bridge') out.push('', 'Bridge');
      continue;
    }
    if (/^\s*#/.test(line)) continue;
    out.push(line.replace(/\[[^\]]*\]/g, '').replace(/\s{2,}/g, ' ').trimEnd());
  }
  return { title, author, copyright, ccli, key, lyrics: out.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

// ------------------------------------------------ editor ------------------------------------------------
export function openSongEditor(song, { themes, onSave }) {
  const s = { title: '', author: '', copyright: '', ccli: '', key: '', tags: '', lyrics: '', themeId: '', ...song };
  const isNew = !song || !song.id;
  const slidesBox = h('div', { class: 'song-slides' });
  const renderSlides = () => {
    slidesBox.innerHTML = '';
    const slides = lyricsToSlides(s.lyrics);
    if (!slides.length) slidesBox.appendChild(h('div', { class: 'muted pad' }, 'Type lyrics on the left. Separate slides with a blank line and put section names (Verse 1, Chorus, Bridge…) on their own line.'));
    slides.forEach((sl) => slidesBox.appendChild(h('div', { class: 'song-slide' }, h('div', { class: 'song-slide-label' }, sl.label), h('div', { class: 'song-slide-text' }, sl.text))));
  };
  const field = (label, key, attrs = {}) => h('label', { class: 'fld' }, h('span', null, label),
    h('input', { type: 'text', value: s[key] || '', oninput: (e) => { s[key] = e.target.value; }, ...attrs }));
  const ta = h('textarea', { class: 'lyrics-input', spellcheck: true, oninput: (e) => { s.lyrics = e.target.value; renderSlides(); } }, s.lyrics);
  const insert = (label) => {
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos), after = ta.value.slice(pos);
    const pre = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
    ta.value = before + pre + label + '\n' + after;
    ta.selectionStart = ta.selectionEnd = (before + pre + label + '\n').length;
    ta.focus(); s.lyrics = ta.value; renderSlides();
  };
  const labels = ['Verse 1', 'Verse 2', 'Verse 3', 'Verse 4', 'Chorus', 'Pre-Chorus', 'Bridge', 'Tag', 'Ending'];
  const body = h('div', { class: 'song-editor' },
    h('div', { class: 'song-meta' },
      field('Title', 'title', { placeholder: 'Song title' }), field('Author', 'author'), field('Copyright', 'copyright'),
      field('CCLI #', 'ccli'), field('Key', 'key'), field('Tags', 'tags', { placeholder: 'worship, communion…' }),
      h('label', { class: 'fld' }, h('span', null, 'Theme'), h('select', { onchange: (e) => { s.themeId = e.target.value; } },
        h('option', { value: '' }, '(default song theme)'),
        themes.map((t) => h('option', { value: t.id, selected: t.id === s.themeId }, t.name))))),
    h('div', { class: 'song-labels' }, h('span', { class: 'muted' }, 'Insert:'), labels.map((l) => h('button', { class: 'btn xs', onclick: () => insert(l) }, l)),
      h('button', { class: 'btn xs', title: 'Split long sections into 2-line slides', onclick: () => { ta.value = autoSplit(ta.value, 2); s.lyrics = ta.value; renderSlides(); } }, 'Split every 2 lines'),
      h('button', { class: 'btn xs', title: 'Split long sections into 4-line slides', onclick: () => { ta.value = autoSplit(ta.value, 4); s.lyrics = ta.value; renderSlides(); } }, '4 lines')),
    h('div', { class: 'song-body' }, ta, slidesBox));
  renderSlides();
  modal({
    title: isNew ? 'New Song' : 'Edit Song — ' + s.title, body, width: 'min(1100px, 94vw)', className: 'tall',
    buttons: [{ label: 'Cancel' }, {
      label: 'Save', primary: true, onClick: () => {
        if (!s.title.trim()) { toast('Please give the song a title', 'warn'); return false; }
        onSave(s);
      },
    }],
  });
}

function autoSplit(lyrics, n) {
  return String(lyrics).replace(/\r/g, '').split(/\n\s*\n/).map((block) => {
    const lines = block.split('\n');
    const label = LABEL_RE.test(lines[0]) ? lines.shift() : null;
    const chunks = [];
    for (let i = 0; i < lines.length; i += n) chunks.push(lines.slice(i, i + n).join('\n'));
    return (label ? label + '\n' : '') + chunks.join('\n\n');
  }).join('\n\n');
}

export async function exportSongs(songs) {
  const p = await window.api.dialog.save({ defaultPath: 'songs-backup.json', filters: [{ name: 'Song library', extensions: ['json'] }] });
  if (!p) return;
  await window.api.fs.writeText(p, JSON.stringify({ app: 'Sanctuary Studio', exported: new Date().toISOString(), songs }, null, 1));
  toast(`Exported ${songs.length} songs`);
}

export async function runSongImport(library, onDone) {
  const choice = await new Promise((resolve) => {
    modal({
      title: 'Import songs', width: 520,
      body: h('div', { class: 'import-help' },
        h('p', null, 'Supported formats:'),
        h('ul', null,
          h('li', null, h('b', null, 'EasyWorship 6/7'), ' — pick the ', h('code', null, 'Songs.db'), ' file (usually in ', h('code', null, 'Documents\\Softouch\\EasyWorship\\Default\\Databases\\Data'), ') or an ', h('code', null, '.ewsx'), ' export'),
          h('li', null, h('b', null, 'Text files'), ' (.txt) — one song per file, CCLI SongSelect text supported'),
          h('li', null, h('b', null, 'SongSelect'), ' (.usr), ', h('b', null, 'OpenLyrics'), ' (.xml, OpenLP/Worship Extreme), ', h('b', null, 'ChordPro'), ' (.cho/.pro)'),
          h('li', null, h('b', null, 'Sanctuary Studio backup'), ' (.json)'))),
      buttons: [
        { label: 'Cancel' },
        { label: 'EasyWorship database…', onClick: () => resolve('ew') },
        { label: 'Song files…', primary: true, onClick: () => resolve('files') },
      ],
      onClose: () => resolve(null),
    });
  });
  if (!choice) return;
  const paths = choice === 'ew'
    ? await window.api.dialog.open({ title: 'EasyWorship Songs.db or .ewsx', filters: [{ name: 'EasyWorship', extensions: ['db', 'ewsx'] }] })
    : await window.api.dialog.open({ multi: true, filters: [{ name: 'Songs', extensions: ['txt', 'usr', 'xml', 'cho', 'chopro', 'chordpro', 'pro', 'json', 'db', 'ewsx'] }] });
  if (!paths.length) return;
  toast('Importing…');
  const { songs, errors } = await importSongFiles(paths).catch((e) => ({ songs: [], errors: [e.message] }));
  if (!songs.length) { toast(errors[0] || 'No songs found', 'error', 7000); return; }
  const dup = await confirmDialog(`Found ${songs.length} song(s). Skip songs whose title already exists in your library?`, { title: 'Import', ok: 'Skip duplicates' });
  const r = library.addMany(songs, dup);
  toast(`Imported ${r.added} song(s)` + (r.skipped ? `, skipped ${r.skipped} duplicate(s)` : '') + (errors.length ? `. ${errors.length} file(s) failed.` : ''), errors.length ? 'warn' : 'ok', 6000);
  if (errors.length) console.warn(errors);
  onDone && onDone();
}

const SAMPLE_SONGS = [
  {
    title: 'Amazing Grace', author: 'John Newton', copyright: 'Public Domain', ccli: '22025', key: 'G', tags: 'hymn',
    lyrics: `Verse 1
Amazing grace how sweet the sound
That saved a wretch like me
I once was lost but now am found
Was blind but now I see

Verse 2
'Twas grace that taught my heart to fear
And grace my fears relieved
How precious did that grace appear
The hour I first believed

Verse 3
Through many dangers toils and snares
I have already come
'Tis grace hath brought me safe thus far
And grace will lead me home

Verse 4
When we've been there ten thousand years
Bright shining as the sun
We've no less days to sing God's praise
Than when we'd first begun`,
  },
  {
    title: 'Holy, Holy, Holy', author: 'Reginald Heber', copyright: 'Public Domain', key: 'D', tags: 'hymn',
    lyrics: `Verse 1
Holy, holy, holy! Lord God Almighty!
Early in the morning our song shall rise to Thee
Holy, holy, holy! Merciful and mighty!
God in three Persons, blessed Trinity!

Verse 2
Holy, holy, holy! All the saints adore Thee
Casting down their golden crowns around the glassy sea
Cherubim and seraphim falling down before Thee
Which wert, and art, and evermore shalt be

Verse 3
Holy, holy, holy! Lord God Almighty!
All Thy works shall praise Thy name in earth and sky and sea
Holy, holy, holy! Merciful and mighty!
God in three Persons, blessed Trinity!`,
  },
  {
    title: 'Doxology', author: 'Thomas Ken', copyright: 'Public Domain', key: 'G', tags: 'hymn, offering',
    lyrics: `Chorus
Praise God from whom all blessings flow
Praise Him all creatures here below
Praise Him above ye heavenly host
Praise Father, Son and Holy Ghost

Ending
Amen`,
  },
];
