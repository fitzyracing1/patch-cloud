#!/usr/bin/env node
/**
 * patch-cloud registry — tiny npm-compatible HTTP registry (no deps).
 *
 * When a mapped package's light is DARK and rewriteReady: serve Joshua's fork
 * (or annotated upstream tarball). When LIT / unknown / not rewrite-ready:
 * serve local upstream tarball (broken-demo) or proxy to registry.npmjs.org.
 *
 * Active-low lights (from greenlight-computer): lit=success/green, dark=failure/red.
 *
 * Read-only by design: PUT/POST (publish) are rejected.
 */
import http from 'node:http';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  createReadStream,
  statSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PORT,
  HOST,
  PUBLIC_URL,
  LIGHTS_FILE,
  LIGHTS_CACHE_MINUTES,
  LIGHTS_REFRESH,
  GITHUB_TOKEN,
  RATE_LIMIT_PER_MIN,
  ROOT,
  STATUS_VERBOSE,
  COUNTS_DIR,
  COUNTS_FLUSH_MS,
} from './config.mjs';

const LOCAL_LIGHTS = join(ROOT, 'local-lights.json');
const MAPPING_FILE = join(ROOT, 'mapping.json');
const UPSTREAM_STATUS_FILE = join(ROOT, 'upstream-status.json');
const UPSTREAM = 'https://registry.npmjs.org';
const UA = 'patch-cloud/0.2 (+https://github.com/fitzyracing1)';

// --- lights cache -----------------------------------------------------------
let lightsCache = { at: 0, byRepo: new Map(), refreshing: false };

const LIGHT_REPOS = [
  'nodejs/node',
  'microsoft/vscode',
  'react/react',
  'rust-lang/rust',
  'vercel/next.js',
  'denoland/deno',
  'python/cpython',
  'fitzyracing1/fakegreen',
];

function loadJson(p, fallback = null) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadMapping() {
  return loadJson(MAPPING_FILE, {});
}

function mergeLights(ghArr) {
  const byRepo = new Map();
  for (const l of ghArr || []) byRepo.set(l.repo, { ...l, source: l.source || 'lights.json' });
  const local = loadJson(LOCAL_LIGHTS, {});
  for (const [repo, l] of Object.entries(local || {})) {
    byRepo.set(repo, { ...l, repo, source: 'local-override' });
  }
  return byRepo;
}

async function fetchOneLight(repo) {
  const url = `https://api.github.com/repos/${repo}/actions/runs?per_page=1&status=completed&event=push`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': UA,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${repo}: HTTP ${res.status}`);
  const data = await res.json();
  const run = data.workflow_runs && data.workflow_runs[0];
  if (!run) throw new Error(`${repo}: no completed runs`);
  return {
    repo,
    conclusion: run.conclusion,
    workflow: run.name,
    url: run.html_url,
    lit: run.conclusion === 'success',
    runAt: run.updated_at,
    fetchedAt: new Date().toISOString(),
  };
}

async function refreshLightsFromGitHub() {
  const results = await Promise.allSettled(LIGHT_REPOS.map(fetchOneLight));
  const lights = [];
  for (const r of results) if (r.status === 'fulfilled') lights.push(r.value);
  if (lights.length) {
    try {
      writeFileSync(LIGHTS_FILE, JSON.stringify(lights, null, 2) + '\n');
    } catch (e) {
      console.warn('could not write lights file:', e.message || e);
    }
  }
  return lights;
}

async function ensureLights() {
  const maxAge = Math.max(0, LIGHTS_CACHE_MINUTES) * 60 * 1000;
  const now = Date.now();
  if (lightsCache.byRepo.size && now - lightsCache.at < maxAge) {
    return lightsCache.byRepo;
  }
  if (LIGHTS_REFRESH && !lightsCache.refreshing) {
    lightsCache.refreshing = true;
    try {
      const lights = await refreshLightsFromGitHub();
      lightsCache.byRepo = mergeLights(lights);
      lightsCache.at = Date.now();
    } catch (e) {
      console.warn('lights refresh failed, using file:', e.message || e);
      lightsCache.byRepo = mergeLights(loadJson(LIGHTS_FILE, []));
      lightsCache.at = Date.now();
    } finally {
      lightsCache.refreshing = false;
    }
  } else {
    lightsCache.byRepo = mergeLights(loadJson(LIGHTS_FILE, []));
    lightsCache.at = Date.now();
  }
  return lightsCache.byRepo;
}

function loadLightsSync() {
  // sync path for status / hot path when cache warm
  if (lightsCache.byRepo.size && Date.now() - lightsCache.at < Math.max(0, LIGHTS_CACHE_MINUTES) * 60 * 1000) {
    return lightsCache.byRepo;
  }
  lightsCache.byRepo = mergeLights(loadJson(LIGHTS_FILE, []));
  lightsCache.at = Date.now();
  return lightsCache.byRepo;
}

function lightFor(repo, lights) {
  return lights.get(repo) || null;
}

function findMappingByNpmName(npmName) {
  const mapping = loadMapping();
  for (const [repo, m] of Object.entries(mapping)) {
    if (m.npmName === npmName) return { repo, ...m };
  }
  return null;
}

function fileIntegrity(absPath) {
  const buf = readFileSync(absPath);
  const shasum = createHash('sha1').update(buf).digest('hex');
  const integrity = 'sha512-' + createHash('sha512').update(buf).digest('base64');
  return { shasum, integrity, size: buf.length };
}

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers.host || `${HOST}:${PORT}`;
  return `${proto}://${host}`;
}

/** npm tarball filename: scoped packages use unscoped basename. */
function tarballFileName(npmName, version) {
  const base = npmName.includes('/') ? npmName.split('/').pop() : npmName;
  return `${base}-${version}.tgz`;
}

function packageMeta(req, npmName, version, tarballRel, description, extra = {}) {
  const abs = join(ROOT, tarballRel);
  const { shasum, integrity } = fileIntegrity(abs);
  const tarball = `${baseUrl(req)}/${npmName}/-/${tarballFileName(npmName, version)}`;
  const verObj = {
    name: npmName,
    version,
    description,
    dist: { tarball, shasum, integrity },
    ...extra,
  };
  return {
    _id: npmName,
    name: npmName,
    description,
    'dist-tags': { latest: version },
    versions: { [version]: verObj },
    time: {
      modified: new Date().toISOString(),
      created: new Date().toISOString(),
      [version]: new Date().toISOString(),
    },
  };
}

// --- upstream PR/issue state (public GitHub REST, cached) --------------------
// Seeded from upstream-status.json (written by check-upstream.mjs); refreshed
// via fetch so it also works in the container (no `gh` there). Read-only.
const UPSTREAM_TTL_MS = 10 * 60 * 1000;
let upstreamCache = { at: 0, results: null, refreshing: null };

function parseUpstreamUrl(url) {
  if (!url) return null;
  const bare = url.split('#')[0];
  let m = bare.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (m) return { kind: 'pull', owner: m[1], repo: m[2], number: Number(m[3]) };
  m = bare.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (m) return { kind: 'issue', owner: m[1], repo: m[2], number: Number(m[3]) };
  return null;
}

async function ghApi(path) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': UA,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchUpstreamOne(parsed) {
  const base = `/repos/${parsed.owner}/${parsed.repo}`;
  let kind = parsed.kind;
  let data;
  if (kind === 'issue') {
    data = await ghApi(`${base}/issues/${parsed.number}`);
    if (data.pull_request) kind = 'pull';
  }
  if (kind === 'pull') {
    data = await ghApi(`${base}/pulls/${parsed.number}`);
    const merged = !!data.merged;
    return { kind, number: parsed.number, state: merged ? 'merged' : data.state, merged, title: data.title };
  }
  return { kind, number: parsed.number, state: data.state, merged: false, title: data.title };
}

function upstreamResultsSync() {
  if (upstreamCache.results) return upstreamCache.results;
  const seeded = loadJson(UPSTREAM_STATUS_FILE, null);
  upstreamCache.results = { ...(seeded?.results || {}) };
  return upstreamCache.results;
}

async function ensureUpstream() {
  const current = upstreamResultsSync();
  if (Date.now() - upstreamCache.at < UPSTREAM_TTL_MS) return current;
  if (upstreamCache.refreshing) return upstreamCache.refreshing;
  upstreamCache.refreshing = (async () => {
    const mapping = loadMapping();
    const next = { ...current };
    const checkedAt = new Date().toISOString();
    await Promise.all(
      Object.entries(mapping).map(async ([repo, m]) => {
        const url = m.ciPatch?.upstreamUrl;
        const parsed = parseUpstreamUrl(url);
        if (!parsed) return;
        try {
          next[repo] = { upstreamUrl: url, ...(await fetchUpstreamOne(parsed)), checkedAt, error: null };
        } catch (e) {
          // keep last known good (seed/cached); only record error if nothing known
          if (!next[repo] || !next[repo].state || next[repo].state === 'unknown') {
            next[repo] = { upstreamUrl: url, kind: parsed.kind, number: parsed.number, state: 'unknown', merged: false, checkedAt, error: String(e.message || e) };
          }
        }
      }),
    );
    upstreamCache = { at: Date.now(), results: next, refreshing: null };
    return next;
  })();
  try {
    return await upstreamCache.refreshing;
  } catch {
    upstreamCache.refreshing = null;
    return current;
  }
}

// --- download counter ----------------------------------------------------------
// Per mapped package: tarballs served from the FORK (rewrite active), tarballs
// served/proxied UPSTREAM, and metadata requests. Unmapped/proxied packages are
// aggregated under one "other" bucket so the file stays bounded. /, /status,
// /health are never counted. Persisted to $COUNTS_DIR/downloads.json (debounced)
// when COUNTS_DIR is set and writable; otherwise in-memory since last restart.
const COUNT_KINDS = ['fork', 'upstream', 'metadata'];
const OTHER_BUCKET = '(other, proxied)';
const HOUR_MS = 3600_000;
const counter = {
  since: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  persistent: false,
  file: null,
  packages: {}, // name -> { fork, upstream, metadata }
  hours: {}, // name -> { 'YYYY-MM-DDTHH': { fork, upstream, metadata } }
  flushTimer: null,
  lastError: null,
};

function zeroCounts() {
  return { fork: 0, upstream: 0, metadata: 0 };
}

function hourKey(t = Date.now()) {
  return new Date(t).toISOString().slice(0, 13);
}

function initCounter() {
  if (!COUNTS_DIR) return;
  try {
    mkdirSync(COUNTS_DIR, { recursive: true });
    const file = join(COUNTS_DIR, 'downloads.json');
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved && typeof saved === 'object') {
        if (saved.since) counter.since = saved.since;
        for (const [name, c] of Object.entries(saved.packages || {})) {
          counter.packages[name] = { ...zeroCounts(), ...c };
        }
        counter.hours = saved.hours && typeof saved.hours === 'object' ? saved.hours : {};
      }
    }
    // prove writability now so the status page doesn't lie about persistence
    writeFileSync(file + '.probe', '{}');
    rmSync(file + '.probe', { force: true });
    counter.file = file;
    counter.persistent = true;
    if (!existsSync(file)) flushCounterNow();
  } catch (e) {
    counter.persistent = false;
    counter.file = null;
    counter.lastError = String(e.code || e.message || e);
    console.warn('download counter: persistence unavailable, in-memory only:', counter.lastError);
  }
}

function pruneHours(now = Date.now()) {
  const cutoff = hourKey(now - 25 * HOUR_MS);
  for (const [name, hrs] of Object.entries(counter.hours)) {
    for (const k of Object.keys(hrs)) if (k < cutoff) delete hrs[k];
    if (!Object.keys(hrs).length) delete counter.hours[name];
  }
}

function flushCounterNow() {
  if (!counter.persistent || !counter.file) return;
  if (counter.flushTimer) {
    clearTimeout(counter.flushTimer);
    counter.flushTimer = null;
  }
  try {
    pruneHours();
    const data = { version: 1, since: counter.since, savedAt: new Date().toISOString(), packages: counter.packages, hours: counter.hours };
    writeFileSync(counter.file + '.tmp', JSON.stringify(data, null, 2) + '\n');
    renameSync(counter.file + '.tmp', counter.file);
  } catch (e) {
    counter.lastError = String(e.code || e.message || e);
    console.warn('download counter: flush failed:', counter.lastError);
  }
}

function scheduleFlush() {
  if (!counter.persistent || counter.flushTimer) return;
  counter.flushTimer = setTimeout(flushCounterNow, COUNTS_FLUSH_MS);
  counter.flushTimer.unref?.();
}

/** kind: 'fork' | 'upstream' | 'metadata'. Unmapped names go to one bucket. */
function countHit(npmName, kind, mapped) {
  if (!COUNT_KINDS.includes(kind)) return;
  const name = mapped && mapped.npmName ? mapped.npmName : OTHER_BUCKET;
  const c = (counter.packages[name] ||= zeroCounts());
  c[kind] += 1;
  const hk = hourKey();
  const hrs = (counter.hours[name] ||= {});
  const h = (hrs[hk] ||= zeroCounts());
  h[kind] += 1;
  scheduleFlush();
}

function last24For(name, now = Date.now()) {
  const out = zeroCounts();
  const cutoff = hourKey(now - 23 * HOUR_MS); // current hour + previous 23
  for (const [k, h] of Object.entries(counter.hours[name] || {})) {
    if (k >= cutoff) for (const kind of COUNT_KINDS) out[kind] += h[kind] || 0;
  }
  return out;
}

function downloadsFor(name) {
  return { ...zeroCounts(), ...(counter.packages[name] || {}), last24h: last24For(name) };
}

function downloadsSummary() {
  const total = zeroCounts();
  const last24h = zeroCounts();
  const names = new Set([...Object.keys(counter.packages), ...Object.keys(counter.hours)]);
  for (const name of names) {
    const d = downloadsFor(name);
    for (const k of COUNT_KINDS) {
      total[k] += d[k];
      last24h[k] += d.last24h[k];
    }
  }
  return {
    since: counter.persistent ? counter.since : counter.startedAt,
    persistent: counter.persistent,
    note: counter.persistent
      ? 'counts persisted across restarts'
      : `counts since last restart ${counter.startedAt} (not persisted)`,
    total: { ...total, tarballs: total.fork + total.upstream },
    last24h: { ...last24h, tarballs: last24h.fork + last24h.upstream },
    other: downloadsFor(OTHER_BUCKET),
    counted: 'tarball GETs served from fork / upstream (incl. proxied) and package metadata GETs; /, /status, /health not counted; no IPs stored',
  };
}

// --- public-safe projection ---------------------------------------------------
const ABS_PATH_RE = /(?:file:\/\/)?\/(?:workspace|home|tmp|root|app|Users|var|opt|mnt|srv)\/[^\s,;)'"]*/g;

/** Strip absolute paths / internal wording from free text meant for the public. */
function publicText(s) {
  if (!s) return null;
  const out = String(s)
    .replace(ABS_PATH_RE, '')
    .replace(/\bJoshua'?s?\b/gi, 'the maintainer')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;])/g, '$1')
    .trim();
  return out || null;
}

function publicNote(m) {
  return publicText(m.publicNote || m.note || '');
}

function upstreamPublic(m, up) {
  const url = m.ciPatch?.upstreamUrl;
  if (!url || !/^https:\/\/github\.com\//.test(url)) return null;
  const parsed = parseUpstreamUrl(url);
  const isComment = /#issuecomment-/.test(url);
  const kind = isComment ? 'pr-comment' : up?.kind === 'pull' || parsed?.kind === 'pull' ? 'pr' : 'issue';
  const state = up?.merged ? 'merged' : ['open', 'closed', 'merged'].includes(up?.state) ? up.state : 'unknown';
  const labels = {
    pr: { open: 'fix submitted upstream', merged: 'fix merged upstream', closed: 'upstream PR closed (not merged)', unknown: 'fix submitted upstream' },
    issue: { open: 'issue filed upstream', closed: 'upstream issue closed', merged: 'upstream issue closed', unknown: 'issue filed upstream' },
    'pr-comment': { open: 'fix proposed on upstream PR', merged: 'upstream PR merged', closed: 'upstream PR closed', unknown: 'fix proposed on upstream PR' },
  };
  return { url, kind, state, label: labels[kind][state] };
}

function forkPublic(m) {
  if (!m.forkRepo || !/^[\w.-]+\/[\w.-]+$/.test(m.forkRepo)) return null;
  const url = `https://github.com/${m.forkRepo}`;
  return {
    repo: m.forkRepo,
    url,
    branch: m.forkBranch || null,
    branchUrl: m.forkBranch ? `${url}/tree/${encodeURIComponent(m.forkBranch)}` : null,
  };
}

function publicStatusPayload() {
  const mapping = loadMapping();
  const lights = loadLightsSync();
  const ups = upstreamResultsSync();
  const reg = PUBLIC_URL || `http://${HOST}:${PORT}`;
  const packages = [];
  for (const [repo, m] of Object.entries(mapping)) {
    const light = lightFor(repo, lights);
    const lit = light ? !!light.lit : null;
    const dark = lit === false;
    const rewrite =
      m.rewriteReady && m.npmName && dark
        ? 'active'
        : dark && m.npmName && !m.rewriteReady
          ? 'would rewrite'
          : m.rewriteReady && m.npmName
            ? 'ready'
            : 'n/a';
    packages.push({
      repo,
      npmName: m.npmName || null,
      light: {
        state: lit === true ? 'lit' : lit === false ? 'dark' : 'unknown',
        conclusion: light?.conclusion ?? 'unknown',
        fetchedAt: light?.fetchedAt ?? null,
      },
      rewrite,
      fork: forkPublic(m),
      upstream: upstreamPublic(m, ups[repo]),
      note: publicNote(m),
      downloads: m.npmName ? downloadsFor(m.npmName) : null,
    });
  }
  return {
    service: 'patch-cloud',
    registry: reg,
    publicUrl: PUBLIC_URL || null,
    lightsCachedAt: lightsCache.at ? new Date(lightsCache.at).toISOString() : null,
    lightsCacheMinutes: LIGHTS_CACHE_MINUTES,
    downloads: downloadsSummary(),
    packages,
    legend: {
      lit: 'CI success → pass through / serve upstream',
      dark: 'CI failure → rewrite to fork when packaged',
      rewrite: 'active = serving fork now · ready = packaged, light lit · would rewrite = dark but no fork packaged · n/a = not an npm rewrite target',
    },
    optIn: {
      install: `npm install <pkg> --registry ${reg}`,
      npmrc: `registry=${reg}/`,
      status: '/status',
      health: '/health',
    },
  };
}

/** Full internal payload (local use only; enabled by STATUS_VERBOSE=1). */
function statusPayloadVerbose() {
  const mapping = loadMapping();
  const lights = loadLightsSync();
  const packages = [];
  for (const [repo, m] of Object.entries(mapping)) {
    const light = lightFor(repo, lights);
    const lit = light ? !!light.lit : null;
    const dark = lit === false;
    const rewriteActive = !!(m.rewriteReady && m.npmName && dark);
    packages.push({
      repo,
      npmName: m.npmName,
      lit,
      conclusion: light?.conclusion ?? 'unknown',
      lightSource: light?.source ?? 'none',
      rewriteReady: !!m.rewriteReady,
      rewriteActive,
      upstreamProxy: !!m.upstreamProxy,
      forkPath: m.forkDir ? join(ROOT, m.forkDir) : null,
      forkTarball: m.forkTarball ? join(ROOT, m.forkTarball) : null,
      upstreamTarball: m.upstreamTarball ? join(ROOT, m.upstreamTarball) : null,
      forkRepo: m.forkRepo || null,
      forkBranch: m.forkBranch || null,
      version: m.version || null,
      note: m.note || null,
      downloads: m.npmName ? downloadsFor(m.npmName) : null,
      ciPatch: m.ciPatch
        ? (() => {
            const up = upstreamResultsSync()[repo] || null;
            return {
              ...m.ciPatch,
              patchFilesPresent: (m.ciPatch.patchFiles || []).map((f) => ({
                path: f,
                exists: existsSync(f),
              })),
              upstreamStatus: up ? (up.merged ? 'merged' : up.state || 'unknown') : null,
              upstreamCheckedAt: up?.checkedAt || null,
              upstreamTitle: up?.title || null,
            };
          })()
        : null,
      wouldRewrite:
        dark && !m.rewriteReady && m.npmName
          ? `would rewrite ${m.npmName} → fitzyracing1/${m.npmName} (not packaged)`
          : null,
    });
  }
  return {
    service: 'patch-cloud',
    registry: PUBLIC_URL || `http://${HOST}:${PORT}`,
    publicUrl: PUBLIC_URL || null,
    lightsFile: LIGHTS_FILE,
    localLights: LOCAL_LIGHTS,
    lightsCachedAt: lightsCache.at ? new Date(lightsCache.at).toISOString() : null,
    lightsCacheMinutes: LIGHTS_CACHE_MINUTES,
    downloads: { ...downloadsSummary(), file: counter.file, lastError: counter.lastError },
    packages,
    ciPatches: packages
      .filter((p) => p.ciPatch)
      .map((p) => ({
        repo: p.repo,
        kind: p.ciPatch.kind,
        state: p.ciPatch.state,
        upstreamUrl: p.ciPatch.upstreamUrl || null,
        upstreamStatus: p.ciPatch.upstreamStatus || null,
        patchFiles: p.ciPatch.patchFiles,
        drafts: p.ciPatch.drafts || [],
        upstreamRun: p.ciPatch.upstreamRun,
        forkRepo: p.forkRepo,
        forkBranch: p.forkBranch,
      })),
    legend: {
      lit: 'CI success → pass through / serve upstream',
      dark: 'CI failure → rewrite to fork when rewriteReady',
    },
    optIn: {
      install: `npm install <pkg> --registry ${PUBLIC_URL || `http://${HOST}:${PORT}`}`,
      npmrc: `registry=${PUBLIC_URL || `http://${HOST}:${PORT}`}/`,
      status: '/status',
      health: '/health',
    },
  };
}

async function proxyNpm(req, res, pathAndQuery, count = null) {
  const url = `${UPSTREAM}${pathAndQuery}`;
  try {
    const upstream = await fetch(url, {
      headers: {
        Accept: req.headers.accept || 'application/json',
        'User-Agent': UA,
      },
      redirect: 'follow',
    });
    const headers = {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Patch-Cloud': res.getHeader('X-Patch-Cloud') || 'proxy',
    };
    // fetch() transparently decompresses, so use the decoded length, never upstream's
    const buf = Buffer.from(await upstream.arrayBuffer());
    headers['Content-Length'] = buf.length;
    res.writeHead(upstream.status, headers);
    res.end(buf);
    if (count && upstream.status >= 200 && upstream.status < 300) countHit(count.npmName, count.kind, count.mapped);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'proxy failed', message: String(e.message || e) }));
  }
}

// npm install POSTs these after resolving; proxy them so audit doesn't 405.
const AUDIT_POST_PATHS = new Set(['/-/npm/v1/security/advisories/bulk', '/-/npm/v1/security/audits/quick']);
const AUDIT_MAX_BODY = 10 * 1024 * 1024;

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxyAuditPost(req, res, pathAndQuery) {
  let body;
  try {
    body = await readBody(req, AUDIT_MAX_BODY);
  } catch (e) {
    return sendJson(res, e.code === 413 ? 413 : 400, { error: String(e.message || e) });
  }
  const headers = {
    'Content-Type': req.headers['content-type'] || 'application/json',
    Accept: req.headers.accept || 'application/json',
    'User-Agent': UA,
  };
  // npm gzips the bulk advisory body; pass the encoding through untouched
  if (req.headers['content-encoding']) headers['Content-Encoding'] = req.headers['content-encoding'];
  try {
    const upstream = await fetch(`${UPSTREAM}${pathAndQuery}`, { method: 'POST', headers, body, redirect: 'follow' });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
      'X-Patch-Cloud': 'proxy',
    });
    res.end(buf);
  } catch (e) {
    sendJson(res, 502, { error: 'proxy failed', message: String(e.message || e) });
  }
}

function sendJson(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendFile(res, absPath, headers = {}) {
  const st = statSync(absPath);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-store',
    ...headers,
  });
  createReadStream(absPath).pipe(res);
}

function htmlLanding(status) {
  const active = status.packages.filter((p) => p.rewrite === 'active');
  const ready = status.packages.filter((p) => p.npmName && (p.rewrite === 'active' || p.rewrite === 'ready'));
  const rows = status.packages
    .filter((p) => p.npmName)
    .map((p) => {
      const lamp = p.light.state === 'lit' ? '● lit' : p.light.state === 'dark' ? '○ dark' : '? unknown';
      const rw =
        p.rewrite === 'active'
          ? '<b style="color:#6f6">REWRITE ACTIVE</b>'
          : p.rewrite === 'ready'
            ? 'ready (light lit → upstream)'
            : 'not packaged';
      return `<tr>
        <td><code>${escapeHtml(p.repo)}</code></td>
        <td><code>${escapeHtml(p.npmName)}</code></td>
        <td>${lamp}</td>
        <td>${rw}</td>
        <td><small>${escapeHtml(p.note || '')}</small></td>
      </tr>`;
    })
    .join('\n');
  const reg = status.registry;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>patch-cloud — opt-in npm registry</title>
<style>
  :root { --bg:#0d1117; --card:#161b22; --border:#30363d; --text:#e6edf3; --muted:#8b949e; --accent:#58a6ff; --ok:#3fb950; --warn:#d29922; }
  *{box-sizing:border-box} body{font-family:ui-sans-serif,system-ui,sans-serif;margin:0;background:var(--bg);color:var(--text);line-height:1.5}
  main{max-width:920px;margin:0 auto;padding:2rem 1.25rem}
  h1{font-size:1.75rem;margin:0 0 .5rem} h2{font-size:1.15rem;margin:2rem 0 .75rem;border-bottom:1px solid var(--border);padding-bottom:.35rem}
  p,li{color:var(--muted)} code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
  code{background:#21262d;padding:.1em .35em;border-radius:4px;color:#a5d6ff}
  pre{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:1rem;overflow:auto;color:var(--text)}
  .card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1.25rem;margin:1rem 0}
  .warn{border-color:var(--warn);background:#211a0a}
  a{color:var(--accent)} table{border-collapse:collapse;width:100%;font-size:.9rem}
  th,td{border:1px solid var(--border);padding:.45rem .6rem;text-align:left} th{background:#21262d}
  .pill{display:inline-block;padding:.15rem .55rem;border-radius:999px;background:#21262d;font-size:.8rem}
  .ok{color:var(--ok)}
</style></head><body><main>
  <h1>patch-cloud</h1>
  <p>Opt-in npm-compatible registry. When a mapped package's CI light is <b>dark</b>, installs get an annotated fork under the <em>same package name</em>. When <b>lit</b>, traffic is proxied to <code>registry.npmjs.org</code>.</p>

  <div class="card warn">
    <strong>Safety / opt-in only</strong>
    <ul>
      <li>You must point npm at this host explicitly (<code>--registry</code> or project <code>.npmrc</code>). It is never the default.</li>
      <li>Only packages listed below with <em>rewrite ready</em> are ever rewritten — and only while their light is dark.</li>
      <li>Everything else (including scoped packages like <code>@types/node</code>) is proxied unchanged to the public registry.</li>
      <li>Publish is disabled (PUT/POST/DELETE → 405). This registry is read-only; only npm's audit POSTs are proxied to the public registry.</li>
      <li><strong>Lockfiles:</strong> rewritten tarballs have different integrity hashes. Existing <code>package-lock.json</code> / <code>npm ci</code> will fail until you regenerate the lockfile while opted in — or opt out and use upstream.</li>
    </ul>
  </div>

  <h2>Opt in (one-liner)</h2>
  <pre>npm install &lt;pkg&gt; --registry ${escapeHtml(reg)}</pre>
  <p>Or add a project <code>.npmrc</code>:</p>
  <pre>registry=${escapeHtml(reg)}/</pre>

  <h2>Opt out</h2>
  <pre>npm config delete registry
# or remove the registry= line from .npmrc, then reinstall</pre>

  <h2>Status</h2>
  <p>
    <span class="pill">${active.length} rewrite active</span>
    <span class="pill">${ready.length} rewrite ready</span>
    <a href="/status">/status</a> ·
    <a href="/health">/health</a>
  </p>
  <table>
    <tr><th>Light repo</th><th>npm</th><th>Light</th><th>Rewrite</th><th>Note</th></tr>
    ${rows}
  </table>

  <h2>What gets rewritten?</h2>
  <p>Currently packaged:</p>
  <ul>
    ${ready
      .map(
        (p) =>
          `<li><code>${escapeHtml(p.npmName)}</code> ← <code>${escapeHtml(p.repo)}</code>${
            p.rewrite === 'active' ? ' <span class="ok">(active now)</span>' : ''
          }</li>`,
      )
      .join('') || '<li>(none)</li>'}
  </ul>

  <p><small>Active-low lights from greenlight-computer · cache ${status.lightsCacheMinutes} min · service read-only</small></p>
</main></body></html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlStatusVerbose(status) {
  const rows = status.packages
    .map((p) => {
      const lamp = p.lit === true ? '● lit' : p.lit === false ? '○ dark' : '? unknown';
      const rw = p.rewriteActive
        ? '<b style="color:#0a0">REWRITE ACTIVE → fork</b>'
        : p.wouldRewrite
          ? `<span style="color:#a60">${escapeHtml(p.wouldRewrite)}</span>`
          : p.rewriteReady
            ? 'rewrite ready (light lit → upstream)'
            : 'n/a';
      return `<tr>
        <td><code>${p.repo}</code></td>
        <td>${p.npmName ? `<code>${p.npmName}</code>` : '—'}</td>
        <td>${lamp} <small>(${p.conclusion})</small></td>
        <td>${rw}</td>
        <td><small>${escapeHtml(p.note || '')}</small></td>
        <td><small>${
          p.ciPatch
            ? `<b style="color:#fc6">${escapeHtml(p.ciPatch.state)}</b><br>${escapeHtml(p.ciPatch.kind)}<br>` +
              (p.ciPatch.upstreamUrl
                ? `<a href="${escapeHtml(p.ciPatch.upstreamUrl)}" target="_blank" rel="noopener">${escapeHtml(p.ciPatch.upstreamUrl)}</a><br>`
                : '') +
              (p.forkRepo
                ? `fork: <code>${escapeHtml(p.forkRepo)}</code>${p.forkBranch ? ` @ <code>${escapeHtml(p.forkBranch)}</code>` : ''}<br>`
                : '') +
              (p.ciPatch.upstreamStatus
                ? `upstream: <b>${escapeHtml(p.ciPatch.upstreamStatus)}</b><br>`
                : '') +
              (p.ciPatch.patchFiles || []).map((f) => `<code>${escapeHtml(f)}</code>`).join('<br>')
            : '—'
        }</small></td>
      </tr>`;
    })
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>patch-cloud status</title>
  <style>
    body{font-family:system-ui,sans-serif;margin:2rem;background:#111;color:#eee}
    table{border-collapse:collapse;width:100%} th,td{border:1px solid #444;padding:.5rem;text-align:left}
    th{background:#222} a{color:#6af} code{color:#9f9}
  </style></head><body>
  <h1>patch-cloud status</h1>
  <p>Registry: <code>${escapeHtml(status.registry)}</code> · Lights: <code>${escapeHtml(status.lightsFile)}</code>
  · <a href="/">landing</a> · <a href="/status">JSON</a> · <a href="/health">/health</a></p>
  <table>
    <tr><th>Light repo</th><th>npm name</th><th>Light</th><th>Rewrite</th><th>Note</th><th>CI patch</th></tr>
    ${rows}
  </table>
  <p><small>Active-low: lit = CI success, dark = CI failure.</small></p>
  </body></html>`;
}

function downloadsLine(d) {
  if (!d) return '';
  const t = d.total;
  const o = d.other || { metadata: 0, upstream: 0 };
  return `<p class="dl"><b>Downloads:</b> ${t.tarballs} tarballs (fork ${t.fork} · upstream ${t.upstream}) · metadata ${t.metadata}
  · last 24h: fork ${d.last24h.fork} · upstream ${d.last24h.upstream} · metadata ${d.last24h.metadata}
  <br><small>${d.persistent ? `since ${escapeHtml(d.since)}` : escapeHtml(d.note)} · unmapped packages (proxied): ${o.upstream} tarballs · ${o.metadata} metadata · all requests counted, incl. our own tests; /, /status, /health excluded; no IPs stored</small></p>`;
}

function htmlStatusPublic(status) {
  const link = (href, text) =>
    `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`;
  const rows = status.packages
    .map((p) => {
      const lamp =
        p.light.state === 'lit'
          ? '<span style="color:#3fb950">● lit</span>'
          : p.light.state === 'dark'
            ? '<span style="color:#f85149">○ dark</span>'
            : '? unknown';
      const rw =
        p.rewrite === 'active'
          ? '<b style="color:#3fb950">active → fork</b>'
          : p.rewrite === 'would rewrite'
            ? '<span style="color:#d29922">would rewrite (no fork packaged)</span>'
            : p.rewrite === 'ready'
              ? 'ready (light lit → upstream)'
              : 'n/a';
      const fork = p.fork
        ? link(p.fork.url, p.fork.repo) + (p.fork.branch ? ` @ ${link(p.fork.branchUrl, p.fork.branch)}` : '')
        : '—';
      const up = p.upstream
        ? `${link(p.upstream.url, p.upstream.url.replace(/^https:\/\/github\.com\//, ''))}<br>` +
          `<b style="color:#fc6">${escapeHtml(p.upstream.label)}</b> <small>(${escapeHtml(p.upstream.state)})</small>`
        : '—';
      const dl = p.downloads
        ? `fork ${p.downloads.fork} · upstream ${p.downloads.upstream}<br><small>metadata ${p.downloads.metadata} · 24h: fork ${p.downloads.last24h.fork} · upstream ${p.downloads.last24h.upstream}</small>`
        : '—';
      return `<tr>
        <td><code>${escapeHtml(p.repo)}</code></td>
        <td>${p.npmName ? `<code>${escapeHtml(p.npmName)}</code>` : '—'}</td>
        <td>${lamp} <small>(${escapeHtml(p.light.conclusion)})</small>${
          p.light.fetchedAt ? `<br><small>${escapeHtml(p.light.fetchedAt)}</small>` : ''
        }</td>
        <td>${rw}</td>
        <td>${dl}</td>
        <td><small>${fork}</small></td>
        <td><small>${up}</small></td>
        <td><small>${escapeHtml(p.note || '')}</small></td>
      </tr>`;
    })
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>patch-cloud status</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{font-family:system-ui,sans-serif;margin:2rem;background:#111;color:#eee}
    table{border-collapse:collapse;width:100%;font-size:.9rem} th,td{border:1px solid #444;padding:.5rem;text-align:left;vertical-align:top}
    th{background:#222} a{color:#6af} code{color:#9f9}
  </style></head><body>
  <h1>patch-cloud status</h1>
  <p>Registry: <code>${escapeHtml(status.registry)}</code>
  · <a href="/">landing</a> · <a href="/status?format=json">JSON</a> · <a href="/health">/health</a></p>
  ${downloadsLine(status.downloads)}
  <table>
    <tr><th>Light repo</th><th>npm name</th><th>Light</th><th>Rewrite</th><th>Downloads</th><th>Fork</th><th>Upstream</th><th>Note</th></tr>
    ${rows}
  </table>
  <p><small>Active-low: lit = CI success, dark = CI failure. Lights cache ${escapeHtml(status.lightsCacheMinutes)} min.</small></p>
  </body></html>`;
}

// --- rate limit (simple fixed window per IP) --------------------------------
const rateBuckets = new Map();
function rateLimitOk(ip) {
  if (!RATE_LIMIT_PER_MIN || RATE_LIMIT_PER_MIN <= 0) return true;
  const now = Date.now();
  const windowMs = 60_000;
  let b = rateBuckets.get(ip);
  if (!b || now - b.start >= windowMs) {
    b = { start: now, count: 0 };
    rateBuckets.set(ip, b);
  }
  b.count += 1;
  if (rateBuckets.size > 10_000) {
    for (const [k, v] of rateBuckets) {
      if (now - v.start >= windowMs) rateBuckets.delete(k);
    }
  }
  return b.count <= RATE_LIMIT_PER_MIN;
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/** Decode package name from URL path (handles @scope%2Fname and @scope/name). */
function decodeNpmName(rawPath) {
  let name = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep */
  }
  return name;
}

function resolveTarballRel(mapped, dark) {
  if (dark) return mapped.forkTarball || null;
  if (mapped.upstreamTarball) return mapped.upstreamTarball;
  return null; // signal proxy
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  // Keep %2F for matching; decode selectively
  const pathRaw = u.pathname;
  let path;
  try {
    path = decodeURIComponent(pathRaw);
  } catch {
    path = pathRaw;
  }

  const ip = clientIp(req);
  if (!rateLimitOk(ip)) {
    return sendJson(res, 429, { error: 'rate limit exceeded', limitPerMinute: RATE_LIMIT_PER_MIN });
  }

  if (req.method === 'POST' && AUDIT_POST_PATHS.has(path)) {
    return proxyAuditPost(req, res, pathRaw + u.search);
  }

  // Read-only: reject publish and other mutating methods early
  if (req.method === 'PUT' || req.method === 'POST' || req.method === 'DELETE' || req.method === 'PATCH') {
    return sendJson(res, 405, {
      error: 'publish disabled — patch-cloud is read-only',
      method: req.method,
    });
  }

  if (req.method === 'GET' && (path === '/health' || path === '/-/ping')) {
    const health = { ok: true, service: 'patch-cloud', port: PORT, publicUrl: PUBLIC_URL || null };
    if (STATUS_VERBOSE) Object.assign(health, { verbose: true, root: ROOT, lightsFile: LIGHTS_FILE });
    return sendJson(res, 200, health);
  }

  if (req.method === 'GET' && path === '/status') {
    try {
      await ensureLights();
    } catch {
      /* ignore */
    }
    try {
      await ensureUpstream();
    } catch (e) {
      console.error('upstream state refresh failed (serving cached):', e.message || e);
    }
    const status = STATUS_VERBOSE ? statusPayloadVerbose() : publicStatusPayload();
    const accept = req.headers.accept || '';
    if (accept.includes('text/html') && u.searchParams.get('format') !== 'json') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(STATUS_VERBOSE ? htmlStatusVerbose(status) : htmlStatusPublic(status));
    }
    return sendJson(res, 200, status);
  }

  if (req.method === 'GET' && path === '/') {
    try {
      await ensureLights();
    } catch {
      /* ignore */
    }
    try {
      await ensureUpstream();
    } catch {
      /* ignore */
    }
    const status = publicStatusPayload();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(htmlLanding(status));
  }

  // Tarball: /<pkg>/-/<file>.tgz  or /@scope/pkg/-/<file>.tgz
  const tarballMatch = path.match(/^\/((?:@[^/]+\/)?[^/]+)\/-\/([^/]+)\.tgz$/);
  if (req.method === 'GET' && tarballMatch) {
    const npmName = tarballMatch[1];
    const mapped = findMappingByNpmName(npmName);
    if (mapped?.rewriteReady) {
      await ensureLights();
      const lights = loadLightsSync();
      const light = lightFor(mapped.repo, lights);
      const dark = light && !light.lit;
      const rel = resolveTarballRel(mapped, dark);
      if (!rel) {
        // lit + upstreamProxy (or missing local upstream): proxy tarball path
        return proxyNpm(req, res, pathRaw + u.search, { npmName, kind: 'upstream', mapped });
      }
      const abs = join(ROOT, rel);
      if (!existsSync(abs)) {
        return sendJson(res, 404, { error: 'tarball missing', npmName, dark });
      }
      countHit(npmName, dark ? 'fork' : 'upstream', mapped);
      return sendFile(res, abs, {
        'X-Patch-Cloud': dark ? 'fork' : 'upstream',
        'X-Patch-Cloud-Light': dark ? 'dark' : 'lit',
      });
    }
    return proxyNpm(req, res, pathRaw + u.search, { npmName, kind: 'upstream', mapped });
  }

  // Package metadata: /pkg or /@scope%2Fpkg or /@scope/pkg
  if (req.method === 'GET' && path.length > 1 && !path.includes('/-/')) {
    // Prefer decoded path; also handle %2F form that decodeURIComponent already expanded
    const npmName = decodeNpmName(path);
    // Reject path traversal-ish
    if (npmName.includes('..') || npmName.startsWith('/')) {
      return sendJson(res, 400, { error: 'bad package name' });
    }

    const mapped = findMappingByNpmName(npmName);
    if (mapped?.rewriteReady) {
      await ensureLights();
      const lights = loadLightsSync();
      const light = lightFor(mapped.repo, lights);
      const dark = light && !light.lit;
      const version = mapped.version || '1.0.0';

      if (dark) {
        if (!mapped.forkTarball || !existsSync(join(ROOT, mapped.forkTarball))) {
          return sendJson(res, 404, { error: 'fork tarball missing', npmName });
        }
        const meta = packageMeta(
          req,
          npmName,
          version,
          mapped.forkTarball,
          `FORK / annotated — rewrite active (light dark). ${publicNote(mapped) || ''}`,
          {
            _patchCloud: {
              rewrite: true,
              source: 'fork',
              lightRepo: mapped.repo,
              fork: mapped.forkRepo || null,
              branch: mapped.forkBranch || null,
              pr: mapped.ciPatch?.upstreamUrl || null,
            },
          },
        );
        countHit(npmName, 'metadata', mapped);
        return sendJson(res, 200, meta, { 'X-Patch-Cloud': 'fork' });
      }

      // lit
      if (mapped.upstreamProxy || !mapped.upstreamTarball) {
        res.setHeader('X-Patch-Cloud', 'upstream-proxy');
        // Use original path encoding for scoped packages when proxying
        return proxyNpm(req, res, pathRaw + u.search, { npmName, kind: 'metadata', mapped });
      }
      const meta = packageMeta(
        req,
        npmName,
        version,
        mapped.upstreamTarball,
        `UPSTREAM — light lit, no rewrite. ${publicNote(mapped) || ''}`,
        { _patchCloud: { rewrite: false, source: 'upstream', lightRepo: mapped.repo } },
      );
      countHit(npmName, 'metadata', mapped);
      return sendJson(res, 200, meta, { 'X-Patch-Cloud': 'upstream' });
    }

    if (mapped && !mapped.rewriteReady && mapped.npmName) {
      res.setHeader('X-Patch-Cloud', 'eligible-not-ready');
      const pn = publicNote(mapped);
      if (pn) res.setHeader('X-Patch-Cloud-Note', encodeURI(pn.slice(0, 200)));
      return proxyNpm(req, res, pathRaw + u.search, { npmName, kind: 'metadata', mapped });
    }

    // Unmapped (incl. scoped): proxy with original encoding
    return proxyNpm(req, res, pathRaw + u.search, { npmName, kind: 'metadata', mapped: null });
  }

  sendJson(res, 404, { error: 'not found', path });
});

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  initCounter();
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      flushCounterNow();
      process.exit(0);
    });
  }
  server.listen(PORT, HOST, () => {
    console.log(`patch-cloud registry listening on http://${HOST}:${PORT}`);
    if (PUBLIC_URL) console.log(`  PUBLIC_URL: ${PUBLIC_URL}`);
    console.log(`  GET /        — landing (opt-in docs)`);
    console.log(`  GET /status  — rewrite board`);
    console.log(`  GET /health  — liveness`);
    console.log(`  lights: ${LIGHTS_FILE} (cache ${LIGHTS_CACHE_MINUTES}m, refresh=${LIGHTS_REFRESH})`);
    console.log(`  status verbose: ${STATUS_VERBOSE ? 'ON (internal details exposed)' : 'off (public-safe)'}`);
    console.log(`  rate limit: ${RATE_LIMIT_PER_MIN || 'off'}/min/IP`);
    console.log(`  download counts: ${counter.persistent ? 'persisted (COUNTS_DIR)' : 'in-memory only'}`);
    console.log(`  npm install <pkg> --registry ${PUBLIC_URL || `http://${HOST}:${PORT}`}`);
  });
}

export {
  publicStatusPayload as statusPayload,
  statusPayloadVerbose,
  publicText,
  downloadsSummary,
  loadLightsSync as loadLights,
  loadMapping,
  PORT,
  HOST,
  ROOT,
  server,
  ensureLights,
  findMappingByNpmName,
};
