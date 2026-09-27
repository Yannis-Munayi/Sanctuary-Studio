// Streaming + recording engine.
//
//  renderer (canvas + WebAudio) --MediaRecorder chunks--> encoder ffmpeg (one per orientation)
//      encoder: webm/mkv in  ->  H.264/AAC MPEG-TS out (stdout)
//      stdout is fanned out to one lightweight "relay" ffmpeg per platform (-c copy -> FLV -> RTMP/RTMPS)
//
// Encoding happens once per orientation; each platform connection is an independent process,
// so one platform failing/reconnecting never interrupts the others.
const { spawnFfmpeg } = require('./ffmpeg');

const ENC = {
  x264: 'libx264', nvenc: 'h264_nvenc', qsv: 'h264_qsv', amf: 'h264_amf',
};

function videoEncoderArgs(o, fps) {
  const enc = ENC[o.encoder] || 'libx264';
  const br = Math.max(200, Number(o.bitrate) || 4500);
  const gop = Math.max(1, Math.round(fps * (Number(o.keyint) || 2)));
  const a = ['-c:v', enc];
  const rc = o.rateControl || 'CBR';
  if (enc === 'libx264') {
    a.push('-preset', o.preset || 'veryfast');
    if (o.tune) a.push('-tune', o.tune);
    if (o.profile) a.push('-profile:v', o.profile);
    a.push('-bf', String(o.bframes ?? 2), '-sc_threshold', '0');
    if (rc === 'CRF') a.push('-crf', String(o.crf ?? 20));
    else if (rc === 'VBR') a.push('-b:v', br + 'k', '-maxrate', Math.round(br * 1.5) + 'k', '-bufsize', br * 2 + 'k');
    else a.push('-b:v', br + 'k', '-maxrate', br + 'k', '-bufsize', br * 2 + 'k', '-x264-params', 'nal-hrd=cbr:force-cfr=1');
  } else if (enc === 'h264_nvenc') {
    const p = /^p[1-7]$/.test(o.preset) ? o.preset : 'p5';
    a.push('-preset', p, '-tune', 'll', '-profile:v', o.profile === 'baseline' ? 'baseline' : (o.profile || 'high'));
    a.push('-bf', String(o.bframes ?? 2));
    if (rc === 'CRF') a.push('-rc', 'vbr', '-cq', String(o.crf ?? 21), '-b:v', '0');
    else if (rc === 'VBR') a.push('-rc', 'vbr', '-b:v', br + 'k', '-maxrate', Math.round(br * 1.5) + 'k', '-bufsize', br * 2 + 'k');
    else a.push('-rc', 'cbr', '-b:v', br + 'k', '-maxrate', br + 'k', '-bufsize', br * 2 + 'k');
  } else if (enc === 'h264_qsv') {
    a.push('-preset', ['veryfast', 'faster', 'fast', 'medium', 'slow'].includes(o.preset) ? o.preset : 'veryfast');
    a.push('-profile:v', o.profile || 'high', '-bf', String(o.bframes ?? 2));
    if (rc === 'CRF') a.push('-global_quality', String(o.crf ?? 23));
    else a.push('-b:v', br + 'k', '-maxrate', (rc === 'VBR' ? Math.round(br * 1.5) : br) + 'k', '-bufsize', br * 2 + 'k');
  } else if (enc === 'h264_amf') {
    a.push('-quality', o.preset === 'quality' ? 'quality' : o.preset === 'balanced' ? 'balanced' : 'speed');
    a.push('-profile:v', o.profile === 'baseline' ? 'constrained_baseline' : (o.profile || 'high'));
    if (rc === 'CRF') a.push('-rc', 'cqp', '-qp_i', String(o.crf ?? 22), '-qp_p', String(o.crf ?? 22));
    else if (rc === 'VBR') a.push('-rc', 'vbr_peak', '-b:v', br + 'k', '-maxrate', Math.round(br * 1.5) + 'k');
    else a.push('-rc', 'cbr', '-b:v', br + 'k', '-maxrate', br + 'k', '-bufsize', br * 2 + 'k');
  }
  a.push('-g', String(gop), '-keyint_min', String(gop),
    '-force_key_frames', `expr:gte(t,n_forced*${Number(o.keyint) || 2})`);
  return a;
}

function videoFilter(o, orientation) {
  const fps = Number(o.fps) || 30;
  const pix = (o.encoder === 'qsv' || o.encoder === 'amf') ? 'nv12' : 'yuv420p';
  const flags = o.scaleFilter || 'bicubic';
  const f = [`fps=${fps}`];
  if (orientation === 'vertical') {
    const vw = Number(o.verticalW) || 720, vh = Number(o.verticalH) || 1280;
    f.push(`crop=trunc(ih*${vw}/${vh}/2)*2:ih`, `scale=${vw}:${vh}:flags=${flags}`);
  } else {
    f.push(`scale=${Number(o.outW) || 1920}:${Number(o.outH) || 1080}:flags=${flags}`);
  }
  f.push('setsar=1', `format=${pix}`);
  return f.join(',');
}

function inputArgs() {
  return ['-hide_banner', '-loglevel', 'warning', '-stats_period', '1', '-stats',
    '-thread_queue_size', '1024', '-fflags', '+genpts', '-probesize', '2M', '-analyzeduration', '1500000',
    '-i', 'pipe:0'];
}

function audioArgs(o) {
  return ['-af', 'aresample=async=1000', '-c:a', 'aac', '-b:a', (Number(o.audioBitrate) || 160) + 'k',
    '-ar', String(Number(o.sampleRate) || 48000), '-ac', '2'];
}

function parseStats(line) {
  const out = {};
  const m = (re) => { const r = line.match(re); return r ? r[1] : null; };
  const fps = m(/fps=\s*([\d.]+)/); if (fps) out.fps = Number(fps);
  const br = m(/bitrate=\s*([\d.]+)kbits/); if (br) out.kbps = Number(br);
  const sp = m(/speed=\s*([\d.]+)x/); if (sp) out.speed = Number(sp);
  const dr = m(/drop=\s*(\d+)/); if (dr) out.drop = Number(dr);
  const du = m(/dup=\s*(\d+)/); if (du) out.dup = Number(du);
  const sz = m(/size=\s*(\d+)\s*[kK]i?B/); if (sz) out.sizeKB = Number(sz);
  const t = m(/time=\s*([\d:.]+)/); if (t) out.time = t;
  return out;
}

function lineSplitter(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString();
    const parts = buf.split(/[\r\n]+/);
    buf = parts.pop();
    for (const p of parts) if (p.trim()) onLine(p.trim());
  };
}

function rtmpUrl(server, key) {
  const s = String(server || '').trim().replace(/\/+$/, '');
  const k = String(key || '').trim().replace(/^\/+/, '');
  return k ? `${s}/${k}` : s;
}

// ---------------------------------------------------------------------------------------------
class Streamer {
  constructor(send) {
    this.send = send; // (channel, payload) -> renderer
    this.stream = null;
    this.record = null;
  }

  // ------------------------------ STREAMING ------------------------------
  startStream(cfg) {
    if (this.stream) this.stopStream(true);
    const o = cfg.output;
    const s = {
      startedAt: Date.now(), stopping: false, encoders: {}, dests: {}, cfg,
    };
    this.stream = s;
    const orientations = [...new Set(cfg.destinations.map((d) => d.orientation === 'vertical' ? 'vertical' : 'landscape'))];
    for (const orient of orientations) {
      const args = [...inputArgs(), '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', videoFilter(o, orient), ...videoEncoderArgs(o, Number(o.fps) || 30), ...audioArgs(o),
        '-bsf:v', 'dump_extra=freq=keyframe',
        '-f', 'mpegts', '-mpegts_flags', '+resend_headers', '-muxdelay', '0', '-flush_packets', '1', 'pipe:1'];
      const proc = spawnFfmpeg(args);
      const enc = { proc, orient, stats: {}, lastErr: '', alive: true };
      s.encoders[orient] = enc;
      proc.stdin.on('error', () => {});
      proc.stdout.on('data', (chunk) => {
        for (const d of Object.values(s.dests)) {
          if (d.orient === orient && d.proc && d.writable) {
            try { d.proc.stdin.write(chunk); } catch {}
          }
        }
      });
      proc.stderr.on('data', lineSplitter((line) => {
        if (/frame=/.test(line)) enc.stats = { ...enc.stats, ...parseStats(line) };
        else { enc.lastErr = line; this.log('encoder', orient, line); }
      }));
      proc.on('exit', (code) => {
        enc.alive = false;
        if (!s.stopping) {
          this.send('stream:error', { message: `Encoder (${orient}) stopped: ${enc.lastErr || 'exit code ' + code}` });
          this.stopStream(true);
        } else {
          // Encoder flushed — now close the relays
          for (const d of Object.values(s.dests)) if (d.orient === orient) { d.writable = false; try { d.proc.stdin.end(); } catch {} }
        }
      });
      proc.on('error', (e) => this.send('stream:error', { message: 'Could not start ffmpeg: ' + e.message }));
    }
    for (const d of cfg.destinations) {
      s.dests[d.id] = {
        id: d.id, name: d.name, url: rtmpUrl(d.server, d.key), orient: d.orientation === 'vertical' ? 'vertical' : 'landscape',
        state: 'connecting', retries: 0, stats: {}, lastErr: '', proc: null, writable: false, liveSince: 0,
      };
      this.startRelay(s, s.dests[d.id]);
    }
    s.timer = setInterval(() => this.emitStatus(), 1000);
    this.emitStatus();
    return { ok: true };
  }

  startRelay(s, d) {
    if (this.stream !== s || s.stopping) return;
    const args = ['-hide_banner', '-loglevel', 'warning', '-stats_period', '1', '-stats',
      '-f', 'mpegts', '-i', 'pipe:0', '-map', '0', '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
      '-f', 'flv', '-flvflags', 'no_duration_filesize', '-rtmp_live', 'live', d.url];
    d.state = d.retries ? 'reconnecting' : 'connecting';
    d.stats = {};
    const proc = spawnFfmpeg(args);
    d.proc = proc;
    d.writable = true;
    proc.stdin.on('error', () => { d.writable = false; });
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', lineSplitter((line) => {
      if (/size=/.test(line) && /bitrate=/.test(line)) {
        const st = parseStats(line);
        d.stats = st;
        if (st.sizeKB > 0 && d.state !== 'live') { d.state = 'live'; d.liveSince = Date.now(); }
      } else {
        d.lastErr = line.replace(d.url, '[stream url]');
        this.log('relay', d.name, d.lastErr);
      }
    }));
    proc.on('error', (e) => { d.lastErr = e.message; });
    proc.on('exit', () => {
      d.writable = false;
      d.proc = null;
      if (this.stream !== s || s.stopping) { d.state = 'stopped'; this.emitStatus(); return; }
      const adv = s.cfg.advanced || {};
      if (d.liveSince && Date.now() - d.liveSince > 60000) d.retries = 0; // was healthy — reset budget
      if (adv.autoReconnect !== false && d.retries < (Number(adv.maxRetries) || 20)) {
        d.retries++;
        d.state = 'reconnecting';
        d.liveSince = 0;
        setTimeout(() => this.startRelay(s, d), (Number(adv.retryDelay) || 5) * 1000);
      } else {
        d.state = 'failed';
      }
      this.emitStatus();
    });
  }

  retryDestination(id) {
    const s = this.stream; if (!s) return;
    const d = s.dests[id]; if (!d || d.proc) return;
    d.retries = 0;
    this.startRelay(s, d);
  }

  stopDestination(id) {
    const s = this.stream; if (!s) return;
    const d = s.dests[id]; if (!d) return;
    d.retries = 1e9; // prevent reconnect
    if (d.proc) { try { d.proc.stdin.end(); } catch {} setTimeout(() => { try { d.proc && d.proc.kill(); } catch {} }, 3000); }
  }

  streamData(buf) {
    const s = this.stream; if (!s || s.stopping) return;
    const b = Buffer.from(buf);
    if (process.env.SS_DUMP) require('fs').appendFileSync(process.env.SS_DUMP, b);
    for (const e of Object.values(s.encoders)) if (e.alive) { try { e.proc.stdin.write(b); } catch {} }
  }

  stopStream(force = false) {
    const s = this.stream; if (!s) return;
    s.stopping = true;
    for (const e of Object.values(s.encoders)) { try { e.proc.stdin.end(); } catch {} }
    const kill = () => {
      for (const e of Object.values(s.encoders)) { try { e.proc.kill(); } catch {} }
      for (const d of Object.values(s.dests)) { try { d.proc && d.proc.kill(); } catch {} }
    };
    setTimeout(kill, force ? 500 : 6000);
    clearInterval(s.timer);
    this.stream = null;
    this.send('stream:status', { active: false });
  }

  emitStatus() {
    const s = this.stream; if (!s) return;
    const dests = {};
    for (const d of Object.values(s.dests)) {
      dests[d.id] = { id: d.id, name: d.name, state: d.state, retries: d.retries, kbps: d.stats.kbps || 0, error: d.state === 'live' ? '' : d.lastErr };
    }
    const encoders = {};
    for (const [k, e] of Object.entries(s.encoders)) encoders[k] = { ...e.stats, alive: e.alive };
    this.send('stream:status', { active: true, startedAt: s.startedAt, dests, encoders });
  }

  // ------------------------------ RECORDING ------------------------------
  startRecord(cfg) {
    if (this.record) this.stopRecord();
    const o = cfg.output;
    const r = cfg.record;
    const fmt = r.format || 'mkv';
    const muxer = { mkv: 'matroska', mp4: 'mp4', mov: 'mov', flv: 'flv', ts: 'mpegts' }[fmt] || 'matroska';
    const encOpts = r.encoder === 'same' || !r.encoder
      ? { ...o, rateControl: 'CRF', crf: r.crf ?? 20 }
      : { ...o, encoder: r.encoder, rateControl: 'CRF', crf: r.crf ?? 20 };
    if (r.quality === 'stream') Object.assign(encOpts, { rateControl: o.rateControl, bitrate: o.bitrate });
    const args = [...inputArgs(), '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', videoFilter({ ...o, outW: r.outW || o.outW, outH: r.outH || o.outH }, 'landscape'),
      ...videoEncoderArgs(encOpts, Number(o.fps) || 30), ...audioArgs({ ...o, audioBitrate: r.audioBitrate || 192 })];
    if (muxer === 'mp4' || muxer === 'mov') args.push('-movflags', '+frag_keyframe+empty_moov+default_base_moof');
    args.push('-f', muxer, '-y', cfg.file);
    const proc = spawnFfmpeg(args);
    const rec = { proc, file: cfg.file, startedAt: Date.now(), stats: {}, lastErr: '' };
    this.record = rec;
    proc.stdin.on('error', () => {});
    proc.stderr.on('data', lineSplitter((line) => {
      if (/frame=/.test(line)) rec.stats = parseStats(line);
      else { rec.lastErr = line; this.log('record', line); }
    }));
    proc.on('exit', (code) => {
      const was = this.record === rec;
      if (was) this.record = null;
      this.send('record:status', { active: false, file: rec.file, code, error: code && !rec.stopping ? rec.lastErr : '' });
    });
    proc.on('error', (e) => this.send('record:status', { active: false, error: e.message }));
    rec.timer = setInterval(() => this.send('record:status', { active: true, file: rec.file, startedAt: rec.startedAt, ...rec.stats }), 1000);
    return { ok: true, file: cfg.file };
  }

  recordData(buf) {
    if (this.record && this.record.proc) { try { this.record.proc.stdin.write(Buffer.from(buf)); } catch {} }
  }

  stopRecord() {
    const r = this.record; if (!r) return;
    r.stopping = true;
    clearInterval(r.timer);
    try { r.proc.stdin.end(); } catch {}
    setTimeout(() => { try { r.proc.kill(); } catch {} }, 10000);
  }

  log(...a) { if (process.env.SS_DEBUG) console.log('[ffmpeg]', ...a); }

  // App is closing: the renderer (input) is gone, so kill immediately instead of flushing a
  // truncated input (ffmpeg would otherwise re-read old data and append garbage).
  shutdown() {
    const s = this.stream;
    if (s) {
      s.stopping = true;
      clearInterval(s.timer);
      for (const e of Object.values(s.encoders)) { try { e.proc.kill(); } catch {} }
      for (const d of Object.values(s.dests)) { try { d.proc && d.proc.kill(); } catch {} }
      this.stream = null;
    }
    const r = this.record;
    if (r) { r.stopping = true; clearInterval(r.timer); try { r.proc.kill(); } catch {} this.record = null; }
  }
}

module.exports = { Streamer, rtmpUrl };
