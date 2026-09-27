// Mouse/keyboard editing of scene items on the edit canvas (move, resize, crop, snap).
import { settings } from '../state.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HPOS = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
const CURSOR = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

export class SceneEditor {
  constructor(studio, overlay) {
    this.S = studio;
    this.c = overlay;
    this.ctx = overlay.getContext('2d');
    this.drag = null;
    this.hover = null;
    this.guides = [];
    overlay.tabIndex = 0;
    overlay.addEventListener('mousedown', (e) => this.down(e));
    overlay.addEventListener('mousemove', (e) => { if (!this.drag) this.hoverAt(e); });
    overlay.addEventListener('dblclick', (e) => { const it = this.hit(this.pt(e)); if (it) this.S.openProperties(it.sourceId); });
    overlay.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const it = this.hit(this.pt(e));
      if (it) { this.S.select(it.id); this.S.itemMenu(e.clientX, e.clientY, it); } else this.S.addMenu(e.clientX, e.clientY);
    });
    overlay.addEventListener('keydown', (e) => this.key(e));
    overlay.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
    overlay.addEventListener('drop', (e) => { e.preventDefault(); this.S.dropFiles(e.dataTransfer.files, this.pt(e)); });
    new ResizeObserver(() => this.fit()).observe(overlay);
  }

  fit() {
    const r = this.c.getBoundingClientRect();
    this.c.width = Math.max(1, Math.round(r.width * devicePixelRatio));
    this.c.height = Math.max(1, Math.round(r.height * devicePixelRatio));
  }

  get W() { return settings.video.baseW; }
  get H() { return settings.video.baseH; }
  get scene() { return this.S.scene(this.S.data.editId); }
  get sel() { const sc = this.scene; return sc && sc.items.find((i) => i.id === this.S.selectedItemId); }

  pt(e) {
    const r = this.c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * this.W, y: ((e.clientY - r.top) / r.height) * this.H };
  }

  // point -> item local coordinates (accounts for rotation)
  local(it, p) {
    const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
    const a = (-(it.rot || 0) * Math.PI) / 180;
    const dx = p.x - cx, dy = p.y - cy;
    return { x: dx * Math.cos(a) - dy * Math.sin(a) + it.w / 2, y: dx * Math.sin(a) + dy * Math.cos(a) + it.h / 2 };
  }

  hit(p) {
    const sc = this.scene;
    if (!sc) return null;
    for (let i = sc.items.length - 1; i >= 0; i--) {
      const it = sc.items[i];
      if (!it.visible || it.locked) continue;
      const src = this.S.data.sources[it.sourceId];
      if (src && this.S.typeOf(src).audioOnly) continue;
      const l = this.local(it, p);
      if (l.x >= 0 && l.y >= 0 && l.x <= it.w && l.y <= it.h) return it;
    }
    return null;
  }

  handleAt(it, p) {
    const l = this.local(it, p);
    const tol = (10 * this.W) / this.c.getBoundingClientRect().width;
    for (const hname of HANDLES) {
      const [fx, fy] = HPOS[hname];
      if (Math.abs(l.x - fx * it.w) <= tol && Math.abs(l.y - fy * it.h) <= tol) return hname;
    }
    return null;
  }

  hoverAt(e) {
    const p = this.pt(e);
    const s = this.sel;
    const hnd = s && !s.locked ? this.handleAt(s, p) : null;
    const it = this.hit(p);
    this.hover = it;
    this.c.style.cursor = hnd ? CURSOR[hnd] : it ? (it.locked ? 'default' : 'move') : 'default';
  }

  down(e) {
    if (e.button !== 0) return;
    this.c.focus();
    const p = this.pt(e);
    const s = this.sel;
    const hnd = s && !s.locked ? this.handleAt(s, p) : null;
    if (hnd) {
      this.startDrag(e, { mode: e.altKey ? 'crop' : 'resize', handle: hnd, item: s, start: p, orig: { ...s, crop: { ...(s.crop || { l: 0, t: 0, r: 0, b: 0 }) } } });
      return;
    }
    const it = this.hit(p);
    this.S.select(it ? it.id : null);
    if (it && !it.locked) this.startDrag(e, { mode: 'move', item: it, start: p, orig: { ...it } });
  }

  startDrag(e, d) {
    this.drag = d;
    const move = (ev) => this.move(ev);
    const up = () => {
      removeEventListener('mousemove', move); removeEventListener('mouseup', up);
      this.drag = null; this.guides = [];
      this.S.changed();
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  }

  move(e) {
    const d = this.drag; if (!d) return;
    const p = this.pt(e);
    const it = d.item, o = d.orig;
    const snap = settings.general.editorSnap !== false && !e.ctrlKey;
    const th = 14;
    this.guides = [];
    if (d.mode === 'move') {
      let x = o.x + (p.x - d.start.x), y = o.y + (p.y - d.start.y);
      if (snap && !it.rot) {
        const W = this.W, H = this.H;
        const xs = [[x, 0], [x + it.w, W], [x + it.w / 2, W / 2]];
        for (const [edge, target] of xs) if (Math.abs(edge - target) < th) { x += target - edge; this.guides.push({ x: target }); break; }
        const ys = [[y, 0], [y + it.h, H], [y + it.h / 2, H / 2]];
        for (const [edge, target] of ys) if (Math.abs(edge - target) < th) { y += target - edge; this.guides.push({ y: target }); break; }
      }
      it.x = Math.round(x); it.y = Math.round(y);
      this.S.itemMoved(it);
      return;
    }
    // resize / crop in the item's local (unrotated) axes
    const a = ((o.rot || 0) * Math.PI) / 180;
    const dxw = p.x - d.start.x, dyw = p.y - d.start.y;
    const dx = dxw * Math.cos(-a) - dyw * Math.sin(-a), dy = dxw * Math.sin(-a) + dyw * Math.cos(-a);
    const [fx, fy] = HPOS[d.handle];
    let l = 0, t = 0, r = o.w, b = o.h;
    if (fx === 0) l += dx; if (fx === 1) r += dx;
    if (fy === 0) t += dy; if (fy === 1) b += dy;
    const corner = fx !== 0.5 && fy !== 0.5;
    if (d.mode === 'resize' && corner && !e.shiftKey && o.w && o.h) {
      // keep aspect ratio
      const ar = o.w / o.h;
      let nw = r - l, nh = b - t;
      if (Math.abs(nw / o.w) > Math.abs(nh / o.h)) nh = nw / ar; else nw = nh * ar;
      if (fx === 0) l = r - nw; else r = l + nw;
      if (fy === 0) t = b - nh; else b = t + nh;
    }
    let nw = Math.max(8, r - l), nh = Math.max(8, b - t);
    if (fx === 0) l = r - nw;
    if (fy === 0) t = b - nh;
    // local offset of top-left -> world position (keep the opposite side fixed)
    const ocx = o.x + o.w / 2, ocy = o.y + o.h / 2;
    const ncxL = l + nw / 2 - o.w / 2, ncyL = t + nh / 2 - o.h / 2;
    const ncx = ocx + ncxL * Math.cos(a) - ncyL * Math.sin(a), ncy = ocy + ncxL * Math.sin(a) + ncyL * Math.cos(a);
    let nx = ncx - nw / 2, ny = ncy - nh / 2;
    if (snap && !o.rot && d.mode === 'resize') {
      const W = this.W, H = this.H;
      if (fx === 1 && Math.abs(nx + nw - W) < th) { nw = W - nx; this.guides.push({ x: W }); }
      if (fx === 0 && Math.abs(nx) < th) { nw += nx; nx = 0; this.guides.push({ x: 0 }); }
      if (fy === 1 && Math.abs(ny + nh - H) < th) { nh = H - ny; this.guides.push({ y: H }); }
      if (fy === 0 && Math.abs(ny) < th) { nh += ny; ny = 0; this.guides.push({ y: 0 }); }
    }
    if (d.mode === 'crop') {
      const rt = this.S.runtimes.get(it.sourceId);
      const nwSrc = (rt && rt.w) || o.w, nhSrc = (rt && rt.h) || o.h;
      const oc = o.crop;
      const pxX = (nwSrc - oc.l - oc.r) / o.w, pxY = (nhSrc - oc.t - oc.b) / o.h;
      const crop = { ...oc };
      if (fx === 0) crop.l = Math.max(0, oc.l + (o.w - nw) * pxX);
      if (fx === 1) crop.r = Math.max(0, oc.r + (o.w - nw) * pxX);
      if (fy === 0) crop.t = Math.max(0, oc.t + (o.h - nh) * pxY);
      if (fy === 1) crop.b = Math.max(0, oc.b + (o.h - nh) * pxY);
      for (const k of ['l', 'r', 't', 'b']) crop[k] = Math.round(crop[k]);
      it.crop = crop;
    }
    Object.assign(it, { x: Math.round(nx), y: Math.round(ny), w: Math.round(nw), h: Math.round(nh) });
    this.S.itemMoved(it);
  }

  key(e) {
    const it = this.sel;
    if (!it) return;
    const step = e.shiftKey ? 10 : 1;
    const k = e.key;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k)) {
      e.preventDefault(); e.stopPropagation();
      if (it.locked) return;
      if (k === 'ArrowLeft') it.x -= step; if (k === 'ArrowRight') it.x += step;
      if (k === 'ArrowUp') it.y -= step; if (k === 'ArrowDown') it.y += step;
      this.S.itemMoved(it); this.S.changed();
    } else if (k === 'Delete') { e.preventDefault(); e.stopPropagation(); this.S.removeItem(it.id); }
    else if (k === 'Escape') { this.S.select(null); }
  }

  draw() {
    const ctx = this.ctx, c = this.c;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const k = c.width / this.W;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const lw = 1 / k;
    const outline = (it, color, width = 1.5, dash = null) => {
      ctx.save();
      ctx.translate(it.x + it.w / 2, it.y + it.h / 2);
      ctx.rotate(((it.rot || 0) * Math.PI) / 180);
      ctx.strokeStyle = color; ctx.lineWidth = width * lw;
      if (dash) ctx.setLineDash(dash.map((x) => x * lw));
      ctx.strokeRect(-it.w / 2, -it.h / 2, it.w, it.h);
      ctx.restore();
    };
    if (this.hover && this.hover !== this.sel) outline(this.hover, 'rgba(120,170,255,.6)', 1, [4, 3]);
    const s = this.sel;
    if (s && s.visible) {
      const color = s.locked ? '#e5a13a' : '#3d8bff';
      outline(s, color, 2);
      if (!s.locked) {
        ctx.save();
        ctx.translate(s.x + s.w / 2, s.y + s.h / 2);
        ctx.rotate(((s.rot || 0) * Math.PI) / 180);
        const hs = 7 * lw;
        ctx.fillStyle = '#fff'; ctx.strokeStyle = color; ctx.lineWidth = 1.5 * lw;
        for (const hname of HANDLES) {
          const [fx, fy] = HPOS[hname];
          const x = -s.w / 2 + fx * s.w, y = -s.h / 2 + fy * s.h;
          ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs); ctx.strokeRect(x - hs / 2, y - hs / 2, hs, hs);
        }
        ctx.restore();
        const c2 = s.crop;
        if (c2 && (c2.l || c2.t || c2.r || c2.b)) {
          ctx.fillStyle = '#9ad'; ctx.font = `${11 * lw}px Segoe UI`;
          ctx.fillText(`crop ${c2.l},${c2.t},${c2.r},${c2.b}`, s.x + 4 * lw, s.y - 5 * lw);
        }
      }
    }
    if (this.guides.length) {
      ctx.strokeStyle = '#ff3fb4'; ctx.lineWidth = lw; ctx.setLineDash([6 * lw, 4 * lw]);
      for (const g of this.guides) {
        ctx.beginPath();
        if (g.x !== undefined) { ctx.moveTo(g.x, 0); ctx.lineTo(g.x, this.H); } else { ctx.moveTo(0, g.y); ctx.lineTo(this.W, g.y); }
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  }
}
