// Offline tests (CI-runnable): fake registry, fake patch cloud, fake GitHub, fake npm pack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { review, download, sign, verifySig, sriOf, repoFromPackument, LIT, DARK } from './lib.mjs';

const SECRET = 'test-secret-not-real';
const TARBALL = Buffer.from('pretend tarball bytes');
const GOOD_SRI = sriOf(TARBALL);

const status = {
  packages: [
    { npmName: 'litpkg', repo: 'o/litpkg', light: { state: 'lit', conclusion: 'success', url: 'u1' } },
    { npmName: 'darkpkg', repo: 'o/darkpkg', light: { state: 'dark', conclusion: 'failure', url: 'u2' } },
  ],
};
const packument = (name, repo) => ({ name, repository: repo ? { url: `git+https://github.com/${repo}.git` } : undefined, versions: { '1.0.0': { dist: { integrity: GOOD_SRI, tarball: `https://reg/${name}/-/${name}-1.0.0.tgz` } } } });
const ghRuns = { 'o/ghlit': 'success', 'o/ghdark': 'cancelled' };

function fakeFetch(url) {
  const json = (body, ok = true) => ({ ok, json: async () => body });
  if (url === 'https://pc/status') return json(status);
  let m = url.match(/^https:\/\/reg\/(.+)$/);
  if (m) {
    const n = decodeURIComponent(m[1]);
    const map = { litpkg: null, darkpkg: null, ghlit: 'o/ghlit', ghdark: 'o/ghdark', nolight: null };
    return n in map ? json(packument(n, map[n])) : json(null, false);
  }
  m = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/?]+)(\/actions\/runs.*)?$/);
  if (m && ghRuns[m[1]]) return m[2] ? json({ workflow_runs: [{ conclusion: ghRuns[m[1]], name: 'CI', html_url: 'gh' }] }) : json({ default_branch: 'main' });
  return json(null, false);
}

const NOW = Date.parse('2026-10-17T18:00:00Z');
function ctx(extra = {}) {
  return { secret: SECRET, allowlist: new Set(['bot-a']), seenNonces: new Set(), usedOkays: new Set(), registry: 'https://reg', statusUrl: 'https://pc/status', fetchImpl: async (u) => fakeFetch(u), now: NOW, ...extra };
}
function req(pkg, extra = {}, secret = SECRET) {
  const r = { id: 'r1', package: pkg, version: '1.0.0', requester: 'bot-a', nonce: 'nonce-' + pkg + Math.random(), createdAt: new Date(NOW - 1000).toISOString(), ...extra };
  r.sig = sign(r, secret);
  return r;
}

test('lit package from patch cloud => okay (lit 0) with signed okay record', async () => {
  const r = await review(req('litpkg'), ctx());
  assert.equal(r.decision, 'okay');
  assert.equal(r.bit, LIT);
  assert.equal(r.light, 'lit');
  assert.equal(r.okay.integrity, GOOD_SRI);
  assert.ok(verifySig(r.okay, SECRET));
});

test('dark package from patch cloud => refuse (dark 1)', async () => {
  const r = await review(req('darkpkg'), ctx());
  assert.equal(r.decision, 'refuse');
  assert.equal(r.bit, DARK);
  assert.match(r.reason, /dark/);
});

test('GitHub Actions fallback: success = lit, anything else = dark', async () => {
  assert.equal((await review(req('ghlit'), ctx())).decision, 'okay');
  const d = await review(req('ghdark'), ctx());
  assert.equal(d.decision, 'refuse');
  assert.match(d.reason, /cancelled/);
});

test('no light anywhere => dark by default', async () => {
  const r = await review(req('nolight'), ctx());
  assert.equal(r.decision, 'refuse');
  assert.equal(r.lightSource, 'unknown');
});

test('unknown requester => refuse', async () => {
  const r = await review(req('litpkg', { requester: 'stranger' }), ctx());
  assert.equal(r.decision, 'refuse');
  assert.match(r.reason, /allowlist/);
});

test('bad signature, tampered field, replay, stale request => refuse', async () => {
  assert.match((await review(req('litpkg', {}, 'wrong-secret'), ctx())).reason, /signature/);
  const t = req('litpkg'); t.version = '9.9.9';
  assert.match((await review(t, ctx())).reason, /signature/);
  const r = req('litpkg');
  assert.match((await review(r, ctx({ seenNonces: new Set([r.nonce]) }))).reason, /replay/);
  assert.match((await review(req('litpkg', { createdAt: new Date(NOW - 3600e3).toISOString() }), ctx())).reason, /old/);
});

test('ranges and tags are refused: okay is for one exact version', async () => {
  assert.match((await review(req('litpkg', { version: '^1.0.0' }), ctx())).reason, /exact/);
  assert.match((await review(req('litpkg', { version: 'latest' }), ctx())).reason, /exact/);
  assert.match((await review(req('litpkg', { version: '2.0.0' }), ctx())).reason, /not on registry/);
});

test('download: runs only with a valid okay, once, and checks integrity', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mb-'));
  let packs = 0;
  const packImpl = async ({ spec, dest }) => { packs++; const f = path.join(dest, spec.replace('@', '-') + '.tgz'); await fs.writeFile(f, TARBALL); return f; };
  const c = ctx({ downloadDir: dir, packImpl });
  const { okay } = await review(req('litpkg'), c);

  const forged = { ...okay, version: '1.0.1' };
  assert.equal((await download(forged, c)).ok, false);
  assert.equal(packs, 0, 'no download without a valid okay');

  const d = await download(okay, c);
  assert.equal(d.ok, true);
  assert.equal(packs, 1);
  const again = await download(okay, c);
  assert.equal(again.ok, false);
  assert.match(again.reason, /already used/);
  assert.equal(packs, 1, 'single use');

  const expired = await review(req('litpkg'), c);
  assert.match((await download(expired.okay, { ...c, now: NOW + 3600e3 })).reason, /expired/);

  const bad = await review(req('litpkg'), c);
  const badPack = async ({ dest }) => { const f = path.join(dest, 'bad.tgz'); await fs.writeFile(f, 'other bytes'); return f; };
  const r = await download(bad.okay, { ...c, packImpl: badPack });
  assert.equal(r.ok, false);
  assert.match(r.reason, /integrity mismatch/);
  await assert.rejects(fs.stat(path.join(dir, 'bad.tgz')), 'mismatched tarball removed');
});

test('repoFromPackument handles common repository forms', () => {
  assert.equal(repoFromPackument({ repository: { url: 'git+https://github.com/iamkun/dayjs.git' } }), 'iamkun/dayjs');
  assert.equal(repoFromPackument({ repository: 'git@github.com:vercel/ms.git' }), 'vercel/ms');
  assert.equal(repoFromPackument({ repository: 'vercel/ms' }), 'vercel/ms');
  assert.equal(repoFromPackument({}), null);
});
