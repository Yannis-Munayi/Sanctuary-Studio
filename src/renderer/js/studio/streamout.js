// Feeds the program canvas + stream audio mix into ffmpeg (main process) via MediaRecorder.
import { settings, bus } from '../state.js';
import { toast } from '../util.js';

const MIME_CANDIDATES = [
  'video/x-matroska;codecs=avc1,opus',
  'video/webm;codecs=h264,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm',
];

function pickMime() { return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || ''; }

class Feed {
  constructor(stream, bitrate, send) {
    this.q = Promise.resolve();
    this.rec = new MediaRecorder(stream, { mimeType: pickMime(), videoBitsPerSecond: bitrate, audioBitsPerSecond: 256000 });
    this.rec.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      const blob = e.data;
      this.q = this.q.then(async () => send(new Uint8Array(await blob.arrayBuffer())));
    };
    this.rec.onerror = (e) => { toast('Encoder input error: ' + (e.error && e.error.message), 'error'); };
  }
  start() { this.rec.start(100); }
  stop() {
    return new Promise((resolve) => {
      if (this.rec.state === 'inactive') return resolve();
      this.rec.onstop = () => this.q.then(resolve);
      this.rec.stop();
    });
  }
}

export class StreamOut {
  constructor(compositor, audio) {
    this.comp = compositor;
    this.audio = audio;
    this.streamFeed = null;
    this.recFeed = null;
    this.streamStatus = { active: false };
    this.recStatus = { active: false };
    this.starting = false;
    window.api.stream.onStatus((st) => { this.streamStatus = st; if (!st.active && this.streamFeed) this.cleanupStream(); bus.emit('stream-status', st); this.updateBusy(); });
    window.api.stream.onError((e) => { toast(e.message, 'error', 9000); });
    window.api.record.onStatus((st) => {
      const wasActive = this.recStatus.active;
      this.recStatus = st;
      if (!st.active && this.recFeed) { this.recFeed.stop(); this.recFeed = null; }
      if (!st.active && wasActive) {
        if (st.error) toast('Recording stopped: ' + st.error, 'error', 9000);
        else if (st.file) toast('Recording saved: ' + st.file, 'ok', 6000);
      }
      bus.emit('record-status', st); this.updateBusy();
    });
  }

  updateBusy() { window.api.setBusy(!!(this.streamStatus.active || this.recStatus.active)); }

  mediaStream() {
    const fps = Number(settings.video.fps) || 30;
    if (!this.canvasStream) this.canvasStream = this.comp.program.captureStream(fps);
    const v = this.canvasStream.getVideoTracks()[0];
    const a = this.audio.dest.stream.getAudioTracks()[0];
    return new MediaStream([v, a]);
  }

  intermediateBitrate(kbps) {
    const o = settings.stream;
    if (o.intermediateMbps > 0) return o.intermediateMbps * 1e6;
    const px = settings.video.baseW * settings.video.baseH;
    const base = px >= 1920 * 1080 ? 14e6 : 9e6;
    return Math.max(base, (kbps || 4500) * 3000);
  }

  outputConfig() {
    return { ...settings.stream, ...settings.video, fps: Number(settings.video.fps) || 30 };
  }

  get streaming() { return !!this.streamFeed; }
  get recording() { return !!this.recFeed; }

  async startStream(destinations) {
    if (this.streamFeed || this.starting) return false;
    if (!destinations.length) { toast('Pick at least one platform to stream to', 'warn'); return false; }
    this.starting = true;
    try {
      if (this.audio.ctx.state !== 'running') await this.audio.ctx.resume();
      const feed = new Feed(this.mediaStream(), this.intermediateBitrate(settings.stream.bitrate), (buf) => window.api.stream.data(buf));
      const res = await window.api.stream.start({ output: this.outputConfig(), destinations, advanced: settings.advanced });
      if (!res || !res.ok) { toast(res && res.error ? res.error : 'Could not start the stream', 'error', 8000); return false; }
      feed.start();
      this.streamFeed = feed;
      if (settings.record.withStream && !this.recFeed) this.startRecord();
      return true;
    } catch (e) {
      toast('Stream failed: ' + e.message, 'error', 8000);
      return false;
    } finally { this.starting = false; }
  }

  async stopStream() {
    const f = this.streamFeed;
    if (!f) { await window.api.stream.stop(); return; }
    this.streamFeed = null;
    await f.stop();
    await window.api.stream.stop();
  }

  cleanupStream() { const f = this.streamFeed; this.streamFeed = null; if (f) f.stop(); }

  async startRecord() {
    if (this.recFeed) return false;
    if (this.audio.ctx.state !== 'running') await this.audio.ctx.resume();
    const feed = new Feed(this.mediaStream(), this.intermediateBitrate(settings.stream.bitrate * 1.5), (buf) => window.api.record.data(buf));
    const res = await window.api.record.start({ output: this.outputConfig(), record: settings.record });
    if (!res || !res.ok) { toast('Could not start recording', 'error'); return false; }
    feed.start();
    this.recFeed = feed;
    toast('Recording to ' + res.file, 'info', 4000);
    return true;
  }

  async stopRecord() {
    const f = this.recFeed;
    this.recFeed = null;
    if (f) await f.stop();
    await window.api.record.stop();
  }
}
