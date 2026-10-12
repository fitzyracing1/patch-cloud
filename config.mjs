/**
 * Runtime config from env (with local-demo defaults).
 *
 *   PORT / PATCH_CLOUD_PORT     listen port (default 4873)
 *   HOST / PATCH_CLOUD_HOST     bind address (default 127.0.0.1; use 0.0.0.0 in containers)
 *   PUBLIC_URL                  absolute base URL for dist.tarball links (e.g. https://patch.example.com)
 *   LIGHTS_FILE                 path to lights.json (default ../greenlight-computer/lights.json if present)
 *   LIGHTS_CACHE_MINUTES        max age before re-reading / refreshing lights (default 5)
 *   LIGHTS_REFRESH              if "1", re-fetch from GitHub Actions when cache expires (needs network)
 *   GITHUB_TOKEN                optional; raises GitHub API rate limits for lights refresh
 *   RATE_LIMIT_PER_MIN          simple per-IP GET budget (default 120; 0 disables)
 *   STATUS_VERBOSE              if "1", /status and /health include internal details
 *                               (file paths, CI patch notes). Default off (public-safe).
 *   COUNTS_DIR                  dir for downloads.json (e.g. Railway volume /data); unset = in-memory
 *   COUNTS_FLUSH_MS             debounce for writing downloads.json (default 2000)
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const defaultLights = join(ROOT, '..', 'greenlight-computer', 'lights.json');
const bundledLights = join(ROOT, 'lights.json');

export const PORT = Number(process.env.PORT || process.env.PATCH_CLOUD_PORT || 4873);
export const HOST = process.env.HOST || process.env.PATCH_CLOUD_HOST || '127.0.0.1';
export const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
export const LIGHTS_FILE =
  process.env.LIGHTS_FILE ||
  (existsSync(defaultLights) ? defaultLights : bundledLights);
export const LIGHTS_CACHE_MINUTES = Number(process.env.LIGHTS_CACHE_MINUTES || 5);
export const LIGHTS_REFRESH = process.env.LIGHTS_REFRESH === '1' || process.env.LIGHTS_REFRESH === 'true';
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
export const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN ?? 120);
export const STATUS_VERBOSE = process.env.STATUS_VERBOSE === '1' || process.env.STATUS_VERBOSE === 'true';
export { ROOT };
/** Directory for downloads.json (e.g. a mounted volume at /data). Unset → in-memory counts. */
export const COUNTS_DIR = process.env.COUNTS_DIR || '';
/** Debounce for flushing counts to disk (ms). */
export const COUNTS_FLUSH_MS = Number(process.env.COUNTS_FLUSH_MS || 2000);
