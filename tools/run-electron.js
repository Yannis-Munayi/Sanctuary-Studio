// Runs an Electron script with ELECTRON_RUN_AS_NODE removed (VS Code terminals set it).
const { spawnSync } = require('child_process');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(require('electron'), process.argv.slice(2), { stdio: 'inherit', env });
process.exit(r.status ?? 0);
