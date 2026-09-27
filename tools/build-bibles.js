// Downloads public-domain translations and converts them to the app's compact format:
// { id, name, books: [ [ [verse1, verse2, ...], ...chapters ], ...66 books ] }
// Usage: node tools/build-bibles.js
const fs = require('fs');
const path = require('path');

const SRC = 'https://raw.githubusercontent.com/scrollmapper/bible_databases/master/formats/json/';
const TRANSLATIONS = [
  { id: 'KJV', name: 'King James Version' },
  { id: 'ASV', name: 'American Standard Version' },
  { id: 'BBE', name: 'Bible in Basic English' },
  { id: 'YLT', name: "Young's Literal Translation" },
];

const clean = (t) => String(t)
  .replace(/\s*\[Selah\]?\s*$/i, ' Selah')
  .replace(/\[([^\]]*)\]/g, '$1')
  .replace(/\s+/g, ' ')
  .trim();

(async () => {
  const out = path.join(__dirname, '..', 'assets', 'bibles');
  fs.mkdirSync(out, { recursive: true });
  for (const t of TRANSLATIONS) {
    process.stdout.write(`Downloading ${t.id}... `);
    const res = await fetch(SRC + t.id + '.json');
    if (!res.ok) { console.log('failed', res.status); continue; }
    const j = await res.json();
    if (j.books.length !== 66) { console.log('unexpected book count', j.books.length); continue; }
    const books = j.books.map((b) => b.chapters.map((c) => c.verses.map((v) => clean(v.text))));
    fs.writeFileSync(path.join(out, t.id.toLowerCase() + '.json'), JSON.stringify({ id: t.id, name: t.name, books }));
    console.log('ok');
  }
})();
