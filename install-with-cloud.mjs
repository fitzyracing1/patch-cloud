#!/usr/bin/env node
/**
 * install-with-cloud.mjs — npm install <pkg> against the local patch-cloud registry.
 * Usage: node install-with-cloud.mjs <pkg> [npm-install-args...]
 */
import { spawnSync } from 'node:child_process';
import { PORT, HOST } from './config.mjs';

const pkg = process.argv[2];
if (!pkg) {
  console.error('Usage: node install-with-cloud.mjs <package> [extra npm args...]');
  process.exit(1);
}
const registry = `http://${HOST}:${PORT}`;
const extra = process.argv.slice(3);
const args = ['install', pkg, `--registry=${registry}`, '--prefer-online', ...extra];
console.log(`> npm ${args.join(' ')}`);
const r = spawnSync('npm', args, { stdio: 'inherit', env: { ...process.env, npm_config_registry: registry } });
process.exit(r.status ?? 1);
