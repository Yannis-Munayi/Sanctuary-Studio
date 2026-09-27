// "Update available" pill + dialog. Updates come from GitHub Releases (see tools/release.js).
import { h, $, modal, toast, confirmDialog } from './util.js';

let pill = null;
let st = { state: 'idle' };
let announced = '';

export function initUpdates() {
  const bar = $('.w-toolbar .tb-spacer');
  pill = h('button', { class: 'btn sm update-pill', style: { display: 'none' }, onclick: () => openDialog() });
  bar.after(pill);
  window.api.update.onStatus(onStatus);
  window.api.update.status().then(onStatus);
}

function onStatus(s) {
  st = s || st;
  if (!pill) return;
  const show = (text, cls) => { pill.style.display = ''; pill.textContent = text; pill.className = 'btn sm update-pill ' + cls; };
  switch (st.state) {
    case 'available':
      show(`⬇ Update ${st.version} available`, 'avail');
      if (announced !== st.version) { announced = st.version; toast(`Sanctuary Studio ${st.version} is available — click the green "Update" button at the top`, 'ok', 7000); }
      break;
    case 'downloading': show(`Downloading update… ${st.percent || 0}%`, 'busy'); break;
    case 'downloaded': show(`↻ Restart to update to ${st.version}`, 'ready'); break;
    default: pill.style.display = 'none';
  }
}

export function openDialog() {
  if (st.state === 'downloaded') return installNow();
  if (st.state !== 'available') return;
  modal({
    title: `Update available — version ${st.version}`, width: 540,
    body: h('div', null,
      h('p', null, `You have version ${st.current}. The update downloads in the background — you can keep working (even stay live) while it downloads.`),
      st.notes ? h('div', null, h('div', { class: 'form-heading' }, "What's new"), h('pre', { class: 'release-notes' }, st.notes)) : null,
      h('div', { class: 'form-note' }, 'Your songs, schedules, scenes, themes, stream keys and settings are kept.')),
    buttons: [{ label: 'Later' }, { label: 'Download update', primary: true, onClick: () => { window.api.update.download(); } }],
  });
}

async function installNow() {
  if (!(await confirmDialog(`Install version ${st.version} now?\n\nSanctuary Studio will close, update (about 20–30 seconds) and reopen by itself. Don't do this in the middle of a service.`, { title: 'Restart to update', ok: 'Restart & update' }))) return;
  const r = await window.api.update.install();
  if (!r.ok) toast(r.error, 'warn', 6000);
}

// For Settings › Advanced
export function updateSettingsBlock() {
  const line = h('span', { class: 'muted' });
  const wrap = h('div', { class: 'update-block' });
  const describe = (s) => {
    const map = {
      dev: 'Updates only work in the installed app (you are running from source).',
      checking: 'Checking…', none: 'You have the latest version.',
      available: `Version ${s.version} is available.`, downloading: `Downloading… ${s.percent || 0}%`,
      downloaded: `Version ${s.version} is ready — restart to install.`, error: s.offline ? 'Could not check: no internet connection.' : 'Could not check for updates: ' + (s.message || ''),
      idle: '',
    };
    line.textContent = map[s.state] ?? '';
  };
  window.api.version().then((v) => {
    wrap.prepend(h('b', null, `Sanctuary Studio ${v.version}`));
  });
  window.api.update.status().then(describe);
  const off = window.api.update.onStatus((s) => { if (!wrap.isConnected) return off(); describe(s); });
  wrap.append(line,
    h('button', { class: 'btn sm', onclick: async () => { describe({ state: 'checking' }); describe(await window.api.update.check()); } }, 'Check for updates'),
    h('button', { class: 'btn sm', onclick: () => openDialog() }, 'Update…'));
  return wrap;
}
