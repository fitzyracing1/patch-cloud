#!/usr/bin/env node
/**
 * Read-only: query GitHub (via `gh`, authed as fitzyracing1) for posted
 * PR/issue state. Never posts, comments, pushes, or opens anything.
 *
 * Usage:
 *   node check-upstream.mjs          # print JSON, write upstream-status.json
 *   node check-upstream.mjs --quiet  # write file only
 *
 * Mapping entries with ciPatch.upstreamUrl are checked:
 *   /pull/N  → repos/{owner}/{repo}/pulls/{N}  (state + merged)
 *   /issues/N → repos/{owner}/{repo}/issues/{N} (state)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAPPING = join(ROOT, 'mapping.json');
const OUT = join(ROOT, 'upstream-status.json');

function parseUpstream(url) {
  if (!url) return null;
  // strip fragment
  const bare = url.split('#')[0];
  let m = bare.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (m) return { kind: 'pull', owner: m[1], repo: m[2], number: Number(m[3]), url: bare };
  m = bare.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (m) return { kind: 'issue', owner: m[1], repo: m[2], number: Number(m[3]), url: bare };
  return null;
}

function ghJson(path) {
  const out = execFileSync('gh', ['api', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  });
  return JSON.parse(out);
}

function checkOne(parsed) {
  if (parsed.kind === 'pull') {
    const data = ghJson(`/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`);
    const merged = !!data.merged;
    const state = merged ? 'merged' : data.state; // open | closed | merged
    return {
      kind: 'pull',
      number: parsed.number,
      state,
      merged,
      title: data.title,
      html_url: data.html_url,
      updated_at: data.updated_at,
    };
  }
  const data = ghJson(`/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`);
  // issues API also returns PRs; prefer pull_request presence
  if (data.pull_request) {
    const pr = ghJson(`/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`);
    const merged = !!pr.merged;
    return {
      kind: 'pull',
      number: parsed.number,
      state: merged ? 'merged' : pr.state,
      merged,
      title: pr.title,
      html_url: pr.html_url,
      updated_at: pr.updated_at,
    };
  }
  return {
    kind: 'issue',
    number: parsed.number,
    state: data.state, // open | closed
    merged: false,
    title: data.title,
    html_url: data.html_url,
    updated_at: data.updated_at,
  };
}

export function checkUpstream() {
  const mapping = JSON.parse(readFileSync(MAPPING, 'utf8'));
  const checkedAt = new Date().toISOString();
  const results = {};
  for (const [repo, m] of Object.entries(mapping)) {
    const url = m.ciPatch?.upstreamUrl;
    const parsed = parseUpstream(url);
    if (!parsed) continue;
    try {
      const info = checkOne(parsed);
      results[repo] = {
        upstreamUrl: url,
        ...info,
        checkedAt,
        error: null,
      };
    } catch (e) {
      results[repo] = {
        upstreamUrl: url,
        kind: parsed.kind,
        number: parsed.number,
        state: 'unknown',
        merged: false,
        checkedAt,
        error: String(e.stderr || e.message || e),
      };
    }
  }
  const payload = { checkedAt, results };
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
  return payload;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const quiet = process.argv.includes('--quiet');
  const payload = checkUpstream();
  if (!quiet) {
    console.log(JSON.stringify(payload, null, 2));
    for (const [repo, r] of Object.entries(payload.results)) {
      console.error(`${repo}: ${r.state}${r.merged ? ' (merged)' : ''}${r.error ? ' ERROR ' + r.error : ''} → ${r.upstreamUrl}`);
    }
  }
}
