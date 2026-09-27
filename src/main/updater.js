// Auto-update from GitHub Releases (github.com/Yannis-Munayi/Sanctuary-Studio).
// Checks quietly at startup and every few hours; nothing is downloaded or installed
// without the operator clicking, and never while streaming/recording.
const { app } = require('electron');

let autoUpdater = null;
let send = () => {};
let lastStatus = { state: 'idle', current: app.getVersion() };
let isBusy = () => false;

function status(s) {
  lastStatus = { current: app.getVersion(), ...s };
  send('update:status', lastStatus);
}

function notesText(n) {
  if (!n) return '';
  const raw = Array.isArray(n) ? n.map((x) => `${x.version}:\n${x.note || ''}`).join('\n\n') : String(n);
  return raw.replace(/<\/(p|li|h\d)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<li>/gi, '• ').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
}

function init(sendFn, busyFn) {
  send = sendFn;
  isBusy = busyFn;
  if (!app.isPackaged) { lastStatus = { state: 'dev', current: app.getVersion() }; return; }
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('checking-for-update', () => status({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => status({ state: 'none' }));
  autoUpdater.on('update-available', (info) => status({ state: 'available', version: info.version, notes: notesText(info.releaseNotes), date: info.releaseDate }));
  autoUpdater.on('download-progress', (p) => status({ ...lastStatus, state: 'downloading', percent: Math.round(p.percent), speed: p.bytesPerSecond }));
  autoUpdater.on('update-downloaded', (info) => status({ state: 'downloaded', version: info.version, notes: notesText(info.releaseNotes) }));
  autoUpdater.on('error', (e) => {
    // Offline at church is normal — report quietly
    const offline = /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|net::ERR|getaddrinfo/i.test(String(e && e.message));
    status({ state: 'error', offline, message: offline ? 'No internet connection' : String((e && e.message) || e).split('\n')[0] });
  });
  setTimeout(check, 15000);
  setInterval(check, 4 * 60 * 60 * 1000);
}

function check() {
  if (!autoUpdater) return lastStatus;
  if (['downloading', 'downloaded'].includes(lastStatus.state)) return lastStatus;
  autoUpdater.checkForUpdates().catch(() => {});
  return lastStatus;
}

function download() {
  if (!autoUpdater) return false;
  status({ ...lastStatus, state: 'downloading', percent: 0 });
  autoUpdater.downloadUpdate().catch(() => {});
  return true;
}

function install() {
  if (!autoUpdater || lastStatus.state !== 'downloaded') return { ok: false, error: 'No update downloaded yet' };
  if (isBusy()) return { ok: false, error: 'Stop the stream / recording first' };
  // silent install, then relaunch the new version
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return { ok: true };
}

module.exports = { init, check, download, install, get: () => lastStatus };
