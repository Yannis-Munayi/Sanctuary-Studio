// Network output: serves the worship output page over HTTP so another machine, a browser
// source in OBS/vMix, or NDI Tools' "Screen Capture"/"Webcam Input" can pick it up.
// Only media files referenced by the current live state are served (never arbitrary files).
const http = require('http');
const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'renderer');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.m4v': 'video/mp4', '.avi': 'video/x-msvideo', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.svg': 'image/svg+xml',
};

class NetServer {
  constructor(outputs) {
    this.outputs = outputs;
    this.server = null;
    this.clients = new Set();
    this.allowed = new Set();
    outputs.listeners.add((type, payload) => {
      if (type === 'state') this.collectMedia(payload);
      const msg = `event: ${type}\ndata: ${JSON.stringify(this.rewrite(payload))}\n\n`;
      for (const c of this.clients) c.write(msg);
    });
  }

  collectMedia(state) {
    this.allowed.clear();
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string' && /path$/i.test(k) && v) this.allowed.add(path.resolve(v));
        else if (typeof v === 'object') walk(v);
      }
    };
    walk(state);
  }

  // Replace local paths with /media URLs for remote viewers
  rewrite(o) {
    if (!o || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map((x) => this.rewrite(x));
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && /path$/i.test(k) && v) out[k] = '/media?p=' + encodeURIComponent(path.resolve(v));
      else out[k] = typeof v === 'object' ? this.rewrite(v) : v;
    }
    return out;
  }

  start(port, lan) {
    this.stop();
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.on('error', (e) => resolve({ ok: false, error: e.message }));
      this.server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => {
        const nets = require('os').networkInterfaces();
        const ips = Object.values(nets).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
        resolve({ ok: true, urls: [`http://localhost:${port}/`, ...(lan ? ips.map((ip) => `http://${ip}:${port}/`) : [])] });
      });
    });
  }

  stop() {
    for (const c of this.clients) { try { c.end(); } catch {} }
    this.clients.clear();
    if (this.server) { this.server.close(); this.server = null; }
  }

  handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(this.rewrite(this.outputs.state))}\n\n`);
      this.clients.add(res);
      req.on('close', () => this.clients.delete(res));
      return;
    }
    if (url.pathname === '/media') {
      const p = path.resolve(url.searchParams.get('p') || '');
      if (!this.allowed.has(p) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
      return this.sendFile(req, res, p);
    }
    let rel = url.pathname === '/' ? 'output.html' : url.pathname.slice(1);
    const p = path.resolve(RENDERER, rel);
    if (!p.startsWith(RENDERER) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    return this.sendFile(req, res, p);
  }

  sendFile(req, res, p) {
    const stat = fs.statSync(p);
    const type = MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const [s, e] = range.replace(/bytes=/, '').split('-');
      const start = Number(s) || 0;
      const end = e ? Number(e) : stat.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
      fs.createReadStream(p, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(p).pipe(res);
    }
  }
}

module.exports = { NetServer };
