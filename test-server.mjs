#!/usr/bin/env node
/**
 * Integration tests for patch-cloud (random port, no external deps).
 *
 * Checks:
 *  - mapped dark → fork tarball (broken-demo, next, react via local override)
 *  - react lit → proxied upstream; /status react fork link + light state
 *  - mapped lit → upstream (broken-demo local tarball)
 *  - unmapped left-pad + scoped @types/node → proxied
 *  - PUT rejected (405)
 *  - /health and landing page
 *  - /status (JSON + HTML), /health, / leak no box paths ('/workspace', '/home/')
 *  - download counter: fork/upstream/metadata per package, /, /status, /health
 *    not counted, persisted to COUNTS_DIR/downloads.json across restart,
 *    in-memory fallback when COUNTS_DIR unset or unwritable
 *  - npm audit POST endpoints proxied (not 405); publish PUT/POST/DELETE still 405
 *  - patch-cloud targets (unzipper, jimp, ms, prebuild-install, cli-table3): dark → fork
 *    version merged into the upstream packument (other versions still resolvable),
 *    full manifest (deps) from the fork tarball, PATCH-CLOUD.md + _patchCloud inside
 *  - ajv: rewriteReady false → never rewritten, shown as "no fork yet"
 *  - dayjs: labeled manual switch (issue #1) serves the fork while the light stays lit;
 *    /status shows it distinctly and counts it separately; dark still wins when dark
 *  - status wording: primary labels never use the bare word "failure"
 *  - lights tracked live include every mapped GitHub repo
 */
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LOCAL_LIGHTS = join(ROOT, 'local-lights.json');
const prevLocal = existsSync(LOCAL_LIGHTS) ? readFileSync(LOCAL_LIGHTS, 'utf8') : null;

const results = [];
function ok(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function overrideEntry(repo, lit) {
  return {
    repo,
    conclusion: lit ? 'success' : 'failure',
    workflow: 'local-demo',
    url: 'file://test',
    lit,
    runAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
  };
}

/** Write local-lights.json overrides. `reactDark` additionally forces react/react dark (test-only). */
function setDemoLight(lit, { reactDark = false } = {}) {
  const o = { 'local/broken-demo': overrideEntry('local/broken-demo', lit) };
  if (reactDark) o['react/react'] = overrideEntry('react/react', false);
  writeFileSync(LOCAL_LIGHTS, JSON.stringify(o, null, 2) + '\n');
}

async function startServer(port, extraEnv = {}) {
  const env = {
    ...process.env,
    COUNTS_DIR: '',
    COUNTS_FLUSH_MS: '50',
    PORT: String(port),
    HOST: '127.0.0.1',
    LIGHTS_CACHE_MINUTES: '60',
    LIGHTS_REFRESH: '0',
    RATE_LIMIT_PER_MIN: '0',
    STATUS_VERBOSE: '0',
    UNMAPPED_LIGHTS: '0',
    LIGHTS_FILE: join(ROOT, 'lights.json'),
    ...extraEnv,
  };
  const child = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
    env,
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try {
      if ((await fetch(`${base}/health`)).ok) return { child, base, log };
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  child.kill('SIGTERM');
  throw new Error('server not ready:\n' + log);
}

async function stop(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 250));
  try {
    child.kill('SIGKILL');
  } catch {
    /* */
  }
}

const COUNTS_TMP = mkdtempSync(join(tmpdir(), 'pc-counts-'));
const getDl = async (b) => (await (await fetch(`${b}/status`)).json()).downloads;
const pkgDl = async (b, repo) => (await (await fetch(`${b}/status`)).json()).packages.find((p) => p.repo === repo)?.downloads;

let child;
try {
  // --- dark path ---
  setDemoLight(false, { reactDark: true });
  const port = await freePort();
  ({ child } = await startServer(port, { COUNTS_DIR: COUNTS_TMP }));
  const base = `http://127.0.0.1:${port}`;

  // download counter (fresh COUNTS_DIR)
  {
    const d0 = await getDl(base);
    ok('counter persistent with COUNTS_DIR', d0?.persistent === true && !!d0.since, JSON.stringify(d0 && { p: d0.persistent, s: d0.since }));
    ok('counter starts at zero', d0.total.tarballs === 0 && d0.total.metadata === 0, JSON.stringify(d0.total));
    await fetch(`${base}/health`);
    await fetch(`${base}/`);
    await fetch(`${base}/status`, { headers: { Accept: 'text/html' } });
    await fetch(`${base}/-/ping`);
    const d1 = await getDl(base);
    ok('/, /status, /health not counted', d1.total.tarballs === 0 && d1.total.metadata === 0, JSON.stringify(d1.total));
    const meta = await (await fetch(`${base}/broken-demo`)).json();
    await (await fetch(meta.versions['1.0.0'].dist.tarball)).arrayBuffer();
    const bd = await pkgDl(base, 'local/broken-demo');
    ok('broken-demo counts fork 1 · metadata 1', bd?.fork === 1 && bd.metadata === 1 && bd.upstream === 0, JSON.stringify(bd));
    ok('broken-demo last24h counted', bd?.last24h?.fork === 1 && bd.last24h.metadata === 1, JSON.stringify(bd?.last24h));
    const d2 = await getDl(base);
    ok('total line fork 1 / tarballs 1', d2.total.fork === 1 && d2.total.tarballs === 1, JSON.stringify(d2.total));
    await (await fetch(`${base}/left-pad`)).arrayBuffer();
    const d3 = await getDl(base);
    ok('unmapped metadata → other bucket', d3.other.metadata === 1 && d3.total.metadata === 2, JSON.stringify(d3.other));
    const lp = d3.unmapped?.top?.find((t) => t.name === 'left-pad');
    ok('unmapped per-name: left-pad metadata 1 (total + 24h)', lp?.metadata === 1 && lp.upstream === 0 && lp.last24h.metadata === 1 && d3.unmapped.tracked === 1, JSON.stringify(d3.unmapped));
    ok('unmapped per-name excludes mapped packages', !d3.unmapped.top.some((t) => t.name === 'broken-demo'));
    const lpMeta = await (await fetch(`${base}/left-pad`)).json();
    await (await fetch(lpMeta.versions['1.3.0'].dist.tarball.replace('https://registry.npmjs.org', base))).arrayBuffer();
    const d3b = await getDl(base);
    const lp2 = d3b.unmapped.top.find((t) => t.name === 'left-pad');
    ok('unmapped per-name: left-pad tarball counted upstream', lp2?.metadata === 2 && lp2.upstream === 1 && lp2.last24h.upstream === 1, JSON.stringify(lp2));
    ok('aggregate other unchanged alongside per-name', d3b.other.metadata === 2 && d3b.other.upstream === 1, JSON.stringify(d3b.other));
    ok('unmapped light unknown when lookups disabled', lp2.light.state === 'unknown' && lp2.forkCandidate === false);
    const sHtml = await (await fetch(`${base}/status`, { headers: { Accept: 'text/html' } })).text();
    ok('/status HTML Downloads column', sHtml.includes('<th>Downloads</th>') && sHtml.includes('fork 1 · upstream 0'));
    ok('/status HTML unmapped table', sHtml.includes('Top unmapped packages') && sHtml.includes('<code>left-pad</code>'));
    ok('/status HTML total line', /Downloads:<\/b> 2 tarballs \(fork 1 · upstream 1\)/.test(sHtml));
    await new Promise((r) => setTimeout(r, 200));
    const saved = JSON.parse(readFileSync(join(COUNTS_TMP, 'downloads.json'), 'utf8'));
    ok('downloads.json flushed', saved.packages?.['broken-demo']?.fork === 1, JSON.stringify(saved.packages?.['broken-demo']));
    ok('downloads.json persists unmapped names', saved.unmapped?.['left-pad']?.metadata === 2 && saved.unmapped['left-pad'].upstream === 1, JSON.stringify(saved.unmapped));
    ok('downloads.json has no IPs', !/127\.0\.0\.1|::1|ffff/.test(JSON.stringify(saved)));
  }

  // npm audit POSTs proxied; publish still rejected
  {
    const bulk = await fetch(`${base}/-/npm/v1/security/advisories/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'left-pad': ['1.3.0'] }),
    });
    ok('POST advisories/bulk proxied (200)', bulk.status === 200 && bulk.headers.get('x-patch-cloud') === 'proxy', `status=${bulk.status}`);
    const bj = await bulk.json().catch(() => null);
    ok('advisories/bulk returns JSON object', bj && typeof bj === 'object');
    const { gzipSync } = await import('node:zlib');
    const bulkGz = await fetch(`${base}/-/npm/v1/security/advisories/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body: gzipSync(JSON.stringify({ 'left-pad': ['1.3.0'] })),
    });
    ok('POST advisories/bulk gzip body proxied (200)', bulkGz.status === 200, `status=${bulkGz.status}`);
    const quick = await fetch(`${base}/-/npm/v1/security/audits/quick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', version: '1.0.0', requires: { 'left-pad': '1.3.0' }, dependencies: { 'left-pad': { version: '1.3.0' } } }),
    });
    ok('POST audits/quick proxied (not 405)', quick.status !== 405 && quick.headers.get('x-patch-cloud') === 'proxy', `status=${quick.status}`);
    const pub = await fetch(`${base}/broken-demo`, { method: 'POST', body: '{}' });
    ok('POST publish → 405', pub.status === 405, `status=${pub.status}`);
    const del = await fetch(`${base}/broken-demo/-rev/1`, { method: 'DELETE' });
    ok('DELETE → 405', del.status === 405, `status=${del.status}`);
    const other = await fetch(`${base}/-/npm/v1/security/other`, { method: 'POST', body: '{}' });
    ok('other POST under /-/npm → 405', other.status === 405, `status=${other.status}`);
    const d = await getDl(base);
    ok('audit POSTs not counted', d.total.metadata === 3 && d.total.tarballs === 2, JSON.stringify(d.total));
  }

  // broken-demo dark → fork
  {
    const res = await fetch(`${base}/broken-demo`);
    const meta = await res.json();
    ok('broken-demo dark → fork header', res.headers.get('x-patch-cloud') === 'fork', res.headers.get('x-patch-cloud'));
    ok('broken-demo dark rewrite flag', meta.versions?.['1.0.0']?._patchCloud?.rewrite === true);
    const tb = await fetch(meta.versions['1.0.0'].dist.tarball);
    ok('broken-demo dark tarball fork', tb.ok && tb.headers.get('x-patch-cloud') === 'fork');
  }

  // next dark (lights.json has vercel/next.js lit:false) → annotated fork
  // The ~44 MB next tarball is not committed; build it with `npm run pack:next` to run these checks.
  if (!existsSync(join(ROOT, 'tarballs', 'next-16.4.0-fork.tgz'))) {
    console.log('SKIP  next checks (tarballs/next-16.4.0-fork.tgz missing; run `npm run pack:next`)');
  } else {
    const res = await fetch(`${base}/next`);
    const meta = await res.json();
    ok('next dark → fork header', res.headers.get('x-patch-cloud') === 'fork', res.headers.get('x-patch-cloud'));
    ok('next serves 16.4.0', !!meta.versions?.['16.4.0']);
    const tb = await fetch(meta.versions['16.4.0'].dist.tarball);
    ok('next tarball fork header', tb.ok && tb.headers.get('x-patch-cloud') === 'fork', String(tb.status));
    const tmp = mkdtempSync(join(tmpdir(), 'pc-test-'));
    writeFileSync(join(tmp, 'n.tgz'), Buffer.from(await tb.arrayBuffer()));
    execFileSync('tar', ['-xzf', join(tmp, 'n.tgz'), '-C', tmp]);
    ok('next has PATCH-CLOUD.md', existsSync(join(tmp, 'package', 'PATCH-CLOUD.md')));
    const pj = JSON.parse(readFileSync(join(tmp, 'package', 'package.json'), 'utf8'));
    ok('next _patchCloud.fork', pj._patchCloud?.fork === 'fitzyracing1/next.js', JSON.stringify(pj._patchCloud));
    rmSync(tmp, { recursive: true, force: true });
  }

  // react forced dark (local override) → annotated upstream react tarball
  {
    const res = await fetch(`${base}/react`);
    const meta = await res.json();
    const ver = JSON.parse(readFileSync(join(ROOT, 'mapping.json'), 'utf8'))['react/react'].version;
    ok('react dark → fork header', res.headers.get('x-patch-cloud') === 'fork', res.headers.get('x-patch-cloud'));
    ok(`react dark serves ${ver}`, !!meta.versions?.[ver] && meta['dist-tags']?.latest === ver, JSON.stringify(meta['dist-tags']));
    ok('react dark meta _patchCloud.fork', meta.versions?.[ver]?._patchCloud?.fork === 'fitzyracing1/react' && meta.versions[ver]._patchCloud.branch === 'main');
    const tb = await fetch(meta.versions[ver].dist.tarball);
    ok('react tarball fork header', tb.ok && tb.headers.get('x-patch-cloud') === 'fork', String(tb.status));
    const tmp = mkdtempSync(join(tmpdir(), 'pc-test-'));
    writeFileSync(join(tmp, 'r.tgz'), Buffer.from(await tb.arrayBuffer()));
    execFileSync('tar', ['-xzf', join(tmp, 'r.tgz'), '-C', tmp]);
    ok('react has PATCH-CLOUD.md', existsSync(join(tmp, 'package', 'PATCH-CLOUD.md')));
    const pj = JSON.parse(readFileSync(join(tmp, 'package', 'package.json'), 'utf8'));
    ok('react pkg name/version', pj.name === 'react' && pj.version === ver);
    ok('react _patchCloud fork/branch', pj._patchCloud?.fork === 'fitzyracing1/react' && pj._patchCloud?.branch === 'main', JSON.stringify(pj._patchCloud));
    rmSync(tmp, { recursive: true, force: true });
    const st = await (await fetch(`${base}/status`)).json();
    const rx = st.packages.find((p) => p.repo === 'react/react');
    ok('/status react dark + rewrite active', rx?.light?.state === 'dark' && rx?.rewrite === 'active', `${rx?.light?.state}/${rx?.rewrite}`);
  }


  // --- patch-cloud targets (bundled lights.json: all dark except iamkun/dayjs) ---
  const mappingNow = JSON.parse(readFileSync(join(ROOT, 'mapping.json'), 'utf8'));
  const TARGETS = [
    ['ZJONSSON/node-unzipper', 'unzipper', (pj) => pj.dependencies?.['@aws-sdk/client-s3'] && !pj.devDependencies?.['@aws-sdk/client-s3']],
    ['jimp-dev/jimp', 'jimp', (pj) => pj.dependencies?.['@jimp/core'] === '1.6.1'],
    ['vercel/ms', 'ms', (pj) => !pj.dependencies],
    ['prebuild/prebuild-install', 'prebuild-install', (pj) => pj.dependencies?.['tar-fs'] === '^2.1.4'],
    ['cli-table/cli-table3', 'cli-table3', (pj) => !!pj.dependencies?.['string-width']],
  ];
  for (const [repo, name, depCheck] of TARGETS) {
    const m = mappingNow[repo];
    const ver = m.version;
    const res = await fetch(`${base}/${name}`, { headers: { Accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' } });
    const meta = await res.json();
    ok(`${name} dark → fork header`, res.headers.get('x-patch-cloud') === 'fork' && res.headers.get('x-patch-cloud-light') === 'dark', res.headers.get('x-patch-cloud'));
    const v = meta.versions?.[ver];
    ok(`${name}@${ver} is the fork version`, v?._patchCloud?.source === 'fork' && v?._patchCloud?.fork === m.forkRepo && v?._patchCloud?.branch === 'patch-cloud', JSON.stringify(v?._patchCloud));
    ok(`${name} other upstream versions still resolvable`, Object.keys(meta.versions || {}).length > 3 && meta._patchCloud?.replacedVersion === ver, String(Object.keys(meta.versions || {}).length));
    const other = Object.keys(meta.versions).find((x) => x !== ver);
    ok(`${name} other versions keep upstream tarballs`, /^https:\/\/registry\.npmjs\.org\//.test(meta.versions[other].dist.tarball) && !meta.versions[other]._patchCloud, meta.versions[other].dist.tarball);
    ok(`${name} manifest deps come from fork tarball`, !!depCheck(v), JSON.stringify(v?.dependencies));
    ok(`${name} dist points at patch-cloud`, v?.dist?.tarball?.startsWith(base) && /^sha512-/.test(v.dist.integrity));
    const tb = await fetch(v.dist.tarball);
    ok(`${name} tarball served from fork`, tb.ok && tb.headers.get('x-patch-cloud') === 'fork', String(tb.status));
    const tmp = mkdtempSync(join(tmpdir(), 'pc-test-'));
    writeFileSync(join(tmp, 't.tgz'), Buffer.from(await tb.arrayBuffer()));
    execFileSync('tar', ['-xzf', join(tmp, 't.tgz'), '-C', tmp]);
    const pj = JSON.parse(readFileSync(join(tmp, 'package', 'package.json'), 'utf8'));
    ok(`${name} tarball has PATCH-CLOUD.md`, existsSync(join(tmp, 'package', 'PATCH-CLOUD.md')) && !/\/workspace|\/home\//.test(readFileSync(join(tmp, 'package', 'PATCH-CLOUD.md'), 'utf8')));
    ok(`${name} tarball name/version unchanged + _patchCloud`, pj.name === name && pj.version === ver && pj._patchCloud?.fork === `https://github.com/${m.forkRepo}` && pj._patchCloud?.branch === 'patch-cloud', JSON.stringify(pj._patchCloud));
    rmSync(tmp, { recursive: true, force: true });
    const otherGet = await fetch(`${base}/${name}/-/${name}-${other}.tgz`);
    ok(`${name}@${other} tarball proxied upstream (not the fork)`, otherGet.ok && otherGet.headers.get('x-patch-cloud') !== 'fork', `${otherGet.status} ${otherGet.headers.get('x-patch-cloud')}`);
    await otherGet.arrayBuffer();
  }
  {
    // jimp: the fork ships the real browser bundle, not the 98-byte stub
    const meta = await (await fetch(`${base}/jimp`)).json();
    const tb = await fetch(meta.versions['1.6.1'].dist.tarball);
    const tmp = mkdtempSync(join(tmpdir(), 'pc-test-'));
    writeFileSync(join(tmp, 'j.tgz'), Buffer.from(await tb.arrayBuffer()));
    execFileSync('tar', ['-xzf', join(tmp, 'j.tgz'), '-C', tmp]);
    const browser = readFileSync(join(tmp, 'package', 'dist', 'browser', 'index.js'), 'utf8');
    ok('jimp fork dist/browser/index.js is the real bundle', browser.length > 100000 && !browser.includes('A stub. The real build is done by rollup'), String(browser.length));
    rmSync(tmp, { recursive: true, force: true });
  }
  {
    // ajv: fork exists but rewriteReady false → never rewritten
    const res = await fetch(`${base}/ajv`, { headers: { Accept: 'application/vnd.npm.install-v1+json' } });
    ok('ajv not rewritten (eligible-not-ready)', res.headers.get('x-patch-cloud') === 'eligible-not-ready', res.headers.get('x-patch-cloud'));
    const meta = await res.json();
    ok('ajv metadata is plain upstream', !meta._patchCloud && !meta.versions?.['6.15.0']?._patchCloud);
  }
  {
    // dayjs: CI light LIT + labeled manual switch → fork, light never faked
    const res = await fetch(`${base}/dayjs`);
    const meta = await res.json();
    ok('dayjs manual → header manual, light lit', res.headers.get('x-patch-cloud') === 'manual' && res.headers.get('x-patch-cloud-light') === 'lit', `${res.headers.get('x-patch-cloud')}/${res.headers.get('x-patch-cloud-light')}`);
    const v = meta.versions?.['1.11.23'];
    ok('dayjs manual _patchCloud.source = manual', v?._patchCloud?.source === 'manual' && v._patchCloud.manual?.label === 'manual: fix available' && !!v._patchCloud.manual.reason, JSON.stringify(v?._patchCloud));
    ok('dayjs manual keeps other upstream versions', Object.keys(meta.versions).length > 50);
    const before = (await pkgDl(base, 'iamkun/dayjs')) || {};
    const tb = await fetch(v.dist.tarball);
    ok('dayjs manual tarball header manual', tb.ok && tb.headers.get('x-patch-cloud') === 'manual' && tb.headers.get('x-patch-cloud-light') === 'lit');
    const tmp = mkdtempSync(join(tmpdir(), 'pc-test-'));
    writeFileSync(join(tmp, 'd.tgz'), Buffer.from(await tb.arrayBuffer()));
    execFileSync('tar', ['-xzf', join(tmp, 'd.tgz'), '-C', tmp]);
    ok('dayjs manual tarball has PATCH-CLOUD.md', existsSync(join(tmp, 'package', 'PATCH-CLOUD.md')));
    rmSync(tmp, { recursive: true, force: true });
    const after = await pkgDl(base, 'iamkun/dayjs');
    ok('dayjs manual download counted as manual (not fork)', after.manual === (before.manual || 0) + 1 && after.fork === (before.fork || 0), JSON.stringify(after));
    const st = await (await fetch(`${base}/status`)).json();
    const dj = st.packages.find((p) => p.repo === 'iamkun/dayjs');
    ok('/status dayjs light stays lit (not dark)', dj.light.state === 'lit' && dj.light.conclusion === 'success', JSON.stringify(dj.light));
    ok('/status dayjs rewrite = manual', dj.rewrite === 'manual' && dj.manual?.label === 'manual: fix available' && dj.manual.servingNow === true && dj.manual.since === '2026-10-11', JSON.stringify(dj.manual));
    ok('/status dayjs label', dj.status.label === 'Fork available (manual: fix waiting upstream)' && dj.status.tone === 'green' && dj.status.secondary === 'upstream build: passing', JSON.stringify(dj.status));
    ok('/status counts manual separately', st.counts.manual === 1 && st.counts.rewriteActive >= 7 && st.packages.filter((p) => p.rewrite === 'active').length === st.counts.rewriteActive, JSON.stringify(st.counts));
    ok('/status downloads total has manual', st.downloads.total.manual >= 1 && st.downloads.total.tarballs === st.downloads.total.fork + st.downloads.total.upstream + st.downloads.total.manual, JSON.stringify(st.downloads.total));
    const sHtml = await (await fetch(`${base}/status`, { headers: { Accept: 'text/html' } })).text();
    ok('/status HTML shows manual switch distinctly', sHtml.includes('Fork available (manual: fix waiting upstream)') && sHtml.includes('manual: fix available') && sHtml.includes('manual → fork'));
    const land = await (await fetch(`${base}/`)).text();
    ok('landing shows manual count', /1 manual: fix available/.test(land), (land.match(/\d+ manual[^<]*/) || [''])[0]);
  }
  {
    // status wording (Joshua): primary label says what you get; CI result is secondary; no bare "failure"
    const st = await (await fetch(`${base}/status`)).json();
    const by = (r) => st.packages.find((p) => p.repo === r);
    const uz = by('ZJONSSON/node-unzipper');
    ok('dark + fork ready → "Fork available — download via patch-cloud"', uz.status.label === 'Fork available — download via patch-cloud' && uz.status.tone === 'green', JSON.stringify(uz.status));
    ok('dark + fork ready → secondary "upstream build: failing" with link', uz.status.secondary === 'upstream build: failing' && /^https:\/\/github\.com\/ZJONSSON\/node-unzipper\/actions\/runs\//.test(uz.status.secondaryUrl || ''), JSON.stringify(uz.status));
    const aj = by('ajv-validator/ajv');
    ok('dark + no fork → "Upstream build failing — no fork yet"', aj.status.label === 'Upstream build failing — no fork yet' && aj.rewrite === 'would rewrite', JSON.stringify(aj.status));
    ok('no primary/secondary label uses "failure"', st.packages.every((p) => !/failure/i.test(p.status.label + ' ' + p.status.secondary)), st.packages.map((p) => p.status.label).join(' | '));
    const sHtml = await (await fetch(`${base}/status`, { headers: { Accept: 'text/html' } })).text();
    const land = await (await fetch(`${base}/`)).text();
    const visible = (h) => h.replace(/<[^>]+>/g, ' ');
    ok('/status HTML has no visible "failure" / "(failure)"', !/failure/i.test(visible(sHtml)), (visible(sHtml).match(/.{30}failure.{30}/i) || [''])[0]);
    ok('landing has no visible "failure"', !/failure/i.test(visible(land)));
    ok('/status HTML dark+ready label + secondary link', sHtml.includes('Fork available — download via patch-cloud') && sHtml.includes('upstream build: failing</a>'));
    for (const r of ['ZJONSSON/node-unzipper', 'jimp-dev/jimp', 'vercel/ms', 'prebuild/prebuild-install', 'ajv-validator/ajv', 'cli-table/cli-table3', 'iamkun/dayjs']) {
      const p = by(r);
      ok(`/status lists ${r} with a real light + fork link`, p && p.light.state !== 'unknown' && p.fork?.branch === 'patch-cloud' && /^https:\/\/github\.com\/fitzyracing1\//.test(p.fork.url) && /^https:\/\/github\.com\//.test(p.upstream?.url || ''), JSON.stringify(p && { l: p.light.state, f: p.fork, u: p.upstream }));
    }
    // dark lights board (out-light #1): days dark, fork yes/no, one-line install, watchlist
    ok('board: dark packages carry days dark', st.packages.filter((p) => p.light.state === 'dark' && p.npmName).every((p) => p.dark && typeof p.dark.days === 'number' && /day/.test(p.dark.label)), JSON.stringify(st.packages.map((p) => p.dark?.label)));
    ok('board: lit packages have no dark info', st.packages.filter((p) => p.light.state === 'lit').every((p) => p.dark === null));
    ok('board: install one-liner only when fork is served', st.packages.every((p) => (p.install ? ['active', 'manual'].includes(p.rewrite) && p.install.startsWith(`npm install ${p.npmName}`) && p.install.includes('--registry') : !['active', 'manual'].includes(p.rewrite))), JSON.stringify(st.packages.map((p) => [p.npmName, p.rewrite, p.install])));
    ok('board: unzipper install pins fork version', uz.install === `npm install unzipper@0.12.5 --registry ${st.registry}`, uz.install);
    ok('board HTML sections', sHtml.includes('dark lights board') && sHtml.includes('Dark now') && sHtml.includes('one-line install') && sHtml.includes(uz.install));
    const wl = st.watchlist;
    ok('watchlist present with repo links + summaries', wl && wl.entries.length >= 10 && wl.entries.every((e) => /^https:\/\/github\.com\//.test(e.repoUrl) && e.summary && e.dark.label && /fork/.test(e.fork)), wl && wl.entries.length);
    ok('watchlist never says "failure"', !/failure/i.test(JSON.stringify(wl)));
    ok('watchlist HTML rendered', sHtml.includes('id="watchlist"') && wl.entries.slice(0, 5).every((e) => sHtml.includes(e.repoUrl)));
    // merged fixes (upstream PRs merged by maintainers; dark → lit upstream), from merged.json
    const mg = st.merged;
    const seed = JSON.parse(readFileSync(join(ROOT, 'merged.json'), 'utf8'));
    const c = mg && mg.entries.find((e) => e.repo === 'cnpm/cnpmcore' && e.pr === 1161);
    ok('merged: JSON section present, one entry per merged.json row', mg && mg.count === seed.length && mg.entries.length === seed.length, JSON.stringify(mg && mg.count));
    ok('merged: lit-dark link', mg && mg.litDark === 'https://fitzyracing1.github.io/lit-dark/#merged');
    ok('merged: cnpmcore #1161 facts', c && c.url === 'https://github.com/cnpm/cnpmcore/pull/1161' && c.title === 'ci: run test-mysql57-s3-nfs against a local S3Mock instead of the remote bucket' && c.mergedAt === '2026-10-12T04:05:45Z' && c.mergedBy === 'fengmk2' && c.mergedByUrl === 'https://github.com/fengmk2', JSON.stringify(c && { url: c.url, mergedAt: c.mergedAt, by: c.mergedBy }));
    ok('merged: date shown in ET', c && c.mergedAtET === 'Oct 12, 2026, 12:05 AM ET', c && c.mergedAtET);
    ok('merged: before = which light, since when, why', c && c.light === 'test-mysql57-s3-nfs' && c.before.light === 'dark' && c.before.sinceET === 'Apr 1, 2026' && /HTTP 530/.test(c.before.why), JSON.stringify(c && c.before.why));
    ok('merged: before links a dark upstream run before the merge', c && c.before.run?.url === 'https://github.com/cnpm/cnpmcore/actions/runs/37601763270' && c.before.run.light === 'dark' && c.before.run.createdAt < c.mergedAt && c.before.run.jobsDark === 3, JSON.stringify(c && c.before.run && { u: c.before.run.url, d: c.before.run.jobsDark }));
    ok('merged: fix in one plain sentence', c && /S3Mock/.test(c.fix || '') && (c.fix.match(/\.\s/g) || []).length === 0, c && c.fix);
    ok('merged: after = first upstream run after merge, all light jobs lit', c && c.after.light === 'lit' && c.after.label === 'lit upstream now' && c.after.run?.url === 'https://github.com/cnpm/cnpmcore/actions/runs/38202391845' && c.after.run.createdAt >= c.mergedAt && c.after.run.jobsLit === 3 && c.after.run.jobs.length === 3 && c.after.run.jobs.every((j) => j.name.includes('test-mysql57-s3-nfs') && j.light === 'lit'), JSON.stringify(c && c.after.summary));
    ok('merged: entries newest first', mg && mg.entries.every((e, i, a) => i === 0 || String(a[i - 1].mergedAt) >= String(e.mergedAt)));
    ok('merged: JSON never says "failure"/"success"', !/failure|success/i.test(JSON.stringify(mg)));
    const mi = sHtml.indexOf('id="merged"');
    ok('merged HTML: section near the top (before "Dark now")', mi > 0 && mi < sHtml.indexOf('Dark now') && sHtml.includes('Merged fixes'), String(mi));
    const mgHtml = mi > 0 ? sHtml.slice(mi, sHtml.indexOf('Dark now')) : '';
    ok('merged HTML: repo, PR link, title, ET date, merged by', mgHtml.includes('href="https://github.com/cnpm/cnpmcore/pull/1161"') && mgHtml.includes('cnpm/cnpmcore#1161') && mgHtml.includes('local S3Mock instead of the remote bucket') && mgHtml.includes('Oct 12, 2026, 12:05 AM ET') && mgHtml.includes('href="https://github.com/fengmk2">@fengmk2'));
    ok('merged HTML: Before / Fix / After', /Before:<\/b>.*was <b>dark<\/b> on master since Apr 1, 2026.*HTTP 530.*actions\/runs\/37601763270.*3 of 3 test-mysql57-s3-nfs jobs dark/s.test(mgHtml) && /Fix:<\/b>.*S3Mock/.test(mgHtml) && /After:<\/b> <b>lit upstream now\.<\/b>.*actions\/runs\/38202391845.*3 of 3 test-mysql57-s3-nfs jobs lit/s.test(mgHtml));
    ok('merged HTML: links lit-dark #merged', mgHtml.includes('href="https://fitzyracing1.github.io/lit-dark/#merged"'));
    ok('merged HTML: nav link + pill', sHtml.includes('href="#merged"') && /\d+ merged upstream · \d+ lit/.test(sHtml));
    ok('merged HTML: only lit/dark vocabulary (no failure/success/passing/failing)', !/failure|success|passing|failing/i.test(visible(mgHtml)), (visible(mgHtml).match(/.{20}(failure|success|passing|failing).{20}/i) || [''])[0]);
    ok('Dockerfile ships merged.json', /^COPY .*\bmerged\.json\b/m.test(readFileSync(join(ROOT, 'Dockerfile'), 'utf8')));
    {
      const run = (args) => { try { execFileSync(process.execPath, [join(ROOT, 'add-merged.mjs'), ...args], { stdio: 'pipe', env: { ...process.env, MERGED_FILE: join(tmpdir(), 'pc-merged-never.json') } }); return 0; } catch (e) { return e.status; } };
      ok('add-merged.mjs: usage / bad args rejected without network', run([]) === 2 && run(['not a repo', '1']) === 1 && run(['cnpm/cnpmcore', 'abc']) === 1);
    }
    ok('third-party upstream PR labeled neutrally', /upstream fix PR/.test(uz.upstream.label) || /merged|closed/.test(uz.upstream.label), uz.upstream.label);
  }
  {
    // lights tracked live: every mapped GitHub repo is refreshed (not just the 8 light-computer repos)
    const mod = await import('./server.mjs');
    const repos = mod.lightRepos();
    const want = Object.keys(mappingNow).filter((r) => !r.startsWith('local/'));
    ok('lightRepos() covers every mapped GitHub repo', want.every((r) => repos.includes(r)) && !repos.includes('local/broken-demo'), repos.join(','));
    const lj = JSON.parse(readFileSync(join(ROOT, 'lights.json'), 'utf8')).map((l) => l.repo);
    ok('bundled lights.json snapshot includes every mapped GitHub repo', want.every((r) => lj.includes(r)));
    {
      const before = mod.unmappedPublic().tracked;
      for (let i = 0; i < mod.UNMAPPED_MAX + 10; i += 1) mod.countHit(`zz-evict-${i}`, 'metadata', null);
      for (let k = 0; k < 5; k += 1) mod.countHit('zz-hot', 'upstream', null);
      mod.countHit('../etc/passwd', 'metadata', null);
      mod.countHit('Bad Name', 'metadata', null);
      const pub = mod.unmappedPublic();
      ok('unmapped names bounded to UNMAPPED_MAX', pub.tracked === mod.UNMAPPED_MAX, `${before}->${pub.tracked}`);
      ok('unmapped eviction keeps the hottest name on top', pub.top[0].name === 'zz-hot' && pub.top[0].upstream === 5, JSON.stringify(pub.top[0]));
      ok('unmapped ignores invalid names', !mod.unmappedTop(1e6).some((t) => /passwd|Bad/.test(t.name)));
      ok('mapped name not counted as unmapped', (mod.countHit('broken-demo', 'metadata', { npmName: 'broken-demo' }), !mod.unmappedTop(1e6).some((t) => t.name === 'broken-demo')));
      ok('githubRepoOf parses npm repository forms',
        mod.githubRepoOf({ url: 'git+https://github.com/stevemao/left-pad.git' }) === 'stevemao/left-pad' &&
        mod.githubRepoOf('github:foo/bar') === 'foo/bar' && mod.githubRepoOf('foo/bar') === 'foo/bar' &&
        mod.githubRepoOf({ url: 'git+ssh://git@github.com/a/b.js.git' }) === 'a/b.js' &&
        mod.githubRepoOf({ url: 'https://gitlab.com/a/b' }) === null && mod.githubRepoOf(undefined) === null);
    }
    const pj = mod.tarballManifest('tarballs/unzipper-0.12.5.tgz');
    ok('tarballManifest reads package.json from .tgz', pj?.name === 'unzipper' && pj.version === '0.12.5');
    // manual switch semantics (pure): needs rewriteReady + reason; dark always wins; never touches the light
    const lit = { lit: true, conclusion: 'success' };
    const dark = { lit: false, conclusion: 'failure' };
    const mm = { npmName: 'x', rewriteReady: true, manualRewrite: { reason: 'r', since: '2026-10-11' } };
    ok('manual + lit → manual', mod.rewriteMode(mm, lit).mode === 'manual');
    ok('manual + dark → fork (dark wins)', mod.rewriteMode(mm, dark).mode === 'fork');
    ok('manual without rewriteReady → none', mod.rewriteMode({ ...mm, rewriteReady: false }, lit).mode === 'none');
    ok('manual without reason → none', mod.rewriteMode({ ...mm, manualRewrite: { since: 'x' } }, lit).mode === 'none');
    ok('manual does not mutate light', lit.lit === true && lit.conclusion === 'success');
    ok('lit, no manual → "Upstream OK — normal npm"', mod.displayFor({ npmName: 'x', rewriteReady: true }, lit, 'ready').label === 'Upstream OK — normal npm');
  }

  // unmapped + scoped while server up
  {
    const res = await fetch(`${base}/left-pad`);
    ok('left-pad proxied 200', res.ok, `status=${res.status}`);
    ok('left-pad proxy header', res.headers.get('x-patch-cloud') === 'proxy');
    const meta = await res.json();
    ok('left-pad has versions', !!meta.versions && Object.keys(meta.versions).length > 0);
  }
  {
    const res = await fetch(`${base}/@types%2Fnode`);
    ok('@types/node proxied 200', res.ok, `status=${res.status}`);
    ok('@types/node proxy header', res.headers.get('x-patch-cloud') === 'proxy');
    const meta = await res.json();
    ok('@types/node name', meta.name === '@types/node', meta.name);
  }

  // PUT rejected
  {
    const res = await fetch(`${base}/broken-demo`, { method: 'PUT', body: '{}' });
    ok('PUT → 405', res.status === 405, `status=${res.status}`);
  }

  // health + landing
  {
    const h = await (await fetch(`${base}/health`)).json();
    ok('health ok', h.ok === true);
    const land = await fetch(`${base}/`);
    const html = await land.text();
    ok('landing mentions opt-in', land.ok && /opt-in/i.test(html));
    ok('landing has npm install', html.includes('npm install'));
  }

  // public status / health: no box paths or internal notes
  {
    const leak = (t) => t.includes('/workspace') || t.includes('/home/');
    const sJson = await (await fetch(`${base}/status`)).text();
    const sHtml = await (await fetch(`${base}/status`, { headers: { Accept: 'text/html' } })).text();
    const hJson = await (await fetch(`${base}/health`)).text();
    const land = await (await fetch(`${base}/`)).text();
    ok('/status JSON has no /workspace or /home/', !leak(sJson));
    ok('/status HTML has no /workspace or /home/', !leak(sHtml));
    ok('/health has no /workspace or /home/', !leak(hJson));
    ok('landing has no /workspace or /home/', !leak(land));
    ok('/status has no internal wording', !/joshua|awaiting|not opened|patchFiles|\.patch\b/i.test(sJson + sHtml));
    const st = JSON.parse(sJson);
    const nx = st.packages.find((p) => p.repo === 'vercel/next.js');
    ok('/status next fork link', nx?.fork?.url === 'https://github.com/fitzyracing1/next.js' && nx.fork.branch === 'rspack-manifest-fix');
    ok('/status next upstream PR', nx?.upstream?.url === 'https://github.com/vercel/next.js/pull/100001' && !!nx.upstream.state, JSON.stringify(nx?.upstream));
    ok('/status next rewrite active', nx?.rewrite === 'active', nx?.rewrite);
    const dn = st.packages.find((p) => p.repo === 'denoland/deno');
    ok('/status deno issue label', /issue/.test(dn?.upstream?.label || ''), dn?.upstream?.label);
    ok('/status HTML shows fork link', sHtml.includes('https://github.com/fitzyracing1/next.js/tree/rspack-manifest-fix'));
  }

  await stop(child);

  // --- lit path for broken-demo ---
  setDemoLight(true);
  const port2 = await freePort();
  ({ child } = await startServer(port2, { COUNTS_DIR: COUNTS_TMP }));
  const base2 = `http://127.0.0.1:${port2}`;
  const forkBefore = (await pkgDl(base2, 'local/broken-demo'))?.fork;
  ok('counts survive restart (same COUNTS_DIR)', forkBefore >= 2, `fork=${forkBefore}`);
  {
    const res = await fetch(`${base2}/broken-demo`);
    ok('broken-demo lit → upstream header', res.headers.get('x-patch-cloud') === 'upstream', res.headers.get('x-patch-cloud'));
    const meta = await res.json();
    const tb = await fetch(meta.versions['1.0.0'].dist.tarball);
    ok('broken-demo lit tarball upstream', tb.ok && tb.headers.get('x-patch-cloud') === 'upstream');
    await tb.arrayBuffer();
    const bd = await pkgDl(base2, 'local/broken-demo');
    ok('lit tarball counted as upstream', bd?.upstream === 1 && bd.fork === forkBefore, JSON.stringify(bd));
  }
  // react lit (bundled lights.json: react/react success) → proxied upstream
  {
    const res = await fetch(`${base2}/react`);
    ok('react lit → upstream-proxy header', res.headers.get('x-patch-cloud') === 'upstream-proxy', res.headers.get('x-patch-cloud'));
    const meta = await res.json();
    ok('react lit proxied has many versions', res.ok && Object.keys(meta.versions || {}).length > 50);
    const st = await (await fetch(`${base2}/status`)).json();
    const rx = st.packages.find((p) => p.repo === 'react/react');
    ok('/status react fork link', rx?.fork?.url === 'https://github.com/fitzyracing1/react' && rx.fork.branch === 'main', JSON.stringify(rx?.fork));
    ok('/status react lit + rewrite ready', rx?.light?.state === 'lit' && rx?.rewrite === 'ready', `${rx?.light?.state}/${rx?.rewrite}`);
    ok('/status react public note', /no code changes yet/i.test(rx?.note || '') && !/\/workspace|\/home\//.test(JSON.stringify(rx)), rx?.note);
  }

  await stop(child);

  // in-memory fallback: COUNTS_DIR unset, and COUNTS_DIR unwritable
  const notADir = join(COUNTS_TMP, 'not-a-dir');
  writeFileSync(notADir, 'x'); // COUNTS_DIR pointing at a file → ENOTDIR
  {
    // merged entry whose after-merge run is not lit yet → "waiting for upstream light", never "lit upstream now"
    const seed = JSON.parse(readFileSync(join(ROOT, 'merged.json'), 'utf8'))[0];
    const tmpMerged = join(COUNTS_TMP, 'merged-waiting.json');
    writeFileSync(tmpMerged, JSON.stringify([
      { ...seed, pr: 99991, litRun: { ...seed.litRun, state: 'dark', jobs: seed.litRun.jobs.map((j) => ({ ...j, light: 'dark' })) } },
      { ...seed, pr: 99992, litRun: { state: 'waiting' } },
    ]));
    const pw = await freePort();
    ({ child } = await startServer(pw, { MERGED_FILE: tmpMerged }));
    const st = await (await fetch(`http://127.0.0.1:${pw}/status`)).json();
    ok('merged waiting: after run dark → waiting', st.merged.entries.every((e) => e.after.light === 'waiting' && e.after.label === 'waiting for upstream light') && st.merged.litCount === 0, JSON.stringify(st.merged.entries.map((e) => e.after.light)));
    const h = await (await fetch(`http://127.0.0.1:${pw}/status`, { headers: { Accept: 'text/html' } })).text();
    const sec = h.slice(h.indexOf('id="merged"'), h.indexOf('Dark now'));
    ok('merged waiting HTML: says "waiting for upstream light", never "lit upstream now"', sec.includes('waiting for upstream light') && !sec.includes('lit upstream now') && sec.includes('no upstream run has finished since the merge'));
    await stop(child);
  }
  for (const [label, dir] of [['unset', ''], ['unwritable', join(notADir, 'sub')]]) {
    const p = await freePort();
    ({ child } = await startServer(p, { COUNTS_DIR: dir }));
    const d = await getDl(`http://127.0.0.1:${p}`);
    ok(`COUNTS_DIR ${label} → in-memory note`, d.persistent === false && /since last restart/.test(d.note), d.note);
    const html = await (await fetch(`http://127.0.0.1:${p}/status`, { headers: { Accept: 'text/html' } })).text();
    ok(`COUNTS_DIR ${label} → HTML shows restart note`, html.includes('counts since last restart') && !html.includes(COUNTS_TMP) && !html.includes('/tmp/'));
    await stop(child);
  }
} catch (e) {
  console.error(e);
  ok('harness', false, String(e.message || e));
  await stop(child);
} finally {
  if (prevLocal === null) rmSync(LOCAL_LIGHTS, { force: true }); else writeFileSync(LOCAL_LIGHTS, prevLocal);
  rmSync(COUNTS_TMP, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log('\n---');
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.error('Failed:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
process.exit(0);
