#!/usr/bin/env node
/**
 * flip-light.mjs — set local/broken-demo light to dark or lit without waiting on GitHub.
 * Usage: node flip-light.mjs dark|lit
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const FILE = join(ROOT, 'local-lights.json');
const mode = (process.argv[2] || '').toLowerCase();
if (mode !== 'dark' && mode !== 'lit') {
  console.error('Usage: node flip-light.mjs dark|lit');
  process.exit(1);
}
const lit = mode === 'lit';
const data = JSON.parse(readFileSync(FILE, 'utf8'));
const now = new Date().toISOString();
data['local/broken-demo'] = {
  repo: 'local/broken-demo',
  conclusion: lit ? 'success' : 'failure',
  workflow: 'local-demo',
  url: 'file:///workspace/patch-cloud/local-lights.json',
  lit,
  runAt: now,
  fetchedAt: now,
  source: 'local-override',
};
writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
console.log(`local/broken-demo → ${lit ? '● lit (upstream)' : '○ dark (fork rewrite)'}`);
