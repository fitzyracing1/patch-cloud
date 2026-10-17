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
 *   LIGHTS_REFRESH_MINUTES      min interval between GitHub lights refreshes (default: cache
 *                               minutes with GITHUB_TOKEN, 20 without — stays under 60 req/h)
 *   UPSTREAM_REFRESH_MINUTES    min interval between upstream PR/issue state checks
 *                               (default 10 with GITHUB_TOKEN, 60 without)
 *   PACKUMENT_CACHE_MINUTES     cache for upstream packuments merged into rewrites (default 5)
 *   DOWN_AFTER                  consecutive dark readings before a light counts as down (default 3)
 *   REWRITE_ON                  'down' (default): rewrite to the fork only when down;
 *                               'dark': previous behavior, rewrite on the first dark reading
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
/** Min minutes between GitHub Actions lights refreshes (unauthenticated API = 60 req/h/IP). */
export const LIGHTS_REFRESH_MINUTES = Number(process.env.LIGHTS_REFRESH_MINUTES || (GITHUB_TOKEN ? LIGHTS_CACHE_MINUTES : 20));
/** Min minutes between upstream PR/issue state checks. */
export const UPSTREAM_REFRESH_MINUTES = Number(process.env.UPSTREAM_REFRESH_MINUTES || (GITHUB_TOKEN ? 10 : 60));
/** Cache for upstream packuments that rewrites are merged into. */
export const PACKUMENT_CACHE_MINUTES = Number(process.env.PACKUMENT_CACHE_MINUTES || 5);
/** Consecutive dark readings (dark streak) at which a light is 'down'. */
export const DOWN_AFTER = Math.max(1, Math.floor(Number(process.env.DOWN_AFTER || 3)) || 3);
/** What gates the fork rewrite: 'down' (default) or 'dark' (previous behavior). */
export const REWRITE_ON = String(process.env.REWRITE_ON || 'down').toLowerCase() === 'dark' ? 'dark' : 'down';
