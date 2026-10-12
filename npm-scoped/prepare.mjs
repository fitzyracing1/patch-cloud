// Stage @fitzyracing1/<pkg> copies of the patch-cloud tarballs for public npm.
// Patch content is byte-identical to tarballs/<pkg>-<ver>.tgz except package.json#name
// (+ publishConfig, _patchCloud.scopedName) and a patched-fork notice prepended to README.md.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const mapping = JSON.parse(readFileSync(join(ROOT, 'mapping.json'), 'utf8'));
const out = join(HERE, 'dist');
mkdirSync(out, { recursive: true });
for (const [repo, m] of Object.entries(mapping)) {
  if (!m.npmName || !m.rewriteReady || !m.forkBranch || m.forkBranch !== 'patch-cloud') continue;
  const name = m.npmName, ver = m.version, scoped = `@fitzyracing1/${name}`;
  const dir = join(HERE, 'stage', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xzf', join(ROOT, m.forkTarball), '-C', dir]);
  const pkgDir = join(dir, 'package');
  const pjPath = join(pkgDir, 'package.json');
  const raw = readFileSync(pjPath, 'utf8');
  const pj = JSON.parse(raw);
  pj.name = scoped;
  pj.publishConfig = { access: 'public', registry: 'https://registry.npmjs.org/' };
  pj._patchCloud = { ...(pj._patchCloud || {}), scopedName: scoped, unscopedName: name };
  for (const k of ['scripts']) if (pj[k]) { // never run upstream lifecycle scripts on publish/install of a prebuilt tarball
    for (const s of ['prepublish', 'prepublishOnly', 'prepack', 'prepare', 'postpack']) delete pj[k][s];
  }
  writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n');
  const readmeName = readdirSync(pkgDir).find((f) => /^readme(\.md)?$/i.test(f)) || 'README.md';
  const readmePath = join(pkgDir, readmeName);
  const old = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
  const links = [m.upstreamUrl, m.upstreamIssue, ...(m.relatedPrs || [])].filter(Boolean).map((u) => `- ${u}`).join('\n');
  const notice = `> **Patched fork — not the official \`${name}\` package.**
> \`${scoped}@${ver}\` is upstream [\`${name}@${ver}\`](https://www.npmjs.com/package/${name}/v/${ver}) plus one fix, built from [${m.forkRepo}@patch-cloud](https://github.com/${m.forkRepo}/tree/patch-cloud).
> See [PATCH-CLOUD.md](./PATCH-CLOUD.md) in this package for exactly what changed and how it was verified.

## patch-cloud fork notes

${m.publicNote}

Upstream: ${m.upstreamRepo}
${links}

### Install

\`\`\`bash
# keep \`require('${name}')\` / \`import '${name}'\` working (npm alias):
npm install ${name}@npm:${scoped}@${ver}

# or install under the scoped name and import '${scoped}':
npm install ${scoped}@${ver}
\`\`\`

The same patched build is also served under the unscoped name \`${name}\` by the opt-in
[patch-cloud](https://patch-cloud-production.up.railway.app/status) registry
(\`npm install ${name} --registry https://patch-cloud-production.up.railway.app\`).
Remove the alias / registry override to go back to upstream.

---

`;
  writeFileSync(readmePath, notice + old);
  const tgz = execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', out, '--json'], { cwd: pkgDir, encoding: 'utf8' });
  const info = JSON.parse(tgz)[0];
  console.log(`${scoped}@${ver} -> dist/${info.filename} (${info.entryCount} files)`);
}
