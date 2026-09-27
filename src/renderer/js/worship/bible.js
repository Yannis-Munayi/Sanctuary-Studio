// Bible data, reference parsing and translation import.

// [name, osis code, extra aliases]
const BOOK_DEFS = [
  ['Genesis', 'Gen', 'gn ge'], ['Exodus', 'Exod', 'ex exo'], ['Leviticus', 'Lev', 'lv le'], ['Numbers', 'Num', 'nm nu nb'], ['Deuteronomy', 'Deut', 'dt de'],
  ['Joshua', 'Josh', 'jos jsh'], ['Judges', 'Judg', 'jdg jg jdgs'], ['Ruth', 'Ruth', 'rth ru'], ['1 Samuel', '1Sam', '1sa 1sm 1s'], ['2 Samuel', '2Sam', '2sa 2sm 2s'],
  ['1 Kings', '1Kgs', '1ki 1kg 1k'], ['2 Kings', '2Kgs', '2ki 2kg 2k'], ['1 Chronicles', '1Chr', '1ch 1chron'], ['2 Chronicles', '2Chr', '2ch 2chron'], ['Ezra', 'Ezra', 'ezr'],
  ['Nehemiah', 'Neh', 'ne'], ['Esther', 'Esth', 'est es'], ['Job', 'Job', 'jb'], ['Psalms', 'Ps', 'psa psalm pss psm ps'], ['Proverbs', 'Prov', 'pr prv pro'],
  ['Ecclesiastes', 'Eccl', 'ec ecc qoh'], ['Song of Solomon', 'Song', 'sos so sng canticles songofsongs song of songs'], ['Isaiah', 'Isa', 'is'], ['Jeremiah', 'Jer', 'je jr'], ['Lamentations', 'Lam', 'la'],
  ['Ezekiel', 'Ezek', 'eze ezk'], ['Daniel', 'Dan', 'dn da'], ['Hosea', 'Hos', 'ho'], ['Joel', 'Joel', 'jl'], ['Amos', 'Amos', 'am'],
  ['Obadiah', 'Obad', 'ob oba'], ['Jonah', 'Jonah', 'jon jnh'], ['Micah', 'Mic', 'mc'], ['Nahum', 'Nah', 'na'], ['Habakkuk', 'Hab', 'hb'],
  ['Zephaniah', 'Zeph', 'zep zp'], ['Haggai', 'Hag', 'hg'], ['Zechariah', 'Zech', 'zec zc'], ['Malachi', 'Mal', 'ml'],
  ['Matthew', 'Matt', 'mt mat'], ['Mark', 'Mark', 'mk mrk mr'], ['Luke', 'Luke', 'lk lu'], ['John', 'John', 'jn jhn joh'], ['Acts', 'Acts', 'ac act'],
  ['Romans', 'Rom', 'ro rm'], ['1 Corinthians', '1Cor', '1co'], ['2 Corinthians', '2Cor', '2co'], ['Galatians', 'Gal', 'ga'], ['Ephesians', 'Eph', 'ep'],
  ['Philippians', 'Phil', 'php pp'], ['Colossians', 'Col', 'co'], ['1 Thessalonians', '1Thess', '1th 1thes'], ['2 Thessalonians', '2Thess', '2th 2thes'], ['1 Timothy', '1Tim', '1ti 1tm'],
  ['2 Timothy', '2Tim', '2ti 2tm'], ['Titus', 'Titus', 'ti tit'], ['Philemon', 'Phlm', 'phm philem pm'], ['Hebrews', 'Heb', 'he'], ['James', 'Jas', 'jm ja jms'],
  ['1 Peter', '1Pet', '1pe 1pt 1p'], ['2 Peter', '2Pet', '2pe 2pt 2p'], ['1 John', '1John', '1jn 1jo 1j'], ['2 John', '2John', '2jn 2jo 2j'], ['3 John', '3John', '3jn 3jo 3j'],
  ['Jude', 'Jude', 'jud jd'], ['Revelation', 'Rev', 're rv revelations apocalypse'],
];

export const BOOKS = BOOK_DEFS.map(([name, osis, aliases], i) => ({ index: i, name, osis, aliases: aliases.split(' ') }));

const norm = (s) => String(s).toLowerCase()
  .replace(/^(iii|3rd|third)\s*/, '3').replace(/^(ii|2nd|second)\s*/, '2').replace(/^(i|1st|first)\s+(?=[a-z])/, '1')
  .replace(/[^a-z0-9]/g, '');

const LOOKUP = new Map();
for (const b of BOOKS) {
  LOOKUP.set(norm(b.name), b.index);
  LOOKUP.set(norm(b.osis), b.index);
  for (const a of b.aliases) LOOKUP.set(norm(a), b.index);
}

export function findBook(text) {
  const n = norm(text);
  if (!n) return -1;
  if (LOOKUP.has(n)) return LOOKUP.get(n);
  // prefix match against full names (first match in canonical order, but prefer exact-number books)
  const cands = BOOKS.filter((b) => norm(b.name).startsWith(n));
  if (cands.length) return cands[0].index;
  const c2 = BOOKS.filter((b) => b.aliases.some((a) => norm(a).startsWith(n)));
  return c2.length ? c2[0].index : -1;
}

export function bookSuggestions(text) {
  const n = norm(text);
  if (!n) return [];
  return BOOKS.filter((b) => norm(b.name).startsWith(n) || b.aliases.some((a) => norm(a) === n)).slice(0, 8);
}

// Parse "John 3:16-18", "jn 3 16", "1 cor 13:4-7", "Ps 23", "Gen 1:1-2:3", "Rom 8:28,31-32"
// Returns { book, chapter, ranges: [[c1,v1,c2,v2], ...], partial } or null
export function parseReference(input) {
  const s = String(input || '').trim().replace(/\s+/g, ' ');
  const m = s.match(/^((?:[1-3]|i{1,3})\s*[a-z][a-z .]*?|[a-z][a-z .]*?)\s*(\d+)?(?:\s*[:. ]\s*(\d+))?(?:\s*[-–]\s*(\d+)(?:\s*[:.]\s*(\d+))?)?((?:\s*,\s*\d+(?:\s*[-–]\s*\d+)?)*)\s*$/i);
  if (!m) {
    const b = findBook(s);
    return b >= 0 ? { book: b, chapter: 1, ranges: [], partial: true } : null;
  }
  const book = findBook(m[1].trim());
  if (book < 0) return null;
  const chapter = m[2] ? Number(m[2]) : 1;
  const ranges = [];
  if (m[3]) {
    const v1 = Number(m[3]);
    if (m[4] && m[5]) ranges.push([chapter, v1, Number(m[4]), Number(m[5])]);
    else if (m[4]) ranges.push([chapter, v1, chapter, Number(m[4])]);
    else ranges.push([chapter, v1, chapter, v1]);
    if (m[6]) {
      for (const part of m[6].split(',').map((x) => x.trim()).filter(Boolean)) {
        const [a, b] = part.split(/[-–]/).map((x) => Number(x.trim()));
        const endC = ranges.at(-1)[2];
        ranges.push([endC, a, endC, b || a]);
      }
    }
  } else if (m[4] && !m[3]) {
    // "Ps 23-24" -> whole chapters
    ranges.push([chapter, 1, Number(m[4]), 999]);
  }
  return { book, chapter, ranges, partial: !m[2] || !m[3] };
}

export function formatRef(book, chapter, v1, v2, c2) {
  const name = BOOKS[book].name;
  if (v1 == null) return `${name} ${chapter}`;
  if (c2 && c2 !== chapter) return `${name} ${chapter}:${v1}-${c2}:${v2}`;
  if (v2 && v2 !== v1) return `${name} ${chapter}:${v1}-${v2}`;
  return `${name} ${chapter}:${v1}`;
}

// ------------------------------------------------ translations ------------------------------------------------
export class BibleLibrary {
  constructor() { this.list = []; this.cache = new Map(); }

  async refresh() { this.list = await window.api.bibles.list(); return this.list; }

  async get(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const entry = this.list.find((b) => b.id === id) || this.list[0];
    if (!entry) return null;
    if (this.cache.has(entry.id)) return this.cache.get(entry.id);
    const data = JSON.parse(await window.api.bibles.load(entry.file));
    data.id = entry.id;
    this.cache.set(entry.id, data);
    return data;
  }

  // verses for a parsed reference -> [{ book, chapter, verse, text }]
  passage(bible, ref) {
    const out = [];
    const bk = bible.books[ref.book];
    if (!bk) return out;
    const ranges = ref.ranges.length ? ref.ranges : [[ref.chapter, 1, ref.chapter, 999]];
    for (const [c1, v1, c2, v2] of ranges) {
      for (let c = c1; c <= Math.min(c2, bk.length); c++) {
        const ch = bk[c - 1] || [];
        const start = c === c1 ? v1 : 1;
        const end = c === c2 ? Math.min(v2, ch.length) : ch.length;
        for (let v = start; v <= end; v++) if (ch[v - 1] != null) out.push({ book: ref.book, chapter: c, verse: v, text: ch[v - 1] });
      }
    }
    return out;
  }

  search(bible, query, limit = 300) {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    if (!words.length) return [];
    const phrase = query.toLowerCase().trim();
    const out = [];
    bible.books.forEach((bk, b) => bk.forEach((ch, c) => ch.forEach((t, v) => {
      if (out.length >= limit) return;
      const low = t.toLowerCase();
      if (low.includes(phrase) || words.every((w) => low.includes(w))) out.push({ book: b, chapter: c + 1, verse: v + 1, text: t });
    })));
    return out;
  }
}

// ------------------------------------------------ importers ------------------------------------------------
const OSIS_INDEX = new Map(BOOKS.map((b) => [b.osis.toLowerCase(), b.index]));

function emptyBooks() { return BOOKS.map(() => []); }
function put(books, b, c, v, text) {
  if (b < 0 || b > 65 || !c || !v) return;
  const ch = (books[b][c - 1] ||= []);
  ch[v - 1] = String(text).replace(/\s+/g, ' ').trim();
}
function finalize(books) {
  return books.map((bk) => { const chs = Array.from(bk, (ch) => Array.from(ch || [], (v) => v || '')); return chs; });
}

export function importBibleText(text, filename) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return importJson(JSON.parse(trimmed), filename);
  const doc = new DOMParser().parseFromString(trimmed, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Not a valid XML or JSON Bible file.');
  const root = doc.documentElement;
  if (root.tagName.toUpperCase() === 'XMLBIBLE') return importZefania(doc, filename);
  if (doc.getElementsByTagName('osisText').length || root.tagName === 'osis') return importOsis(doc, filename);
  if (root.tagName.toLowerCase() === 'bible') return importOpenSong(doc, filename);
  throw new Error('Unrecognised Bible format. Supported: Zefania XML, OSIS XML, OpenSong XML, JSON.');
}

function idFromName(filename) { return String(filename || 'BIBLE').replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase() || 'BIBLE'; }

function importZefania(doc, filename) {
  const books = emptyBooks();
  const root = doc.documentElement;
  const title = doc.querySelector('INFORMATION title, information title')?.textContent || root.getAttribute('biblename') || filename;
  const abbr = doc.querySelector('INFORMATION identifier, information identifier')?.textContent || idFromName(filename);
  for (const b of doc.getElementsByTagName('BIBLEBOOK')) {
    let bi = Number(b.getAttribute('bnumber')) - 1;
    if (!(bi >= 0 && bi < 66)) bi = findBook(b.getAttribute('bname') || b.getAttribute('bsname') || '');
    for (const c of b.getElementsByTagName('CHAPTER')) {
      const cn = Number(c.getAttribute('cnumber'));
      for (const v of c.getElementsByTagName('VERS')) put(books, bi, cn, Number(v.getAttribute('vnumber')), v.textContent);
    }
  }
  return { id: abbr.toUpperCase().slice(0, 10), name: title.trim(), books: finalize(books) };
}

function importOsis(doc, filename) {
  const books = emptyBooks();
  const work = doc.querySelector('work title');
  const verses = doc.getElementsByTagName('verse');
  for (const v of verses) {
    const id = v.getAttribute('osisID');
    if (!id) continue; // milestone end markers
    for (const one of id.split(' ')) {
      const [bk, c, vn] = one.split('.');
      const bi = OSIS_INDEX.get(String(bk).toLowerCase()) ?? findBook(bk);
      let text = v.textContent;
      // milestoned verses: collect text until eID
      if (!text.trim() && v.getAttribute('sID')) {
        text = '';
        let n = v.nextSibling;
        while (n && !(n.nodeType === 1 && n.tagName === 'verse' && n.getAttribute('eID'))) { text += n.textContent || ''; n = n.nextSibling; }
      }
      put(books, bi, Number(c), Number(vn), text);
    }
  }
  const idText = doc.querySelector('osisText')?.getAttribute('osisIDWork') || idFromName(filename);
  return { id: idText.toUpperCase().slice(0, 10), name: (work && work.textContent) || idText, books: finalize(books) };
}

function importOpenSong(doc, filename) {
  const books = emptyBooks();
  let order = 0;
  for (const b of doc.getElementsByTagName('b')) {
    let bi = findBook(b.getAttribute('n') || '');
    if (bi < 0) bi = order;
    order++;
    for (const c of b.getElementsByTagName('c')) {
      const cn = Number(c.getAttribute('n'));
      for (const v of c.getElementsByTagName('v')) put(books, bi, cn, Number(v.getAttribute('n')), v.textContent);
    }
  }
  return { id: idFromName(filename), name: doc.documentElement.getAttribute('n') || filename, books: finalize(books) };
}

function importJson(j, filename) {
  // Our own format
  if (j && Array.isArray(j.books) && Array.isArray(j.books[0]) && Array.isArray(j.books[0][0])) return { id: j.id || idFromName(filename), name: j.name || filename, books: j.books };
  // [{ abbrev, chapters: [[verses]] }]
  if (Array.isArray(j) && j[0] && Array.isArray(j[0].chapters)) return { id: idFromName(filename), name: filename, books: j.map((b) => b.chapters) };
  // { books: [{ name, chapters: [{ chapter, verses: [{ verse, text }] }] }] }
  if (j && Array.isArray(j.books) && j.books[0] && j.books[0].chapters) {
    const books = emptyBooks();
    j.books.forEach((b, i) => {
      const bi = findBook(b.name || '') >= 0 ? findBook(b.name) : i;
      b.chapters.forEach((c, ci) => (c.verses || c).forEach((v, vi) => put(books, bi, c.chapter || ci + 1, v.verse || vi + 1, v.text ?? v)));
    });
    return { id: (j.translation || idFromName(filename)).split(':')[0].trim().slice(0, 10), name: j.translation || filename, books: finalize(books) };
  }
  // flat [{ book_name|book, chapter, verse, text }]
  const rows = Array.isArray(j) ? j : j.verses;
  if (Array.isArray(rows) && rows[0] && rows[0].text != null) {
    const books = emptyBooks();
    for (const r of rows) {
      const bi = typeof r.book === 'number' ? r.book - 1 : findBook(r.book_name || r.book || '');
      put(books, bi, Number(r.chapter), Number(r.verse), r.text);
    }
    return { id: idFromName(filename), name: j.name || filename, books: finalize(books) };
  }
  throw new Error('Unrecognised JSON Bible layout.');
}
