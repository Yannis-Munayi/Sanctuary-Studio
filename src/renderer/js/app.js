// Bootstrap: loads data, builds the two halves (Presenter left, Studio right), wires hotkeys.
import { h, $, toast, accelFromEvent, isTyping } from './util.js';
import { settings, loadSettings, saveSettings, bus } from './state.js';
import { SongLibrary } from './worship/songs.js';
import { ThemeLibrary } from './worship/themes.js';
import { BibleLibrary } from './worship/bible.js';
import { Worship } from './worship/worship.js';
import { Studio } from './studio/studio.js';
import { openSettings, getEncoders } from './settings.js';

const app = {};
window.__app = app; // handy for debugging in DevTools (F12)

async function main() {
  await loadSettings();
  const songs = new SongLibrary();
  const themes = new ThemeLibrary();
  const bibles = new BibleLibrary();
  await Promise.all([songs.load(), themes.load(), bibles.refresh()]);

  const left = $('#worship');
  const right = $('#studio');
  const split = $('#splitter');
  applySplit(settings.general.split);

  app.bibles = bibles;
  app.settings = settings;
  app.worship = new Worship(left, { songs, themes, bibles });
  app.studio = new Studio(right);
  await Promise.all([app.worship.init(), app.studio.init()]);
  app.applyHotkeys = applyHotkeys;
  applyHotkeys();

  bus.on('open-settings', (tab) => openSettings(app, tab));
  autoPickEncoder();

  // draggable divider between Presenter and Studio
  split.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('resizing');
    const move = (ev) => applySplit(Math.min(0.75, Math.max(0.25, ev.clientX / innerWidth)));
    const up = () => {
      removeEventListener('mousemove', move); removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
      settings.general.split = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--split')) || 0.5;
      saveSettings(); app.worship.repaintMonitors();
    };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  });
  split.addEventListener('dblclick', () => { applySplit(0.5); settings.general.split = 0.5; saveSettings(); app.worship.repaintMonitors(); });

  document.addEventListener('keydown', onKey);
  window.api.hotkeys.onHotkey((action) => dispatch(action));
  window.api.onQuitRequested(async () => {
    toast('Stopping stream / recording…');
    try { await app.studio.out.stopStream(); } catch {}
    try { await app.studio.out.stopRecord(); } catch {}
    await new Promise((r) => setTimeout(r, 1500)); // give ffmpeg a moment to finish the file
    await window.api.setBusy(false);
    window.close();
  });
  $('#boot').remove();
}

// First run: prefer a hardware encoder (GPU) so the laptop's CPU stays free for everything else
async function autoPickEncoder() {
  if (settings.stream.encoderPicked) return;
  const info = await getEncoders();
  const hw = info.encoders.find((e) => e.id !== 'x264');
  if (!hw) return;
  settings.stream.encoder = hw.id;
  settings.stream.preset = hw.id === 'nvenc' ? 'p5' : hw.id === 'amf' ? 'balanced' : 'veryfast';
  settings.stream.encoderPicked = true;
  saveSettings();
  toast(`Using ${hw.label} for streaming (change in Settings › Output)`, 'ok', 5000);
}

function applySplit(r) { document.documentElement.style.setProperty('--split', r); }

function dispatch(action) {
  return app.studio.hotkey(action) || app.worship.hotkey(action);
}

function onKey(e) {
  if (document.querySelector('.modal-back')) return;
  if (isTyping(e)) return;
  if (e.target.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return; // let the button handle it
  if (e.target.classList && e.target.classList.contains('edit-overlay')) {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete'].includes(e.key)) return; // nudging items
  }
  const a = accelFromEvent(e);
  if (!a) return;
  const aliases = [a];
  if (a === 'Right' || a === 'Down' || a === 'PageDown' || a === 'Space') aliases.push('Right');
  if (a === 'Left' || a === 'Up' || a === 'PageUp') aliases.push('Left');
  for (const [action, accel] of Object.entries(settings.hotkeys)) {
    if (accel && aliases.includes(accel)) {
      if (dispatch(action)) { e.preventDefault(); return; }
    }
  }
}

async function applyHotkeys() {
  if (!settings.advanced.globalHotkeys) { await window.api.hotkeys.setGlobal({}); return; }
  const map = {};
  for (const [action, accel] of Object.entries(settings.hotkeys)) {
    if (accel && (/(Ctrl|Alt)\+/.test(accel) || /^F\d+$/.test(accel))) map[action] = accel.replace('Ctrl', 'CommandOrControl');
  }
  const failed = await window.api.hotkeys.setGlobal(map);
  if (failed && failed.length) toast('Some global hotkeys are used by another app: ' + failed.join(', '), 'warn');
}

main().catch((e) => {
  console.error(e);
  const b = $('#boot');
  if (b) b.innerHTML = `<div class="boot-err"><b>Startup error</b><pre>${String(e.stack || e)}</pre></div>`;
});
