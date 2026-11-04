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
import { createGitHub, lightOfRun, darkStreak, RateLimitError } from '@fitzyracing1/light-core';

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
  LIGHTS_REFRESH_MINUTES,
  UPSTREAM_REFRESH_MINUTES,
  PACKUMENT_CACHE_MINUTES,
} from './config.mjs';
import { gunzipSync } from 'node:zlib';

const LOCAL_LIGHTS = join(ROOT, 'local-lights.json');
const MAPPING_FILE = join(ROOT, 'mapping.json');
const UPSTREAM_STATUS_FILE = join(ROOT, 'upstream-status.json');
const WATCHLIST_FILE = join(ROOT, 'watchlist.json');
const MERGED_FILE = process.env.MERGED_FILE || join(ROOT, 'merged.json');
const LIT_DARK_MERGED_URL = 'https://fitzyracing1.github.io/lit-dark/#merged';
const UPSTREAM = 'https://registry.npmjs.org';
const UA = 'patch-cloud/0.2 (+https://github.com/fitzyracing1)';

// --- lights cache -----------------------------------------------------------
let lightsCache = { at: 0, byRepo: new Map(), refreshing: false };

const BASE_LIGHT_REPOS = [
  'nodejs/node',
  'microsoft/vscode',
  'react/react',
  'rust-lang/rust',
  'vercel/next.js',
  'denoland/deno',
  'python/cpython',
  'fitzyracing1/fakegreen',
];

/** Repos whose lights are tracked live: the light computer's 8 + every GitHub repo in mapping.json. */
function lightRepos() {
  const set = new Set(BASE_LIGHT_REPOS);
  for (const repo of Object.keys(loadMapping())) {
    if (/^[\w.-]+\/[\w.-]+$/.test(repo) && !repo.startsWith('local/')) set.add(repo);
  }
  return [...set];
}

// One light-core GitHub client for lights and upstream reads (unauthenticated API: 60 requests/hour/IP).
// It waits out retry-after and short resets, and refuses calls until a far reset (gh.rate.blockedUntil).
// Waits are capped at 10 s so a request never hangs on GitHub.
const gh = createGitHub({
  token: GITHUB_TOKEN,
  userAgent: UA,
  fetch: (...args) => globalThis.fetch(...args),
  maxWaitMs: 10_000,
  retries: 2,
});

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

/**
 * How long the light has read dark (light-core darkStreak): newest first while not "success"; runs are
 * ordered by run_started_at, so a re-run counts when it ran. If the page ends before a lit run, the
 * streak is capped (dark at least that long). Lit → {} (no dark fields).
 */
function darkStreakOf(runs) {
  const s = darkStreak(runs);
  return s.darkRuns ? s : {};
}

async function fetchOneLight(repo) {
  const data = await gh.get(`/repos/${repo}/actions/runs?per_page=30&status=completed&event=push`);
  const runs = data.workflow_runs || [];
  const run = runs[0];
  if (!run) throw new Error(`${repo}: no completed runs`); // an error, never dark
  return {
    repo,
    conclusion: run.conclusion,
    workflow: run.name,
    url: run.html_url,
    lit: lightOfRun(run) === 'lit',
    runAt: run.updated_at,
    ...darkStreakOf(runs),
    fetchedAt: new Date().toISOString(),
  };
}

async function refreshLightsFromGitHub() {
  if (Date.now() < gh.rate.blockedUntil) throw new Error(`GitHub rate limited until ${new Date(gh.rate.blockedUntil).toISOString()}`);
  const repos = lightRepos();
  const results = await Promise.allSettled(repos.map(fetchOneLight));
  // Keep the last known light for repos whose fetch failed (rate limit / network),
  // so a partial refresh never makes a light "unknown" and silently drops a rewrite.
  const prev = new Map((loadJson(LIGHTS_FILE, []) || []).map((l) => [l.repo, l]));
  for (const [repo, l] of lightsCache.byRepo) {
    if (l.source !== 'local-override') {
      const { source, ...rest } = l; // eslint-disable-line no-unused-vars
      prev.set(repo, rest); // in-memory beats the (possibly read-only) file
    }
  }
  const lights = [];
  let fresh = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      lights.push(r.value);
      fresh += 1;
    } else if (prev.has(repos[i])) {
      lights.push({ ...prev.get(repos[i]), stale: true });
    }
  });
  if (fresh) {
    try {
      writeFileSync(LIGHTS_FILE, JSON.stringify(lights, null, 2) + '\n');
    } catch (e) {
      console.warn('could not write lights file:', e.message || e);
    }
  }
  return lights;
}

let lastLightsRefreshAt = 0;
async function ensureLights() {
  const maxAge = Math.max(0, LIGHTS_CACHE_MINUTES) * 60 * 1000;
  const now = Date.now();
  const refreshDue = LIGHTS_REFRESH && now - lastLightsRefreshAt >= Math.max(0, LIGHTS_REFRESH_MINUTES) * 60 * 1000;
  if (lightsCache.byRepo.size && now - lightsCache.at < maxAge && !refreshDue) {
    return lightsCache.byRepo;
  }
  if (refreshDue && !lightsCache.refreshing) {
    lightsCache.refreshing = true;
    lastLightsRefreshAt = now;
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

const integrityCache = new Map();
function fileIntegrity(absPath) {
  const st = statSync(absPath);
  const key = `${absPath}:${st.size}:${st.mtimeMs}`;
  if (integrityCache.has(key)) return integrityCache.get(key);
  const buf = readFileSync(absPath);
  const shasum = createHash('sha1').update(buf).digest('hex');
  const integrity = 'sha512-' + createHash('sha512').update(buf).digest('base64');
  const out = { shasum, integrity, size: buf.length };
  integrityCache.set(key, out);
  return out;
}

/** Read <top>/package.json out of a .tgz (no deps; ustar + pax path headers). */
const manifestCache = new Map();
function tarballManifest(rel) {
  const abs = join(ROOT, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return null;
  }
  const key = `${abs}:${st.size}:${st.mtimeMs}`;
  if (manifestCache.has(key)) return manifestCache.get(key);
  let found = null;
  try {
    const buf = gunzipSync(readFileSync(abs));
    const cstr = (b) => b.toString('utf8').replace(/\0[\s\S]*$/, '');
    let off = 0;
    let paxPath = null;
    while (off + 512 <= buf.length) {
      const h = buf.subarray(off, off + 512);
      if (h.every((b) => b === 0)) break;
      let name = cstr(h.subarray(0, 100));
      const prefix = cstr(h.subarray(345, 500));
      if (prefix) name = `${prefix}/${name}`;
      const size = parseInt(cstr(h.subarray(124, 136)).trim() || '0', 8);
      const type = h[156];
      const body = buf.subarray(off + 512, off + 512 + size);
      if (type === 0x78 /* x */) {
        const m = body.toString('utf8').match(/\d+ path=([^\n]*)\n/);
        paxPath = m ? m[1] : null;
      } else if (type === 0x30 /* 0 */ || type === 0) {
        const path = paxPath || name;
        paxPath = null;
        if (/^[^/]+\/package\.json$/.test(path)) {
          found = JSON.parse(body.toString('utf8'));
          break;
        }
      }
      off += 512 + Math.ceil(size / 512) * 512;
    }
  } catch (e) {
    console.warn(`could not read package.json from ${rel}:`, e.message || e);
  }
  manifestCache.set(key, found);
  return found;
}

/** Full version manifest for a served tarball (deps, bin, engines, … from its package.json). */
function versionManifest(req, npmName, version, tarballRel, extra = {}) {
  const abs = join(ROOT, tarballRel);
  const { shasum, integrity } = fileIntegrity(abs);
  const tarball = `${baseUrl(req)}/${npmName}/-/${tarballFileName(npmName, version)}`;
  const pj = tarballManifest(tarballRel) || {};
  // eslint-disable-next-line no-unused-vars
  const { readme, readmeFilename, _patchCloud: pkgPatchCloud, ...rest } = pj;
  return {
    ...rest,
    name: npmName,
    version,
    _id: `${npmName}@${version}`,
    ...extra,
    _patchCloud: { ...(pkgPatchCloud || {}), ...(extra._patchCloud || {}) },
    dist: { tarball, shasum, integrity },
  };
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
  const verObj = versionManifest(req, npmName, version, tarballRel, extra);
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

// --- rewrites merged into the upstream packument ------------------------------
// While a rewrite is active, only the fork's version entry is replaced; every
// other upstream version (and upstream dist-tags) stays resolvable, so ranges
// like ms@2.0.0 or ajv@^6 never fail with ETARGET just because one version is
// rewritten. Falls back to a single-version document if npm is unreachable.
const packumentCache = new Map();
const PACKUMENT_CACHE_MAX_BYTES = 25 * 1024 * 1024;

async function upstreamPackument(npmName, accept) {
  const corgi = /application\/vnd\.npm\.install-v1\+json/.test(accept || '');
  const key = `${npmName}|${corgi ? 'corgi' : 'full'}`;
  const hit = packumentCache.get(key);
  if (hit && Date.now() - hit.at < Math.max(0, PACKUMENT_CACHE_MINUTES) * 60 * 1000) return JSON.parse(hit.body);
  const res = await fetch(`${UPSTREAM}/${npmName.replace('/', '%2F')}`, {
    headers: { Accept: corgi ? 'application/vnd.npm.install-v1+json' : 'application/json', 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`upstream packument ${npmName}: HTTP ${res.status}`);
  const body = await res.text();
  if (body.length <= PACKUMENT_CACHE_MAX_BYTES) packumentCache.set(key, { at: Date.now(), body });
  return JSON.parse(body);
}

async function rewrittenPackument(req, mapped, mode) {
  const npmName = mapped.npmName;
  const version = mapped.version || '1.0.0';
  const meta = {
    rewrite: true,
    source: mode, // 'fork' (light dark) | 'manual' (labeled manual switch, light lit)
    lightRepo: mapped.repo,
    fork: mapped.forkRepo || null,
    branch: mapped.forkBranch || null,
    pr: mapped.upstreamUrl || mapped.ciPatch?.upstreamUrl || null,
    ...(mode === 'manual' ? { manual: { label: 'manual: fix available', reason: mapped.manualRewrite?.reason || null, since: mapped.manualRewrite?.since || null } } : {}),
  };
  const description =
    mode === 'manual'
      ? `FORK — manual: fix available (CI light lit; fix waiting upstream). ${publicNote(mapped) || ''}`
      : `FORK / annotated — rewrite active (light dark). ${publicNote(mapped) || ''}`;
  const verObj = versionManifest(req, npmName, version, mapped.forkTarball, { _patchCloud: meta });
  let up = null;
  if (mapped.upstreamProxy && mapped.mergeUpstream !== false) {
    try {
      up = await upstreamPackument(npmName, req.headers.accept);
    } catch (e) {
      console.warn('upstream packument unavailable, serving fork version only:', e.message || e);
    }
  }
  if (up && up.versions && typeof up.versions === 'object') {
    const out = { ...up, description, versions: { ...up.versions, [version]: verObj } };
    delete out._rev;
    if (!out['dist-tags'] || !out['dist-tags'].latest) out['dist-tags'] = { ...(out['dist-tags'] || {}), latest: version };
    if (out.time && !out.time[version]) out.time = { ...out.time, [version]: new Date().toISOString() };
    out._patchCloud = { ...meta, replacedVersion: version, otherVersions: 'upstream (registry.npmjs.org)' };
    return out;
  }
  const single = packageMeta(req, npmName, version, mapped.forkTarball, description, { _patchCloud: meta });
  single._patchCloud = { ...meta, replacedVersion: version, otherVersions: 'unavailable (upstream unreachable)' };
  return single;
}

/** How a mapped package is served right now. Never alters the light itself. */
function rewriteMode(mapped, light) {
  const dark = !!light && light.lit === false;
  if (!mapped || !mapped.rewriteReady || !mapped.npmName) return { mode: 'none', dark };
  if (dark) return { mode: 'fork', dark };
  if (hasManual(mapped)) return { mode: 'manual', dark };
  return { mode: 'none', dark };
}

function hasManual(m) {
  return !!(m && m.manualRewrite && typeof m.manualRewrite === 'object' && m.manualRewrite.reason);
}

// --- upstream PR/issue state (public GitHub REST, cached) --------------------
// Seeded from upstream-status.json (written by check-upstream.mjs); refreshed
// via fetch so it also works in the container (no `gh` there). Read-only.
const UPSTREAM_TTL_MS = Math.max(1, UPSTREAM_REFRESH_MINUTES) * 60 * 1000;
let upstreamCache = { at: 0, results: null, refreshing: null };

function upstreamUrlOf(m) {
  return m.upstreamUrl || m.ciPatch?.upstreamUrl || null;
}

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
  try {
    return await gh.get(path);
  } catch (e) {
    throw new Error(e instanceof RateLimitError ? 'GitHub rate limited' : e.status ? `HTTP ${e.status}` : e.message);
  }
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
        const url = upstreamUrlOf(m);
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
const COUNT_KINDS = ['fork', 'upstream', 'metadata', 'manual'];
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
  return { fork: 0, upstream: 0, metadata: 0, manual: 0 };
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

/** kind: 'fork' | 'upstream' | 'metadata' | 'manual' (fork tarball served via the manual switch). Unmapped names go to one bucket. */
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
    total: { ...total, tarballs: total.fork + total.upstream + total.manual },
    last24h: { ...last24h, tarballs: last24h.fork + last24h.upstream + last24h.manual },
    other: downloadsFor(OTHER_BUCKET),
    counted: 'tarball GETs served from fork (light dark) / manual switch / upstream (incl. proxied) and package metadata GETs; /, /status, /health not counted; no IPs stored',
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
  const url = upstreamUrlOf(m);
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
  // Upstream PRs/issues written by someone else (the fork just applies them)
  const thirdParty = {
    pr: { open: 'upstream fix PR open (not merged)', merged: 'fix merged upstream', closed: 'upstream PR closed (not merged)', unknown: 'upstream fix PR' },
    issue: { open: 'upstream issue open', closed: 'upstream issue closed', merged: 'upstream issue closed', unknown: 'upstream issue' },
    'pr-comment': labels['pr-comment'],
  };
  const table = m.upstreamRole === 'third-party' ? thirdParty : labels;
  return { url, kind, state, label: table[kind][state] };
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

/** Human wording for an upstream CI conclusion (never the bare word "failure"). */
function ciWord(conclusion) {
  const c = String(conclusion || 'unknown');
  if (c === 'success') return 'passing';
  if (/fail/.test(c)) return 'failing';
  if (c === 'timed_out') return 'timed out';
  if (c === 'action_required') return 'waiting for approval';
  return c.replace(/_/g, ' ');
}

/**
 * Primary/secondary status wording shown next to each light on /status and /.
 * The primary label says what an installer gets; the upstream CI result is secondary.
 */
function displayFor(m, light, rewrite) {
  const state = light ? (light.lit ? 'lit' : 'dark') : 'unknown';
  const ciUrl = light && /^https:\/\/github\.com\//.test(light.url || '') ? light.url : null;
  const secondary = light ? `upstream build: ${ciWord(light.conclusion)}` : 'upstream build: unknown';
  let label;
  let tone;
  if (rewrite === 'active') {
    label = 'Fork available — download via patch-cloud';
    tone = 'green';
  } else if (rewrite === 'manual') {
    label = 'Fork available (manual: fix waiting upstream)';
    tone = 'green';
  } else if (!m.npmName) {
    label = state === 'lit' ? 'Upstream OK' : state === 'dark' ? 'Upstream build failing — not an npm rewrite target' : 'Upstream build status unknown';
    tone = state === 'lit' ? 'ok' : state === 'dark' ? 'warn' : 'muted';
  } else if (state === 'dark') {
    label = 'Upstream build failing — no fork yet';
    tone = 'warn';
  } else if (state === 'lit') {
    label = 'Upstream OK — normal npm';
    tone = 'ok';
  } else {
    label = 'Upstream build status unknown — normal npm';
    tone = 'muted';
  }
  return { label, tone, secondary, secondaryUrl: ciUrl };
}

// --- dark lights board helpers ----------------------------------------------
const DAY_MS = 86_400_000;
const daysSince = (iso, now = Date.now()) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DAY_MS)) : null;
};

/** How long a mapped light has been dark (null when lit/unknown). */
function darkInfo(light) {
  if (!light || light.lit !== false) return null;
  const since = light.darkSince || light.runAt || null;
  const atLeast = !light.darkSince || !!light.darkSinceCapped;
  const days = daysSince(since);
  return {
    since,
    days,
    atLeast,
    label: days == null ? 'dark (since unknown)' : `${atLeast ? '≥ ' : ''}${days} day${days === 1 ? '' : 's'} dark`,
    lastLitAt: light.lastLitAt || light.lastPassingAt || null, // lastPassingAt: lights.json written before light-core
  };
}

// npm weekly downloads (public api.npmjs.org), cached; only used for ranking/labels.
const NPM_DL_CACHE_MS = 12 * 60 * 60 * 1000;
let npmWeekly = { at: 0, byName: {}, loading: null };
async function refreshNpmWeekly(names) {
  const unscoped = [...new Set(names.filter((n) => n && !n.startsWith('@')))].slice(0, 120);
  const scoped = [...new Set(names.filter((n) => n && n.startsWith('@')))].slice(0, 10);
  const byName = { ...npmWeekly.byName };
  const get = async (q) => {
    const r = await fetch(`https://api.npmjs.org/downloads/point/last-week/${q}`, { headers: { 'User-Agent': UA } });
    return r.ok ? r.json() : null;
  };
  if (unscoped.length) {
    const j = await get(unscoped.join(','));
    if (j && unscoped.length === 1 && j.package) byName[j.package] = j.downloads;
    else if (j) for (const [k, v] of Object.entries(j)) if (v && typeof v.downloads === 'number') byName[k] = v.downloads;
  }
  await Promise.allSettled(scoped.map(async (n) => {
    const j = await get(encodeURIComponent(n).replace('%40', '@'));
    if (j && typeof j.downloads === 'number') byName[n] = j.downloads;
  }));
  npmWeekly = { at: Date.now(), byName, loading: null };
}
/** Fire-and-forget refresh; /status never waits more than ~2.5s for it. */
async function ensureNpmWeekly() {
  if (Date.now() - npmWeekly.at < NPM_DL_CACHE_MS) return;
  if (!npmWeekly.loading) {
    const names = [
      ...Object.values(loadMapping()).map((m) => m.npmName).filter((n) => n && n !== 'broken-demo'),
      ...((loadJson(WATCHLIST_FILE, {})?.entries) || []).map((e) => e.packages?.[0]?.name),
    ];
    npmWeekly.loading = refreshNpmWeekly(names).catch((e) => {
      npmWeekly.loading = null;
      npmWeekly.at = Date.now() - NPM_DL_CACHE_MS + 10 * 60 * 1000; // retry in 10 min
      console.warn('npm weekly downloads refresh failed:', e.message || e);
    });
  }
  await Promise.race([npmWeekly.loading, new Promise((r) => setTimeout(r, 2500))]);
}
const weeklyFor = (name) => (name && typeof npmWeekly.byName[name] === 'number' ? npmWeekly.byName[name] : null);

/** Popular packages with dark CI from the mirror scan, public-safe (no fork yet unless mapped). */
function watchlistPublic() {
  const w = loadJson(WATCHLIST_FILE, null);
  if (!w || !Array.isArray(w.entries)) return null;
  const mapping = loadMapping();
  const clean = (s) => (s ? publicText(String(s).replace(/\bfailures\b/gi, 'failing runs').replace(/\bfailure\b/gi, 'failing run')) : null);
  const entries = w.entries.map((e) => {
    const mapped = mapping[e.repo];
    const top = e.packages?.[0]?.name || null;
    const scanAt = Date.parse(w.generatedAt || '') || Date.now();
    const latestDays = daysSince(e.ci?.latestRunAt, scanAt);
    const passDays = daysSince(e.ci?.lastPassingAt, scanAt);
    return {
      rank: e.rank,
      repo: e.repo,
      repoUrl: /^https:\/\/github\.com\//.test(e.repoUrl || '') ? e.repoUrl : `https://github.com/${e.repo}`,
      packages: (e.packages || []).map((p) => ({ name: p.name, mirrorDownloadsSep2026: p.mirrorDownloadsSep2026 ?? null })),
      npmWeeklyDownloads: weeklyFor(top),
      archived: !!e.archived,
      ci: {
        workflow: e.ci?.workflow || null,
        url: /^https:\/\/github\.com\//.test(e.ci?.url || '') ? e.ci.url : null,
        latestRunAt: e.ci?.latestRunAt || null,
        redRunsInARow: e.ci?.redRunsInARow ?? null,
        redRunsCapped: !!e.ci?.redRunsCapped,
        lastPassingAt: e.ci?.lastPassingAt || null,
      },
      dark: (() => {
        const exact = e.ci?.redRunsInARow === 1 && !e.ci?.redRunsCapped && latestDays != null;
        const d = (n) => `${n} day${n === 1 ? '' : 's'}`;
        let label;
        if (latestDays == null) label = 'dark (since unknown)';
        else if (exact) label = `${d(latestDays)} dark`;
        else if (passDays != null) label = passDays === latestDays ? `${d(latestDays)} dark` : `${latestDays}–${d(passDays)} dark`;
        else label = `≥ ${d(latestDays)} dark · no passing run in scan window`;
        return { daysAtLeast: latestDays, lastPassingDaysAgo: passDays, exact, label };
      })(),
      summary: clean(e.summary),
      fixability: clean(e.fixability),
      existingFix: clean(e.existingFix),
      fork: mapped && mapped.rewriteReady ? 'patch-cloud fork available' : 'no patch-cloud fork yet',
    };
  });
  return {
    scannedAt: w.generatedAt || null,
    source: clean(w.source),
    downloadsNote: clean(w.downloadsNote),
    darkDefinition: clean(w.darkDefinition),
    totalDarkRepos: w.totalDarkRepos ?? entries.length,
    note: 'Snapshot from a one-off scan; these lights are not refreshed live and day counts are as of the scan date. A dark light means the latest upstream build did not pass — npm installs of these packages still work.',
    entries,
  };
}

/** "2026-10-12T04:05:45Z" → "Oct 12, 2026, 12:05 AM ET" (America/New_York). */
function formatET(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(t));
  return `${s} ET`;
}

/** "Oct 12, 2026" (America/New_York). */
function formatDayET(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(t));
}

const ghUrl = (u) => (/^https:\/\/github\.com\//.test(u || '') ? u : null);
const LIGHT_WORD = (x) => (x === 'lit' || x === 'dark' ? x : 'waiting');

/** One upstream run (before/after the merge) in public, lit/dark-only form. */
function mergedRun(r) {
  if (!r || !ghUrl(r.url)) return null;
  const jobs = (Array.isArray(r.jobs) ? r.jobs : []).map((j) => ({ name: String(j.name || ''), light: LIGHT_WORD(j.light), url: ghUrl(j.url) }));
  return {
    id: r.id ?? null,
    url: r.url,
    workflow: publicText(r.workflow) || 'CI',
    branch: r.branch || null,
    createdAt: r.createdAt || null,
    createdAtET: formatET(r.createdAt),
    light: LIGHT_WORD(r.state),
    jobs,
    jobsLit: jobs.filter((j) => j.light === 'lit').length,
    jobsDark: jobs.filter((j) => j.light === 'dark').length,
  };
}

/** Upstream PRs merged by their maintainers that took a dark light to lit (merged.json, written by add-merged.mjs). */
function mergedPublic() {
  const raw = loadJson(MERGED_FILE, []);
  const list = Array.isArray(raw) ? raw : [];
  const entries = list
    .filter((e) => e && /^[\w.-]+\/[\w.-]+$/.test(e.repo || '') && Number.isInteger(Number(e.pr)))
    .map((e) => {
      const darkRun = mergedRun(e.darkRun);
      const litRun = mergedRun(e.litRun);
      const isLit = !!litRun && litRun.light === 'lit';
      const lightName = publicText(e.light) || 'CI';
      const n = litRun ? litRun.jobs.length : 0;
      return {
        repo: e.repo,
        repoUrl: `https://github.com/${e.repo}`,
        pr: Number(e.pr),
        url: ghUrl(e.url) || `https://github.com/${e.repo}/pull/${Number(e.pr)}`,
        title: publicText(e.title) || '',
        mergedAt: e.mergedAt || null,
        mergedAtET: formatET(e.mergedAt),
        mergedBy: e.mergedBy || null,
        mergedByUrl: /^[\w-]+$/.test(e.mergedBy || '') ? `https://github.com/${e.mergedBy}` : null,
        branch: e.branch || null,
        light: lightName,
        before: {
          light: 'dark',
          since: e.darkSince || null,
          sinceET: formatDayET(e.darkSince),
          why: publicText(e.darkBefore),
          run: darkRun,
        },
        fix: publicText(e.fix),
        after: {
          light: isLit ? 'lit' : 'waiting',
          label: isLit ? 'lit upstream now' : 'waiting for upstream light',
          run: litRun,
          summary: isLit
            ? `First ${e.branch || 'default-branch'} run after the merge: ${litRun.workflow} ${litRun.id}${n ? `, ${litRun.jobsLit} of ${n} ${lightName} jobs lit` : ''}.`
            : 'waiting for upstream light',
        },
        verifiedAt: e.verifiedAt || null,
        note: publicText(e.note),
      };
    })
    .sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)));
  return {
    count: entries.length,
    litCount: entries.filter((e) => e.after.light === 'lit').length,
    litDark: LIT_DARK_MERGED_URL,
    note: 'Upstream pull requests merged by each project’s maintainers that took a dark light to lit upstream. Before and after are upstream CI runs, checked with the GitHub API.',
    entries,
  };
}

function rewriteStateFor(m, light) {
  const lit = light ? !!light.lit : null;
  const dark = lit === false;
  if (m.rewriteReady && m.npmName && dark) return 'active';
  if (m.rewriteReady && m.npmName && hasManual(m)) return 'manual';
  if (dark && m.npmName && !m.rewriteReady) return 'would rewrite';
  if (m.rewriteReady && m.npmName) return 'ready';
  return 'n/a';
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
    const rewrite = rewriteStateFor(m, light);
    packages.push({
      repo,
      npmName: m.npmName || null,
      version: m.npmName && m.rewriteReady ? m.version || null : null,
      light: {
        state: lit === true ? 'lit' : lit === false ? 'dark' : 'unknown',
        conclusion: light?.conclusion ?? 'unknown',
        ci: light ? ciWord(light.conclusion) : 'unknown',
        url: light && /^https:\/\/github\.com\//.test(light.url || '') ? light.url : null,
        fetchedAt: light?.fetchedAt ?? null,
      },
      status: displayFor(m, light, rewrite),
      rewrite,
      manual: hasManual(m)
        ? { label: 'manual: fix available', reason: publicText(m.manualRewrite.reason), since: m.manualRewrite.since || null, servingNow: rewrite === 'manual' }
        : null,
      fork: forkPublic(m),
      upstream: upstreamPublic(m, ups[repo]),
      note: publicNote(m),
      downloads: m.npmName ? downloadsFor(m.npmName) : null,
      dark: darkInfo(light),
      npmWeeklyDownloads: m.npmName ? weeklyFor(m.npmName) : null,
      install:
        m.npmName && (rewrite === 'active' || rewrite === 'manual')
          ? `npm install ${m.npmName}${m.version ? `@${m.version}` : ''} --registry ${reg}`
          : null,
    });
  }
  const count = (f) => packages.filter(f).length;
  return {
    service: 'patch-cloud',
    registry: reg,
    publicUrl: PUBLIC_URL || null,
    lightsCachedAt: lightsCache.at ? new Date(lightsCache.at).toISOString() : null,
    lightsCacheMinutes: LIGHTS_CACHE_MINUTES,
    counts: {
      rewriteActive: count((p) => p.rewrite === 'active'),
      manual: count((p) => p.rewrite === 'manual'),
      ready: count((p) => p.rewrite === 'ready'),
      wouldRewrite: count((p) => p.rewrite === 'would rewrite'),
      dark: count((p) => p.light.state === 'dark'),
      lit: count((p) => p.light.state === 'lit'),
      unknown: count((p) => p.light.state === 'unknown'),
    },
    downloads: downloadsSummary(),
    packages,
    watchlist: watchlistPublic(),
    merged: mergedPublic(),
    legend: {
      lit: 'Upstream OK — normal npm (CI passing → proxied / upstream)',
      dark: 'Upstream build failing → fork served when one is packaged',
      manual: 'Fork available (manual: fix waiting upstream) — labeled override; the CI light is shown as-is and is never faked',
      rewrite: 'active = serving fork now (light dark) · manual = serving fork via the labeled manual switch (light lit) · ready = packaged, light lit → upstream · would rewrite = dark but no fork packaged · n/a = not an npm rewrite target',
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
      rewrite: rewriteStateFor(m, light),
      manualRewrite: m.manualRewrite || null,
      status: displayFor(m, light, rewriteStateFor(m, light)),
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

const TONE_COLOR = { green: '#3fb950', ok: '#8b949e', warn: '#d29922', muted: '#8b949e' };
function statusCellHtml(p) {
  const st = p.status;
  const color = TONE_COLOR[st.tone] || '#8b949e';
  const primary = st.tone === 'green' ? `<b style="color:${color}">${escapeHtml(st.label)}</b>` : `<span style="color:${color}">${escapeHtml(st.label)}</span>`;
  const sec = st.secondaryUrl
    ? `<a href="${escapeHtml(st.secondaryUrl)}" target="_blank" rel="noopener">${escapeHtml(st.secondary)}</a>`
    : escapeHtml(st.secondary);
  const manual = p.manual
    ? `<br><small style="color:#d2a8ff">manual: fix available${p.manual.reason ? ` — ${escapeHtml(p.manual.reason)}` : ''}${p.manual.since ? ` (since ${escapeHtml(p.manual.since)})` : ''}</small>`
    : '';
  return `${primary}<br><small>${sec}${p.light.fetchedAt ? ` · checked ${escapeHtml(p.light.fetchedAt)}` : ''}</small>${manual}`;
}

function htmlLanding(status) {
  const active = status.packages.filter((p) => p.rewrite === 'active');
  const manual = status.packages.filter((p) => p.rewrite === 'manual');
  const ready = status.packages.filter((p) => p.npmName && ['active', 'manual', 'ready'].includes(p.rewrite));
  const rows = status.packages
    .filter((p) => p.npmName)
    .map((p) => {
      return `<tr>
        <td><code>${escapeHtml(p.repo)}</code></td>
        <td><code>${escapeHtml(p.npmName)}</code></td>
        <td>${statusCellHtml(p)}</td>
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
  <p>Opt-in npm-compatible registry. When a mapped package's upstream build is failing (light <b>dark</b>) and a fixed fork is packaged, installs get the fork under the <em>same package name</em>. When upstream is OK (light <b>lit</b>), traffic is proxied to <code>registry.npmjs.org</code>. A package can also carry a clearly labeled <b>manual: fix available</b> switch that serves the fork while the light stays lit — the light is never faked.</p>

  <div class="card warn">
    <strong>Safety / opt-in only</strong>
    <ul>
      <li>You must point npm at this host explicitly (<code>--registry</code> or project <code>.npmrc</code>). It is never the default.</li>
      <li>Only packages listed below with a packaged fork are ever rewritten — while their light is dark, or while they carry the labeled <em>manual: fix available</em> switch.</li>
      <li>Only the fork's version is replaced; every other version of the package still comes from the public registry.</li>
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
    <span class="pill">${manual.length} manual: fix available</span>
    <span class="pill">${ready.length} forks packaged</span>
    <a href="/status">dark lights board</a> ·
    <a href="/health">/health</a>
  </p>
  <table>
    <tr><th>Light repo</th><th>npm</th><th>Status</th><th>Note</th></tr>
    ${rows}
  </table>

  <h2>What gets rewritten?</h2>
  <p>Currently packaged:</p>
  <ul>
    ${ready
      .map(
        (p) =>
          `<li><code>${escapeHtml(p.npmName)}</code> ← <code>${escapeHtml(p.repo)}</code>${
            p.rewrite === 'active' ? ' <span class="ok">(active now)</span>' : p.rewrite === 'manual' ? ' <span class="ok">(active now — manual: fix available)</span>' : ''
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
      const lamp = `${p.lit === true ? '● lit' : p.lit === false ? '○ dark' : '? unknown'} — ${escapeHtml(p.status.label)}`;
      const rw = p.rewriteActive
        ? '<b style="color:#0a0">REWRITE ACTIVE → fork</b>'
        : p.rewrite === 'manual'
          ? '<b style="color:#0a0">MANUAL: FIX AVAILABLE → fork</b>'
        : p.wouldRewrite
          ? `<span style="color:#a60">${escapeHtml(p.wouldRewrite)}</span>`
          : p.rewriteReady
            ? 'rewrite ready (light lit → upstream)'
            : 'n/a';
      return `<tr>
        <td><code>${p.repo}</code></td>
        <td>${p.npmName ? `<code>${p.npmName}</code>` : '—'}</td>
        <td>${lamp} <small>(upstream build: ${escapeHtml(ciWord(p.conclusion))})</small></td>
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
  return `<p class="dl"><b>Downloads:</b> ${t.tarballs} tarballs (fork ${t.fork} · upstream ${t.upstream}) · manual switch ${t.manual || 0} · metadata ${t.metadata}
  · last 24h: fork ${d.last24h.fork} · manual ${d.last24h.manual || 0} · upstream ${d.last24h.upstream} · metadata ${d.last24h.metadata}
  <br><small>${d.persistent ? `since ${escapeHtml(d.since)}` : escapeHtml(d.note)} · unmapped packages (proxied): ${o.upstream} tarballs · ${o.metadata} metadata · all requests counted, incl. our own tests; /, /status, /health excluded; no IPs stored</small></p>`;
}

function htmlStatusPublic(status) {
  const link = (href, text) =>
    `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`;
  const rows = status.packages
    .map((p) => {
      const rw =
        p.rewrite === 'active'
          ? '<b style="color:#3fb950">active → fork</b>'
          : p.rewrite === 'manual'
            ? '<b style="color:#3fb950">manual → fork</b>'
            : p.rewrite === 'would rewrite'
              ? '<span style="color:#d29922">would rewrite (no fork packaged)</span>'
              : p.rewrite === 'ready'
                ? 'ready (upstream OK → normal npm)'
                : 'n/a';
      const fork = p.fork
        ? link(p.fork.url, p.fork.repo) + (p.fork.branch ? ` @ ${link(p.fork.branchUrl, p.fork.branch)}` : '')
        : '—';
      const up = p.upstream
        ? `${link(p.upstream.url, p.upstream.url.replace(/^https:\/\/github\.com\//, ''))}<br>` +
          `<b style="color:#fc6">${escapeHtml(p.upstream.label)}</b> <small>(${escapeHtml(p.upstream.state)})</small>`
        : '—';
      const dl = p.downloads
        ? `fork ${p.downloads.fork} · upstream ${p.downloads.upstream}${p.downloads.manual ? ` · manual ${p.downloads.manual}` : ''}<br><small>metadata ${p.downloads.metadata} · 24h: fork ${p.downloads.last24h.fork} · upstream ${p.downloads.last24h.upstream}</small>`
        : '—';
      return `<tr>
        <td><code>${escapeHtml(p.repo)}</code></td>
        <td>${p.npmName ? `<code>${escapeHtml(p.npmName)}</code>` : '—'}</td>
        <td>${statusCellHtml(p)}</td>
        <td>${rw}</td>
        <td>${dl}</td>
        <td><small>${fork}</small></td>
        <td><small>${up}</small></td>
        <td><small>${escapeHtml(p.note || '')}</small></td>
      </tr>`;
    })
    .join('\n');
  const fmtN = (n) => (n == null ? null : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));
  const codeify = (t) => escapeHtml(t || '').replace(/`([^`]+)`/g, '<code>$1</code>');
  const darkNow = status.packages
    .filter((p) => p.npmName && p.npmName !== 'broken-demo' && p.light.state === 'dark')
    .sort((x, y) => (y.npmWeeklyDownloads || 0) - (x.npmWeeklyDownloads || 0) || (y.dark?.days || 0) - (x.dark?.days || 0));
  const boardRows = darkNow
    .map((p) => {
      const forkCell =
        p.rewrite === 'active'
          ? `<b style="color:#3fb950">yes — served now</b>${p.fork ? `<br><small>${link(p.fork.branchUrl || p.fork.url, p.fork.repo + (p.fork.branch ? '@' + p.fork.branch : ''))}</small>` : ''}`
          : `<span style="color:#d29922">no fork yet</span>`;
      const install = p.install ? `<pre class="one">${escapeHtml(p.install)}</pre>` : '<small>— (normal npm; nothing rewritten)</small>';
      const days = p.dark
        ? `<b>${escapeHtml(p.dark.label)}</b>${p.dark.since ? `<br><small>since ${escapeHtml(p.dark.since.slice(0, 10))}${p.dark.lastLitAt ? ` · last lit ${escapeHtml(p.dark.lastLitAt.slice(0, 10))}` : ''}</small>` : ''}`
        : '—';
      const ci = p.light.url ? link(p.light.url, `upstream build: ${p.light.ci}`) : escapeHtml(`upstream build: ${p.light.ci}`);
      return `<tr>
        <td><code>${escapeHtml(p.npmName)}</code>${p.npmWeeklyDownloads != null ? `<br><small>${fmtN(p.npmWeeklyDownloads)}/week on npm</small>` : ''}<br><small>${link(`https://github.com/${p.repo}`, p.repo)}</small></td>
        <td>${days}<br><small>${ci}</small></td>
        <td>${forkCell}</td>
        <td>${install}</td>
      </tr>`;
    })
    .join('\n');
  const wl = status.watchlist;
  const wlRow = (e) => {
    const pk = e.packages
      .slice(0, 3)
      .map((x) => `<code>${escapeHtml(x.name)}</code>${x.mirrorDownloadsSep2026 != null ? ` <small>${fmtN(x.mirrorDownloadsSep2026)}</small>` : ''}`)
      .join('<br>');
    const more = e.packages.length > 3 ? `<br><small>+${e.packages.length - 3} more</small>` : '';
    return `<tr>
        <td>${e.rank}</td>
        <td>${pk}${more}${e.npmWeeklyDownloads != null ? `<br><small>${fmtN(e.npmWeeklyDownloads)}/week on npm</small>` : ''}</td>
        <td>${link(e.repoUrl, e.repo)}${e.archived ? ' <small>(archived)</small>' : ''}<br><small>${e.ci.url ? link(e.ci.url, `${e.ci.workflow || 'CI'} run`) : ''}</small></td>
        <td><b>${escapeHtml(e.dark.label)}</b><br><small>${e.ci.lastPassingAt ? `last passing ${escapeHtml(e.ci.lastPassingAt.slice(0, 10))}<br>` : ''}${e.ci.redRunsInARow != null ? `${e.ci.redRunsInARow}${e.ci.redRunsCapped ? '+' : ''} red run${e.ci.redRunsInARow === 1 ? '' : 's'} in a row` : ''}</small></td>
        <td><small>${codeify(e.summary)}</small></td>
        <td><small>${codeify(e.fixability)}${e.existingFix ? `<br>existing fix: ${codeify(e.existingFix)}` : ''}</small></td>
        <td><small style="color:#d29922">${escapeHtml(e.fork)}</small></td>
      </tr>`;
  };
  const mg = status.merged;
  const runLink = (r) => (r ? `<a href="${escapeHtml(r.url)}">${escapeHtml(r.workflow)} ${escapeHtml(r.id)}</a> (${escapeHtml(r.createdAtET || '')})` : '');
  const mgItem = (e) => {
    const b = e.before, a = e.after, dr = b.run, lr = a.run;
    const lamp = a.light === 'lit' ? '<span class="lamp" aria-hidden="true">●</span> <b>lit</b>' : '<span class="lamp wait" aria-hidden="true">○</span> <b>waiting for upstream light</b>';
    const beforeTxt = `<code>${escapeHtml(e.light)}</code> was <b>dark</b>${e.branch ? ` on ${escapeHtml(e.branch)}` : ''}${b.sinceET ? ` since ${escapeHtml(b.sinceET)}` : ''}. ${escapeHtml(b.why || '')}`
      + (dr ? ` Dark run before the fix: ${runLink(dr)}${dr.jobs.length ? `, ${dr.jobsDark} of ${dr.jobs.length} ${escapeHtml(e.light)} jobs dark` : ''}.` : '');
    const afterTxt = a.light === 'lit'
      ? `<b>lit upstream now.</b> First ${escapeHtml(e.branch || 'default-branch')} run after the merge: ${runLink(lr)}${lr.jobs.length ? `, ${lr.jobsLit} of ${lr.jobs.length} ${escapeHtml(e.light)} jobs lit` : ''}.`
      : `<b>waiting for upstream light</b>${lr ? ` — latest run after the merge: ${runLink(lr)}` : ' — no upstream run has finished since the merge'}.`;
    return `<li class="mg-item">
      <div>${lamp} <a href="${escapeHtml(e.url)}">${escapeHtml(e.repo)}#${escapeHtml(e.pr)}</a> — ${escapeHtml(e.title)}</div>
      <div class="muted">repo <a href="${escapeHtml(e.repoUrl)}">${escapeHtml(e.repo)}</a> · merged <time datetime="${escapeHtml(e.mergedAt || '')}">${escapeHtml(e.mergedAtET || '—')}</time> by ${e.mergedByUrl ? `<a href="${escapeHtml(e.mergedByUrl)}">@${escapeHtml(e.mergedBy)}</a>` : escapeHtml(e.mergedBy || '—')}</div>
      <div class="mg-step"><b>Before:</b> ${beforeTxt}</div>
      <div class="mg-step"><b>Fix:</b> ${escapeHtml(e.fix || '—')}</div>
      <div class="mg-step"><b>After:</b> ${afterTxt}</div>${e.note ? `\n      <div class="muted">${escapeHtml(e.note)}</div>` : ''}
    </li>`;
  };
  const mgHtml = mg
    ? `<h2 id="merged">Merged fixes — dark → lit upstream (${mg.count})</h2>
  <p class="muted">${escapeHtml(mg.note)} Also on <a href="${escapeHtml(mg.litDark)}">lit-dark</a>.</p>
  ${mg.entries.length ? `<ul class="mg">\n    ${mg.entries.map(mgItem).join('\n    ')}\n  </ul>` : '<p class="muted">None recorded yet.</p>'}`
    : '';
  const wlHtml = wl
    ? `<h2 id="watchlist">Watchlist — popular packages with dark CI (${wl.entries.length} of ${escapeHtml(wl.totalDarkRepos)} dark repos)</h2>
  <p class="muted">${escapeHtml(wl.note)} Scan: ${escapeHtml((wl.scannedAt || '').slice(0, 10))}. ${escapeHtml(wl.darkDefinition || '')}. Numbers next to package names are ${escapeHtml(wl.downloadsNote || '')}.</p>
  <table>
    <tr><th>#</th><th>package(s)</th><th>repo / red run</th><th>dark</th><th>why the build is red</th><th>fixability</th><th>patch-cloud</th></tr>
    ${wl.entries.map(wlRow).join('\n')}
  </table>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>patch-cloud — dark lights board</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{font-family:system-ui,sans-serif;margin:2rem;background:#111;color:#eee;line-height:1.45}
    table{border-collapse:collapse;width:100%;font-size:.9rem} th,td{border:1px solid #444;padding:.5rem;text-align:left;vertical-align:top}
    th{background:#222} a{color:#6af} code{color:#9f9}
    h2{margin-top:2.2rem;border-bottom:1px solid #333;padding-bottom:.3rem}
    .muted{color:#aaa;font-size:.9rem}
    pre.one{margin:0;background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:.35rem .5rem;white-space:pre-wrap;word-break:break-all;font-size:.8rem}
    .pill{display:inline-block;padding:.15rem .55rem;border-radius:999px;background:#222;font-size:.8rem;margin-right:.3rem}
    ul.mg{list-style:none;padding:0;margin:0} .mg-item{border:1px solid #2f4a2f;background:#142014;border-radius:8px;padding:.6rem .8rem;margin:.5rem 0}
    .mg-item>div{margin:.2rem 0} .lamp{color:#7f7} .lamp.wait{color:#aaa}
  </style></head><body>
  <h1>patch-cloud — dark lights board</h1>
  <p class="muted">A light is <b>dark</b> when the upstream project's latest CI build did not pass, and <b>lit</b> when it passed. A dark light is about the project's own tests, not your install: packages still download normally from npm. Where a fixed fork is packaged, patch-cloud can serve it under the same name if you opt in.</p>
  <p>Registry: <code>${escapeHtml(status.registry)}</code>
  · <a href="/">landing</a> · <a href="/status?format=json">JSON</a> · <a href="/health">/health</a>${mg ? ' · <a href="#merged">merged fixes</a>' : ''}${wl ? ' · <a href="#watchlist">watchlist</a>' : ''} · <a href="#all">all tracked lights</a></p>
  <p><span class="pill">${status.counts.rewriteActive} fork available (upstream build failing)</span>
  <span class="pill">${status.counts.manual} fork available (manual: fix waiting upstream)</span>
  <span class="pill">${status.counts.ready} fork packaged, upstream OK</span>
  <span class="pill">${status.counts.wouldRewrite} upstream failing, no fork yet</span>${wl ? `<span class="pill">${wl.entries.length} on watchlist</span>` : ''}${mg ? `<span class="pill">${mg.count} merged upstream · ${mg.litCount} lit</span>` : ''}</p>
  ${mgHtml}

  <h2>Dark now — tracked packages</h2>
  <p class="muted">Live lights (cached ${escapeHtml(status.lightsCacheMinutes)} min). "Days dark" counts from the first red run after the last passing one; "≥" means no passing run was in the window checked.</p>
  <table>
    <tr><th>package</th><th>dark for</th><th>patch-cloud fork</th><th>one-line install (opt-in)</th></tr>
    ${boardRows || '<tr><td colspan="4">No tracked package is dark right now.</td></tr>'}
  </table>
  ${wlHtml}

  <h2 id="all">All tracked lights</h2>
  ${downloadsLine(status.downloads)}
  <table>
    <tr><th>Light repo</th><th>npm name</th><th>Status</th><th>Rewrite</th><th>Downloads</th><th>Fork</th><th>Upstream</th><th>Note</th></tr>
    ${rows}
  </table>
  <p><small>Lights are active-low: lit = upstream build passing, dark = upstream build failing. The manual switch never changes a light. Lights cache ${escapeHtml(status.lightsCacheMinutes)} min.</small></p>
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
    try {
      await ensureNpmWeekly();
    } catch {
      /* ignore */
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
      const { mode } = rewriteMode(mapped, light);
      const dark = mode === 'fork';
      const forkFile = `${tarballFileName(npmName, mapped.version || '1.0.0')}`;
      if ((mode === 'fork' || mode === 'manual') && `${tarballMatch[2]}.tgz` !== forkFile && mapped.upstreamProxy) {
        // another version of a rewritten package → upstream tarball
        return proxyNpm(req, res, pathRaw + u.search, { npmName, kind: 'upstream', mapped });
      }
      if (mode === 'manual') {
        const abs = join(ROOT, mapped.forkTarball || '');
        if (!mapped.forkTarball || !existsSync(abs)) return sendJson(res, 404, { error: 'tarball missing', npmName, manual: true });
        countHit(npmName, 'manual', mapped);
        return sendFile(res, abs, { 'X-Patch-Cloud': 'manual', 'X-Patch-Cloud-Light': 'lit' });
      }
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
      const { mode } = rewriteMode(mapped, light);
      const version = mapped.version || '1.0.0';

      if (mode === 'fork' || mode === 'manual') {
        if (!mapped.forkTarball || !existsSync(join(ROOT, mapped.forkTarball))) {
          return sendJson(res, 404, { error: 'fork tarball missing', npmName });
        }
        const meta = await rewrittenPackument(req, mapped, mode);
        countHit(npmName, 'metadata', mapped);
        return sendJson(res, 200, meta, {
          'X-Patch-Cloud': mode,
          'X-Patch-Cloud-Light': mode === 'fork' ? 'dark' : 'lit',
        });
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
  lightRepos,
  tarballManifest,
  rewriteMode,
  displayFor,
  darkStreakOf,
  fetchOneLight,
  watchlistPublic,
};
