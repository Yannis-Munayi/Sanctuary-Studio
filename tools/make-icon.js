// Renders build/icon.png (512×512) using Electron's canvas. Run: node tools/run-electron.js tools/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const html = `<canvas id=c width=512 height=512></canvas><script>
const c = document.getElementById('c'), x = c.getContext('2d');
const r = 96;
x.beginPath(); x.moveTo(r,0); x.arcTo(512,0,512,512,r); x.arcTo(512,512,0,512,r); x.arcTo(0,512,0,0,r); x.arcTo(0,0,512,0,r); x.closePath();
const g = x.createLinearGradient(0,0,512,512); g.addColorStop(0,'#10244a'); g.addColorStop(1,'#3b1b58');
x.fillStyle = g; x.fill();
// soft glow
const rg = x.createRadialGradient(256,230,10,256,230,230); rg.addColorStop(0,'rgba(242,193,78,.35)'); rg.addColorStop(1,'rgba(242,193,78,0)');
x.fillStyle = rg; x.fillRect(0,0,512,512);
// cross
x.fillStyle = '#f2c14e'; x.shadowColor = 'rgba(0,0,0,.45)'; x.shadowBlur = 18; x.shadowOffsetY = 6;
x.fillRect(226, 88, 60, 300); x.fillRect(176, 170, 160, 58);
// broadcast arcs
x.shadowColor = 'transparent'; x.strokeStyle = '#ffffff'; x.lineCap = 'round';
for (const [rad, w, a] of [[132, 16, .9], [178, 14, .6]]) {
  x.globalAlpha = a; x.lineWidth = w;
  x.beginPath(); x.arc(256, 240, rad, -0.55, 0.55); x.stroke();
  x.beginPath(); x.arc(256, 240, rad, Math.PI - 0.55, Math.PI + 0.55); x.stroke();
}
x.globalAlpha = 1;
// live dot
x.fillStyle = '#e5484d'; x.beginPath(); x.arc(412, 412, 44, 0, Math.PI*2); x.fill();
x.strokeStyle = '#fff'; x.lineWidth = 10; x.stroke();
</script>`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 512, height: 512, show: false });
  await w.loadURL('data:text/html,' + encodeURIComponent(html));
  const data = await w.webContents.executeJavaScript('document.getElementById("c").toDataURL("image/png")');
  const out = path.join(__dirname, '..', 'build');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'icon.png'), Buffer.from(data.split(',')[1], 'base64'));
  console.log('icon written');
  app.quit();
});
