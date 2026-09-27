// Locates ffmpeg and detects which H.264 encoders actually work on this machine.
const { spawn, execFile } = require('child_process');
const fs = require('fs');

let override = '';
let cachedEncoders = null;

function ffmpegPath() {
  if (override && fs.existsSync(override)) return override;
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p.replace('app.asar', 'app.asar.unpacked'))) return p.replace('app.asar', 'app.asar.unpacked');
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return 'ffmpeg'; // fall back to PATH
}

function setOverride(p) { override = p || ''; cachedEncoders = null; }

function run(args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(ffmpegPath(), args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

const HW = [
  { id: 'nvenc', codec: 'h264_nvenc', label: 'NVIDIA NVENC (hardware)' },
  { id: 'qsv', codec: 'h264_qsv', label: 'Intel Quick Sync (hardware)' },
  { id: 'amf', codec: 'h264_amf', label: 'AMD AMF (hardware)' },
];

async function detectEncoders() {
  if (cachedEncoders) return cachedEncoders;
  const list = [{ id: 'x264', codec: 'libx264', label: 'x264 (software, CPU)' }];
  const res = await run(['-hide_banner', '-encoders']);
  if (!res.ok && !res.stdout) {
    cachedEncoders = { ok: false, path: ffmpegPath(), encoders: list, error: res.stderr.slice(0, 400) || 'ffmpeg not found' };
    return cachedEncoders;
  }
  // Listing an encoder doesn't mean the GPU exists — do a 1-frame test encode.
  await Promise.all(HW.map(async (hw) => {
    if (!res.stdout.includes(hw.codec)) return;
    const pixFmt = hw.id === 'qsv' ? 'nv12' : 'yuv420p';
    const t = await run(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=640x360:r=30',
      '-frames:v', '3', '-pix_fmt', pixFmt, '-c:v', hw.codec, '-f', 'null', '-'], 12000);
    if (t.ok) list.push(hw);
  }));
  const v = await run(['-hide_banner', '-version']);
  const order = ['nvenc', 'qsv', 'amf', 'x264'];
  list.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const result = {
    ok: true,
    path: ffmpegPath(),
    version: (v.stdout.split('\n')[0] || '').trim(),
    rtmps: /--enable-(openssl|gnutls|schannel|mbedtls)/.test(v.stdout) || res.stdout.length > 0,
    encoders: list,
  };
  // A GPU test can fail transiently (driver busy) — only cache once hardware was found
  if (list.length > 1) cachedEncoders = result;
  return result;
}

function spawnFfmpeg(args) {
  return spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

module.exports = { ffmpegPath, setOverride, detectEncoders, spawnFfmpeg, run };
