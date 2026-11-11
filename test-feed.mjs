#!/usr/bin/env node
/**
 * Unit tests for the public dark-package feed (no server, no network).
 */
import { buildFeed, feedToAtom, feedToRss, shouldIncludeInFeed } from './feed.mjs';

const results = [];
function ok(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const status = {
  service: 'patch-cloud',
  registry: 'https://patch-cloud.example',
  publicUrl: 'https://patch-cloud.example',
  optIn: {
    install: 'npm install <pkg> --registry https://patch-cloud.example',
    npmrc: 'registry=https://patch-cloud.example/',
  },
  packages: [
    {
      repo: 'local/broken-demo',
      npmName: 'broken-demo',
      version: '1.0.0',
      light: { state: 'dark', url: null },
      rewrite: 'active',
      fork: {},
      dark: { since: '2026-10-12T03:56:31.769Z', days: 30, atLeast: true, lastPassingAt: null },
      install: 'npm install broken-demo@1.0.0 --registry https://patch-cloud.example',
      note: 'Demo package.',
    },
    {
      repo: 'react/react',
      npmName: 'react',
      version: '19.3.0',
      light: { state: 'lit', url: 'https://github.com/react/react/actions/runs/1' },
      rewrite: 'ready',
      fork: { repo: 'fitzyracing1/react', url: 'https://github.com/fitzyracing1/react', branch: 'main', branchUrl: 'https://github.com/fitzyracing1/react/tree/main' },
      dark: null,
      install: null,
    },
    {
      repo: 'vercel/next.js',
      npmName: 'next',
      version: '16.4.0',
      light: { state: 'dark', url: 'https://github.com/vercel/next.js/actions/runs/43091587389' },
      rewrite: 'active',
      fork: { repo: 'fitzyracing1/next.js', url: 'https://github.com/fitzyracing1/next.js', branch: 'rspack-manifest-fix', branchUrl: 'https://github.com/fitzyracing1/next.js/tree/rspack-manifest-fix' },
      dark: { since: '2026-11-11T19:54:53Z', days: 0, atLeast: false, lastPassingAt: '2026-11-11T19:59:07Z' },
      install: 'npm install next@16.4.0 --registry https://patch-cloud.example',
      note: 'CI-only fix.',
      upstream: { url: 'https://github.com/vercel/next.js/pull/100001', kind: 'pr', state: 'open' },
    },
    {
      repo: 'denoland/deno',
      npmName: null,
      version: null,
      light: { state: 'dark', url: 'https://github.com/denoland/deno/actions/runs/1' },
      rewrite: 'n/a',
      fork: {},
      dark: { since: '2026-01-01T00:00:00Z', days: 1, atLeast: false },
      install: null,
    },
    {
      repo: 'ajv-validator/ajv',
      npmName: 'ajv',
      version: '6.15.0',
      light: { state: 'dark', url: 'https://github.com/ajv-validator/ajv/actions/runs/24892856278' },
      rewrite: 'would rewrite',
      fork: { repo: 'fitzyracing1/ajv', url: 'https://github.com/fitzyracing1/ajv', branch: 'patch-cloud', branchUrl: 'https://github.com/fitzyracing1/ajv/tree/patch-cloud' },
      dark: { since: '2026-04-24T13:46:25Z', days: 201, atLeast: false },
      install: null,
      note: 'Not rewritten.',
    },
    {
      repo: 'iamkun/dayjs',
      npmName: 'dayjs',
      version: '1.11.23',
      light: { state: 'lit', url: 'https://github.com/iamkun/dayjs/actions/runs/1' },
      rewrite: 'manual',
      fork: { repo: 'fitzyracing1/dayjs', url: 'https://github.com/fitzyracing1/dayjs', branch: 'patch-cloud', branchUrl: 'https://github.com/fitzyracing1/dayjs/tree/patch-cloud' },
      dark: null,
      install: 'npm install dayjs@1.11.23 --registry https://patch-cloud.example',
      note: 'timezone plugin cache <script>alert("x")</script> & more',
    },
  ],
};

ok('include dark npm', shouldIncludeInFeed(status.packages[0]) === true);
ok('exclude lit ready', shouldIncludeInFeed(status.packages[1]) === false);
ok('include dark next', shouldIncludeInFeed(status.packages[2]) === true);
ok('exclude non-npm dark', shouldIncludeInFeed(status.packages[3]) === false);
ok('include dark without packaged fix', shouldIncludeInFeed(status.packages[4]) === true);
ok('include lit manual fix', shouldIncludeInFeed(status.packages[5]) === true);

const feed = buildFeed(status, { generatedAt: '2026-11-11T22:00:00.000Z' });
const names = feed.items.map((i) => i.package);
ok('feed version 1', feed.version === 1 && feed.service === 'patch-cloud');
ok('feed generatedAt + registry', feed.generatedAt === '2026-11-11T22:00:00.000Z' && feed.registry === 'https://patch-cloud.example');
ok('feed urls', feed.feed.json === 'https://patch-cloud.example/feed.json' && feed.feed.atom.endsWith('/feed.atom') && feed.feed.rss.endsWith('/feed.rss'));
ok('items are dark npm + manual only', JSON.stringify(names) === JSON.stringify(['broken-demo', 'next', 'ajv', 'dayjs']), JSON.stringify(names));
ok('react and deno omitted', !names.includes('react') && !feed.items.some((i) => i.upstreamRepo === 'denoland/deno'));
ok('counts', feed.counts.dark === 3 && feed.counts.fixAvailable === 3, JSON.stringify(feed.counts));

const next = feed.items.find((i) => i.package === 'next');
ok('next fields', !!(next && next.version === '16.4.0' && next.upstreamRepo === 'vercel/next.js' && next.light === 'dark' && next.failingRunUrl === 'https://github.com/vercel/next.js/actions/runs/43091587389' && next.since === '2026-11-11T19:54:53Z' && next.fork?.repo === 'fitzyracing1/next.js' && next.fork.branch === 'rspack-manifest-fix' && next.fixAvailable === true && next.install === 'npm install next@16.4.0 --registry https://patch-cloud.example'), JSON.stringify(next));

const ajv = feed.items.find((i) => i.package === 'ajv');
ok('ajv listed but not served', !!(ajv && ajv.fixAvailable === false && ajv.install === null && ajv.fork?.repo === 'fitzyracing1/ajv' && ajv.light === 'dark'));

const dayjs = feed.items.find((i) => i.package === 'dayjs');
ok('dayjs manual included while lit', !!(dayjs && dayjs.light === 'lit' && dayjs.fixAvailable === true && dayjs.failingRunUrl === null && dayjs.install.includes('dayjs@1.11.23')));

ok('optIn + optOut', /official npm registry/.test(feed.optIn.optOut) && feed.optIn.npmrc.includes('registry=') && next.optOut === feed.optIn.optOut);

const raw = JSON.stringify(feed);
ok('feed JSON has no box paths', !/\/workspace|\/home\//.test(raw));

const atom = feedToAtom(feed);
const rss = feedToRss(feed);
ok('atom header', atom.startsWith('<?xml version="1.0" encoding="utf-8"?>') && atom.includes('<feed xmlns="http://www.w3.org/2005/Atom">') && atom.includes('<title>patch-cloud'));
ok('atom has all items', atom.includes('next is dark') && atom.includes('ajv is dark') && atom.includes('dayjs light is lit') && atom.includes('broken-demo'));
ok('atom has install line', atom.includes('npm install next@16.4.0 --registry https://patch-cloud.example'));
ok('rss header', rss.includes('<rss version="2.0"') && rss.includes('<channel>') && rss.includes('patch-cloud'));
ok('rss has items', rss.includes('<item>') && rss.includes('next is dark') && rss.includes('ajv is dark'));
ok('xml escapes note special chars', atom.includes('&lt;script&gt;') && atom.includes('&amp; more') && !atom.includes('<script>alert') && rss.includes('&lt;script&gt;') && !rss.includes('<script>alert'));
ok('atom/rss have no box paths', !/\/workspace|\/home\//.test(atom + rss));
ok('react omitted from xml', !atom.includes('>react ') && !rss.includes('>react '));

const failed = results.filter((r) => !r.pass);
console.log('\n---');
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.error('Failed:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
process.exit(0);
