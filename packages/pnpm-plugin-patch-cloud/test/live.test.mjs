// Optional live check against the real patch-cloud status feed (PATCH_CLOUD_LIVE=1).
// It only reads /status?format=json; it never downloads a tarball, so patch-cloud's download counts don't move.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const lib = createRequire(import.meta.url)('../lib.cjs');

test('live feed: every dark rewrite-ready package maps to a fork; lit packages never do', { skip: process.env.PATCH_CLOUD_LIVE !== '1' }, async () => {
  const cfg = lib.readConfig({ PATCH_CLOUD_URL: process.env.PATCH_CLOUD_URL, PATCH_CLOUD_TIMEOUT_MS: '15000' });
  const status = await lib.fetchStatus(cfg);
  const forks = lib.forksFromStatus(status, cfg.url);
  for (const p of status.packages) {
    if (!p.npmName || !p.version) continue;
    const dark = p.light && p.light.state === 'dark' && (p.rewrite === 'active' || p.rewrite === 'ready');
    const manual = !!(p.manual && p.manual.servingNow);
    assert.equal(forks.has(p.npmName), dark || manual, `${p.npmName}: ${p.light && p.light.state} / ${p.rewrite}`);
    if (forks.has(p.npmName)) {
      const pkg = { dependencies: { [p.npmName]: `^${p.version}` } };
      lib.rewriteManifest(pkg, forks, 'registry');
      assert.equal(pkg.dependencies[p.npmName], `patch-cloud:${p.npmName}@${p.version}`);
    } else {
      const pkg = { dependencies: { [p.npmName]: `^${p.version}` } };
      lib.rewriteManifest(pkg, forks, 'registry');
      assert.equal(pkg.dependencies[p.npmName], `^${p.version}`, 'untouched');
    }
  }
  console.log('live dark rewrite-ready:', [...forks.keys()].join(', ') || '(none)');
});
