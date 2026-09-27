// Worship (lyrics/scripture) output windows — one fullscreen window per target display.
// Targets: 'off' | 'primary' | 'secondary' (every non-primary display) | 'display:<id>'
const { BrowserWindow, screen } = require('electron');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'renderer');

class Outputs {
  constructor(onChange) {
    this.target = 'off';
    this.windows = new Map(); // displayId -> BrowserWindow
    this.state = null;
    this.onChange = onChange;
    this.listeners = new Set(); // network output subscribers
    screen.on('display-added', () => this.apply());
    screen.on('display-removed', () => this.apply());
    screen.on('display-metrics-changed', () => this.apply());
  }

  displays() {
    const primary = screen.getPrimaryDisplay();
    return screen.getAllDisplays().map((d, i) => ({
      id: String(d.id), index: i + 1, primary: d.id === primary.id,
      label: d.label || `Display ${i + 1}`, bounds: d.bounds, scaleFactor: d.scaleFactor,
      size: `${Math.round(d.bounds.width * d.scaleFactor)}×${Math.round(d.bounds.height * d.scaleFactor)}`,
    }));
  }

  wantedDisplays() {
    const all = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const t = this.target;
    if (t === 'primary') return [primary];
    if (t === 'secondary') return all.filter((d) => d.id !== primary.id);
    if (t.startsWith('display:')) return all.filter((d) => String(d.id) === t.slice(8));
    return [];
  }

  setTarget(target) {
    this.target = target || 'off';
    this.apply();
    return this.status();
  }

  apply() {
    const wanted = this.wantedDisplays();
    const wantedIds = new Set(wanted.map((d) => String(d.id)));
    for (const [id, win] of this.windows) {
      if (!wantedIds.has(id) || win.isDestroyed()) { if (!win.isDestroyed()) win.destroy(); this.windows.delete(id); }
    }
    const primaryId = screen.getPrimaryDisplay().id;
    let first = true;
    for (const d of wanted) {
      const id = String(d.id);
      let win = this.windows.get(id);
      if (win && !win.isDestroyed()) {
        win.setBounds(d.bounds);
      } else {
        const isPrimary = d.id === primaryId;
        win = new BrowserWindow({
          x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
          frame: false, show: false, backgroundColor: '#000000', skipTaskbar: !isPrimary,
          focusable: isPrimary, // secondary outputs never steal focus from the operator
          alwaysOnTop: !isPrimary, fullscreenable: true, autoHideMenuBar: true, title: 'Worship Output',
          webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'output-preload.js'),
            contextIsolation: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
          },
        });
        win.loadFile(path.join(RENDERER, 'output.html'));
        win.once('ready-to-show', () => {
          win.setBounds(d.bounds);
          win.setFullScreen(true);
          if (!isPrimary) win.setAlwaysOnTop(true, 'screen-saver');
          win.showInactive();
        });
        win.webContents.on('did-finish-load', () => {
          if (this.state) win.webContents.send('output:state', this.state);
        });
        win.webContents.on('before-input-event', (e, input) => {
          if (input.type === 'keyDown' && input.key === 'Escape') { this.setTarget('off'); this.onChange && this.onChange(this.status()); }
        });
        win.on('closed', () => { if (this.windows.get(id) === win) this.windows.delete(id); });
        this.windows.set(id, win);
      }
      // Only the first output plays video audio — otherwise two monitors = doubled sound
      win.__audioMaster = first;
      first = false;
      if (win.webContents && !win.webContents.isLoading()) win.webContents.send('output:role', { audio: win.__audioMaster });
      else win.webContents.once('did-finish-load', () => win.webContents.send('output:role', { audio: win.__audioMaster }));
    }
    this.onChange && this.onChange(this.status());
  }

  status() {
    return { target: this.target, active: [...this.windows.keys()], displays: this.displays() };
  }

  setState(state) {
    this.state = state;
    for (const win of this.windows.values()) if (!win.isDestroyed()) win.webContents.send('output:state', state);
    for (const l of this.listeners) l('state', state);
  }

  mediaCommand(cmd) {
    for (const win of this.windows.values()) if (!win.isDestroyed()) win.webContents.send('output:media', cmd);
    for (const l of this.listeners) l('media', cmd);
  }

  identify() {
    const wins = this.displays().map((d) => {
      const w = new BrowserWindow({
        x: d.bounds.x + 40, y: d.bounds.y + 40, width: 360, height: 220, frame: false, alwaysOnTop: true,
        focusable: false, skipTaskbar: true, backgroundColor: '#1f6feb', show: false,
      });
      const html = `<body style="margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#1f6feb;color:#fff;font-family:Segoe UI,sans-serif">
        <div style="font-size:110px;font-weight:700;line-height:1">${d.index}</div>
        <div style="font-size:18px">${d.primary ? 'Primary' : 'Secondary'} · ${d.size}</div></body>`;
      w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      w.once('ready-to-show', () => w.showInactive());
      return w;
    });
    setTimeout(() => wins.forEach((w) => !w.isDestroyed() && w.destroy()), 3500);
  }

  closeAll() { for (const w of this.windows.values()) if (!w.isDestroyed()) w.destroy(); this.windows.clear(); }
}

module.exports = { Outputs };
