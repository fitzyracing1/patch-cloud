#!/usr/bin/env node
/**
 * Build watchlist.json for the public dark lights board from the npmmirror
 * dark-CI scan (/workspace/mirror/dig.json + notes.json). Research data only:
 * nothing here forks, opens, or comments on anything.
 *
 *   node build-watchlist.mjs [--mirror /workspace/mirror] [--top 20]
 *
 * Entries are popular packages whose upstream test CI is red. They have no
 * patch-cloud fork unless mapping.json maps the repo (then fork: true).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const MIRROR = arg('--mirror', join(ROOT, '..', 'mirror'));
const TOP = Number(arg('--top', 20));

const digPath = join(MIRROR, 'dig.json');
if (!existsSync(digPath)) {
  console.error(`no ${digPath}; mirror scan not available, watchlist unchanged`);
  process.exit(1);
}
const dig = JSON.parse(readFileSync(digPath, 'utf8'));
const notes = existsSync(join(MIRROR, 'notes.json')) ? JSON.parse(readFileSync(join(MIRROR, 'notes.json'), 'utf8')) : {};
const mapping = JSON.parse(readFileSync(join(ROOT, 'mapping.json'), 'utf8'));

/** Never use the word "failure" publicly (reads like a download failed). */
const honest = (s) =>
  s == null ? null : String(s)
    .replace(/\bfailures\b/gi, 'failing runs')
    .replace(/\bfailure\b/gi, 'failing run')
    .replace(/(?:file:\/\/)?\/(?:workspace|home|tmp|root)\/[^\s,;)'"]*/g, '')
    .trim();

const rows = dig
  .map((d) => ({ ...d, pkgs: [...d.pkgs].sort((a, b) => b.dl - a.dl) }))
  .sort((a, b) => b.pkgs[0].dl - a.pkgs[0].dl)
  .slice(0, TOP)
  .map((d, i) => {
    const n = notes[d.full] || [];
    const mapped = mapping[d.full];
    return {
      rank: i + 1,
      repo: d.full,
      repoUrl: `https://github.com/${d.full}`,
      packages: d.pkgs.slice(0, 6).map((p) => ({ name: p.pkg, mirrorDownloadsSep2026: p.dl })),
      archived: !!d.archived,
      ci: {
        workflow: d.latestCI.name,
        event: d.latestCI.event,
        url: d.latestCI.url,
        latestRunAt: d.latestCI.date,
        redRunsInARow: d.streak,
        redRunsCapped: !!d.streakCapped,
        lastPassingAt: d.lastSuccess?.date || null,
      },
      summary: honest(n[0]) || null,
      fixability: honest(n[1]) || null,
      existingFix: honest(n[2]) || null,
      fork: !!(mapped && mapped.rewriteReady),
      openPRCount: d.openPRCount ?? null,
    };
  });

const out = {
  generatedAt: new Date().toISOString(),
  source: 'npmmirror dark-CI scan (top npm + China-popular packages, 573 checked, 496 repos)',
  downloadsNote: 'npmmirror (China mirror) downloads for September 2026; the /week figure is npmjs.org',
  darkDefinition: 'dark = the latest push/schedule test-CI run on the default branch did not pass',
  scanned: { packages: 573, repos: 496 },
  totalDarkRepos: dig.length,
  entries: rows,
};
writeFileSync(join(ROOT, 'watchlist.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`watchlist.json: ${rows.length} of ${dig.length} dark repos`);
