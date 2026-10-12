#!/usr/bin/env node
/**
 * Download an upstream npm tarball, add PATCH-CLOUD.md + package.json#_patchCloud,
 * write to tarballs/<name>-<version>-fork.tgz
 *
 * Usage:
 *   node pack-annotated.mjs next \
 *     --fork fitzyracing1/next.js \
 *     --branch rspack-manifest-fix \
 *     --pr https://github.com/vercel/next.js/pull/100001 \
 *     [--version 16.4.0]
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (!args[0] || args[0] === '-h' || args[0] === '--help') {
  console.log('Usage: node pack-annotated.mjs <npmName> --fork <repo> --branch <branch> [--pr <url>] [--note <text>] [--version <ver>]');
  process.exit(args[0] ? 0 : 1);
}

function flag(name, def = null) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}

const npmName = args[0];
const fork = flag('--fork');
const branch = flag('--branch');
const pr = flag('--pr');
let version = flag('--version');
const noteText = flag('--note');
if (!fork || !branch) {
  console.error('Required: --fork --branch (optional: --pr, --note)');
  process.exit(1);
}

const metaUrl = `https://registry.npmjs.org/${npmName.replace('/', '%2F')}${version ? `/${version}` : '/latest'}`;
const metaRes = await fetch(metaUrl, { headers: { Accept: 'application/json' } });
if (!metaRes.ok) throw new Error(`metadata ${metaRes.status} ${metaUrl}`);
const meta = await metaRes.json();
version = meta.version;
const tarballUrl = meta.dist.tarball;
console.log(`Downloading ${npmName}@${version} from ${tarballUrl}`);

const work = mkdtempSync(join(tmpdir(), 'patch-cloud-pack-'));
const tgzPath = join(work, 'upstream.tgz');
const extractDir = join(work, 'extract');
mkdirSync(extractDir);

const buf = Buffer.from(await (await fetch(tarballUrl)).arrayBuffer());
writeFileSync(tgzPath, buf);
execFileSync('tar', ['-xzf', tgzPath, '-C', extractDir]);

const pkgDir = join(extractDir, 'package');
const pjPath = join(pkgDir, 'package.json');
const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
pj._patchCloud = {
  fork,
  branch,
  pr: pr || null,
  note: noteText || 'Annotated by patch-cloud (upstream tarball + metadata).',
  annotatedAt: new Date().toISOString(),
  upstreamVersion: pj.version,
};
writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n');
writeFileSync(
  join(pkgDir, 'PATCH-CLOUD.md'),
  `# patch-cloud annotation for ${npmName}@${version}\n\n` +
    `Upstream package from registry.npmjs.org, repacked with metadata only.\n\n` +
    `- **Fork:** ${fork}\n- **Branch:** ${branch}\n- **PR:** ${pr || 'none yet'}\n` +
    (noteText ? `\n${noteText}\n` : ''),
);

const base = npmName.includes('/') ? npmName.split('/').pop() : npmName;
const outName = `${base}-${version}-fork.tgz`;
const outPath = join(ROOT, 'tarballs', outName);
mkdirSync(join(ROOT, 'tarballs'), { recursive: true });
execFileSync('tar', ['-czf', outPath, '-C', extractDir, 'package']);
rmSync(work, { recursive: true, force: true });

console.log(`Wrote tarballs/${outName}`);
console.log(JSON.stringify({ npmName, version, forkTarball: `tarballs/${outName}`, fork, branch, pr }, null, 2));
