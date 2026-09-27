// Starts Electron with a clean environment. VS Code terminals set ELECTRON_RUN_AS_NODE=1,
// which would make Electron behave like plain Node and crash on startup.
const { spawn } = require('child_process');
const path = require('path');

const electron = require('electron'); // path to electron.exe when required from Node
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env, windowsHide: false });
child.on('exit', (code) => process.exit(code ?? 0));
