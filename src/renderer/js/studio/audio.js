// WebAudio mixer. Every audio-producing source gets a Channel:
//   input → filters → sync delay → fader(volume/mute) ─┬→ gate (on only while in the LIVE scene) → master → stream
//                                                      ├→ monitor (headphones/speakers)
//                                                      └→ meters
// Sources that are only in the scene being edited never reach the stream mix.

const GATE_WORKLET = `
class NoiseGate extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [
    { name: 'open', defaultValue: -40 }, { name: 'close', defaultValue: -46 },
    { name: 'attack', defaultValue: 10 }, { name: 'hold', defaultValue: 150 }, { name: 'release', defaultValue: 150 } ]; }
  constructor() { super(); this.env = 0; this.gain = 0; this.holdLeft = 0; this.open = false; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    if (!inp.length) return true;
    const openT = Math.pow(10, p.open[0] / 20), closeT = Math.pow(10, p.close[0] / 20);
    const a = 1 / (sampleRate * Math.max(1, p.attack[0]) / 1000), r = 1 / (sampleRate * Math.max(1, p.release[0]) / 1000);
    const n = inp[0].length;
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < inp.length; c++) peak = Math.max(peak, Math.abs(inp[c][i]));
      this.env = Math.max(peak, this.env * 0.9995);
      if (this.env > openT) { this.open = true; this.holdLeft = sampleRate * p.hold[0] / 1000; }
      else if (this.env < closeT) { if (this.holdLeft > 0) this.holdLeft--; else this.open = false; }
      this.gain = this.open ? Math.min(1, this.gain + a) : Math.max(0, this.gain - r);
      for (let c = 0; c < out.length; c++) out[c][i] = (inp[c] || inp[0])[i] * this.gain;
    }
    return true;
  }
}
registerProcessor('noise-gate', NoiseGate);`;

export const AUDIO_FILTER_TYPES = {
  gain: { label: 'Gain', defaults: { db: 0 }, fields: [{ key: 'db', label: 'Gain', type: 'range', min: -30, max: 30, step: 0.5, unit: ' dB' }] },
  eq: { label: '3-Band EQ', defaults: { low: 0, mid: 0, high: 0 }, fields: [
    { key: 'low', label: 'Low (250 Hz)', type: 'range', min: -20, max: 20, step: 0.5, unit: ' dB' },
    { key: 'mid', label: 'Mid (1 kHz)', type: 'range', min: -20, max: 20, step: 0.5, unit: ' dB' },
    { key: 'high', label: 'High (4 kHz)', type: 'range', min: -20, max: 20, step: 0.5, unit: ' dB' }] },
  highpass: { label: 'Low cut (high-pass)', defaults: { freq: 80 }, fields: [{ key: 'freq', label: 'Cut below', type: 'range', min: 20, max: 400, unit: ' Hz' }] },
  compressor: { label: 'Compressor', defaults: { threshold: -18, ratio: 4, attack: 6, release: 60, makeup: 0 }, fields: [
    { key: 'threshold', label: 'Threshold', type: 'range', min: -60, max: 0, unit: ' dB' },
    { key: 'ratio', label: 'Ratio', type: 'range', min: 1, max: 20, step: 0.5, unit: ':1' },
    { key: 'attack', label: 'Attack', type: 'range', min: 1, max: 200, unit: ' ms' },
    { key: 'release', label: 'Release', type: 'range', min: 10, max: 1000, unit: ' ms' },
    { key: 'makeup', label: 'Output gain', type: 'range', min: 0, max: 24, step: 0.5, unit: ' dB' }] },
  limiter: { label: 'Limiter', defaults: { threshold: -3 }, fields: [{ key: 'threshold', label: 'Ceiling', type: 'range', min: -20, max: 0, step: 0.5, unit: ' dB' }] },
  gate: { label: 'Noise gate', defaults: { open: -40, close: -46, attack: 10, hold: 150, release: 150 }, fields: [
    { key: 'open', label: 'Open threshold', type: 'range', min: -80, max: 0, unit: ' dB' },
    { key: 'close', label: 'Close threshold', type: 'range', min: -80, max: 0, unit: ' dB' },
    { key: 'attack', label: 'Attack', type: 'range', min: 1, max: 100, unit: ' ms' },
    { key: 'hold', label: 'Hold', type: 'range', min: 0, max: 1000, unit: ' ms' },
    { key: 'release', label: 'Release', type: 'range', min: 10, max: 1000, unit: ' ms' }] },
};

const dbToGain = (db) => Math.pow(10, db / 20);

export class AudioEngine {
  constructor(sampleRate = 48000) {
    this.ctx = new AudioContext({ sampleRate, latencyHint: 'interactive' });
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.dest = ctx.createMediaStreamDestination();
    this.dest.channelCount = 2;
    this.master.connect(this.dest);
    this.masterMeter = new Meter(ctx);
    this.master.connect(this.masterMeter.input);
    this.monitorBus = ctx.createGain();
    this.monitorBus.connect(ctx.destination);
    // Keeps the audio track alive (constant timestamps) even when nothing is making sound
    const keep = ctx.createConstantSource();
    keep.offset.value = 0;
    keep.connect(this.master);
    keep.start();
    this.channels = new Map();
    this.workletReady = ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([GATE_WORKLET], { type: 'text/javascript' }))).then(() => true).catch((e) => { console.warn('gate worklet', e); return false; });
    const resume = () => { if (ctx.state !== 'running') ctx.resume(); };
    addEventListener('pointerdown', resume, { capture: true });
    addEventListener('keydown', resume, { capture: true });
    resume();
  }

  async setMonitorDevice(id) {
    try { if (this.ctx.setSinkId) await this.ctx.setSinkId(id === 'default' || !id ? '' : id); } catch (e) { console.warn('setSinkId', e); }
  }

  channel(source) {
    let ch = this.channels.get(source.id);
    if (!ch) { ch = new Channel(this, source); this.channels.set(source.id, ch); }
    return ch;
  }

  removeChannel(id) {
    const ch = this.channels.get(id);
    if (ch) { ch.destroy(); this.channels.delete(id); }
  }
}

class Meter {
  constructor(ctx) {
    this.input = ctx.createGain();
    const split = ctx.createChannelSplitter(2);
    this.input.connect(split);
    this.a = [ctx.createAnalyser(), ctx.createAnalyser()];
    this.a.forEach((an, i) => { an.fftSize = 1024; split.connect(an, i); });
    this.buf = new Float32Array(1024);
    this.peak = [0, 0];
    this.hold = [0, 0];
  }
  read() {
    const out = [];
    for (let i = 0; i < 2; i++) {
      this.a[i].getFloatTimeDomainData(this.buf);
      let p = 0;
      for (let k = 0; k < this.buf.length; k++) { const v = Math.abs(this.buf[k]); if (v > p) p = v; }
      this.peak[i] = Math.max(p, this.peak[i] * 0.85);
      this.hold[i] = Math.max(this.peak[i], this.hold[i] - 0.004);
      out.push({ level: this.peak[i], hold: this.hold[i] });
    }
    return out;
  }
}

class Channel {
  constructor(engine, source) {
    const ctx = engine.ctx;
    this.engine = engine;
    this.source = source;
    this.input = ctx.createGain();
    this.filterOut = ctx.createGain();
    this.delay = ctx.createDelay(3);
    this.fader = ctx.createGain();
    this.gate = ctx.createGain();
    this.gate.gain.value = 0;
    this.toMaster = ctx.createGain();
    this.monitor = ctx.createGain();
    this.monitor.gain.value = 0;
    this.meter = new Meter(ctx);
    this.nodes = [];
    this.input.connect(this.filterOut); // replaced by rebuildFilters
    this.filterOut.connect(this.delay);
    this.delay.connect(this.fader);
    this.fader.connect(this.meter.input);
    this.fader.connect(this.gate);
    this.gate.connect(this.toMaster);
    this.toMaster.connect(engine.master);
    this.fader.connect(this.monitor);
    this.monitor.connect(engine.monitorBus);
    this.inputNode = null;
    this.active = false;
    this.apply();
    this.rebuildFilters();
  }

  connectInput(node) {
    if (this.inputNode) { try { this.inputNode.disconnect(this.input); } catch {} }
    this.inputNode = node;
    if (node) node.connect(this.input);
  }

  apply() {
    const a = this.source.audio || {};
    const t = this.engine.ctx.currentTime;
    this.fader.gain.setTargetAtTime(a.muted ? 0 : (a.volume ?? 1), t, 0.02);
    this.delay.delayTime.setTargetAtTime(Math.max(0, (a.syncMs || 0) / 1000), t, 0.01);
    const mon = a.monitor || 'off';
    this.monitor.gain.setTargetAtTime(mon === 'off' ? 0 : 1, t, 0.02);
    this.toMaster.gain.setTargetAtTime(mon === 'monitorOnly' ? 0 : 1, t, 0.02);
  }

  setActive(on, rampSec = 0.25) {
    this.active = on;
    const g = this.gate.gain;
    const t = this.engine.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(on ? 1 : 0, t + Math.max(0.01, rampSec));
  }

  async rebuildFilters() {
    const ctx = this.engine.ctx;
    try { this.input.disconnect(); } catch {}
    this.nodes.forEach((n) => { try { n.disconnect(); } catch {} });
    this.nodes = [];
    let last = this.input;
    const push = (n) => { last.connect(n); last = n; this.nodes.push(n); };
    for (const f of this.source.audioFilters || []) {
      if (!f.enabled) continue;
      const s = f.settings || {};
      if (f.type === 'gain') { const g = ctx.createGain(); g.gain.value = dbToGain(s.db || 0); push(g); }
      if (f.type === 'eq') {
        const lo = ctx.createBiquadFilter(); lo.type = 'lowshelf'; lo.frequency.value = 250; lo.gain.value = s.low || 0; push(lo);
        const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 0.9; mid.gain.value = s.mid || 0; push(mid);
        const hi = ctx.createBiquadFilter(); hi.type = 'highshelf'; hi.frequency.value = 4000; hi.gain.value = s.high || 0; push(hi);
      }
      if (f.type === 'highpass') { const b = ctx.createBiquadFilter(); b.type = 'highpass'; b.frequency.value = s.freq || 80; b.Q.value = 0.7; push(b); }
      if (f.type === 'compressor' || f.type === 'limiter') {
        const c = ctx.createDynamicsCompressor();
        if (f.type === 'limiter') { c.threshold.value = s.threshold ?? -3; c.ratio.value = 20; c.attack.value = 0.001; c.release.value = 0.05; c.knee.value = 0; }
        else { c.threshold.value = s.threshold ?? -18; c.ratio.value = s.ratio ?? 4; c.attack.value = (s.attack ?? 6) / 1000; c.release.value = (s.release ?? 60) / 1000; c.knee.value = 6; }
        push(c);
        if (f.type === 'compressor' && s.makeup) { const g = ctx.createGain(); g.gain.value = dbToGain(s.makeup); push(g); }
      }
      if (f.type === 'gate' && (await this.engine.workletReady)) {
        const n = new AudioWorkletNode(ctx, 'noise-gate', { outputChannelCount: [2] });
        for (const k of ['open', 'close', 'attack', 'hold', 'release']) n.parameters.get(k).value = s[k] ?? AUDIO_FILTER_TYPES.gate.defaults[k];
        push(n);
      }
    }
    last.connect(this.filterOut);
  }

  levels() { return this.meter.read(); }

  destroy() {
    for (const n of [this.input, this.filterOut, this.delay, this.fader, this.gate, this.toMaster, this.monitor, ...this.nodes]) { try { n.disconnect(); } catch {} }
    if (this.inputNode) { try { this.inputNode.disconnect(); } catch {} }
  }
}

export const gainToDb = (g) => (g <= 0.00001 ? -Infinity : 20 * Math.log10(g));
export { dbToGain };
