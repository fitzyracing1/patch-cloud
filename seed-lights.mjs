#!/usr/bin/env node
// One-shot: refresh ./lights.json (bundled for deploy) with dark-streak fields.
// Uses the same fetchOneLight as the server; keeps the previous entry on error.
import { readFileSync, writeFileSync } from 'node:fs';
import { fetchOneLight, lightRepos } from './server.mjs';
const prev = new Map(JSON.parse(readFileSync('lights.json', 'utf8')).map((l) => [l.repo, l]));
const out = [];
for (const repo of lightRepos()) {
  try { out.push(await fetchOneLight(repo)); } catch (e) { console.warn(e.message); if (prev.has(repo)) out.push(prev.get(repo)); }
}
writeFileSync('lights.json', JSON.stringify(out, null, 2) + '\n');
for (const l of out) console.log(l.lit ? '●' : '○', l.repo, l.conclusion, l.darkSince || '', l.darkRuns ?? '', l.darkSinceCapped ? 'capped' : '');
