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
    const sHtml = await (await fetch(`${base}/status`, { headers: { Accept: 'text/html' } })).text();
    ok('/status HTML Downloads column', sHtml.includes('<th>Downloads</th>') && sHtml.includes('fork 1 · upstream 0'));
    ok('/status HTML total line', /Downloads:<\/b> 1 tarballs \(fork 1 · upstream 0\)/.test(sHtml));
    await new Promise((r) => setTimeout(r, 200));
    const saved = JSON.parse(readFileSync(join(COUNTS_TMP, 'downloads.json'), 'utf8'));
    ok('downloads.json flushed', saved.packages?.['broken-demo']?.fork === 1, JSON.stringify(saved.packages?.['broken-demo']));
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
    ok('audit POSTs not counted', d.total.metadata === 2 && d.total.tarballs === 1, JSON.stringify(d.total));
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
