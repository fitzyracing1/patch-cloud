'use strict';
// pnpm-plugin-patch-cloud core logic. No dependencies (pnpm config dependencies cannot have any).
// Vocabulary: a light is "lit" (upstream CI build OK) or "dark" (upstream CI build did not pass).

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_URL = 'https://patch-cloud-production.up.railway.app';
const DEFAULT_TIMEOUT_MS = 3000;
const ALIAS = 'patch-cloud';
const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'devDependencies'];

function readConfig(env = process.env, cwd = process.cwd()) {
  const disabled = /^(1|true|yes|on)$/i.test(String(env.PATCH_CLOUD_DISABLE || '').trim());
  const url = String(env.PATCH_CLOUD_URL || DEFAULT_URL).trim().replace(/\/+$/, '');
  const t = Number.parseInt(env.PATCH_CLOUD_TIMEOUT_MS, 10);
  const timeoutMs = Number.isFinite(t) && t > 0 ? t : DEFAULT_TIMEOUT_MS;
  const quiet = /^(1|true|yes|on)$/i.test(String(env.PATCH_CLOUD_QUIET || '').trim());
  // Local compute-saved record (NDJSON). "off" disables it; any other value is a file path.
  const rec = String(env.PATCH_CLOUD_RECORD || '').trim();
  const record = /^(0|off|false|no)$/i.test(rec) ? null : rec || path.join(cwd, 'node_modules', '.patch-cloud', 'swaps.ndjson');
  // Anonymous ping: off by default. patch-cloud has no ingest endpoint yet, so nothing is ever sent (see README TODO).
  const ping = /^(1|true|yes|on)$/i.test(String(env.PATCH_CLOUD_PING || '').trim());
  // How a swapped dependency points at the fork: "registry" (named registry, pnpm >= 11.1),
  // "tarball" (direct tarball URL), or "auto" (pick by pnpm version).
  const m = String(env.PATCH_CLOUD_MODE || 'auto').trim().toLowerCase();
  const mode = m === 'registry' || m === 'tarball' ? m : 'auto';
  // Lockfile policy: "keep" = a dependency already in pnpm-lock.yaml stays exactly as locked (fork pin or not),
  // so frozen-lockfile installs never break when a light changes; "follow" = follow the live lights.
  // Default: keep in CI (CI env set) or with --frozen-lockfile, follow otherwise.
  const l = String(env.PATCH_CLOUD_LOCKFILE || '').trim().toLowerCase();
  const ci = !!env.CI && !/^(0|false|no|off)$/i.test(String(env.CI).trim());
  const lockfile = l === 'keep' || l === 'follow' ? l : ci ? 'keep' : 'auto';
  return { disabled, url, timeoutMs, quiet, record, ping, mode, lockfile };
}

/** npm tarball file name: scoped packages use the unscoped basename. */
function tarballUrl(baseUrl, name, version) {
  const base = name.startsWith('@') ? name.split('/')[1] : name;
  return `${baseUrl}/${name}/-/${base}-${version}.tgz`;
}

/**
 * From a patch-cloud /status?format=json body, build Map(npmName -> { version, tarball, repo, reason }).
 * A package is served from the fork only when its light is dark AND patch-cloud marks it rewrite-ready
 * (rewrite "active"/"ready"), or when patch-cloud's labeled manual switch is serving now.
 */
function forksFromStatus(status, baseUrl) {
  const out = new Map();
  const list = status && Array.isArray(status.packages) ? status.packages : [];
  for (const p of list) {
    if (!p || typeof p.npmName !== 'string' || !p.npmName) continue;
    if (typeof p.version !== 'string' || !parseVersion(p.version)) continue;
    const state = p.light && p.light.state;
    const ready = p.rewrite === 'active' || p.rewrite === 'ready';
    const manual = !!(p.manual && p.manual.servingNow === true);
    let reason = null;
    if (state === 'dark' && ready) reason = 'dark';
    else if (manual) reason = 'manual';
    if (!reason) continue;
    out.set(p.npmName, {
      version: p.version,
      tarball: tarballUrl(baseUrl, p.npmName, p.version),
      alias: `${ALIAS}:${p.npmName}@${p.version}`,
      repo: p.repo || null,
      lightState: state || null,
      lightUrl: (p.light && p.light.url) || null,
      reason,
    });
  }
  return out;
}

/** Map(npmName -> light state) for every package in the feed (lit ones too). */
function lightsFromStatus(status) {
  const out = new Map();
  for (const p of (status && Array.isArray(status.packages) ? status.packages : [])) {
    if (p && typeof p.npmName === 'string' && p.npmName && p.light && p.light.state) out.set(p.npmName, p.light.state);
  }
  return out;
}

// ---- minimal semver (enough for npm-style ranges); unknown syntax => no match (leave untouched) ----
function parseVersion(v) {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(String(v));
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null };
}
function cmp(a, b) {
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}
// Partial version like 1, 1.2, 1.x, 1.2.*, returns {major,minor,patch, wild} with nulls for wildcards.
function parsePartial(s) {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s);
  if (!m) return null;
  const n = (x) => (x === undefined || /^[xX*]$/.test(x) ? null : +x);
  const major = n(m[1]);
  const minor = major === null ? null : n(m[2]);
  const patch = minor === null ? null : n(m[3]);
  return { major, minor, patch, pre: patch === null ? null : m[4] || null };
}
function lower(p) { return { major: p.major || 0, minor: p.minor || 0, patch: p.patch || 0, pre: p.pre }; }
// Returns array of [op, version] comparators for a single (space-separated) comparator set, or null.
function comparators(set) {
  set = set.trim();
  const hy = /^(\S+)\s+-\s+(\S+)$/.exec(set);
  if (hy) {
    const a = parsePartial(hy[1]); const b = parsePartial(hy[2]);
    if (!a || !b) return null;
    const out = [['>=', lower(a)]];
    if (b.major === null) return out;
    if (b.minor === null) out.push(['<', { major: b.major + 1, minor: 0, patch: 0, pre: null }]);
    else if (b.patch === null) out.push(['<', { major: b.major, minor: b.minor + 1, patch: 0, pre: null }]);
    else out.push(['<=', lower(b)]);
    return out;
  }
  if (set === '' ) return [];
  const out = [];
  for (const tok of set.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/)) {
    const m = /^(>=|<=|>|<|=|\^|~>?|)(.*)$/.exec(tok);
    const op = m[1]; const p = parsePartial(m[2]);
    if (!p) return null;
    if (p.major === null) { if (op === '<' || op === '>') return [['<', { major: 0, minor: 0, patch: 0, pre: '0' }]]; continue; }
    const lo = lower(p);
    if (op === '' || op === '=') {
      if (p.patch !== null) out.push(['=', lo]);
      else if (p.minor !== null) out.push(['>=', lo], ['<', { major: p.major, minor: p.minor + 1, patch: 0, pre: null }]);
      else out.push(['>=', lo], ['<', { major: p.major + 1, minor: 0, patch: 0, pre: null }]);
    } else if (op === '^') {
      out.push(['>=', lo]);
      if (p.major > 0 || p.minor === null) out.push(['<', { major: p.major + 1, minor: 0, patch: 0, pre: null }]);
      else if (p.minor > 0 || p.patch === null) out.push(['<', { major: 0, minor: p.minor + 1, patch: 0, pre: null }]);
      else out.push(['<', { major: 0, minor: 0, patch: p.patch + 1, pre: null }]);
    } else if (op === '~' || op === '~>') {
      out.push(['>=', lo]);
      if (p.minor === null) out.push(['<', { major: p.major + 1, minor: 0, patch: 0, pre: null }]);
      else out.push(['<', { major: p.major, minor: p.minor + 1, patch: 0, pre: null }]);
    } else if (op === '>') {
      if (p.patch !== null) out.push(['>', lo]);
      else if (p.minor !== null) out.push(['>=', { major: p.major, minor: p.minor + 1, patch: 0, pre: null }]);
      else out.push(['>=', { major: p.major + 1, minor: 0, patch: 0, pre: null }]);
    } else if (op === '>=') out.push(['>=', lo]);
    else if (op === '<') out.push(['<', lo]);
    else if (op === '<=') {
      if (p.patch !== null) out.push(['<=', lo]);
      else if (p.minor !== null) out.push(['<', { major: p.major, minor: p.minor + 1, patch: 0, pre: null }]);
      else out.push(['<', { major: p.major + 1, minor: 0, patch: 0, pre: null }]);
    }
  }
  return out;
}
function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v || typeof range !== 'string') return false;
  for (const set of range.split('||')) {
    const cs = comparators(set);
    if (!cs) continue;
    // prerelease versions only match comparators on the same major.minor.patch with a prerelease (npm rule)
    if (v.pre && !cs.some(([, c]) => c.pre && c.major === v.major && c.minor === v.minor && c.patch === v.patch)) continue;
    const ok = cs.every(([op, c]) => {
      const r = cmp(v, c);
      return op === '=' ? r === 0 : op === '>' ? r > 0 : op === '>=' ? r >= 0 : op === '<' ? r < 0 : r <= 0;
    });
    if (ok) return true;
  }
  return false;
}

/** Is this a plain registry semver range (not a tag, alias, git, file, url or workspace spec)? */
function isRegistryRange(spec) {
  if (typeof spec !== 'string') return false;
  const s = spec.trim();
  if (/^(npm|workspace|file|link|git|git\+[a-z]+|github|gitlab|bitbucket|http|https|catalog|jsr|portal|patch):/i.test(s)) return false;
  if (s.includes('/')) return false; // owner/repo shorthand or path
  return s === '' || s === '*' || /^[\s\d.xX*^~<>=|v-]+$/.test(s);
}

/**
 * Dependencies that pnpm-lock.yaml's importers already resolve, keyed by name: { spec, pin } where pin is the
 * fork version when the locked specifier points at patch-cloud (named registry or tarball URL), else null.
 */
function lockfileSpecs(text, baseUrl) {
  const out = new Map();
  if (typeof text !== 'string') return out;
  const tarRe = new RegExp('^' + baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/.+-(\\d+\\.\\d+\\.\\d+[^/]*)\\.tgz$');
  for (const doc of text.split(/^---\s*$/m)) {
    const m = /^importers:\s*$([\s\S]*?)(?=^\S|(?![\s\S]))/m.exec(doc);
    if (!m) continue;
    const re = /^\s+'?((?:@[^\s/:']+\/)?[^\s/:']+)'?:\s*\n\s+specifier:\s*'?([^'\n]+?)'?\s*$/gm;
    let e;
    while ((e = re.exec(m[1]))) {
      const name = e[1]; const spec = e[2].trim();
      let pin = null;
      const a = new RegExp(`^${ALIAS}:(?:@[^/]+/)?[^@]+@(.+)$`).exec(spec);
      if (a) pin = a[1];
      else { const t = tarRe.exec(spec); if (t) pin = t[1]; }
      if (!out.has(name) || pin) out.set(name, { spec, pin });
    }
  }
  return out;
}

/**
 * Rewrite a manifest in place. Returns list of { name, from, to, reason } changes.
 */
function rewriteManifest(pkg, forks, mode = 'tarball', locked = null, lights = null) {
  const changes = [];
  if (!pkg || ((!forks || forks.size === 0) && (!locked || locked.size === 0))) return changes;
  forks = forks || new Map();
  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const name of Object.keys(deps)) {
      const spec = deps[name];
      if (!isRegistryRange(spec)) continue;
      const lock = locked && locked.get(name);
      if (lock) {
        // keep policy: reuse the locked fork pin as-is; a dependency locked to upstream stays upstream
        if (lock.pin && satisfies(lock.pin, spec.trim() === '' ? '*' : spec)) {
          const f = forks.get(name);
          deps[name] = lock.spec;
          changes.push({ name, from: spec, to: lock.spec, version: lock.pin, reason: 'lockfile', field,
            repo: f ? f.repo : null, lightState: (lights && lights.get(name)) || (f ? f.lightState : null), lightUrl: f ? f.lightUrl : null });
        }
        continue;
      }
      const fork = forks.get(name);
      if (!fork) continue;
      if (!satisfies(fork.version, spec.trim() === '' ? '*' : spec)) continue;
      const to = mode === 'registry' ? fork.alias : fork.tarball;
      deps[name] = to;
      changes.push({ name, from: spec, to, version: fork.version, reason: fork.reason, field,
        repo: fork.repo, lightState: fork.lightState, lightUrl: fork.lightUrl });
    }
  }
  return changes;
}

async function fetchStatus(cfg, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available in this Node.js');
  const res = await fetchImpl(`${cfg.url}/status?format=json`, {
    headers: { accept: 'application/json', 'user-agent': 'pnpm-plugin-patch-cloud' },
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Create the pnpm hooks. state is kept per process so the feed is fetched once per install.
 */
/** pnpm version from pnpm's config.userAgent ("pnpm/12.21.0 npm/? node/..."). */
function pnpmVersion(config) {
  const m = /\bpnpm\/(\d+)\.(\d+)\.(\d+)/.exec(String((config && config.userAgent) || ''));
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}
/** Named registries (pnpm add work:pkg@range) exist since pnpm 11.1.0. */
function supportsNamedRegistries(v) {
  return !!v && (v.major > 11 || (v.major === 11 && v.minor >= 1));
}

/** One NDJSON line per swap: what was swapped, its light, and when. Local only; never sent anywhere. */
function recordSwap(file, c, now = new Date()) {
  const line = {
    ts: now.toISOString(),
    package: c.name,
    version: c.version,
    light: c.lightState,
    reason: c.reason,
    requested: c.from,
    fork: c.to,
    repo: c.repo,
    lightRun: c.lightUrl,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(line) + '\n');
  return line;
}

/**
 * Newer pnpm runs updateConfig and readPackage in separate hook processes started by the same pnpm
 * process, so updateConfig leaves its decision in a small temp file keyed by that parent pid.
 */
function modeFile(ppid, dir = os.tmpdir()) {
  return path.join(dir, `patch-cloud-mode-${ppid}.json`);
}

function createHooks({ env = process.env, cwd = process.cwd(), fetchImpl, logger, now, ppid = process.ppid, tmpdir } = {}) {
  const cfg = readConfig(env, cwd);
  const swapped = [];
  // Resolved by updateConfig (runs before readPackage). Without it we fall back to tarball URLs.
  let mode = cfg.mode === 'registry' ? 'registry' : 'tarball';
  let blockExotic = false;
  let blockedNoted = false;
  let decided = false;
  let frozen = false;
  const handoff = modeFile(ppid, tmpdir);
  let lights = new Map();
  let locked; // lockfile specs, read once when the keep policy applies
  function updateConfig(config) {
    if (cfg.disabled || !config || typeof config !== 'object') return config;
    if (cfg.mode === 'auto') mode = supportsNamedRegistries(pnpmVersion(config)) ? 'registry' : 'tarball';
    blockExotic = config.blockExoticSubdeps === true;
    frozen = config.frozenLockfile === true;
    decided = true;
    try { fs.writeFileSync(handoff, JSON.stringify({ mode, blockExotic, frozen, ts: Date.now() })); } catch { /* in-process state still works */ }
    if (mode === 'registry') {
      // pnpm reads the prefix map as registriesByPrefix (11.x/12.x) or namedRegistries; set both.
      config.namedRegistries = { ...(config.namedRegistries || {}), [ALIAS]: `${cfg.url}/` };
      config.registriesByPrefix = { ...(config.registriesByPrefix || {}), [ALIAS]: `${cfg.url}/` };
    }
    return config;
  }
  let forksPromise = null;
  const announced = new Set();
  const say = (ctx, msg) => {
    if (cfg.quiet) return;
    if (ctx && typeof ctx.log === 'function') ctx.log(msg);
    else if (logger) logger(msg);
    else process.stderr.write(msg + '\n');
  };
  let failNoted = false;
  function loadForks(ctx) {
    if (!forksPromise) {
      forksPromise = fetchStatus(cfg, fetchImpl || globalThis.fetch)
        .then((status) => { lights = lightsFromStatus(status); return forksFromStatus(status, cfg.url); })
        .catch((err) => {
          if (!failNoted) {
            failNoted = true;
            const why = err && err.name === 'TimeoutError' ? `no answer within ${cfg.timeoutMs} ms` : (err && err.message) || String(err);
            say(ctx, `patch-cloud: status feed ${cfg.url} unreachable (${why}); installing unchanged.`);
          }
          return new Map();
        });
    }
    return forksPromise;
  }
  async function readPackage(pkg, context) {
    if (cfg.disabled) return pkg;
    if (!decided) {
      decided = true;
      try {
        const h = JSON.parse(fs.readFileSync(handoff, 'utf8'));
        if (Date.now() - h.ts < 30 * 60 * 1000) {
          if (h.mode === 'registry' || h.mode === 'tarball') mode = h.mode;
          blockExotic = h.blockExotic === true;
          frozen = h.frozen === true;
        }
      } catch { /* no handoff: keep the tarball default */ }
    }
    const forks = await loadForks(context);
    if (mode === 'tarball' && blockExotic) {
      // Tarball URLs are "exotic" sources; with blockExoticSubdeps on, pnpm would refuse them. Fail open.
      if (forks.size && !blockedNoted) {
        blockedNoted = true;
        say(context, 'patch-cloud: blockExoticSubdeps is on and this pnpm has no named registries (needs pnpm >= 11.1); installing unchanged.');
      }
      return pkg;
    }
    const keep = cfg.lockfile === 'keep' || (cfg.lockfile === 'auto' && frozen);
    if (keep && locked === undefined) {
      try { locked = lockfileSpecs(fs.readFileSync(path.join(cwd, 'pnpm-lock.yaml'), 'utf8'), cfg.url); }
      catch { locked = new Map(); }
    }
    for (const c of rewriteManifest(pkg, forks, mode, keep ? locked : null, lights)) {
      const key = `${c.name}@${c.version}`;
      if (announced.has(key)) continue;
      announced.add(key);
      const why = c.reason === 'manual' ? 'manual switch: fix available'
        : c.reason === 'lockfile' ? `kept from pnpm-lock.yaml; light ${c.lightState || 'unknown'}` : 'upstream light dark';
      say(context, `patch-cloud: ${c.name} ${c.from} -> fork ${c.version} (${why}) ${c.to}`);
      swapped.push(c);
      if (cfg.record) {
        try { recordSwap(cfg.record, c, now ? now() : new Date()); }
        catch (err) { say(context, `patch-cloud: could not write record ${cfg.record} (${err.message}); install continues.`); }
      }
    }
    return pkg;
  }
  // Runs once after resolution: one summary line, and the ping note.
  function afterAllResolved(lockfile, context) {
    if (cfg.disabled) return lockfile;
    try { fs.unlinkSync(handoff); } catch { /* already gone */ }
    if (swapped.length) {
      const names = swapped.map((c) => `${c.name}@${c.version}`).join(', ');
      say(context, `patch-cloud: ${swapped.length} package(s) installed from patch-cloud forks this install: ${names}` +
        (cfg.record ? ` (recorded in ${cfg.record})` : ''));
      if (cfg.ping) say(context, 'patch-cloud: PATCH_CLOUD_PING is set, but patch-cloud has no ping endpoint yet; nothing was sent.');
    }
    return lockfile;
  }
  return { updateConfig, readPackage, afterAllResolved, swapped, getMode: () => mode, _config: cfg };
}

module.exports = {
  DEFAULT_URL, readConfig, tarballUrl, forksFromStatus, parseVersion, satisfies,
  isRegistryRange, rewriteManifest, fetchStatus, recordSwap, createHooks, lockfileSpecs, lightsFromStatus, pnpmVersion, supportsNamedRegistries, modeFile, ALIAS,
};
