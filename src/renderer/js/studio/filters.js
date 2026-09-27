// Video filters. Colour/blur use the canvas 2D filter pipeline (GPU-accelerated);
// chroma key runs a small WebGL shader per source.

export const VIDEO_FILTER_TYPES = {
  color: { label: 'Color correction', defaults: { brightness: 0, contrast: 1, saturation: 1, hue: 0, gamma: 1 }, fields: [
    { key: 'brightness', label: 'Brightness', type: 'range', min: -1, max: 1, step: 0.01 },
    { key: 'contrast', label: 'Contrast', type: 'range', min: 0, max: 2, step: 0.01 },
    { key: 'saturation', label: 'Saturation', type: 'range', min: 0, max: 3, step: 0.01 },
    { key: 'hue', label: 'Hue shift', type: 'range', min: -180, max: 180, unit: '°' }] },
  chroma: { label: 'Chroma key (green screen)', defaults: { color: '#00ff00', similarity: 0.4, smoothness: 0.08, spill: 0.1 }, fields: [
    { key: 'color', label: 'Key colour', type: 'color' },
    { key: 'similarity', label: 'Similarity', type: 'range', min: 0.01, max: 1, step: 0.01 },
    { key: 'smoothness', label: 'Smoothness', type: 'range', min: 0.01, max: 0.5, step: 0.01 },
    { key: 'spill', label: 'Spill reduction', type: 'range', min: 0.01, max: 0.5, step: 0.01 }] },
  blur: { label: 'Blur', defaults: { radius: 8 }, fields: [{ key: 'radius', label: 'Radius', type: 'range', min: 0, max: 60, unit: 'px' }] },
  effects: { label: 'Effects (grayscale/sepia/invert)', defaults: { grayscale: 0, sepia: 0, invert: 0 }, fields: [
    { key: 'grayscale', label: 'Grayscale', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'sepia', label: 'Sepia', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'invert', label: 'Invert', type: 'range', min: 0, max: 1, step: 0.05 }] },
  frame: { label: 'Rounded corners & border', defaults: { radius: 24, border: 0, borderColor: '#ffffff', shadow: 0 }, fields: [
    { key: 'radius', label: 'Corner radius', type: 'range', min: 0, max: 400, unit: 'px' },
    { key: 'border', label: 'Border width', type: 'range', min: 0, max: 40, unit: 'px' },
    { key: 'borderColor', label: 'Border colour', type: 'color' },
    { key: 'shadow', label: 'Drop shadow', type: 'range', min: 0, max: 80, unit: 'px' }] },
};

export function cssFilter(filters, scale = 1) {
  const parts = [];
  for (const f of filters || []) {
    if (!f.enabled) continue;
    const s = f.settings || {};
    if (f.type === 'color') {
      if (s.brightness) parts.push(`brightness(${1 + Number(s.brightness)})`);
      if (s.contrast !== undefined && s.contrast !== 1) parts.push(`contrast(${s.contrast})`);
      if (s.saturation !== undefined && s.saturation !== 1) parts.push(`saturate(${s.saturation})`);
      if (s.hue) parts.push(`hue-rotate(${s.hue}deg)`);
    } else if (f.type === 'blur' && s.radius > 0) parts.push(`blur(${s.radius * scale}px)`);
    else if (f.type === 'effects') {
      if (s.grayscale) parts.push(`grayscale(${s.grayscale})`);
      if (s.sepia) parts.push(`sepia(${s.sepia})`);
      if (s.invert) parts.push(`invert(${s.invert})`);
    }
  }
  return parts.length ? parts.join(' ') : 'none';
}

export function frameFilter(filters) {
  for (const f of filters || []) if (f.enabled && f.type === 'frame') return f.settings;
  return null;
}

const VS = `attribute vec2 p; varying vec2 uv; void main(){ uv = vec2((p.x+1.0)/2.0, 1.0-(p.y+1.0)/2.0); gl_Position = vec4(p,0.0,1.0); }`;
const FS = `precision mediump float;
uniform sampler2D tex; uniform vec3 key; uniform float sim; uniform float smoothv; uniform float spill; varying vec2 uv;
vec2 cbcr(vec3 c){ return vec2(-0.168736*c.r-0.331264*c.g+0.5*c.b, 0.5*c.r-0.418688*c.g-0.081312*c.b); }
void main(){
  vec4 c = texture2D(tex, uv);
  float d = distance(cbcr(c.rgb), cbcr(key));
  float a = smoothstep(sim*0.5, sim*0.5+smoothv, d);
  float s = pow(clamp((d - sim*0.5) / spill, 0.0, 1.0), 1.5);
  float lum = dot(c.rgb, vec3(0.2126,0.7152,0.0722));
  vec3 rgb = mix(vec3(lum), c.rgb, s);
  gl_FragColor = vec4(rgb, c.a * a);
}`;

export class ChromaKeyer {
  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl', { premultipliedAlpha: false, alpha: true, preserveDrawingBuffer: true });
    this.gl = gl;
    if (!gl) return;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    this.prog = prog;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.u = {
      key: gl.getUniformLocation(prog, 'key'), sim: gl.getUniformLocation(prog, 'sim'),
      smooth: gl.getUniformLocation(prog, 'smoothv'), spill: gl.getUniformLocation(prog, 'spill'),
    };
  }

  process(src, w, h, s) {
    const gl = this.gl;
    if (!gl || !w || !h) return src;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; gl.viewport(0, 0, w, h); }
    try {
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } catch { return src; }
    const hex = String(s.color || '#00ff00').replace('#', '');
    const n = parseInt(hex, 16);
    gl.uniform3f(this.u.key, ((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
    gl.uniform1f(this.u.sim, s.similarity ?? 0.4);
    gl.uniform1f(this.u.smooth, s.smoothness ?? 0.08);
    gl.uniform1f(this.u.spill, s.spill ?? 0.1);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}
