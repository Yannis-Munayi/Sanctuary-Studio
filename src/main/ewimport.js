// EasyWorship song import (EW 6 / EW 7 databases and .ewsx exports).
// EW stores songs in SQLite: Songs.db (table "song": title, author, copyright...) and
// SongWords.db (table "word": song_id, words as RTF). Schema is discovered dynamically so
// small differences between EW versions don't break the import.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let SQL = null;
async function sqlJs() {
  if (!SQL) SQL = await require('sql.js')();
  return SQL;
}

// ---------- RTF -> plain text (enough for EasyWorship lyric RTF) ----------
function rtfToText(rtf) {
  if (!rtf || !/^\s*\{\\rtf/.test(rtf)) return String(rtf || '');
  let out = '';
  const stack = [];
  let skip = false;
  let ucSkip = 1;
  let i = 0;
  const SKIP_DEST = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'listtable', 'listoverridetable', 'themedata', 'latentstyles', 'rsidtbl', 'generator', 'xmlnstbl']);
  while (i < rtf.length) {
    const ch = rtf[i];
    if (ch === '{') { stack.push(skip); i++; continue; }
    if (ch === '}') { skip = stack.pop() || false; i++; continue; }
    if (ch === '\\') {
      const next = rtf[i + 1];
      if (next === '\\' || next === '{' || next === '}') { if (!skip) out += next; i += 2; continue; }
      if (next === '*') { skip = true; i += 2; continue; }
      if (next === "'") {
        const hex = rtf.substr(i + 2, 2);
        if (!skip) out += Buffer.from([parseInt(hex, 16)]).toString('latin1');
        i += 4; continue;
      }
      if (next === '\n' || next === '\r') { if (!skip) out += '\n'; i += 2; continue; }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i, i + 40));
      if (!m) { i += 2; continue; }
      const word = m[1], arg = m[2];
      i += m[0].length;
      if (SKIP_DEST.has(word)) { skip = true; continue; }
      if (skip) continue;
      if (word === 'par' || word === 'line') out += '\n';
      else if (word === 'tab') out += '\t';
      else if (word === 'uc') ucSkip = Number(arg) || 1;
      else if (word === 'u') {
        let code = Number(arg); if (code < 0) code += 65536;
        out += String.fromCharCode(code);
        // skip fallback characters
        let n = ucSkip;
        while (n > 0 && i < rtf.length) {
          if (rtf[i] === '\\' && rtf[i + 1] === "'") { i += 4; } else if (rtf[i] === '{' || rtf[i] === '}') break; else i++;
          n--;
        }
      } else if (word === 'emdash') out += '—';
      else if (word === 'endash') out += '–';
      else if (word === 'lquote') out += '‘';
      else if (word === 'rquote') out += '’';
      else if (word === 'ldblquote') out += '“';
      else if (word === 'rdblquote') out += '”';
      continue;
    }
    if (ch === '\r' || ch === '\n') { i++; continue; }
    if (!skip) out += ch;
    i++;
  }
  return out.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- minimal zip reader (for .ewsx) ----------
function unzip(buf) {
  const files = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return files;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(local + 26), lxlen = buf.readUInt16LE(local + 28);
    const data = buf.slice(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
    try { files[name] = method === 8 ? zlib.inflateRawSync(data) : data; } catch {}
    p += 46 + nlen + xlen + clen;
  }
  return files;
}

function tablesWithColumns(db) {
  const res = {};
  const t = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
  for (const [name] of (t[0] ? t[0].values : [])) {
    const info = db.exec(`PRAGMA table_info("${name}")`);
    res[name] = info[0] ? info[0].values.map((r) => String(r[1]).toLowerCase()) : [];
  }
  return res;
}

function queryAll(db, sql) {
  const r = db.exec(sql);
  if (!r[0]) return [];
  const cols = r[0].columns.map((c) => c.toLowerCase());
  return r[0].values.map((row) => Object.fromEntries(row.map((v, i) => [cols[i], v])));
}

async function importEasyWorship(selected) {
  const S = await sqlJs();
  const dbs = [];
  const addDb = (buf) => { if (buf && buf.slice(0, 15).toString() === 'SQLite format 3') dbs.push(new S.Database(new Uint8Array(buf))); };

  const st = fs.statSync(selected);
  if (st.isDirectory()) {
    const candidates = [selected, path.join(selected, 'Databases', 'Data'), path.join(selected, 'Data')];
    for (const dir of candidates) {
      for (const f of ['Songs.db', 'SongWords.db']) {
        const p = path.join(dir, f);
        if (fs.existsSync(p)) addDb(fs.readFileSync(p));
      }
      if (dbs.length) break;
    }
  } else {
    const buf = fs.readFileSync(selected);
    if (buf.slice(0, 2).toString() === 'PK') {
      for (const [name, data] of Object.entries(unzip(buf))) if (/\.db$/i.test(name) || data.slice(0, 15).toString() === 'SQLite format 3') addDb(data);
    } else {
      addDb(buf);
      const dir = path.dirname(selected);
      for (const f of ['Songs.db', 'SongWords.db']) {
        const p = path.join(dir, f);
        if (fs.existsSync(p) && path.resolve(p) !== path.resolve(selected)) addDb(fs.readFileSync(p));
      }
    }
  }
  if (!dbs.length) throw new Error('No EasyWorship database found. Choose the EasyWorship "Databases\\Data" folder, Songs.db, or an .ewsx file.');

  // Find song + words tables across all databases
  let songs = null, words = null;
  for (const db of dbs) {
    const tables = tablesWithColumns(db);
    for (const [name, cols] of Object.entries(tables)) {
      if (!songs && cols.includes('title') && !cols.includes('words')) songs = { db, name, cols };
      if (!words && cols.includes('words')) words = { db, name, cols };
      if (!songs && cols.includes('title') && cols.includes('words')) { songs = { db, name, cols }; words = songs; }
    }
  }
  if (!songs) throw new Error('Could not find the song table in the EasyWorship database.');

  const songRows = queryAll(songs.db, `SELECT rowid AS _rid, * FROM "${songs.name}"`);
  const wordMap = new Map();
  if (words && words !== songs) {
    const fk = words.cols.find((c) => c === 'song_id') || words.cols.find((c) => /song/.test(c)) || 'rowid';
    for (const w of queryAll(words.db, `SELECT rowid AS _rid, * FROM "${words.name}"`)) {
      const key = String(w[fk] ?? w._rid);
      if (!wordMap.has(key)) wordMap.set(key, w.words);
    }
  }
  const out = [];
  for (const r of songRows) {
    const idKey = String(r.song_uid && wordMap.has(String(r.song_uid)) ? r.song_uid : (r.id ?? r._rid));
    const rtf = words === songs ? r.words : (wordMap.get(idKey) ?? wordMap.get(String(r._rid)));
    const lyrics = rtfToText(rtf || '');
    if (!r.title && !lyrics) continue;
    out.push({
      title: String(r.title || 'Untitled').trim(),
      author: String(r.author || '').trim(),
      copyright: String(r.copyright || '').trim(),
      ccli: String(r.reference_number || r.ccli_number || r.vendor_id || '').trim(),
      lyrics,
    });
  }
  dbs.forEach((d) => d.close());
  return out;
}

module.exports = { importEasyWorship, rtfToText };
