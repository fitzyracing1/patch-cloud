'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../lib.cjs');
// Words this project never uses for lights (stored reversed so this file doesn't use them either).
const OFF_VOCAB = new RegExp(`\\b(${['neerg', 'der', 'gnissap', 'gniliaf'].map((w) => [...w].reverse().join('')).join('|')})\\b`, 'i');

const BASE = 'https://pc.example';
const STATUS = {
  packages: [
    { npmName: 'ms', version: '2.1.3', repo: 'vercel/ms', rewrite: 'active', light: { state: 'dark', url: 'https://github.com/vercel/ms/actions/runs/1' } },
    { npmName: 'react', version: '19.3.0', rewrite: 'ready', light: { state: 'lit' } },
    { npmName: 'ajv', version: null, rewrite: 'would rewrite', light: { state: 'dark' } },
    { npmName: 'nofork', version: '1.0.0', rewrite: 'n/a', light: { state: 'dark' } },
    { npmName: 'dayjs', version: '1.11.23', rewrite: 'ready', light: { state: 'lit' }, manual: { servingNow: true } },
    { npmName: 'dayoff', version: '1.0.0', rewrite: 'ready', light: { state: 'lit' }, manual: { servingNow: false } },
    { npmName: '@scope/pkg', version: '3.0.0', rewrite: 'active', light: { state: 'dark' } },
    { repo: 'rust-lang/rust', light: { state: 'dark' }, rewrite: 'n/a' },
  ],
};
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pcp-')), 'rec', 'swaps.ndjson');

test('readConfig defaults and env overrides', () => {
  const d = lib.readConfig({}, '/proj');
  assert.equal(d.url, lib.DEFAULT_URL);
  assert.equal(d.disabled, false);
  assert.equal(d.timeoutMs, 3000);
  assert.equal(d.record, path.join('/proj', 'node_modules', '.patch-cloud', 'swaps.ndjson'));
  assert.equal(d.ping, false);
  const c = lib.readConfig({ PATCH_CLOUD_URL: 'http://x:1///', PATCH_CLOUD_DISABLE: 'true', PATCH_CLOUD_TIMEOUT_MS: '250', PATCH_CLOUD_RECORD: 'off', PATCH_CLOUD_PING: '1' });
  assert.deepEqual([c.url, c.disabled, c.timeoutMs, c.record, c.ping], ['http://x:1', true, 250, null, true]);
  assert.equal(lib.readConfig({ PATCH_CLOUD_TIMEOUT_MS: 'abc' }).timeoutMs, 3000);
});

test('tarballUrl handles scoped names', () => {
  assert.equal(lib.tarballUrl(BASE, 'ms', '2.1.3'), `${BASE}/ms/-/ms-2.1.3.tgz`);
  assert.equal(lib.tarballUrl(BASE, '@scope/pkg', '3.0.0'), `${BASE}/@scope/pkg/-/pkg-3.0.0.tgz`);
});

test('forksFromStatus: only dark + rewrite-ready, or manual switch serving now', () => {
  const f = lib.forksFromStatus(STATUS, BASE);
  assert.deepEqual([...f.keys()].sort(), ['@scope/pkg', 'dayjs', 'ms']);
  assert.equal(f.get('ms').reason, 'dark');
  assert.equal(f.get('ms').lightState, 'dark');
  assert.equal(f.get('dayjs').reason, 'manual');
  assert.equal(f.has('react'), false, 'lit package untouched');
  assert.equal(lib.forksFromStatus(null, BASE).size, 0);
  assert.equal(lib.forksFromStatus({ packages: 'nope' }, BASE).size, 0);
});

test('satisfies: common npm ranges', () => {
  const yes = [['2.1.3', '^2.1.1'], ['2.1.3', '2.x'], ['2.1.3', '*'], ['2.1.3', '>=2 <3'], ['2.1.3', '1.0.0 - 2.1.3'],
    ['2.1.3', '^1 || ^2'], ['0.12.5', '^0.12.0'], ['2.1.3', '~2.1'], ['2.1.3', '2.1.3'], ['2.1.3', '=2.1.3'], ['2.1.3', '>= 2.0.0'], ['2.1.3', '<=2.1']];
  const no = [['2.1.3', '~2.0.0'], ['0.12.5', '^0.11.0'], ['2.1.3', '^3'], ['2.1.3', '<2.1.3'], ['2.1.3', '>2.1'], ['2.1.3', 'latest'], ['3.0.0-beta.1', '^3.0.0'], ['nope', '*']];
  for (const [v, r] of yes) assert.equal(lib.satisfies(v, r), true, `${v} ${r}`);
  for (const [v, r] of no) assert.equal(lib.satisfies(v, r), false, `${v} ${r}`);
});

test('isRegistryRange rejects non-registry specs', () => {
  for (const s of ['^1.0.0', '*', '', '1.x', '>=1 <2']) assert.equal(lib.isRegistryRange(s), true, s);
  for (const s of ['latest', 'npm:other@1', 'workspace:*', 'file:../x', 'github:a/b', 'a/b', 'https://x/y.tgz', 'catalog:', 'git+ssh://x']) assert.equal(lib.isRegistryRange(s), false, s);
});

test('rewriteManifest swaps dark forks only when the range allows the fork version', () => {
  const forks = lib.forksFromStatus(STATUS, BASE);
  const pkg = { name: 'app', dependencies: { ms: '^2.0.0', react: '^19.0.0', '@scope/pkg': '^3' },
    devDependencies: { dayjs: '^1.11.0' }, optionalDependencies: { ms: '^1.0.0' }, peerDependencies: { ms: '^2.0.0' } };
  const changes = lib.rewriteManifest(pkg, forks);
  assert.equal(pkg.dependencies.ms, `${BASE}/ms/-/ms-2.1.3.tgz`);
  assert.equal(pkg.dependencies.react, '^19.0.0');
  assert.equal(pkg.dependencies['@scope/pkg'], `${BASE}/@scope/pkg/-/pkg-3.0.0.tgz`);
  assert.equal(pkg.devDependencies.dayjs, `${BASE}/dayjs/-/dayjs-1.11.23.tgz`);
  assert.equal(pkg.optionalDependencies.ms, '^1.0.0', 'range excludes fork version -> untouched');
  assert.equal(pkg.peerDependencies.ms, '^2.0.0', 'peer deps never rewritten');
  assert.equal(changes.length, 3);
  assert.deepEqual(lib.rewriteManifest({ dependencies: { ms: '^2' } }, new Map()), []);
});

test('recordSwap appends one NDJSON line with package, version, light, timestamp', () => {
  const file = tmpFile();
  const c = { name: 'ms', version: '2.1.3', lightState: 'dark', reason: 'dark', from: '^2.0.0', to: `${BASE}/ms/-/ms-2.1.3.tgz`, repo: 'vercel/ms', lightUrl: null };
  lib.recordSwap(file, c, new Date('2026-11-19T00:00:00Z'));
  lib.recordSwap(file, c, new Date('2026-11-19T00:00:01Z'));
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.deepEqual([lines[0].package, lines[0].version, lines[0].light, lines[0].ts], ['ms', '2.1.3', 'dark', '2026-11-19T00:00:00.000Z']);
});

function okFetch(body, calls) {
  return async (url, opts) => { calls.push(url); assert.ok(opts.signal); return { ok: true, status: 200, json: async () => body }; };
}

test('createHooks: fetches the feed once per install, rewrites, records, summarizes', async () => {
  const calls = []; const logs = []; const record = tmpFile();
  const h = lib.createHooks({ env: { PATCH_CLOUD_URL: BASE, PATCH_CLOUD_RECORD: record }, fetchImpl: okFetch(STATUS, calls), logger: (m) => logs.push(m) });
  const a = await h.readPackage({ name: 'a', dependencies: { ms: '^2.1.0', react: '^19' } }, {});
  const b = await h.readPackage({ name: 'b', dependencies: { ms: '~2.1.3' } }, {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0], `${BASE}/status?format=json`);
  assert.equal(a.dependencies.ms, `${BASE}/ms/-/ms-2.1.3.tgz`);
  assert.equal(a.dependencies.react, '^19');
  assert.equal(b.dependencies.ms, `${BASE}/ms/-/ms-2.1.3.tgz`);
  assert.equal(fs.readFileSync(record, 'utf8').trim().split('\n').length, 1, 'one record per package@version per install');
  h.afterAllResolved({}, {});
  assert.ok(logs.some((l) => l.includes('1 package(s) installed from patch-cloud forks this install: ms@2.1.3')));
  assert.ok(logs.every((l) => !OFF_VOCAB.test(l)), 'lit/dark vocabulary only');
});

test('createHooks: context.log is used when pnpm provides it', async () => {
  const seen = [];
  const h = lib.createHooks({ env: { PATCH_CLOUD_URL: BASE, PATCH_CLOUD_RECORD: 'off' }, fetchImpl: okFetch(STATUS, []) });
  await h.readPackage({ dependencies: { ms: '*' } }, { log: (m) => seen.push(m) });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /ms \* -> fork 2\.1\.3 \(upstream light dark\)/);
});

test('fail open: unreachable feed changes nothing and logs one line', async () => {
  const logs = [];
  const h = lib.createHooks({ env: { PATCH_CLOUD_URL: BASE, PATCH_CLOUD_RECORD: 'off' }, logger: (m) => logs.push(m),
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  const p1 = await h.readPackage({ dependencies: { ms: '^2' } }, {});
  const p2 = await h.readPackage({ dependencies: { ms: '^2' } }, {});
  assert.equal(p1.dependencies.ms, '^2');
  assert.equal(p2.dependencies.ms, '^2');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /unreachable \(ECONNREFUSED\); installing unchanged/);
});

test('fail open: slow feed hits the timeout', async () => {
  const logs = [];
  const h = lib.createHooks({ env: { PATCH_CLOUD_URL: BASE, PATCH_CLOUD_TIMEOUT_MS: '50', PATCH_CLOUD_RECORD: 'off' }, logger: (m) => logs.push(m),
    fetchImpl: (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason))) });
  const p = await h.readPackage({ dependencies: { ms: '^2' } }, {});
  assert.equal(p.dependencies.ms, '^2');
  assert.match(logs[0], /no answer within 50 ms/);
});

test('fail open: HTTP error status', async () => {
  const logs = [];
  const h = lib.createHooks({ env: { PATCH_CLOUD_URL: BASE, PATCH_CLOUD_RECORD: 'off' }, logger: (m) => logs.push(m),
    fetchImpl: async () => ({ ok: false, status: 503 }) });
  const p = await h.readPackage({ dependencies: { ms: '^2' } }, {});
  assert.equal(p.dependencies.ms, '^2');
  assert.match(logs[0], /HTTP 503/);
});

test('PATCH_CLOUD_DISABLE: no fetch, no change', async () => {
  const calls = [];
  const h = lib.createHooks({ env: { PATCH_CLOUD_DISABLE: '1' }, fetchImpl: okFetch(STATUS, calls) });
  const p = await h.readPackage({ dependencies: { ms: '^2' } }, {});
  assert.equal(p.dependencies.ms, '^2');
  assert.equal(calls.length, 0);
});

test('PATCH_CLOUD_PING: nothing is sent (no endpoint yet), note is logged', async () => {
  const calls = []; const logs = [];
  const h = lib.createHooks({ env: { PATCH_CLOUD_URL: BASE, PATCH_CLOUD_PING: '1', PATCH_CLOUD_RECORD: 'off' }, fetchImpl: okFetch(STATUS, calls), logger: (m) => logs.push(m) });
  await h.readPackage({ dependencies: { ms: '^2' } }, {});
  h.afterAllResolved({}, {});
  assert.equal(calls.length, 1, 'only the status feed was fetched');
  assert.ok(logs.some((l) => /no ping endpoint yet; nothing was sent/.test(l)));
});

test('PATCH_CLOUD_QUIET silences logs', async () => {
  const logs = [];
  const h = lib.createHooks({ env: { PATCH_CLOUD_URL: BASE, PATCH_CLOUD_QUIET: '1', PATCH_CLOUD_RECORD: 'off' }, fetchImpl: okFetch(STATUS, []), logger: (m) => logs.push(m) });
  await h.readPackage({ dependencies: { ms: '^2' } }, {});
  assert.equal(logs.length, 0);
});

test('source and docs use lit/dark vocabulary only', () => {
  const root = path.join(__dirname, '..');
  for (const f of ['lib.cjs', 'pnpmfile.cjs', 'README.md', 'package.json', 'test/unit.test.cjs', 'test/e2e.test.mjs', 'test/live.test.mjs']) {
    const txt = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(txt, OFF_VOCAB, f);
  }
});

test('pnpmVersion / supportsNamedRegistries', () => {
  assert.deepEqual(lib.pnpmVersion({ userAgent: 'pnpm/12.21.0 npm/? node/? linux x64' }), { major: 12, minor: 21, patch: 0 });
  assert.equal(lib.pnpmVersion({}), null);
  assert.equal(lib.supportsNamedRegistries({ major: 10, minor: 34, patch: 6 }), false);
  assert.equal(lib.supportsNamedRegistries({ major: 11, minor: 0, patch: 9 }), false);
  assert.equal(lib.supportsNamedRegistries({ major: 11, minor: 1, patch: 0 }), true);
  assert.equal(lib.supportsNamedRegistries({ major: 12, minor: 0, patch: 0 }), true);
  assert.equal(lib.supportsNamedRegistries(null), false);
});

test('registry mode rewrites to the patch-cloud named registry', () => {
  const pkg = { dependencies: { ms: '^2.0.0', react: '^19' } };
  lib.rewriteManifest(pkg, lib.forksFromStatus(STATUS, BASE), 'registry');
  assert.equal(pkg.dependencies.ms, 'patch-cloud:ms@2.1.3');
  assert.equal(pkg.dependencies.react, '^19');
});

test('updateConfig picks the mode, adds the named registry, and hands it to a separate readPackage process', async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcp-h-'));
  const env = { PATCH_CLOUD_URL: BASE, PATCH_CLOUD_RECORD: 'off' };
  const a = lib.createHooks({ env, ppid: 4242, tmpdir, fetchImpl: okFetch(STATUS, []) });
  const cfg = a.updateConfig({ userAgent: 'pnpm/12.21.0 npm/? node/? linux x64', blockExoticSubdeps: true });
  assert.deepEqual(cfg.namedRegistries, { 'patch-cloud': `${BASE}/` });
  assert.deepEqual(cfg.registriesByPrefix, { 'patch-cloud': `${BASE}/` });
  assert.ok(fs.existsSync(lib.modeFile(4242, tmpdir)));
  const b = lib.createHooks({ env, ppid: 4242, tmpdir, fetchImpl: okFetch(STATUS, []) }); // other process, same pnpm parent
  const p = await b.readPackage({ dependencies: { ms: '^2' } }, {});
  assert.equal(p.dependencies.ms, 'patch-cloud:ms@2.1.3');
  b.afterAllResolved({}, {});
  assert.ok(!fs.existsSync(lib.modeFile(4242, tmpdir)), 'handoff file removed after resolution');
});

test('old pnpm: tarball mode, no named registry added', async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcp-h-'));
  const h = lib.createHooks({ env: { PATCH_CLOUD_URL: BASE, PATCH_CLOUD_RECORD: 'off' }, ppid: 1, tmpdir, fetchImpl: okFetch(STATUS, []) });
  const cfg = h.updateConfig({ userAgent: 'pnpm/10.34.6 npm/? node/v24 linux x64' });
  assert.equal(cfg.namedRegistries, undefined);
  assert.equal(cfg.registriesByPrefix, undefined);
  const p = await h.readPackage({ dependencies: { ms: '^2' } }, {});
  assert.equal(p.dependencies.ms, `${BASE}/ms/-/ms-2.1.3.tgz`);
});

test('tarball mode + blockExoticSubdeps: fail open with one note', async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcp-h-'));
  const logs = [];
  const h = lib.createHooks({ env: { PATCH_CLOUD_URL: BASE, PATCH_CLOUD_RECORD: 'off', PATCH_CLOUD_MODE: 'tarball' }, ppid: 2, tmpdir,
    fetchImpl: okFetch(STATUS, []), logger: (m) => logs.push(m) });
  h.updateConfig({ userAgent: 'pnpm/12.21.0', blockExoticSubdeps: true });
  const p = await h.readPackage({ dependencies: { ms: '^2' } }, {});
  await h.readPackage({ dependencies: { ms: '^2' } }, {});
  assert.equal(p.dependencies.ms, '^2');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /blockExoticSubdeps is on/);
});

test('lockfileSpecs reads fork pins from importers (named registry and tarball URL)', () => {
  const lock = ['---', "lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    configDependencies:', '      pnpm-plugin-patch-cloud:',
    '        specifier: ^0.1.0', '        version: 0.1.0', '', 'packages: {}', '', '---', "lockfileVersion: '9.0'", '', 'importers:', '', '  .:',
    '    dependencies:', '      ms:', '        specifier: patch-cloud:ms@2.1.3', '        version: patch-cloud:2.1.3',
    "      '@scope/pkg':", `        specifier: ${BASE}/@scope/pkg/-/pkg-3.0.0.tgz`, `        version: ${BASE}/@scope/pkg/-/pkg-3.0.0.tgz`,
    '      react:', '        specifier: ^19.0.0', '        version: 19.3.0', '', 'packages:', '', '  ms@2.1.3:', '    resolution: {}', ''].join('\n');
  const m = lib.lockfileSpecs(lock, BASE);
  assert.deepEqual(m.get('ms'), { spec: 'patch-cloud:ms@2.1.3', pin: '2.1.3' });
  assert.deepEqual(m.get('@scope/pkg'), { spec: `${BASE}/@scope/pkg/-/pkg-3.0.0.tgz`, pin: '3.0.0' });
  assert.deepEqual(m.get('react'), { spec: '^19.0.0', pin: null });
  assert.equal(m.has('ms@2.1.3'), false);
  assert.equal(lib.lockfileSpecs(null, BASE).size, 0);
});

test('keep policy: locked fork pin is reused even when the light is lit; locked upstream stays upstream even when dark', () => {
  const locked = new Map([['ms', { spec: 'patch-cloud:ms@2.1.3', pin: '2.1.3' }], ['@scope/pkg', { spec: '^3', pin: null }]]);
  const lights = new Map([['ms', 'lit']]);
  const pkg = { dependencies: { ms: '^2', '@scope/pkg': '^3' } };
  const ch = lib.rewriteManifest(pkg, lib.forksFromStatus(STATUS, BASE), 'registry', locked, lights);
  assert.equal(pkg.dependencies.ms, 'patch-cloud:ms@2.1.3');
  assert.equal(pkg.dependencies['@scope/pkg'], '^3', 'dark but locked upstream -> untouched');
  assert.deepEqual(ch.map((c) => [c.name, c.reason, c.lightState]), [['ms', 'lockfile', 'lit']]);
  const pkg2 = { dependencies: { ms: '^1' } };
  lib.rewriteManifest(pkg2, new Map(), 'registry', locked, lights);
  assert.equal(pkg2.dependencies.ms, '^1', 'pin outside the requested range is ignored');
});

test('readConfig lockfile policy: keep in CI, auto otherwise, env override', () => {
  assert.equal(lib.readConfig({ CI: 'true' }).lockfile, 'keep');
  assert.equal(lib.readConfig({ CI: 'false' }).lockfile, 'auto');
  assert.equal(lib.readConfig({}).lockfile, 'auto');
  assert.equal(lib.readConfig({ CI: '1', PATCH_CLOUD_LOCKFILE: 'follow' }).lockfile, 'follow');
});
