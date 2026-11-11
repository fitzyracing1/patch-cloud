/**
 * Public machine-readable feed of dark packages and available fixes.
 * Built from the public /status payload. No box paths, no tokens.
 */
export const FEED_VERSION = 1;

const OPT_OUT =
  'Remove the --registry flag or the registry= line from .npmrc and reinstall to use the official npm registry.';

function xmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function registryOf(status) {
  return (status?.registry || status?.publicUrl || '').replace(/\/$/, '');
}

function feedUrls(status) {
  const base = registryOf(status);
  return {
    json: base ? `${base}/feed.json` : '/feed.json',
    atom: base ? `${base}/feed.atom` : '/feed.atom',
    rss: base ? `${base}/feed.rss` : '/feed.rss',
  };
}

function forkOf(pkg) {
  const f = pkg?.fork;
  if (!f || !f.repo) return null;
  return {
    repo: f.repo,
    branch: f.branch || null,
    url: f.url || null,
    branchUrl: f.branchUrl || null,
  };
}

function failingRunUrl(pkg) {
  if (pkg?.light?.state !== 'dark') return null;
  const url = pkg.light?.url || pkg.status?.secondaryUrl || null;
  return typeof url === 'string' && /^https:\/\/github\.com\//.test(url) ? url : null;
}

function installLine(pkg, registry) {
  if (pkg.install) return pkg.install;
  if (pkg.npmName && (pkg.rewrite === 'active' || pkg.rewrite === 'manual')) {
    const ver = pkg.version ? `@${pkg.version}` : '';
    return `npm install ${pkg.npmName}${ver} --registry ${registry}`;
  }
  return null;
}

function fixAvailable(pkg) {
  return pkg.rewrite === 'active' || pkg.rewrite === 'manual';
}

/** Dark npm packages, plus lit packages served via the labeled manual switch. */
export function shouldIncludeInFeed(pkg) {
  if (!pkg?.npmName) return false;
  if (pkg.light?.state === 'dark') return true;
  if (pkg.rewrite === 'manual') return true;
  return false;
}

export function buildFeed(status, { generatedAt } = {}) {
  const registry = registryOf(status);
  const generated = generatedAt || new Date().toISOString();
  const urls = feedUrls(status);
  const items = [];
  for (const pkg of status?.packages || []) {
    if (!shouldIncludeInFeed(pkg)) continue;
    const fork = forkOf(pkg);
    const available = fixAvailable(pkg);
    items.push({
      package: pkg.npmName,
      version: pkg.version || null,
      upstreamRepo: pkg.repo || null,
      light: pkg.light?.state || 'unknown',
      failingRunUrl: failingRunUrl(pkg),
      since: pkg.dark?.since || null,
      daysDark: pkg.dark?.days ?? null,
      daysDarkAtLeast: !!pkg.dark?.atLeast,
      lastPassingAt: pkg.dark?.lastPassingAt || null,
      fork,
      fixAvailable: available,
      rewrite: pkg.rewrite || null,
      install: available ? installLine(pkg, registry) : null,
      optOut: OPT_OUT,
      note: pkg.note || null,
      upstream: pkg.upstream || null,
    });
  }

  const darkCount = items.filter((i) => i.light === 'dark').length;
  const fixCount = items.filter((i) => i.fixAvailable).length;
  return {
    version: FEED_VERSION,
    service: 'patch-cloud',
    generatedAt: generated,
    registry: registry || null,
    publicUrl: status?.publicUrl || registry || null,
    statusUrl: registry ? `${registry}/status` : '/status',
    feed: urls,
    optIn: {
      install: status?.optIn?.install || (registry ? `npm install <pkg> --registry ${registry}` : null),
      npmrc: status?.optIn?.npmrc || (registry ? `registry=${registry}/` : null),
      optOut: OPT_OUT,
    },
    counts: {
      dark: darkCount,
      fixAvailable: fixCount,
    },
    items,
  };
}

function itemTitle(item) {
  const fix = item.fixAvailable && item.fork
    ? ` — fork available on ${item.fork.repo}${item.fork.branch ? `@${item.fork.branch}` : ''}`
    : item.light === 'dark'
      ? ' — no packaged fork yet'
      : '';
  const light = item.light === 'dark' ? 'is dark' : `light is ${item.light}`;
  return `${item.package} ${light}${fix}`;
}

function itemSummary(item) {
  const parts = [`${item.package}${item.version ? `@${item.version}` : ''}`];
  if (item.upstreamRepo) parts.push(`upstream ${item.upstreamRepo}`);
  parts.push(`light ${item.light}`);
  if (item.failingRunUrl) parts.push(`failing run ${item.failingRunUrl}`);
  if (item.since) parts.push(`dark since ${item.since}`);
  if (item.fork) parts.push(`fork ${item.fork.repo}${item.fork.branch ? `@${item.fork.branch}` : ''}`);
  if (item.install) parts.push(`install: ${item.install}`);
  if (item.note) parts.push(item.note);
  parts.push(`opt out: ${item.optOut}`);
  return parts.join('. ') + '.';
}

function itemUpdated(item, generatedAt) {
  return item.since || generatedAt;
}

function itemId(item, origin) {
  const key = `${item.package}:${item.since || item.light}:${item.rewrite || ''}`;
  if (origin) return `${origin}/feed.json#${encodeURIComponent(key)}`;
  return `tag:patch-cloud:${key}`;
}

export function feedToAtom(feed) {
  const urls = feed.feed || {};
  const self = urls.atom || '/feed.atom';
  const statusUrl = feed.statusUrl || '/status';
  const updated = xmlEscape(feed.generatedAt);
  const entries = (feed.items || [])
    .map((item) => {
      const link = item.failingRunUrl || item.fork?.branchUrl || item.fork?.url || statusUrl;
      return `  <entry>
    <title>${xmlEscape(itemTitle(item))}</title>
    <link href="${xmlEscape(link)}"/>
    <id>${xmlEscape(itemId(item, feed.publicUrl || feed.registry))}</id>
    <updated>${xmlEscape(itemUpdated(item, feed.generatedAt))}</updated>
    <summary>${xmlEscape(itemSummary(item))}</summary>
  </entry>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>patch-cloud — dark packages and available fixes</title>
  <subtitle>Opt-in npm registry feed. A dark light means the upstream project's latest CI build did not pass. Fixes are served only if you point npm at this registry.</subtitle>
  <link href="${xmlEscape(self)}" rel="self"/>
  <link href="${xmlEscape(statusUrl)}"/>
  <id>${xmlEscape(self)}</id>
  <updated>${updated}</updated>
  <generator>patch-cloud</generator>
${entries}
</feed>
`;
}

export function feedToRss(feed) {
  const urls = feed.feed || {};
  const self = urls.rss || '/feed.rss';
  const statusUrl = feed.statusUrl || '/status';
  const updated = xmlEscape(feed.generatedAt);
  const items = (feed.items || [])
    .map((item) => {
      const link = item.failingRunUrl || item.fork?.branchUrl || item.fork?.url || statusUrl;
      return `    <item>
      <title>${xmlEscape(itemTitle(item))}</title>
      <link>${xmlEscape(link)}</link>
      <guid isPermaLink="false">${xmlEscape(itemId(item, feed.publicUrl || feed.registry))}</guid>
      <pubDate>${xmlEscape(itemUpdated(item, feed.generatedAt))}</pubDate>
      <description>${xmlEscape(itemSummary(item))}</description>
    </item>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>patch-cloud — dark packages and available fixes</title>
    <link>${xmlEscape(statusUrl)}</link>
    <description>Opt-in npm registry feed. A dark light means the upstream project's latest CI build did not pass. Fixes are served only if you point npm at this registry.</description>
    <lastBuildDate>${updated}</lastBuildDate>
    <atom:link href="${xmlEscape(self)}" rel="self" type="application/rss+xml"/>
    <generator>patch-cloud</generator>
${items}
  </channel>
</rss>
`;
}

export { OPT_OUT, xmlEscape, feedUrls };
