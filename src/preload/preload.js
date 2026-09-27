const { contextBridge, ipcRenderer, webUtils } = require('electron');

const inv = async (ch, ...a) => {
  const r = await ipcRenderer.invoke(ch, ...a);
  if (r && typeof r === 'object' && r.__error) throw new Error(r.__error);
  return r;
};
const on = (ch, fn) => {
  const h = (e, p) => fn(p);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('api', {
  store: { read: (n, f) => inv('store:read', n, f), write: (n, d) => inv('store:write', n, d) },
  secrets: { read: () => inv('secrets:read'), write: (k, v) => inv('secrets:write', k, v) },
  dialog: { open: (o) => inv('dialog:open', o), save: (o) => inv('dialog:save', o) },
  fs: {
    readText: (p) => inv('fs:readText', p), writeText: (p, t) => inv('fs:writeText', p, t),
    exists: (p) => inv('fs:exists', p), listDir: (d, e) => inv('fs:listDir', d, e),
  },
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  paths: () => inv('app:paths'),
  showItem: (p) => inv('shell:show', p),
  openExternal: (u) => inv('shell:open', u),
  setBusy: (b) => inv('app:busy', b),
  onQuitRequested: (fn) => on('app:quitRequested', fn),
  version: () => inv('app:version'),
  update: {
    status: () => inv('update:status'), check: () => inv('update:check'),
    download: () => inv('update:download'), install: () => inv('update:install'),
    onStatus: (fn) => on('update:status', fn),
  },
  metrics: () => inv('app:metrics'),
  bibles: {
    list: () => inv('bibles:list'), load: (f) => inv('bibles:load', f),
    save: (b) => inv('bibles:save', b), remove: (f) => inv('bibles:delete', f),
  },
  songs: { importEW: (p) => inv('songs:importEW', p) },
  output: {
    displays: () => inv('displays:list'),
    setTarget: (t) => inv('output:target', t),
    identify: () => inv('output:identify'),
    state: (s) => ipcRenderer.send('output:state', s),
    media: (c) => ipcRenderer.send('output:media', c),
    onStatus: (fn) => on('output:status', fn),
    onMediaStatus: (fn) => on('output:mediaStatus', fn),
    netStart: (port, lan) => inv('net:start', port, lan),
    netStop: () => inv('net:stop'),
  },
  capture: {
    sources: (types) => inv('capture:sources', types),
    select: (id, audio) => inv('capture:select', id, audio),
  },
  ffmpeg: { detect: () => inv('ffmpeg:detect'), setPath: (p) => inv('ffmpeg:setPath', p) },
  stream: {
    start: (cfg) => inv('stream:start', cfg),
    data: (buf) => ipcRenderer.send('stream:data', buf),
    stop: () => inv('stream:stop'),
    retry: (id) => inv('stream:retry', id),
    dropDest: (id) => inv('stream:dropDest', id),
    onStatus: (fn) => on('stream:status', fn),
    onError: (fn) => on('stream:error', fn),
  },
  record: {
    start: (cfg) => inv('record:start', cfg),
    data: (buf) => ipcRenderer.send('record:data', buf),
    stop: () => inv('record:stop'),
    onStatus: (fn) => on('record:status', fn),
  },
  hotkeys: { setGlobal: (m) => inv('hotkeys:global', m), onHotkey: (fn) => on('hotkey', fn) },
});
