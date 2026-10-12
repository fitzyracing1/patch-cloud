#!/usr/bin/env node
/**
 * Add patch-cloud metadata to a fork checkout before `npm pack`:
 *   - package.json#_patchCloud  { fork, branch, upstream, upstreamPr/upstreamIssue, fix, ... }
 *   - PATCH-CLOUD.md            human-readable description of exactly what changed
 *   - adds PATCH-CLOUD.md to package.json#files when a files allowlist exists
 * The package name and version are never changed.
 *
 * Usage: node annotate-fork.mjs <forkDir> <spec.json>
 * spec.json: { fork, branch, upstreamRepo, upstreamPr?, upstreamIssue?, baseRef, fix, changes: [..], verification: [..], credit?: [..], pkgJsonPath? }
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, specPath] = process.argv.slice(2);
if (!dir || !specPath) {
  console.error('usage: node annotate-fork.mjs <forkDir> <spec.json>');
  process.exit(1);
}
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const pjPath = join(dir, spec.pkgJsonPath || 'package.json');
const raw = readFileSync(pjPath, 'utf8');
const indent = (raw.match(/^\{\n([ \t]+)"/) || [, '  '])[1];
const pj = JSON.parse(raw);
pj._patchCloud = {
  fork: `https://github.com/${spec.fork}`,
  branch: spec.branch,
  upstream: `https://github.com/${spec.upstreamRepo}`,
  ...(spec.upstreamPr ? { upstreamPr: spec.upstreamPr } : {}),
  ...(spec.upstreamIssue ? { upstreamIssue: spec.upstreamIssue } : {}),
  baseRef: spec.baseRef,
  upstreamVersion: pj.version,
  fix: spec.fix,
  details: 'See PATCH-CLOUD.md in this package.',
};
if (Array.isArray(pj.files) && !pj.files.includes('PATCH-CLOUD.md')) pj.files.push('PATCH-CLOUD.md');
writeFileSync(pjPath, JSON.stringify(pj, null, indent) + (raw.endsWith('\n') ? '\n' : ''));

const md = [
  `# patch-cloud build of ${pj.name}@${pj.version}`,
  '',
  `This tarball was built by patch-cloud from [${spec.fork}@${spec.branch}](https://github.com/${spec.fork}/tree/${spec.branch}),`,
  `a fork of [${spec.upstreamRepo}](https://github.com/${spec.upstreamRepo}). It is **not** an official upstream release.`,
  `Package name and version are unchanged from upstream (\`${pj.name}@${pj.version}\`, base \`${spec.baseRef}\`).`,
  '',
  '## Fix',
  '',
  spec.fix,
  '',
  ...(spec.upstreamPr ? [`- Upstream PR: ${spec.upstreamPr}`] : []),
  ...(spec.upstreamIssue ? [`- Upstream issue: ${spec.upstreamIssue}`] : []),
  ...(spec.credit || []).map((c) => `- Credit: ${c}`),
  '',
  '## Exactly what changed vs upstream',
  '',
  ...spec.changes.map((c) => `- ${c}`),
  '- Added this `PATCH-CLOUD.md` and a `_patchCloud` field in `package.json` (metadata only).',
  '',
  '## Verification',
  '',
  ...spec.verification.map((c) => `- ${c}`),
  '',
  '## Opting out',
  '',
  'Remove the patch-cloud `registry=` override and reinstall from registry.npmjs.org to get the upstream tarball.',
  '',
].join('\n');
writeFileSync(join(dir, 'PATCH-CLOUD.md'), md);
console.log(`annotated ${pj.name}@${pj.version} in ${dir}`);
