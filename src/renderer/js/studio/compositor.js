// Renders scenes. Two independent outputs:
//   • edit canvas   — whatever scene you're editing (never streamed)
//   • program canvas — the LIVE scene (+ transition + downstream scripture/lyrics overlay); this is what's streamed/recorded
import { clamp } from '../util.js';
import { settings } from '../state.js';
import { cssFilter, frameFilter, ChromaKeyer } from './filters.js';
import { roundRect } from '../slide-render.js';

const TICKER = `let t=null;onmessage=(e)=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data);};`;

export const TRANSITIONS = [
  { value: 'cut', label: 'Cut' }, { value: 'fade', label: 'Fade' }, { value: 'fadeColor', label: 'Fade to colour' },
  { value: 'slideLeft', label: 'Slide left' }, { value: 'slideRight', label: 'Slide right' }, { value: 'slideUp', label: 'Slide up' },
  { value: 'swipeLeft', label: 'Swipe left' }, { value: 'swipeRight', label: 'Swipe right' }, { value: 'wipe', label: 'Wipe' }, { value: 'zoom', label: 'Zoom' },
];

const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

export class Compositor {
  constructor(studio) {
    this.studio = studio;
    this.program = document.createElement('canvas');
    this.preview = document.createElement('canvas');
    this.offA = document.createElement('canvas');
    this.offB = document.createElement('canvas');
    this.thumbs = new Map();
    this.transition = null;
    this.stack = new Set();
    this.onFrame = [];
    this.previewScale = 0.5;
    this.frames = 0; this.fps = 0; this.lastFpsT = performance.now();
    this.renderMs = 0;
    this.thumbIndex = 0; this.lastThumb = 0;
    this.resize();
    this.worker = new Worker(URL.createObjectURL(new Blob([TICKER], { type: 'text/javascript' })));
    this.worker.onmessage = () => this.frame(performance.now());
  }

  get W() { return settings.video.baseW; }
  get H() { return settings.video.baseH; }

  resize() {
    const W = this.W, H = this.H;
    for (const c of [this.program, this.offA, this.offB]) { c.width = W; c.height = H; }
    this.previewScale = Math.min(1, 1280 / W);
    this.preview.width = Math.round(W * this.previewScale);
    this.preview.height = Math.round(H * this.previewScale);
    this.pctx = this.program.getContext('2d', { alpha: false });
    this.vctx = this.preview.getContext('2d', { alpha: false });
  }

  start() { this.worker.postMessage(1000 / (Number(settings.video.fps) || 30)); }
  setFps() { this.start(); }

  frame(now) {
    const t0 = performance.now();
    const S = this.studio;
    for (const rt of S.runtimes.values()) { try { rt.tick(now); } catch (e) { rt.error = e.message; } }
    this.renderProgram(now);
    if (S.previewVisible !== false) this.renderPreview();
    if (settings.general.thumbnails && now - this.lastThumb > 350) { this.lastThumb = now; this.renderNextThumb(); }
    for (const fn of this.onFrame) fn(now);
    this.renderMs = this.renderMs * 0.9 + (performance.now() - t0) * 0.1;
    this.frames++;
    if (now - this.lastFpsT >= 1000) { this.fps = (this.frames * 1000) / (now - this.lastFpsT); this.frames = 0; this.lastFpsT = now; }
  }

  // ------------------------------------------------ program ------------------------------------------------
  transitionTo(fromId, toId, type, duration) {
    if (!type || type === 'cut' || !duration || fromId === toId) { this.transition = null; return; }
    this.transition = { fromId, toId, type, dur: duration, start: performance.now() };
  }

  renderProgram(now) {
    const S = this.studio, ctx = this.pctx, W = this.W, H = this.H;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const tr = this.transition;
    if (tr) {
      const p = clamp((now - tr.start) / tr.dur, 0, 1);
      if (p >= 1) { this.transition = null; }
      else {
        this.renderToCanvas(this.offA, S.scene(tr.fromId));
        this.renderToCanvas(this.offB, S.scene(tr.toId));
        this.compose(ctx, W, H, tr.type, ease(p));
        this.drawOverlay(ctx);
        return;
      }
    }
    this.renderScene(ctx, S.scene(S.data.programId), W, H);
    this.drawOverlay(ctx);
  }

  drawOverlay(ctx) {
    const S = this.studio;
    if (!settings.worship.streamOverlay) return;
    const rt = S.runtimes.get(S.data.overlaySourceId);
    const f = rt && rt.frame();
    if (f) ctx.drawImage(f, 0, 0, this.W, this.H);
  }

  renderToCanvas(c, scene) {
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
    this.renderScene(ctx, scene, c.width, c.height);
  }

  compose(ctx, W, H, type, p) {
    const A = this.offA, B = this.offB;
    switch (type) {
      case 'fade': ctx.drawImage(A, 0, 0); ctx.globalAlpha = p; ctx.drawImage(B, 0, 0); break;
      case 'fadeColor': {
        ctx.drawImage(p < 0.5 ? A : B, 0, 0);
        ctx.globalAlpha = p < 0.5 ? p * 2 : (1 - p) * 2;
        ctx.fillStyle = settings.transition.color || '#000'; ctx.fillRect(0, 0, W, H);
        break;
      }
      case 'slideLeft': ctx.drawImage(A, -p * W, 0); ctx.drawImage(B, (1 - p) * W, 0); break;
      case 'slideRight': ctx.drawImage(A, p * W, 0); ctx.drawImage(B, -(1 - p) * W, 0); break;
      case 'slideUp': ctx.drawImage(A, 0, -p * H); ctx.drawImage(B, 0, (1 - p) * H); break;
      case 'swipeLeft': ctx.drawImage(A, 0, 0); ctx.drawImage(B, (1 - p) * W, 0); break;
      case 'swipeRight': ctx.drawImage(A, 0, 0); ctx.drawImage(B, -(1 - p) * W, 0); break;
      case 'wipe': ctx.drawImage(A, 0, 0); ctx.drawImage(B, 0, 0, p * W, H, 0, 0, p * W, H); break;
      case 'zoom': {
        ctx.drawImage(A, 0, 0);
        const s = 0.6 + 0.4 * p;
        ctx.globalAlpha = p;
        ctx.drawImage(B, (W - W * s) / 2, (H - H * s) / 2, W * s, H * s);
        break;
      }
      default: ctx.drawImage(B, 0, 0);
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------ preview ------------------------------------------------
  renderPreview() {
    const S = this.studio, ctx = this.vctx, s = this.previewScale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, this.preview.width, this.preview.height);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    this.renderScene(ctx, S.scene(S.data.editId), this.W, this.H, s, true);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  renderNextThumb() {
    const scenes = this.studio.data.scenes;
    if (!scenes.length) return;
    this.thumbIndex = (this.thumbIndex + 1) % scenes.length;
    const sc = scenes[this.thumbIndex];
    let c = this.thumbs.get(sc.id);
    if (!c) { c = document.createElement('canvas'); c.width = 192; c.height = 108; this.thumbs.set(sc.id, c); }
    const ctx = c.getContext('2d');
    const s = c.width / this.W;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    this.renderScene(ctx, sc, this.W, this.H, s);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.studio.onThumb && this.studio.onThumb(sc.id, c);
  }

  // ------------------------------------------------ scene rendering ------------------------------------------------
  renderNested(sceneId, ctx, W, H) {
    if (this.stack.has(sceneId)) return; // prevent a scene containing itself
    this.renderScene(ctx, this.studio.scene(sceneId), W, H);
  }

  renderScene(ctx, scene, W, H, scale = 1, isEditor = false) {
    if (!scene) return;
    if (this.stack.has(scene.id)) return;
    this.stack.add(scene.id);
    try {
      for (const item of scene.items) {
        if (!item.visible) continue;
        const src = this.studio.data.sources[item.sourceId];
        const rt = this.studio.runtimes.get(item.sourceId);
        if (!src || !rt) continue;
        this.drawItem(ctx, item, src, rt, scale, isEditor);
      }
    } finally { this.stack.delete(scene.id); }
  }

  drawItem(ctx, item, src, rt, scale, isEditor) {
    let f = rt.frame();
    if (!f) {
      if (isEditor && !this.studio.typeOf(src).audioOnly) {
        ctx.save();
        ctx.strokeStyle = rt.error ? 'rgba(255,90,90,.7)' : 'rgba(255,255,255,.25)';
        ctx.setLineDash([12, 8]); ctx.lineWidth = 2 / scale;
        ctx.strokeRect(item.x, item.y, item.w, item.h);
        ctx.fillStyle = rt.error ? 'rgba(255,120,120,.9)' : 'rgba(255,255,255,.5)';
        ctx.font = `${24}px Segoe UI`; ctx.textAlign = 'center';
        const label = rt.error || (src.type === 'worship' ? '✝ Scripture / lyrics appear here when live' : src.type === 'video' && !src.settings.path ? 'No video file chosen' : `${src.name} (loading…)`);
        ctx.fillText(label, item.x + item.w / 2, item.y + item.h / 2, item.w - 20);
        ctx.restore();
      }
      return;
    }
    const nw = rt.w || f.videoWidth || f.naturalWidth || f.width, nh = rt.h || f.videoHeight || f.naturalHeight || f.height;
    if (!nw || !nh) return;
    if (item.pendingSize || !item.nat || item.nat[0] !== nw || item.nat[1] !== nh) this.studio.autoSize(item, nw, nh);
    const fw = f.videoWidth || f.naturalWidth || f.width, fh = f.videoHeight || f.naturalHeight || f.height;
    const kx = fw / nw, ky = fh / nh;
    const c = item.crop || { l: 0, t: 0, r: 0, b: 0 };
    const cw = Math.max(1, nw - c.l - c.r), ch = Math.max(1, nh - c.t - c.b);
    // fit
    let dx = 0, dy = 0, dw = item.w, dh = item.h;
    const fit = item.fit || 'stretch';
    if (fit === 'fit' || fit === 'fill') {
      const s = fit === 'fit' ? Math.min(item.w / cw, item.h / ch) : Math.max(item.w / cw, item.h / ch);
      dw = cw * s; dh = ch * s; dx = (item.w - dw) / 2; dy = (item.h - dh) / 2;
    }
    const filters = src.filters || [];
    const chroma = filters.find((x) => x.enabled && x.type === 'chroma');
    if (chroma) {
      rt._chroma ||= new ChromaKeyer();
      f = rt._chroma.process(f, fw, fh, chroma.settings);
    }
    const frameF = frameFilter(filters);
    ctx.save();
    ctx.translate(item.x + item.w / 2, item.y + item.h / 2);
    if (item.rot) ctx.rotate((item.rot * Math.PI) / 180);
    ctx.scale(item.flipH ? -1 : 1, item.flipV ? -1 : 1);
    ctx.translate(-item.w / 2, -item.h / 2);
    ctx.globalAlpha = item.opacity ?? 1;
    if (fit === 'fill') { ctx.beginPath(); ctx.rect(0, 0, item.w, item.h); ctx.clip(); }
    if (frameF) {
      if (frameF.shadow > 0) {
        ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = frameF.shadow; ctx.shadowOffsetY = frameF.shadow / 4;
        ctx.fillStyle = '#000'; roundRect(ctx, dx, dy, dw, dh, frameF.radius || 0); ctx.fill(); ctx.restore();
      }
      if (frameF.radius > 0) { roundRect(ctx, dx, dy, dw, dh, frameF.radius); ctx.clip(); }
    }
    const filt = cssFilter(filters, scale);
    if (filt !== 'none') ctx.filter = filt;
    try { ctx.drawImage(f, c.l * kx, c.t * ky, cw * kx, ch * ky, dx, dy, dw, dh); } catch {}
    ctx.filter = 'none';
    if (frameF && frameF.border > 0) {
      ctx.lineWidth = frameF.border * 2; ctx.strokeStyle = frameF.borderColor || '#fff';
      roundRect(ctx, dx, dy, dw, dh, frameF.radius || 0); ctx.stroke();
    }
    ctx.restore();
  }
}
