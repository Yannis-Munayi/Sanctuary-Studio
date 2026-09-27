// Build & publish Sanctuary Studio.
//
//   npm run dist                          Build the installer only (dist\Sanctuary-Studio-Setup-X.Y.Z.exe) — for the USB key.
//   npm run release -- "Fixed song import" Publish an update: bump version, commit + push the code, build,
//                                         and upload to GitHub Releases. The church laptop sees "Update available".
//   Options: --minor / --major (default: patch 1.0.0 -> 1.0.1), --no-bump (retry a failed upload of the same version)
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const local = flag('--local');
const bumpKind = flag('--major') ? 'major' : flag('--minor') ? 'minor' : 'patch';

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8', shell: opts.shell || false, env: opts.env || process.env, input: opts.input });
  if (r.status !== 0 && !opts.allowFail) {
    console.error(`\n✖ Failed: ${cmd} ${cmdArgs.join(' ')}\n${r.stderr || ''}`);
    process.exit(1);
  }
  return r;
}
const git = (...a) => run('git', a, { capture: true });
const pkgPath = path.join(ROOT, 'package.json');
const readPkg = () => JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

function bump(v, kind) {
  const [a, b, c] = v.split('.').map(Number);
  return kind === 'major' ? `${a + 1}.0.0` : kind === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
}

function githubToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  // Reuse the login Git already has (Git Credential Manager) — no separate token needed
  const r = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
  const m = (r.stdout || '').match(/^password=(.+)$/m);
  return m ? m[1].trim() : '';
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a); }));
}

function builder(extra, env) {
  const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  const e = { ...(env || process.env) };
  delete e.ELECTRON_RUN_AS_NODE;
  run(process.execPath, [cli, '--win', '--x64', ...extra], { env: e });
}

(async () => {
  if (local) {
    console.log(`Building installer for version ${readPkg().version}…`);
    builder(['--publish', 'never']);
    console.log(`\n✔ Installer ready: dist\\Sanctuary-Studio-Setup-${readPkg().version}.exe  — copy it to the USB key.`);
    return;
  }

  let notes = args.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!notes) notes = (await ask('What changed in this update? (shown on the church laptop): ')).trim();
  if (!notes) { console.error('Release notes are required.'); process.exit(1); }

  const token = githubToken();
  if (!token) { console.error('No GitHub login found. Run "git push" once in this folder (it will ask you to sign in), or set GH_TOKEN.'); process.exit(1); }

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  let version = readPkg().version;
  if (!flag('--no-bump')) {
    version = bump(version, bumpKind);
    run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { shell: true, capture: true });
    const clPath = path.join(ROOT, 'CHANGELOG.md');
    const old = fs.existsSync(clPath) ? fs.readFileSync(clPath, 'utf8').replace(/^# Changelog\s*/, '') : '';
    fs.writeFileSync(clPath, `# Changelog\n\n## ${version} — ${new Date().toISOString().slice(0, 10)}\n${notes.split(/\s*;\s*|\n/).map((n) => `- ${n}`).join('\n')}\n\n${old}`);
    const changed = git('status', '--porcelain').stdout.trim();
    console.log(`\nCommitting for v${version}:\n${changed}\n`);
    git('add', '-A');
    git('commit', '-m', `Release v${version}: ${notes}`);
    git('tag', `v${version}`);
  } else if (!git('tag', '--list', `v${version}`).stdout.trim()) {
    git('tag', `v${version}`);
  }
  console.log(`Pushing code to GitHub (${branch})…`);
  run('git', ['push', 'origin', branch]);
  run('git', ['push', 'origin', `v${version}`], { allowFail: true });

  console.log(`\nBuilding & uploading v${version}… (a few minutes)`);
  builder(['--publish', 'always', `-c.releaseInfo.releaseNotes=${notes}`], { ...process.env, GH_TOKEN: token });
  console.log(`\n✔ Released v${version}. The church laptop will show "Update ${version} available" next time Sanctuary Studio opens (with internet).`);
  console.log(`  Installer also saved at dist\\Sanctuary-Studio-Setup-${version}.exe (for the USB key if there's no internet).`);
})();
