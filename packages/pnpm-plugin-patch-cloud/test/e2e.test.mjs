// Real end-to-end test: real pnpm installs pnpm-plugin-patch-cloud as a config dependency from a local
// mock registry, then installs a project. A local mock patch-cloud serves /status?format=json and the fork
// tarball. No network access and no live patch-cloud traffic.
// PNPM_BINS="pnpm,/path/to/pnpm12" picks which pnpm binaries to test (default: "pnpm").
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
import { fileURLToPath } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BINS = (process.env.PNPM_BINS || 'pnpm').split(',').map((s) => s.trim()).filter(Boolean);
const OLD = '2025-01-01T00:00:00.000Z'; // older than any minimumReleaseAge

function pack(dir, outDir) {
  const out = execFileSync('npm', ['pack', '--silent', '--pack-destination', outDir], { cwd: dir, encoding: 'utf8' }).trim().split('\n').pop();
  return path.join(outDir, out);
}
function makePkg(root, name, version, body, deps = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'src-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js', dependencies: deps }));
  fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = ${JSON.stringify(body)};\n`);
  return pack(dir, root);
}
const integrity = (file) => 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcp-e2e-'));
  const tars = {
    'pnpm-plugin-patch-cloud': { version: JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'))).version, file: pack(PKG_DIR, root) },
    'dark-pkg': { version: '1.0.0', file: makePkg(root, 'dark-pkg', '1.0.0', 'upstream dark-pkg') },
    'lit-pkg': { version: '1.0.0', file: makePkg(root, 'lit-pkg', '1.0.0', 'upstream lit-pkg') },
    'parent-pkg': { version: '1.0.0', file: makePkg(root, 'parent-pkg', '1.0.0', 'upstream parent-pkg', { 'dark-pkg': '^1.0.0' }) },
  };
  const forkDir = fs.mkdtempSync(path.join(root, 'fork-'));
  const forkFile = makePkg(forkDir, 'dark-pkg', '1.0.0', 'FORK dark-pkg'); // own dir: same file name as upstream
  const hits = { registry: [], cloud: [] };
  const state = { darkPkgLit: false };

  const registry = http.createServer((req, res) => {
    hits.registry.push(req.url);
    const u = decodeURIComponent(req.url.split('?')[0]).slice(1);
    const tm = /^(.+)\/-\/(.+\.tgz)$/.exec(u);
    if (tm && tars[tm[1]]) { res.setHeader('content-type', 'application/octet-stream'); return res.end(fs.readFileSync(tars[tm[1]].file)); }
    const t = tars[u];
    if (!t) { res.statusCode = 404; return res.end('{}'); }
    const manifest = JSON.parse(execFileSync('tar', ['-xzOf', t.file, 'package/package.json'], { encoding: 'utf8' }));
    const base = `http://127.0.0.1:${registry.address().port}`;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      name: u, 'dist-tags': { latest: t.version }, time: { created: OLD, modified: OLD, [t.version]: OLD },
      versions: { [t.version]: { ...manifest, dist: { tarball: `${base}/${u}/-/${path.basename(t.file)}`, integrity: integrity(t.file) } } },
    }));
  });
  const cloud = http.createServer((req, res) => {
    hits.cloud.push(req.url);
    if (req.url === '/status?format=json') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ packages: [
        state.darkPkgLit
          ? { npmName: 'dark-pkg', version: '1.0.0', repo: 'example/dark-pkg', rewrite: 'ready', light: { state: 'lit' } }
          : { npmName: 'dark-pkg', version: '1.0.0', repo: 'example/dark-pkg', rewrite: 'active', light: { state: 'dark', url: 'https://example.invalid/run/1' } },
        { npmName: 'lit-pkg', version: '1.0.0', repo: 'example/lit-pkg', rewrite: 'ready', light: { state: 'lit' } },
      ] }));
    }
    if (req.url === '/dark-pkg/-/dark-pkg-1.0.0.tgz') return res.end(fs.readFileSync(forkFile));
    if (req.url === '/dark-pkg') { // patch-cloud serves the fork under the same name (named-registry mode)
      const base = `http://127.0.0.1:${cloud.address().port}`;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ name: 'dark-pkg', 'dist-tags': { latest: '1.0.0' }, time: { created: OLD, modified: OLD, '1.0.0': OLD },
        versions: { '1.0.0': { name: 'dark-pkg', version: '1.0.0', main: 'index.js',
          dist: { tarball: `${base}/dark-pkg/-/dark-pkg-1.0.0.tgz`, integrity: integrity(forkFile) } } } }));
    }
    res.statusCode = 404; res.end();
  });
  const regPort = await listen(registry);
  const cloudPort = await listen(cloud);
  return { root, hits, state, regUrl: `http://127.0.0.1:${regPort}`, cloudUrl: `http://127.0.0.1:${cloudPort}`, close: () => { registry.close(); cloud.close(); } };
}

function project(ctx, name) {
  const dir = path.join(ctx.root, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', private: true,
    dependencies: { 'dark-pkg': '^1.0.0', 'lit-pkg': '^1.0.0', 'parent-pkg': '^1.0.0' } }, null, 2));
  fs.writeFileSync(path.join(dir, '.npmrc'), `registry=${ctx.regUrl}/\n`);
  return dir;
}
// Async on purpose: the mock servers live in this process, so a sync spawn would block them.
async function pnpm(bin, dir, ctx, args, env = {}) {
  // A fresh store per project: each install downloads (and locks the integrity of) what it uses.
  args = [...args, '--store-dir', path.join(dir, '.store')];
  const { stdout, stderr } = await execFileP(bin, args, { cwd: dir, encoding: 'utf8', timeout: 120000, maxBuffer: 1 << 24,
    env: { ...process.env, npm_config_cache_dir: path.join(ctx.root, 'cache'),
      npm_config_registry: `${ctx.regUrl}/`, CI: '1', ...env } });
  return stdout + stderr;
}
const body = (dir, rel) => fs.readFileSync(fs.realpathSync(path.join(dir, rel)), 'utf8');
function transitiveDark(dir) {
  const parentReal = fs.realpathSync(path.join(dir, 'node_modules', 'parent-pkg'));
  return fs.readFileSync(fs.realpathSync(path.join(path.dirname(parentReal), 'dark-pkg', 'index.js')), 'utf8');
}

// pnpm >= 11.1 uses the named-registry route; older pnpm uses the direct tarball URL.
const NAMED = (ver) => { const [a, b] = ver.split('.').map(Number); return a > 11 || (a === 11 && b >= 1); };
let ctx;
test.before(async () => { ctx = await setup(); });
test.after(() => ctx && ctx.close());

for (const bin of BINS) {
  const ver = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();

  test(`pnpm ${ver}: dark rewrite-ready package resolves to the fork; lit package does not`, async () => {
    const dir = project(ctx, `app-${ver}`);
    const env = { PATCH_CLOUD_URL: ctx.cloudUrl };
    const out1 = await pnpm(bin, dir, ctx, ['add', '--config', 'pnpm-plugin-patch-cloud'], env);
    assert.match(fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8'), /configDependencies:[\s\S]*pnpm-plugin-patch-cloud/);
    const out2 = await pnpm(bin, dir, ctx, ['install'], env);
    const out = out1 + out2;
    assert.match(body(dir, 'node_modules/dark-pkg/index.js'), /FORK dark-pkg/, 'direct dark dep -> fork');
    assert.match(transitiveDark(dir), /FORK dark-pkg/, 'transitive dark dep -> fork');
    assert.match(body(dir, 'node_modules/lit-pkg/index.js'), /upstream lit-pkg/, 'lit dep untouched');
    assert.match(body(dir, 'node_modules/parent-pkg/index.js'), /upstream parent-pkg/);
    const lock = fs.readFileSync(path.join(dir, 'pnpm-lock.yaml'), 'utf8');
    const named = NAMED(ver);
    if (named) assert.ok(lock.includes('patch-cloud:dark-pkg@1.0.0'), 'lockfile records the patch-cloud named registry');
    else assert.ok(lock.includes(`${ctx.cloudUrl}/dark-pkg/-/dark-pkg-1.0.0.tgz`), 'lockfile pins the fork tarball');
    assert.ok(!lock.includes('patch-cloud:lit-pkg') && !lock.includes(`${ctx.cloudUrl}/lit-pkg`), 'lit-pkg not pointed at patch-cloud');
    assert.match(out, /patch-cloud: dark-pkg \^1\.0\.0 -> fork 1\.0\.0 \(upstream light dark\)/);
    assert.ok(ctx.hits.cloud.includes('/status?format=json'));
    const rec = fs.readFileSync(path.join(dir, 'node_modules', '.patch-cloud', 'swaps.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(rec.length >= 1);
    assert.deepEqual([rec[0].package, rec[0].version, rec[0].light], ['dark-pkg', '1.0.0', 'dark']);
    assert.ok(!Number.isNaN(Date.parse(rec[0].ts)));
    assert.ok(!rec.some((r) => r.package === 'lit-pkg'));
  });

  test(`pnpm ${ver}: light turns lit -> CI frozen install keeps the locked fork; a local re-resolve returns to upstream`, async () => {
    const dir = project(ctx, `flip-${ver}`);
    const env = { PATCH_CLOUD_URL: ctx.cloudUrl };
    await pnpm(bin, dir, ctx, ['add', '--config', 'pnpm-plugin-patch-cloud'], env);
    await pnpm(bin, dir, ctx, ['install'], env);
    assert.match(body(dir, 'node_modules/dark-pkg/index.js'), /FORK dark-pkg/);
    ctx.state.darkPkgLit = true;
    try {
      fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
      const out = await pnpm(bin, dir, ctx, ['install', '--frozen-lockfile'], env); // CI=1 -> keep policy
      assert.match(body(dir, 'node_modules/dark-pkg/index.js'), /FORK dark-pkg/, 'frozen install matches the lockfile');
      assert.match(out, /kept from pnpm-lock\.yaml; light lit/);
      await pnpm(bin, dir, ctx, ['update', 'dark-pkg', 'parent-pkg'], { ...env, CI: '', PATCH_CLOUD_LOCKFILE: 'follow' });
      assert.match(body(dir, 'node_modules/dark-pkg/index.js'), /upstream dark-pkg/, 'lit again -> upstream after re-resolve');
      assert.match(transitiveDark(dir), /upstream dark-pkg/);
      assert.ok(!fs.readFileSync(path.join(dir, 'pnpm-lock.yaml'), 'utf8').includes('patch-cloud:dark-pkg') &&
        !fs.readFileSync(path.join(dir, 'pnpm-lock.yaml'), 'utf8').includes(`${ctx.cloudUrl}/dark-pkg`));
    } finally { ctx.state.darkPkgLit = false; }
  });

  test(`pnpm ${ver}: light turns dark after locking upstream -> CI frozen install stays upstream (no lockfile break)`, async () => {
    const dir = project(ctx, `lockup-${ver}`);
    ctx.state.darkPkgLit = true;
    const env = { PATCH_CLOUD_URL: ctx.cloudUrl };
    try {
      await pnpm(bin, dir, ctx, ['add', '--config', 'pnpm-plugin-patch-cloud'], env);
      await pnpm(bin, dir, ctx, ['install'], env);
      assert.match(body(dir, 'node_modules/dark-pkg/index.js'), /upstream dark-pkg/);
    } finally { ctx.state.darkPkgLit = false; }
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
    await pnpm(bin, dir, ctx, ['install', '--frozen-lockfile'], env);
    assert.match(body(dir, 'node_modules/dark-pkg/index.js'), /upstream dark-pkg/);
    await pnpm(bin, dir, ctx, ['update', 'dark-pkg', 'parent-pkg'], { ...env, CI: '', PATCH_CLOUD_LOCKFILE: 'follow' });
    assert.match(body(dir, 'node_modules/dark-pkg/index.js'), /FORK dark-pkg/, 'local re-resolve picks up the dark light');
  });

  test(`pnpm ${ver}: unreachable status feed fails open (installs unchanged, one note)`, async () => {
    const dir = project(ctx, `down-${ver}`);
    await pnpm(bin, dir, ctx, ['add', '--config', 'pnpm-plugin-patch-cloud'], { PATCH_CLOUD_URL: 'http://127.0.0.1:1' });
    const out = await pnpm(bin, dir, ctx, ['install'], { PATCH_CLOUD_URL: 'http://127.0.0.1:1', PATCH_CLOUD_TIMEOUT_MS: '500' });
    assert.match(body(dir, 'node_modules/dark-pkg/index.js'), /upstream dark-pkg/);
    assert.match(transitiveDark(dir), /upstream dark-pkg/);
    assert.ok(!fs.readFileSync(path.join(dir, 'pnpm-lock.yaml'), 'utf8').includes('127.0.0.1:1/'));
    assert.match(out, /patch-cloud: status feed http:\/\/127\.0\.0\.1:1 unreachable/);
  });

  test(`pnpm ${ver}: PATCH_CLOUD_DISABLE=1 leaves everything upstream`, async () => {
    const dir = project(ctx, `off-${ver}`);
    const env = { PATCH_CLOUD_URL: ctx.cloudUrl, PATCH_CLOUD_DISABLE: '1' };
    await pnpm(bin, dir, ctx, ['add', '--config', 'pnpm-plugin-patch-cloud'], env);
    await pnpm(bin, dir, ctx, ['install'], env);
    assert.match(body(dir, 'node_modules/dark-pkg/index.js'), /upstream dark-pkg/);
    assert.ok(!fs.existsSync(path.join(dir, 'node_modules', '.patch-cloud', 'swaps.ndjson')));
  });
}
