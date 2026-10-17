// mirror-bot core: verify a download request, give one okay, then download.
// Lit/dark is active-low: lit = 0 = ok, dark = 1 = everything else.
import { createHmac, createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileP = promisify(execFile);
export const LIT = 0;
export const DARK = 1;
export const lightWord = (bit) => (bit === LIT ? 'lit' : 'dark');

// ---- signing -------------------------------------------------------------
// Canonical form: keys sorted, `sig` field left out.
export function canonical(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) if (k !== 'sig') out[k] = obj[k];
  return JSON.stringify(out);
}
export function sign(obj, secret) {
  if (!secret) throw new Error('no secret');
  return createHmac('sha256', secret).update(canonical(obj)).digest('hex');
}
export function verifySig(obj, secret) {
  if (!secret || typeof obj?.sig !== 'string') return false;
  const want = Buffer.from(sign(obj, secret), 'hex');
  const got = Buffer.from(obj.sig, 'hex');
  return want.length === got.length && timingSafeEqual(want, got);
}

// ---- request shape -------------------------------------------------------
const NAME_RE = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
export function checkShape(r) {
  if (!r || typeof r !== 'object') return 'request is not an object';
  if (typeof r.package !== 'string' || !NAME_RE.test(r.package) || r.package.length > 214) return 'bad package name';
  // Exact version only: no ranges, tags or URLs. One okay = one exact package@version.
  if (typeof r.version !== 'string' || !VERSION_RE.test(r.version)) return 'version must be exact (x.y.z)';
  if (typeof r.requester !== 'string' || !r.requester) return 'missing requester';
  if (typeof r.nonce !== 'string' || r.nonce.length < 8) return 'missing nonce';
  if (typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt))) return 'missing createdAt';
  return null;
}

// ---- lights --------------------------------------------------------------
// Returns { bit, source, detail, url }. Unknown => dark.
export async function lightFromPatchCloud(name, { statusUrl, fetchImpl = fetch }) {
  const res = await fetchImpl(statusUrl, { headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  const s = await res.json();
  const p = (s.packages || []).find((x) => x.npmName === name);
  if (!p || !p.light) return null;
  const lit = p.light.state === 'lit' && p.light.conclusion === 'success';
  return { bit: lit ? LIT : DARK, source: 'patch-cloud', detail: `${p.repo} conclusion=${p.light.conclusion ?? 'none'}`, url: p.light.url ?? null };
}

export function repoFromPackument(meta) {
  const r = meta?.repository;
  const u = typeof r === 'string' ? r : r?.url;
  const m = u && u.match(/github\.com[/:]([^/]+)\/([^/#]+?)(\.git)?(#.*)?$/i);
  if (m) return `${m[1]}/${m[2]}`;
  if (typeof r === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r)) return r; // "owner/repo" shorthand
  return null;
}

export async function lightFromGitHub(repo, { fetchImpl = fetch, token } = {}) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'mirror-bot' };
  if (token) headers.authorization = `Bearer ${token}`;
  const info = await fetchImpl(`https://api.github.com/repos/${repo}`, { headers });
  if (!info.ok) return null;
  const branch = (await info.json()).default_branch;
  const runs = await fetchImpl(`https://api.github.com/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=1`, { headers });
  if (!runs.ok) return null;
  const run = (await runs.json()).workflow_runs?.[0];
  if (!run) return null;
  // GitHub 'success' = lit; everything else (failure, cancelled, skipped, ...) = dark.
  return { bit: run.conclusion === 'success' ? LIT : DARK, source: 'github-actions', detail: `${repo}@${branch} "${run.name}" conclusion=${run.conclusion}`, url: run.html_url };
}

export async function getLight(name, meta, opts) {
  try {
    const pc = await lightFromPatchCloud(name, opts);
    if (pc) return pc;
  } catch (e) { /* fall through */ }
  const repo = repoFromPackument(meta);
  if (repo) {
    try {
      const gh = await lightFromGitHub(repo, opts);
      if (gh) return gh;
    } catch (e) { /* fall through */ }
  }
  return { bit: DARK, source: 'unknown', detail: 'no light found (dark by default)', url: null };
}

export async function getPackument(name, { registry, fetchImpl = fetch }) {
  const res = await fetchImpl(`${registry.replace(/\/$/, '')}/${name.replace('/', '%2f')}`, { headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  return res.json();
}

// ---- review (the mirror bot's decision) ---------------------------------
// ctx: { secret, allowlist:Set, seenNonces:Set, registry, statusUrl, fetchImpl, token, now, okayTtlMs }
export async function review(req, ctx) {
  const now = ctx.now ?? Date.now();
  const base = { id: req?.id ?? null, package: req?.package, version: req?.version, requester: req?.requester };
  const refuse = (reason, light = null) => ({ ...base, decision: 'refuse', bit: DARK, light: 'dark', reason, lightSource: light?.source ?? null, lightDetail: light?.detail ?? null, lightUrl: light?.url ?? null });

  const shape = checkShape(req);
  if (shape) return refuse(shape);
  if (!ctx.allowlist.has(req.requester)) return refuse(`requester "${req.requester}" not on allowlist`);
  if (!verifySig(req, ctx.secret)) return refuse('bad or missing HMAC signature');
  const age = now - Date.parse(req.createdAt);
  if (age > (ctx.maxRequestAgeMs ?? 15 * 60e3) || age < -60e3) return refuse('request too old or from the future');
  if (ctx.seenNonces.has(req.nonce)) return refuse('nonce already used (replay)');

  const meta = await getPackument(req.package, ctx);
  if (!meta) return refuse('package not found on registry');
  const v = meta.versions?.[req.version];
  if (!v) return refuse(`version ${req.version} not on registry`);
  const integrity = v.dist?.integrity;
  if (!integrity || !integrity.startsWith('sha512-')) return refuse('registry has no sha512 dist.integrity');

  const light = await getLight(req.package, meta, ctx);
  if (light.bit !== LIT) return refuse(`package light is dark (${light.source}: ${light.detail})`, light);

  const okay = {
    okayId: randomUUID(),
    requestId: req.id ?? null,
    requester: req.requester,
    nonce: req.nonce,
    package: req.package,
    version: req.version,
    integrity,
    tarball: v.dist.tarball,
    light: 'lit',
    bit: LIT,
    lightSource: light.source,
    lightDetail: light.detail,
    lightUrl: light.url,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (ctx.okayTtlMs ?? 10 * 60e3)).toISOString(),
    scope: 'download-only exact package@version, single use',
  };
  okay.sig = sign(okay, ctx.secret);
  return { ...base, decision: 'okay', bit: LIT, light: 'lit', reason: `package light is lit (${light.source}: ${light.detail})`, lightSource: light.source, lightDetail: light.detail, lightUrl: light.url, okay };
}

// ---- downloader ----------------------------------------------------------
export function sriOf(buf) {
  return 'sha512-' + createHash('sha512').update(buf).digest('base64');
}

export async function defaultPack({ spec, dest, registry }) {
  // Download only: `npm pack` of a registry spec fetches the tarball; --ignore-scripts so nothing runs.
  // Runs in the scratch folder with no package.json, so nothing gets installed anywhere.
  const { stdout } = await execFileP('npm', ['pack', spec, '--ignore-scripts', '--json', `--pack-destination=${dest}`, `--registry=${registry}`, '--no-audit', '--no-fund'], { cwd: dest, env: { ...process.env, npm_config_ignore_scripts: 'true' }, maxBuffer: 16 << 20 });
  const out = JSON.parse(stdout);
  return path.join(dest, out[0].filename);
}

// usedOkays: Set of okayIds already consumed. Returns { ok, file?, reason }.
export async function download(okay, ctx) {
  const now = ctx.now ?? Date.now();
  if (!verifySig(okay, ctx.secret)) return { ok: false, reason: 'okay record signature invalid' };
  if (okay.bit !== LIT || okay.light !== 'lit') return { ok: false, reason: 'okay record is not lit' };
  if (Date.parse(okay.expiresAt) < now) return { ok: false, reason: 'okay record expired' };
  if (ctx.usedOkays.has(okay.okayId)) return { ok: false, reason: 'okay record already used' };
  if (checkShape({ ...okay, createdAt: okay.issuedAt })) return { ok: false, reason: 'okay record malformed' };
  ctx.usedOkays.add(okay.okayId); // consume before downloading: one okay = one try
  await fs.mkdir(ctx.downloadDir, { recursive: true });
  const pack = ctx.packImpl ?? defaultPack;
  const spec = `${okay.package}@${okay.version}`;
  const file = await pack({ spec, dest: ctx.downloadDir, registry: ctx.registry });
  const got = sriOf(await fs.readFile(file));
  if (got !== okay.integrity) {
    await fs.rm(file, { force: true });
    return { ok: false, reason: `integrity mismatch (got ${got.slice(0, 20)}..., want ${okay.integrity.slice(0, 20)}...); tarball removed` };
  }
  return { ok: true, file, integrity: got };
}
