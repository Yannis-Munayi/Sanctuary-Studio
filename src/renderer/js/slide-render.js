// Shared slide renderer — used by the projector output windows, the Preview/Live monitors
// in the worship panel, and the scripture/lyrics source in the streaming compositor.
// All sizes in themes are expressed for a 1920×1080 canvas and scaled to the target.

export const DEFAULT_THEME = {
  id: 'default', name: 'Default',
  bg: { type: 'gradient', color: '#0c1a33', color2: '#27456f', angle: 135, path: '', dim: 0, fit: 'cover', loop: true },
  font: { family: 'Segoe UI', size: 80, minSize: 28, color: '#ffffff', bold: true, italic: false, align: 'center', valign: 'middle', lineHeight: 1.18, caps: false },
  outline: { enabled: false, color: '#000000', width: 3 },
  shadow: { enabled: true, color: '#000000', blur: 10, x: 2, y: 3 },
  margin: { l: 6, r: 6, t: 8, b: 8 },
  box: { enabled: false, color: '#000000', opacity: 0.45, radius: 12 },
  ref: { show: true, size: 40, color: '#e6e6e6', position: 'bottom', align: 'right', italic: false, bold: false },
  label: { show: false },
};

export function resolveTheme(t) {
  const d = DEFAULT_THEME;
  t = t || {};
  return {
    ...d, ...t,
    bg: { ...d.bg, ...(t.bg || {}) }, font: { ...d.font, ...(t.font || {}) }, outline: { ...d.outline, ...(t.outline || {}) },
    shadow: { ...d.shadow, ...(t.shadow || {}) }, margin: { ...d.margin, ...(t.margin || {}) }, box: { ...d.box, ...(t.box || {}) },
    ref: { ...d.ref, ...(t.ref || {}) },
  };
}

export function hexToRgba(hex, a = 1) {
  let h = String(hex || '#000').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function fontSpec(f, size) {
  return `${f.italic ? 'italic ' : ''}${f.bold ? '700 ' : '400 '}${Math.max(1, size)}px "${f.family}", "Segoe UI", sans-serif`;
}

// Word-wrap `text` (respecting explicit newlines) and find the largest font size that fits the box.
export function layoutText(ctx, text, boxW, boxH, f, maxSize, minSize, lineHeight = 1.2) {
  const paragraphs = String(text || '').split('\n');
  const wrapAt = (size) => {
    ctx.font = fontSpec(f, size);
    const lines = [];
    for (const para of paragraphs) {
      if (!para.trim()) { lines.push(''); continue; }
      const words = para.split(/\s+/).filter(Boolean);
      let line = '';
      for (const w of words) {
        const test = line ? line + ' ' + w : w;
        if (ctx.measureText(test).width <= boxW || !line) line = test;
        else { lines.push(line); line = w; }
      }
      if (line) lines.push(line);
    }
    return lines;
  };
  let lo = Math.max(4, minSize), hi = Math.max(lo, maxSize), best = lo, bestLines = null;
  // Quick accept at max size
  let lines = wrapAt(hi);
  if (fits(ctx, lines, hi, boxW, boxH, lineHeight)) return { size: hi, lines };
  for (let i = 0; i < 12 && hi - lo > 1; i++) {
    const mid = (lo + hi) / 2;
    lines = wrapAt(mid);
    if (fits(ctx, lines, mid, boxW, boxH, lineHeight)) { best = mid; bestLines = lines; lo = mid; } else hi = mid;
  }
  if (!bestLines) { best = lo; bestLines = wrapAt(lo); }
  return { size: Math.floor(best), lines: bestLines };
}

function fits(ctx, lines, size, boxW, boxH, lh) {
  if (lines.length * size * lh > boxH) return false;
  for (const l of lines) if (ctx.measureText(l).width > boxW * 1.001) return false;
  return true;
}

export function drawBackground(ctx, W, H, theme, media) {
  const bg = theme.bg;
  ctx.save();
  if ((bg.type === 'image' || bg.type === 'video') && media && (media.naturalWidth || media.videoWidth)) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    drawCover(ctx, media, W, H, bg.fit);
  } else if (bg.type === 'gradient') {
    const a = ((bg.angle ?? 135) * Math.PI) / 180;
    const cx = W / 2, cy = H / 2, r = Math.abs(W * Math.cos(a)) / 2 + Math.abs(H * Math.sin(a)) / 2;
    const g = ctx.createLinearGradient(cx - Math.cos(a) * r, cy - Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    g.addColorStop(0, bg.color); g.addColorStop(1, bg.color2 || bg.color);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  } else if (bg.type === 'transparent') {
    ctx.clearRect(0, 0, W, H);
  } else {
    ctx.fillStyle = bg.color || '#000'; ctx.fillRect(0, 0, W, H);
  }
  if (bg.dim > 0) { ctx.fillStyle = `rgba(0,0,0,${bg.dim})`; ctx.fillRect(0, 0, W, H); }
  ctx.restore();
}

export function drawCover(ctx, media, W, H, fit = 'cover', x = 0, y = 0) {
  const mw = media.videoWidth || media.naturalWidth || media.width, mh = media.videoHeight || media.naturalHeight || media.height;
  if (!mw || !mh) return;
  if (fit === 'stretch') { ctx.drawImage(media, x, y, W, H); return; }
  const s = fit === 'contain' ? Math.min(W / mw, H / mh) : Math.max(W / mw, H / mh);
  const dw = mw * s, dh = mh * s;
  ctx.drawImage(media, x + (W - dw) / 2, y + (H - dh) / 2, dw, dh);
}

// slide: { text, reference, label }
export function drawSlideText(ctx, W, H, slide, theme, opts = {}) {
  if (!slide) return;
  const t = theme;
  const k = H / 1080;
  const f = t.font;
  const text = f.caps ? String(slide.text || '').toUpperCase() : String(slide.text || '');
  const m = t.margin;
  let bx = (W * m.l) / 100, by = (H * m.t) / 100;
  let bw = W - bx - (W * m.r) / 100, bh = H - by - (H * m.b) / 100;
  const showRef = t.ref.show && slide.reference && opts.showReference !== false;
  const refSize = t.ref.size * k;
  let refY = 0;
  if (showRef && t.ref.position !== 'after') {
    const refH = refSize * 1.7;
    if (t.ref.position === 'top') { refY = by + refSize; by += refH; bh -= refH; } else { bh -= refH; refY = by + bh + refH * 0.72; }
  }
  const lh = f.lineHeight || 1.2;
  let { size, lines } = layoutText(ctx, text, bw, bh - (showRef && t.ref.position === 'after' ? refSize * 1.6 : 0), f, f.size * k, (f.minSize || 20) * k, lh);
  const blockH = lines.length * size * lh;
  let y0 = f.valign === 'top' ? by : f.valign === 'bottom' ? by + bh - blockH : by + (bh - blockH) / 2;
  if (showRef && t.ref.position === 'after' && f.valign === 'middle') y0 -= (refSize * 1.6) / 2;
  const xFor = (align) => (align === 'left' ? bx : align === 'right' ? bx + bw : bx + bw / 2);

  ctx.save();
  if (t.box.enabled && text.trim()) {
    ctx.font = fontSpec(f, size);
    const maxW = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const pad = size * 0.45;
    const x = f.align === 'left' ? bx - pad : f.align === 'right' ? bx + bw - maxW - pad : bx + (bw - maxW) / 2 - pad;
    ctx.fillStyle = hexToRgba(t.box.color, t.box.opacity);
    roundRect(ctx, x, y0 - pad * 0.6, maxW + pad * 2, blockH + pad * 1.2, (t.box.radius || 0) * k);
    ctx.fill();
  }
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = f.align === 'left' ? 'left' : f.align === 'right' ? 'right' : 'center';
  ctx.font = fontSpec(f, size);
  const x = xFor(f.align);
  lines.forEach((line, i) => {
    const y = y0 + i * size * lh + size * 0.86;
    paintText(ctx, line, x, y, f.color, t, k);
  });
  if (showRef) {
    const rf = { ...f, size: t.ref.size, bold: t.ref.bold, italic: t.ref.italic };
    ctx.font = fontSpec(rf, refSize);
    ctx.textAlign = t.ref.align === 'left' ? 'left' : t.ref.align === 'center' ? 'center' : 'right';
    const ry = t.ref.position === 'after' ? y0 + blockH + refSize * 1.25 : refY;
    paintText(ctx, slide.reference, xFor(t.ref.align), ry, t.ref.color, t, k);
  }
  ctx.restore();
}

function paintText(ctx, str, x, y, color, t, k) {
  if (t.shadow.enabled) {
    ctx.shadowColor = t.shadow.color; ctx.shadowBlur = t.shadow.blur * k;
    ctx.shadowOffsetX = t.shadow.x * k; ctx.shadowOffsetY = t.shadow.y * k;
  }
  if (t.outline.enabled && t.outline.width > 0) {
    ctx.lineJoin = 'round';
    ctx.strokeStyle = t.outline.color; ctx.lineWidth = t.outline.width * 2 * k;
    ctx.strokeText(str, x, y);
    ctx.shadowColor = 'transparent';
  }
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
  ctx.shadowColor = 'transparent';
}

export function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Media cache so thumbnails/monitors don't reload the same image repeatedly
const mediaCache = new Map();
export function loadImage(url, onload) {
  if (!url) return null;
  let img = mediaCache.get(url);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.src = url;
    mediaCache.set(url, img);
    if (mediaCache.size > 200) mediaCache.delete(mediaCache.keys().next().value);
  }
  if (onload && !img.complete) img.addEventListener('load', onload, { once: true });
  return img;
}
