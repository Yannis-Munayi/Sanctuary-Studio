const { app, BrowserWindow, ipcMain, dialog, desktopCapturer, session, screen, shell, globalShortcut, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const ffmpeg = require('./ffmpeg');
const { Streamer } = require('./streamer');
const { Outputs } = require('./outputs');
const { NetServer } = require('./netserver');
const { importEasyWorship } = require('./ewimport');
const updater = require('./updater');

// Keep rendering/encoding at full speed even when the window is minimised or covered —
// otherwise Chromium throttles timers and the livestream freezes.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'MediaSessionService,HardwareMediaKeyHandling,CalculateNativeWinOcclusion');

app.setName('Sanctuary Studio');
if (process.env.SS_USERDATA) app.setPath('userData', process.env.SS_USERDATA); // isolated profile for testing
const ROOT = path.join(__dirname, '..', '..');
const BUNDLED_BIBLES = path.join(ROOT, 'assets', 'bibles');
const userBibles = () => path.join(app.getPath('userData'), 'bibles');

let mainWin = null;
let busy = false; // streaming or recording — confirm before quitting
let pendingCapture = null;
const send = (ch, payload) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(ch, payload); };
const streamer = new Streamer(send);
// Created after 'ready' — the screen module isn't available before that
let outputs = null;
let net = null;

function createMainWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  mainWin = new BrowserWindow({
    x: wa.x, y: wa.y, width: wa.width, height: wa.height, minWidth: 1100, minHeight: 640,
    backgroundColor: '#15171c', title: `Sanctuary Studio ${app.getVersion()}`, show: false, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required', spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  mainWin.maximize();
  mainWin.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') mainWin.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'r') mainWin.webContents.reloadIgnoringCache();
  });
  mainWin.on('close', (e) => {
    if (!busy) return;
    const r = dialog.showMessageBoxSync(mainWin, {
      type: 'warning', buttons: ['Keep running', 'Stop and quit'], defaultId: 0, cancelId: 0,
      title: 'Still live', message: 'You are still streaming or recording.', detail: 'Quitting will end the livestream / recording.',
    });
    e.preventDefault();
    if (r === 1) {
      // Let the renderer stop cleanly (finalises the recording), then close for real
      send('app:quitRequested');
      setTimeout(() => { busy = false; if (mainWin) mainWin.close(); }, 8000);
    }
  });
  mainWin.on('closed', () => { mainWin = null; outputs.closeAll(); streamer.shutdown(); net.stop(); app.quit(); });

  if (process.env.SS_DEBUG) {
    mainWin.webContents.on('console-message', (e) => {
      const { level, message, lineNumber, sourceId } = e;
      console.log(`[renderer:${level}] ${message}${sourceId ? ` (${path.basename(sourceId)}:${lineNumber})` : ''}`);
    });
  }
  if (process.env.SS_SCREENSHOT) {
    setTimeout(async () => {
      if (process.env.SS_TEST_SCRIPT) {
        try {
          const r = await mainWin.webContents.executeJavaScript(fs.readFileSync(process.env.SS_TEST_SCRIPT, 'utf8'));
          console.log('[test] ' + JSON.stringify(r));
        } catch (e) { console.log('[test] ERROR ' + e.message); }
      }
      const img = await mainWin.webContents.capturePage();
      fs.writeFileSync(process.env.SS_SCREENSHOT, img.toPNG());
      console.log('screenshot saved');
      if (!process.env.SS_KEEP) app.quit();
    }, Number(process.env.SS_DELAY || 6000));
  }
}

app.whenReady().then(() => {
  outputs = new Outputs((status) => send('output:status', status));
  net = new NetServer(outputs);
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(['media', 'display-capture', 'mediaKeySystem', 'fullscreen', 'speaker-selection', 'local-fonts'].includes(permission)));
  ses.setPermissionCheckHandler(() => true);
  // Display / window / desktop-audio capture: the renderer picks a source first (capture:select),
  // then calls getDisplayMedia; we hand back exactly that source.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const want = pendingCapture || { id: null, audio: false };
    pendingCapture = null;
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const src = sources.find((s) => s.id === want.id) || sources.find((s) => s.id.startsWith('screen')) || sources[0];
      const res = { video: src };
      if (want.audio) res.audio = 'loopback';
      callback(res);
    } catch (e) {
      callback({});
    }
  }, { useSystemPicker: false });
  createMainWindow();
  updater.init(send, () => busy);
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());

// ------------------------------------------------ IPC ------------------------------------------------
const handle = (ch, fn) => ipcMain.handle(ch, async (e, ...args) => {
  try { return await fn(...args); } catch (err) { console.error(ch, err); return { __error: err.message || String(err) }; }
});

handle('store:read', (name, fallback) => store.read(name, fallback));
handle('store:write', (name, data) => store.write(name, data));
handle('secrets:read', () => store.readSecrets());
handle('secrets:write', (key, value) => store.writeSecret(key, value));

handle('dialog:open', async (opts = {}) => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters,
    properties: [opts.directory ? 'openDirectory' : 'openFile', ...(opts.multi ? ['multiSelections'] : [])],
  });
  return r.canceled ? [] : r.filePaths;
});
handle('dialog:save', async (opts = {}) => {
  const r = await dialog.showSaveDialog(mainWin, { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters });
  return r.canceled ? '' : r.filePath;
});
handle('fs:readText', (p) => {
  const buf = fs.readFileSync(p);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.slice(2)); b.swap16(); return b.toString('utf16le'); }
  const s = buf.toString('utf8');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
});
handle('fs:writeText', (p, text) => { fs.writeFileSync(p, text, 'utf8'); return true; });
handle('fs:exists', (p) => !!p && fs.existsSync(p));
handle('fs:listDir', (dir, exts) => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => !exts || exts.includes(path.extname(f).toLowerCase())).map((f) => path.join(dir, f));
});
handle('app:paths', () => ({
  videos: app.getPath('videos'), documents: app.getPath('documents'), userData: app.getPath('userData'),
  pictures: app.getPath('pictures'), root: ROOT,
}));
handle('shell:show', (p) => shell.showItemInFolder(p));
handle('shell:open', (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
handle('app:busy', (b) => { busy = !!b; });
handle('app:version', () => ({ version: app.getVersion(), packaged: app.isPackaged }));
handle('update:status', () => updater.get());
handle('update:check', () => updater.check());
handle('update:download', () => updater.download());
handle('update:install', () => updater.install());
handle('app:metrics', () => {
  const m = app.getAppMetrics();
  const cpu = m.reduce((a, p) => a + (p.cpu ? p.cpu.percentCPUUsage : 0), 0);
  const mem = m.reduce((a, p) => a + (p.memory ? p.memory.workingSetSize : 0), 0);
  return { cpu: cpu / (require('os').cpus().length || 1), memMB: Math.round(mem / 1024) };
});

// ---- Bibles ----
handle('bibles:list', () => {
  const list = [];
  const add = (dir, builtin) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 300);
        const id = (head.match(/"id"\s*:\s*"([^"]+)"/) || [])[1] || path.basename(f, '.json').toUpperCase();
        const name = (head.match(/"name"\s*:\s*"([^"]+)"/) || [])[1] || id;
        if (!list.some((b) => b.id === id)) list.push({ id, name, builtin, file: path.join(dir, f) });
      } catch {}
    }
  };
  add(userBibles(), false);
  add(BUNDLED_BIBLES, true);
  return list;
});
handle('bibles:load', (file) => fs.readFileSync(file, 'utf8'));
handle('bibles:save', (bible) => {
  fs.mkdirSync(userBibles(), { recursive: true });
  const f = path.join(userBibles(), String(bible.id).replace(/[^a-z0-9_-]/gi, '_').toLowerCase() + '.json');
  fs.writeFileSync(f, JSON.stringify(bible));
  return f;
});
handle('bibles:delete', (file) => { if (file.startsWith(userBibles())) fs.unlinkSync(file); return true; });

handle('songs:importEW', (p) => importEasyWorship(p));

// ---- Worship outputs ----
handle('displays:list', () => outputs.status());
handle('output:target', (t) => outputs.setTarget(t));
handle('output:identify', () => outputs.identify());
ipcMain.on('output:state', (e, state) => outputs.setState(state));
ipcMain.on('output:media', (e, cmd) => outputs.mediaCommand(cmd));
ipcMain.on('output:mediaStatus', (e, st) => send('output:mediaStatus', st));
handle('net:start', (port, lan) => net.start(port, lan));
handle('net:stop', () => net.stop());

// ---- Capture ----
handle('capture:sources', async (types) => {
  const sources = await desktopCapturer.getSources({ types: types || ['screen', 'window'], thumbnailSize: { width: 240, height: 135 }, fetchWindowIcons: false });
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  return sources
    .filter((s) => !/^(Sanctuary Studio|Worship Output)$/.test(s.name))
    .map((s) => {
      const d = displays.find((x) => String(x.id) === s.display_id);
      return {
        id: s.id, name: s.name, displayId: s.display_id, thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
        primary: d ? d.id === primary.id : false, size: d ? `${Math.round(d.bounds.width * d.scaleFactor)}×${Math.round(d.bounds.height * d.scaleFactor)}` : '',
      };
    });
});
handle('capture:select', (id, audio) => { pendingCapture = { id, audio: !!audio }; return true; });

// ---- Streaming / recording ----
handle('ffmpeg:detect', () => ffmpeg.detectEncoders());
handle('ffmpeg:setPath', (p) => { ffmpeg.setOverride(p); return ffmpeg.detectEncoders(); });
handle('stream:start', (cfg) => {
  const keys = store.readSecrets();
  cfg.destinations = cfg.destinations.map((d) => ({ ...d, key: keys['key:' + d.id] || '' }));
  const missing = cfg.destinations.filter((d) => !d.key && !/rtmps?:\/\/[^/]+\/.+\/.+/.test(d.server));
  if (missing.length) return { ok: false, error: `Missing stream key for: ${missing.map((d) => d.name).join(', ')}` };
  return streamer.startStream(cfg);
});
ipcMain.on('stream:data', (e, buf) => streamer.streamData(buf));
handle('stream:stop', () => streamer.stopStream());
handle('stream:retry', (id) => streamer.retryDestination(id));
handle('stream:dropDest', (id) => streamer.stopDestination(id));

function recordFileName(dir, pattern, ext) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = (pattern || '%Y-%m-%d %H-%M-%S')
    .replace(/%Y/g, d.getFullYear()).replace(/%m/g, pad(d.getMonth() + 1)).replace(/%d/g, pad(d.getDate()))
    .replace(/%H/g, pad(d.getHours())).replace(/%M/g, pad(d.getMinutes())).replace(/%S/g, pad(d.getSeconds()))
    .replace(/[<>:"/\\|?*]/g, '-');
  fs.mkdirSync(dir, { recursive: true });
  let f = path.join(dir, `${name}.${ext}`);
  let n = 2;
  while (fs.existsSync(f)) f = path.join(dir, `${name} (${n++}).${ext}`);
  return f;
}
handle('record:start', (cfg) => {
  cfg.file = recordFileName(cfg.record.path || app.getPath('videos'), cfg.record.filename, cfg.record.format || 'mkv');
  return streamer.startRecord(cfg);
});
ipcMain.on('record:data', (e, buf) => streamer.recordData(buf));
handle('record:stop', () => streamer.stopRecord());

// ---- Global hotkeys ----
handle('hotkeys:global', (map) => {
  globalShortcut.unregisterAll();
  const failed = [];
  for (const [action, accel] of Object.entries(map || {})) {
    if (!accel) continue;
    try {
      const ok = globalShortcut.register(accel, () => send('hotkey', action));
      if (!ok) failed.push(accel);
    } catch { failed.push(accel); }
  }
  return failed;
});
