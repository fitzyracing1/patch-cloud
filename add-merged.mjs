#!/usr/bin/env node
// Add (or refresh) a merged upstream fix on the patch-cloud /status board. Uses @fitzyracing1/light-core.
//
//   node add-merged.mjs <owner/repo> <pr> --light "job name" --dark "why it was dark" --fix "what the PR changed" \
//        [--dark-since ISO] [--dark-run URL] [--lit-run URL] [--note "..."]
//   node add-merged.mjs --list
//
// Mirrors fitzyracing1/lit-dark scripts/add-merged.mjs (same flags, same merged.json entry shape).
// Fetches the PR with the light-core GitHub client (GITHUB_TOKEN; e.g. GITHUB_TOKEN=$(gh auth token)), refuses PRs that are not merged, finds (or verifies) a dark
// upstream run before the merge and the first upstream run after it, and writes the entry to
// merged.json (deduped by repo + pr). server.mjs renders it on /status ("Merged fixes"; JSON: `merged`).
// Until the after-merge run is lit, the board says "waiting for upstream light"; re-run to refresh.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGitHub, lightOfRun, LightError } from '@fitzyracing1/light-core';

const root = dirname(fileURLToPath(import.meta.url));
const dataPath = process.env.MERGED_FILE || join(root, 'merged.json');

// ---- shared with fitzyracing1/lit-dark scripts/add-merged.mjs and fitzyracing1/patch-cloud add-merged.mjs ----
export class AddMergedError extends Error {}
function die(msg) { throw new AddMergedError(msg); }

const VALUE_FLAGS = ['dark', 'note', 'fix', 'light', 'dark-since', 'dark-run', 'lit-run'];
export function parseArgs(argv) {
  const pos = []; const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--render') opts.render = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--no-detect') opts.noDetect = true;
    else if (a.startsWith('--') && VALUE_FLAGS.includes(a.slice(2))) {
      if (i + 1 >= argv.length) die(`${a} needs a value`);
      opts[a.slice(2)] = argv[++i];
    } else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('--')) die(`unknown flag ${a}`);
    else pos.push(a);
  }
  return { pos, opts };
}

/** light-core client; rate limits (403/429, retry-after, x-ratelimit-reset) are waited out or refused there. */
export function makeGitHub(options = {}) {
  const client = createGitHub({ token: process.env.GITHUB_TOKEN, userAgent: 'add-merged', ...options });
  return async (path) => {
    try {
      return await client.get('/' + path.replace(/^\//, ''));
    } catch (e) { die(`GET ${path} failed: ${e.message} (set GITHUB_TOKEN, e.g. GITHUB_TOKEN=$(gh auth token))`); }
  };
}

const iso = (s) => (s ? new Date(s).toISOString().replace(/\.\d{3}Z$/, 'Z') : null);

/** Light of a GitHub job/run (light-core: only success is lit, every other conclusion is dark).
 *  Only lit / dark / waiting leave this function; a run that hasn't completed is waiting. */
export function lightOf(status, conclusion) {
  try {
    return lightOfRun({ status, conclusion });
  } catch (e) {
    if (e instanceof LightError && (e.code === 'not-completed' || e.code === 'no-conclusion')) return 'waiting';
    throw e;
  }
}

const startedAt = (r) => r.run_started_at || r.created_at;

export function parseRunUrl(url, repo) {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)/.exec(String(url || ''));
  if (!m) die(`bad run URL "${url}" (want https://github.com/owner/repo/actions/runs/N)`);
  if (m[1].toLowerCase() !== repo.toLowerCase()) die(`run ${url} is not in ${repo}`);
  return Number(m[2]);
}

/** Facts for one workflow run, restricted to jobs whose name contains `light` (when given). */
export async function runFacts(gh, repo, id, light) {
  const r = await gh(`repos/${repo}/actions/runs/${id}`);
  const jobs = (await gh(`repos/${repo}/actions/runs/${id}/jobs?per_page=100&filter=latest`)).jobs || [];
  // No job is dropped: a skipped or cancelled job is dark.
  const picked = jobs.filter((j) => !light || j.name.includes(light))
    .map((j) => ({ name: j.name, light: lightOf(j.status, j.conclusion), url: j.html_url }));
  let state;
  if (r.status !== 'completed' || picked.some((j) => j.light === 'waiting')) state = 'waiting';
  else if (light) state = !picked.length ? 'none' : picked.every((j) => j.light === 'lit') ? 'lit' : picked.some((j) => j.light === 'dark') ? 'dark' : 'waiting';
  else state = lightOf(r.status, r.conclusion);
  return {
    id: r.id, url: r.html_url, workflow: r.name, branch: r.head_branch, headSha: r.head_sha,
    createdAt: iso(startedAt(r)), state,
    jobs: picked.map((j) => ({ name: j.name, light: j.light, url: j.url })),
  };
}

async function defaultBranch(gh, repo) { return (await gh(`repos/${repo}`)).default_branch; }

/** Last run on the default branch before the merge where the light was dark. */
export async function detectDarkRun(gh, repo, branch, mergedAt, light) {
  // Cancelled/skipped runs are dark, but the "dark before" proof should cite a real failure, so they are not cited.
  const runs = ((await gh(`repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=50&created=${encodeURIComponent('<' + mergedAt)}`)).workflow_runs || [])
    .filter((r) => r.conclusion && r.conclusion !== 'cancelled' && r.conclusion !== 'skipped');
  for (const r of runs.slice(0, 15)) {
    const f = await runFacts(gh, repo, r.id, light);
    if (f.state === 'dark') return f;
  }
  return null;
}

/** First run on the default branch after the merge that has the light; `waiting` when none has finished yet. */
export async function detectLitRun(gh, repo, branch, mergedAt, mergeSha, light) {
  const runs = ((await gh(`repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=50&created=${encodeURIComponent('>=' + mergedAt)}`)).workflow_runs || [])
    .sort((a, b) => startedAt(a).localeCompare(startedAt(b)));
  const ordered = [...runs.filter((r) => r.head_sha === mergeSha), ...runs.filter((r) => r.head_sha !== mergeSha)];
  for (const r of ordered.slice(0, 15)) {
    const f = await runFacts(gh, repo, r.id, light);
    if (f.state !== 'none') return f;
  }
  return null;
}

/** Fetch PR + before/after facts; returns the merged.json entry (prev keeps hand-written text). */
export async function buildEntry(gh, repo, pr, opts, prev = {}) {
  const p = await gh(`repos/${repo}/pulls/${pr}`);
  if (!p.merged || !p.merged_at) die(`${repo}#${pr} is not merged (state: ${p.state}); only merged fixes are listed`);
  const fullRepo = p.base?.repo?.full_name || repo;
  const mergedAt = iso(p.merged_at);
  const branch = p.base?.repo?.default_branch || await defaultBranch(gh, fullRepo);
  const light = opts.light ?? prev.light ?? '';

  let darkRun = null;
  const darkUrl = opts['dark-run'] ?? prev.darkRun?.url;
  if (darkUrl) {
    darkRun = await runFacts(gh, fullRepo, parseRunUrl(darkUrl, fullRepo), light);
    if (darkRun.createdAt > mergedAt) die(`--dark-run ${darkUrl} started after the merge`);
    if (darkRun.state !== 'dark') die(`--dark-run ${darkUrl}: ${light || 'run'} is ${darkRun.state}, not dark`);
  } else if (!opts.noDetect) darkRun = await detectDarkRun(gh, fullRepo, branch, mergedAt, light);

  let litRun = null;
  const litUrl = opts['lit-run'] ?? (prev.litRun?.state === 'lit' ? prev.litRun.url : null);
  if (litUrl) {
    litRun = await runFacts(gh, fullRepo, parseRunUrl(litUrl, fullRepo), light);
    if (litRun.createdAt < mergedAt) die(`--lit-run ${litUrl} started before the merge`);
  } else if (!opts.noDetect) litRun = await detectLitRun(gh, fullRepo, branch, mergedAt, p.merge_commit_sha, light);
  if (litRun && litRun.state !== 'lit') console.log(`note: after-merge run ${litRun.url} is ${litRun.state}; page will say "waiting for upstream light"`);
  if (!litRun) console.log('note: no finished run after the merge yet; page will say "waiting for upstream light"');

  return {
    repo: fullRepo,
    pr,
    title: p.title,
    url: p.html_url,
    mergedAt,
    mergedBy: p.merged_by?.login || '',
    branch,
    light,
    darkSince: opts['dark-since'] ?? prev.darkSince ?? '',
    darkBefore: opts.dark ?? prev.darkBefore ?? '',
    fix: opts.fix ?? prev.fix ?? '',
    darkRun,
    litRun: litRun || { state: 'waiting' },
    verifiedAt: iso(new Date()),
    note: opts.note ?? prev.note ?? '',
  };
}

export function upsert(entries, entry) {
  const key = (x) => `${String(x.repo).toLowerCase()}#${x.pr}`;
  const i = entries.findIndex((x) => key(x) === key(entry));
  if (i >= 0) entries[i] = entry; else entries.push(entry);
  entries.sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)));
  return i >= 0 ? 'updated' : 'added';
}

const USAGE = `usage: add-merged.mjs <owner/repo> <pr> [--light "job name"] [--dark "why it was dark"] [--dark-since ISO]
                      [--fix "what the PR changed"] [--dark-run URL] [--lit-run URL] [--note "..."] [--no-detect]
  --light      substring of the upstream job name that is the light (e.g. test-mysql57-s3-nfs); omit to use the whole run
  --dark-run   a dark upstream run before the merge (default: newest dark run on the default branch before mergedAt)
  --lit-run    the first upstream run after the merge (default: auto-detected; shown as "waiting for upstream light" until lit)
Re-running for the same repo#pr updates it in place (dedupe) and keeps earlier text unless new values are passed.`;
// ---- end shared ----

function loadData() {
  if (!existsSync(dataPath)) return [];
  const d = JSON.parse(readFileSync(dataPath, 'utf8'));
  if (!Array.isArray(d)) die('merged.json must be an array');
  return d;
}

async function main() {
  const { pos, opts } = parseArgs(process.argv.slice(2));
  if (opts.help || (!opts.list && pos.length !== 2)) { console.error(USAGE.replace('add-merged.mjs', 'node add-merged.mjs') + '\n       node add-merged.mjs --list'); process.exit(opts.help ? 0 : 2); }

  const entries = loadData();
  if (opts.list) {
    for (const e of entries) console.log(`${e.repo}#${e.pr}  merged ${e.mergedAt} by ${e.mergedBy}  after: ${e.litRun?.state || 'waiting'}  ${e.title}`);
    return;
  }

  const repo = pos[0].replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) die(`bad repo "${pos[0]}" (want owner/repo)`);
  const pr = Number(String(pos[1]).replace(/^#/, ''));
  if (!Number.isInteger(pr) || pr <= 0) die(`bad PR number "${pos[1]}"`);

  const prev = entries.find((x) => `${x.repo}#${x.pr}`.toLowerCase() === `${repo}#${pr}`.toLowerCase()) || {};
  const entry = await buildEntry(makeGitHub(), repo, pr, opts, prev);
  const how = upsert(entries, entry);
  writeFileSync(dataPath, JSON.stringify(entries, null, 2) + '\n');
  console.log(`${how} ${entry.repo}#${pr} — ${entry.title} (merged ${entry.mergedAt} by ${entry.mergedBy})`);
  console.log(`  before: ${entry.darkRun ? `${entry.darkRun.state} ${entry.darkRun.url}` : 'no dark run found (pass --dark-run)'}`);
  console.log(`  after:  ${entry.litRun.url ? `${entry.litRun.state} ${entry.litRun.url}` : 'waiting for upstream light'}`);
  for (const [k, f] of [['darkBefore', '--dark'], ['fix', '--fix'], ['light', '--light']]) if (!entry[k]) console.log(`tip: pass ${f} to fill in ${k}`);
  console.log(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} in merged.json; deploy to show them on /status`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`add-merged: ${e instanceof AddMergedError ? e.message : e.stack || e}`);
    process.exit(1);
  });
}
