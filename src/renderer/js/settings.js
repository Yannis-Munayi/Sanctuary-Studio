// Settings dialog (General, Stream, Output, Audio, Video, Hotkeys, Worship, Advanced).
import { h, modal, buildForm, toast, uid, accelFromEvent, confirmDialog } from './util.js';
import { settings, saveSettings, PLATFORM_PRESETS } from './state.js';

const PRESETS = {
  x264: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'],
  nvenc: [{ value: 'p1', label: 'P1 (fastest)' }, 'p2', 'p3', 'p4', { value: 'p5', label: 'P5 (quality)' }, 'p6', { value: 'p7', label: 'P7 (best quality)' }],
  qsv: ['veryfast', 'faster', 'fast', 'medium', 'slow'],
  amf: ['speed', 'balanced', 'quality'],
};
const RESOLUTIONS = ['3840x2160', '2560x1440', '1920x1080', '1600x900', '1280x720', '1080x1920', '720x1280', '854x480'];

const HOTKEY_LABELS = {
  goLive: 'Start / stop streaming', record: 'Start / stop recording', transition: 'Send edited scene live', sceneNext: 'Next scene live', scenePrev: 'Previous scene live',
  scene1: 'Scene 1 live', scene2: 'Scene 2 live', scene3: 'Scene 3 live', scene4: 'Scene 4 live', scene5: 'Scene 5 live', scene6: 'Scene 6 live', scene7: 'Scene 7 live', scene8: 'Scene 8 live', scene9: 'Scene 9 live',
  slideNext: 'Presenter: next slide', slidePrev: 'Presenter: previous slide', black: 'Presenter: black screen', clear: 'Presenter: clear text', logo: 'Presenter: logo',
  streamOverlay: 'Presenter: scripture/lyrics on stream', goLiveWorship: 'Presenter: send preview live',
};

let encoderInfo = null;
export async function getEncoders() {
  if (encoderInfo && encoderInfo.encoders.length > 1) return encoderInfo;
  encoderInfo = await window.api.ffmpeg.detect().catch((e) => ({ ok: false, encoders: [{ id: 'x264', label: 'x264' }], error: e.message }));
  return encoderInfo;
}

export function openSettings(app, tab = 'general') {
  const before = JSON.stringify({ v: settings.video, fps: settings.video.fps });
  const tabs = [
    ['general', 'General'], ['stream', 'Stream'], ['output', 'Output'], ['audio', 'Audio'], ['video', 'Video'],
    ['hotkeys', 'Hotkeys'], ['worship', 'Presenter'], ['advanced', 'Advanced'],
  ];
  const nav = h('div', { class: 'set-nav' });
  const pane = h('div', { class: 'set-pane' });
  const changed = () => saveSettings();
  const show = (id) => {
    nav.querySelectorAll('.set-tab').forEach((t) => t.classList.toggle('active', t.dataset.id === id));
    pane.innerHTML = '';
    pane.appendChild(PAGES[id](app, changed));
  };
  tabs.forEach(([id, label]) => nav.appendChild(h('div', { class: 'set-tab', dataset: { id }, onclick: () => show(id) }, label)));
  modal({
    title: 'Settings', body: h('div', { class: 'settings' }, nav, pane), width: 'min(980px, 95vw)', className: 'tall settings-modal',
    buttons: [{ label: 'Close', primary: true }],
    onClose: () => {
      saveSettings.flush && saveSettings.flush();
      if (JSON.stringify({ v: settings.video, fps: settings.video.fps }) !== before) app.studio.videoSettingsChanged();
      app.applyHotkeys();
      app.studio.renderAll();
      app.studio.audio.setMonitorDevice(settings.audio.monitorDevice);
    },
  });
  show(tab);
}

const PAGES = {
  general: (app, changed) => buildForm([
    { type: 'heading', label: 'Scenes' },
    { key: 'general.sceneClick', label: 'Clicking a scene', type: 'select', options: [
      { value: 'live', label: 'Sends it to the livestream (✎ button edits)' },
      { value: 'edit', label: 'Opens it for editing (double-click sends it live)' }] },
    { key: 'general.thumbnails', label: 'Live scene thumbnails', type: 'checkbox' },
    { key: 'general.editorSnap', label: 'Snap to edges & centre while editing', type: 'checkbox', help: 'Hold Ctrl while dragging to temporarily disable snapping.' },
    { type: 'heading', label: 'Safety' },
    { key: 'general.confirmStart', label: 'Confirm before going live', type: 'checkbox' },
    { key: 'general.confirmStop', label: 'Confirm before ending the stream', type: 'checkbox' },
    { key: 'record.withStream', label: 'Automatically record when streaming', type: 'checkbox' },
  ], settings, () => { changed(); app.studio.renderScenes(); }),

  stream: (app, changed) => {
    const wrap = h('div', { class: 'platforms' });
    let secrets = {};
    const render = () => {
      wrap.innerHTML = '';
      wrap.appendChild(h('div', { class: 'form-note' }, 'Toggle platforms on the main screen by clicking their chips next to GO LIVE. All enabled platforms receive the stream at the same time. Stream keys are stored encrypted on this PC.'));
      for (const p of settings.platforms) {
        const preset = PLATFORM_PRESETS[p.kind] || PLATFORM_PRESETS.custom;
        const keyObj = { key: secrets['key:' + p.id] || '' };
        const saveKey = debounceKey(p.id);
        const card = h('div', { class: 'platform-card', style: { '--pc': preset.color } },
          h('div', { class: 'platform-head' },
            h('span', { class: 'chip-dot' }), h('b', null, p.name),
            h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: p.enabled, onchange: (e) => { p.enabled = e.target.checked; changed(); } }), 'Stream to this platform'),
            h('div', { class: 'tb-spacer' }),
            preset.dashboard ? h('button', { class: 'btn xs', onclick: () => window.api.openExternal(preset.dashboard) }, 'Open dashboard ↗') : null,
            !['youtube', 'facebook', 'tiktok', 'instagram'].includes(p.id) ? h('button', { class: 'btn xs danger', onclick: async () => {
              if (!(await confirmDialog(`Remove ${p.name}?`, { danger: true, ok: 'Remove' }))) return;
              settings.platforms = settings.platforms.filter((x) => x !== p); window.api.secrets.write('key:' + p.id, ''); changed(); render();
            } }, 'Remove') : null),
          h('div', { class: 'form-help' }, preset.help),
          buildForm([
            ...(p.kind === 'custom' || p.kind === 'twitch' ? [{ key: 'name', label: 'Name', type: 'text' }] : []),
            { key: 'server', label: 'Server URL', type: 'text', placeholder: 'rtmp://… or rtmps://…' },
            { key: 'orientation', label: 'Orientation', type: 'select', options: [{ value: 'landscape', label: 'Landscape 16:9' }, { value: 'vertical', label: 'Vertical 9:16 (centre crop — TikTok / Instagram)' }] },
          ], p, changed),
          buildForm([{ key: 'key', label: 'Stream key', type: 'password', placeholder: 'paste stream key' }], keyObj, (k, v) => saveKey(v)));
        wrap.appendChild(card);
      }
      const add = h('select', { onchange: (e) => {
        const kind = e.target.value; if (!kind) return;
        const pr = PLATFORM_PRESETS[kind];
        settings.platforms.push({ id: uid('dest'), kind, name: pr.name, server: pr.server, enabled: true, orientation: 'landscape' });
        changed(); render();
      } }, h('option', { value: '' }, '+ Add another destination…'), h('option', { value: 'twitch' }, 'Twitch'), h('option', { value: 'custom' }, 'Custom RTMP server'), h('option', { value: 'youtube' }, 'Second YouTube channel'), h('option', { value: 'facebook' }, 'Another Facebook page'));
      wrap.appendChild(add);
    };
    window.api.secrets.read().then((s) => { secrets = s; render(); });
    return wrap;
  },

  output: (app, changed) => {
    const wrap = h('div', null, h('div', { class: 'muted pad' }, 'Detecting encoders…'));
    getEncoders().then((info) => {
      const encOpts = info.encoders.map((e) => ({ value: e.id, label: e.label }));
      const s = settings.stream;
      if (!info.encoders.some((e) => e.id === s.encoder)) s.encoder = 'x264';
      const build = () => {
      const form = buildForm([
        { type: 'heading', label: 'Streaming' },
        { key: 'encoder', label: 'Video encoder', type: 'select', options: encOpts, help: info.encoders.length > 1 ? 'Hardware encoders use your graphics card and keep the CPU free — recommended on laptops.' : 'Only the software encoder was found on this PC.' },
        { key: 'rateControl', label: 'Rate control', type: 'select', options: [{ value: 'CBR', label: 'CBR (recommended for streaming)' }, { value: 'VBR', label: 'VBR' }, { value: 'CRF', label: 'CRF / CQP (quality-based)' }] },
        { key: 'bitrate', label: 'Video bitrate', type: 'number', min: 300, max: 51000, step: 100, unit: 'kbps', showIf: (o) => o.rateControl !== 'CRF', help: '1080p30: 4500–6000 · 720p30: 2500–4000. Facebook max 8000. Keep below ~75% of your upload speed per platform… all platforms share one encode, but upload is multiplied by the number of platforms.' },
        { key: 'crf', label: 'Quality (CRF/CQ)', type: 'range', min: 14, max: 35, showIf: (o) => o.rateControl === 'CRF', help: 'Lower = better quality, bigger' },
        { key: 'keyint', label: 'Keyframe interval', type: 'number', min: 1, max: 10, unit: 's', help: 'YouTube/Facebook require 2 s' },
        { key: 'preset', label: 'Preset', type: 'select', options: (o) => PRESETS[o.encoder] || PRESETS.x264 },
        { key: 'profile', label: 'Profile', type: 'select', options: ['high', 'main', 'baseline'] },
        { key: 'tune', label: 'Tune (x264)', type: 'select', options: [{ value: '', label: '(none)' }, 'film', 'animation', 'stillimage', 'zerolatency'], showIf: (o) => o.encoder === 'x264' },
        { key: 'bframes', label: 'B-frames', type: 'number', min: 0, max: 4 },
        { key: 'audioBitrate', label: 'Audio bitrate', type: 'select', numeric: true, options: [96, 128, 160, 192, 256, 320], unit: 'kbps' },
        { type: 'heading', label: 'Vertical outputs (TikTok / Instagram)' },
        { key: 'verticalW', label: 'Width', type: 'number', min: 360, unit: 'px' },
        { key: 'verticalH', label: 'Height', type: 'number', min: 640, unit: 'px', help: 'Vertical platforms get a centre crop of your live scene. 720×1280 is recommended.' },
      ], s, (k) => {
        if (k === 'encoder') {
          const valid = (PRESETS[s.encoder] || PRESETS.x264).map((p) => (typeof p === 'object' ? p.value : p));
          if (!valid.includes(s.preset)) s.preset = s.encoder === 'nvenc' ? 'p5' : s.encoder === 'amf' ? 'speed' : 'veryfast';
          changed(); build(); return;
        }
        changed();
      });
      const rec = buildForm([
        { type: 'heading', label: 'Recording' },
        { key: 'path', label: 'Folder', type: 'folder' },
        { key: 'filename', label: 'File name', type: 'text', help: '%Y year, %m month, %d day, %H hour, %M minute, %S second' },
        { key: 'format', label: 'Format', type: 'select', options: [{ value: 'mkv', label: 'MKV (safest — survives crashes)' }, { value: 'mp4', label: 'MP4 (fragmented)' }, { value: 'mov', label: 'MOV' }, { value: 'flv', label: 'FLV' }, { value: 'ts', label: 'MPEG-TS' }] },
        { key: 'encoder', label: 'Encoder', type: 'select', options: [{ value: 'same', label: '(same as stream)' }, ...encOpts] },
        { key: 'quality', label: 'Quality', type: 'select', options: [{ value: 'high', label: 'High quality (CRF)' }, { value: 'stream', label: 'Same as stream (bitrate)' }] },
        { key: 'crf', label: 'CRF', type: 'range', min: 12, max: 30, showIf: (r) => r.quality !== 'stream', help: '18 ≈ visually lossless, 23 = smaller files' },
        { key: 'audioBitrate', label: 'Audio bitrate', type: 'select', numeric: true, options: [128, 160, 192, 256, 320] },
      ], settings.record, changed);
      const adv = buildForm([
        { type: 'heading', label: 'Capture pipeline' },
        { key: 'intermediateMbps', label: 'Internal capture bitrate', type: 'number', min: 0, max: 80, unit: 'Mbps', help: '0 = automatic. Quality of the hand-off from the compositor to the encoder; raise if you see blockiness in fast motion.' },
      ], s, changed);
      const info2 = h('div', { class: 'form-note' }, info.ok ? `ffmpeg: ${info.version || info.path}` : `⚠ ffmpeg problem: ${info.error}`);
      wrap.replaceChildren(form, rec, adv, info2);
      };
      build();
    });
    return wrap;
  },

  audio: (app, changed) => {
    const wrap = h('div');
    navigator.mediaDevices.enumerateDevices().then((devs) => {
      const outs = devs.filter((d) => d.kind === 'audiooutput').map((d) => ({ value: d.deviceId, label: d.label || 'Output' }));
      wrap.appendChild(buildForm([
        { key: 'audio.monitorDevice', label: 'Monitoring device', type: 'select', options: outs.length ? outs : [{ value: 'default', label: 'Default' }], help: 'Where sources set to "Monitor" are heard (e.g. headphones). The stream mix is never played here unless monitored.' },
        { key: 'stream.sampleRate', label: 'Sample rate', type: 'select', numeric: true, options: [{ value: 48000, label: '48 kHz (recommended)' }, { value: 44100, label: '44.1 kHz' }], help: 'Takes effect after restarting the app.' },
        { type: 'note', label: 'Microphones and desktop audio that should be heard in every scene are in the Audio Mixer (＋). Per-source filters — EQ, compressor, noise gate, gain — are in each mixer strip\'s ⋮ menu.' },
      ], settings, () => { changed(); app.studio.audio.setMonitorDevice(settings.audio.monitorDevice); }));
    });
    return wrap;
  },

  video: (app, changed) => {
    const v = settings.video;
    const obj = { base: `${v.baseW}x${v.baseH}`, out: `${v.outW}x${v.outH}`, fps: v.fps, scaleFilter: v.scaleFilter };
    const apply = () => {
      const [bw, bh] = obj.base.split('x').map(Number); const [ow, oh] = obj.out.split('x').map(Number);
      if (bw && bh) { v.baseW = bw; v.baseH = bh; }
      if (ow && oh) { v.outW = ow; v.outH = oh; }
      v.fps = Number(obj.fps) || 30; v.scaleFilter = obj.scaleFilter;
      changed();
    };
    return buildForm([
      { key: 'base', label: 'Canvas (base) resolution', type: 'select', options: RESOLUTIONS, help: 'The size of your scenes. Changing it does not move existing sources.' },
      { key: 'out', label: 'Output (scaled) resolution', type: 'select', options: RESOLUTIONS, help: 'What viewers receive. Use 1280×720 on slow internet or older laptops.' },
      { key: 'fps', label: 'Frame rate', type: 'select', numeric: true, options: [24, 25, 29.97, 30, 48, 50, 59.94, 60] },
      { key: 'scaleFilter', label: 'Downscale filter', type: 'select', options: [{ value: 'bilinear', label: 'Bilinear (fastest)' }, { value: 'bicubic', label: 'Bicubic' }, { value: 'lanczos', label: 'Lanczos (sharpest)' }] },
    ], obj, apply);
  },

  hotkeys: (app, changed) => {
    const wrap = h('div', { class: 'hotkeys' }, h('div', { class: 'form-note' }, 'Click a box and press the key combination. Backspace clears. Presenter keys (single letters/arrows) only work while the app is focused and you are not typing.'));
    for (const [action, label] of Object.entries(HOTKEY_LABELS)) {
      const inp = h('input', { type: 'text', readOnly: true, value: settings.hotkeys[action] || '', placeholder: '—', class: 'hotkey-input',
        onkeydown: (e) => {
          e.preventDefault(); e.stopPropagation();
          if (e.key === 'Backspace' || e.key === 'Delete') { settings.hotkeys[action] = ''; inp.value = ''; changed(); return; }
          if (e.key === 'Escape') { inp.blur(); return; }
          const a = accelFromEvent(e); if (!a) return;
          settings.hotkeys[action] = a; inp.value = a; changed();
        } });
      wrap.appendChild(h('div', { class: 'form-row' }, h('label', { class: 'form-label' }, label), h('div', { class: 'form-control' }, inp)));
    }
    wrap.appendChild(buildForm([{ key: 'advanced.globalHotkeys', label: 'Work when app is in the background', type: 'checkbox', help: 'Only combinations with Ctrl/Alt or F-keys are registered globally.' }], settings, changed));
    return wrap;
  },

  worship: (app, changed) => {
    const wrap = h('div');
    wrap.appendChild(buildForm([
      { type: 'heading', label: 'Displays' },
      { type: 'note', label: 'Choose where lyrics & scripture appear with the "Output" menu at the top of the Presenter. "Secondary" = every monitor except this laptop.' },
      { key: 'worship.logoPath', label: 'Logo image', type: 'file', clearable: true, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }] },
      { key: 'worship.transition', label: 'Slide fade', type: 'range', min: 0, max: 1500, step: 50, unit: ' ms' },
      { type: 'heading', label: 'Scripture' },
      { key: 'worship.versesPerSlide', label: 'Verses per slide', type: 'select', numeric: true, options: [1, 2, 3, 4] },
      { key: 'worship.verseNumbers', label: 'Show verse numbers', type: 'checkbox' },
      { key: 'worship.showTranslation', label: 'Show translation in reference', type: 'checkbox', help: 'e.g. "John 3:16 (KJV)"' },
      { key: 'worship.continueChapter', label: 'Single verse continues to end of chapter', type: 'checkbox' },
      { type: 'heading', label: 'Network output (NDI / browser capture)' },
      { type: 'note', label: 'Serves the projector output as a web page. Use it as a Browser Source in OBS/vMix on another computer, or capture it with NDI Tools (Screen Capture / Webcam Input). Native NDI sending requires the NDI SDK and is not built in.' },
      { key: 'worship.netPort', label: 'Port', type: 'number', min: 1024, max: 65535 },
      { key: 'worship.netLan', label: 'Allow other computers on the network', type: 'checkbox', help: 'Off = only this computer (localhost).' },
    ], settings, () => { changed(); app.worship.pushOutput(); }));
    // Bible translations
    const list = h('div', { class: 'bible-list' });
    const renderBibles = async () => {
      const bibles = await window.api.bibles.list();
      list.replaceChildren(...bibles.map((b) => h('div', { class: 'bible-row' }, h('b', null, b.id), h('span', null, b.name), h('div', { class: 'tb-spacer' }),
        b.builtin ? h('span', { class: 'muted small' }, 'built-in') : h('button', { class: 'btn xs danger', onclick: async () => { await window.api.bibles.remove(b.file); await app.bibles.refresh(); renderBibles(); } }, 'Remove'))));
    };
    renderBibles();
    wrap.append(h('div', { class: 'form-heading' }, 'Bible translations'), list,
      h('div', { class: 'form-note' }, 'Import more translations from the Scriptures tab (translation menu › Import). Supports Zefania XML, OSIS XML, OpenSong XML and JSON. Only import translations you are licensed to use (NIV/NKJV/ESV are copyrighted).'));
    return wrap;
  },

  advanced: (app, changed) => {
    const wrap = h('div');
    wrap.appendChild(buildForm([
      { type: 'heading', label: 'Reconnect' },
      { key: 'advanced.autoReconnect', label: 'Automatically reconnect', type: 'checkbox', help: 'If a platform drops, only that platform reconnects — the others keep streaming.' },
      { key: 'advanced.retryDelay', label: 'Retry delay', type: 'number', min: 1, max: 120, unit: 's' },
      { key: 'advanced.maxRetries', label: 'Maximum retries', type: 'number', min: 0, max: 1000 },
      { type: 'heading', label: 'ffmpeg' },
      { key: 'advanced.ffmpegPath', label: 'Custom ffmpeg.exe', type: 'file', clearable: true, filters: [{ name: 'ffmpeg', extensions: ['exe'] }], help: 'Leave empty to use the bundled ffmpeg.' },
    ], settings, async (k) => {
      changed();
      if (k === 'advanced.ffmpegPath') { encoderInfo = await window.api.ffmpeg.setPath(settings.advanced.ffmpegPath); toast(encoderInfo.ok ? 'ffmpeg OK: ' + (encoderInfo.version || '') : 'ffmpeg problem: ' + encoderInfo.error, encoderInfo.ok ? 'ok' : 'error'); }
    }));
    wrap.appendChild(h('div', { class: 'btn-row' },
      h('button', { class: 'btn sm', onclick: async () => window.api.showItem((await window.api.paths()).userData + '\\data\\settings.json') }, 'Open data folder'),
      h('button', { class: 'btn sm', onclick: () => backup(app) }, 'Back up everything…'),
      h('button', { class: 'btn sm', onclick: () => restore(app) }, 'Restore backup…')));
    return wrap;
  },
};

const keyTimers = {};
function debounceKey(id) {
  return (v) => { clearTimeout(keyTimers[id]); keyTimers[id] = setTimeout(() => window.api.secrets.write('key:' + id, v.trim()), 300); };
}

async function backup(app) {
  const p = await window.api.dialog.save({ defaultPath: `sanctuary-backup-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'Backup', extensions: ['json'] }] });
  if (!p) return;
  const names = ['settings', 'studio', 'songs', 'themes', 'schedule', 'media', 'presentations'];
  const data = {};
  for (const n of names) data[n] = await window.api.store.read(n, null);
  await window.api.fs.writeText(p, JSON.stringify({ app: 'Sanctuary Studio', created: new Date().toISOString(), data }));
  toast('Backup saved (stream keys are not included)', 'ok');
}

async function restore() {
  const [p] = await window.api.dialog.open({ filters: [{ name: 'Backup', extensions: ['json'] }] });
  if (!p) return;
  try {
    const j = JSON.parse(await window.api.fs.readText(p));
    if (!j.data) throw new Error('not a Sanctuary Studio backup');
    if (!(await confirmDialog('Replace your current songs, scenes, themes and settings with this backup? The app will reload.', { danger: true, ok: 'Restore' }))) return;
    for (const [n, v] of Object.entries(j.data)) if (v !== null) await window.api.store.write(n, v);
    location.reload();
  } catch (e) { toast('Restore failed: ' + e.message, 'error'); }
}
