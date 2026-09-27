// JSON persistence in the user-data folder. Writes are atomic (tmp file + rename)
// so a crash mid-save never corrupts songs, scenes or settings.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const dataDir = () => path.join(app.getPath('userData'), 'data');
const safeName = (name) => String(name).replace(/[^a-z0-9_\-]/gi, '_');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function file(name) { return path.join(dataDir(), safeName(name) + '.json'); }

function read(name, fallback = null) {
  try {
    const p = file(name);
    if (!fs.existsSync(p)) {
      // Recover from an interrupted write
      if (fs.existsSync(p + '.bak')) return JSON.parse(fs.readFileSync(p + '.bak', 'utf8'));
      return fallback;
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('store read failed', name, e.message);
    try { return JSON.parse(fs.readFileSync(file(name) + '.bak', 'utf8')); } catch { return fallback; }
  }
}

function write(name, data) {
  ensureDir(dataDir());
  const p = file(name);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  if (fs.existsSync(p)) { try { fs.copyFileSync(p, p + '.bak'); } catch {} }
  fs.renameSync(tmp, p);
  return true;
}

// ---- Secrets (stream keys) — encrypted with Windows DPAPI via safeStorage ----
function readSecrets() {
  const raw = read('secrets', {});
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    try {
      out[k] = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(Buffer.from(v, 'base64'))
        : Buffer.from(v, 'base64').toString('utf8');
    } catch { out[k] = ''; }
  }
  return out;
}

function writeSecret(key, value) {
  const raw = read('secrets', {});
  if (!value) delete raw[key];
  else raw[key] = (safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(value)
    : Buffer.from(value, 'utf8')).toString('base64');
  write('secrets', raw);
}

module.exports = { read, write, readSecrets, writeSecret, dataDir, ensureDir };
