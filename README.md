# patch-cloud

Opt-in npm-compatible registry that **rewrites broken dependencies to your fork** when the [light computer](https://github.com/fitzyracing1/light-computer) internet lights say CI is dark.

**Live status:** https://patch-cloud-production.up.railway.app/status

Opt in to the live registry for one install:

```bash
npm install <pkg> --registry https://patch-cloud-production.up.railway.app
```

or for a whole project, add `registry=https://patch-cloud-production.up.railway.app/` to `.npmrc`. Remove it to opt out.

Not committed here: the ~44 MB annotated `next` tarball (rebuild with `npm run pack:next`) and `local-lights.json` (copy `local-lights.example.json` to force the demo light dark).

Nothing is published to the public npm registry by this project. Fork / annotated tarballs live under `tarballs/`.

## Idea

1. The light computer fetches CI status for public repos into `lights.json` (● lit = upstream build passing, ○ dark = upstream build failing; active-low). The registry tracks the light computer's 8 repos **plus every GitHub repo in `mapping.json`**, refreshed live.
2. You point `npm install` at this registry (explicit `--registry` or project `.npmrc`).
3. For a mapped package whose light is **dark** and `rewriteReady`, the registry serves **your fork / annotated tarball** under the **same package name**.
4. When the light is **lit**, it serves local upstream (demo) or **proxies** to `registry.npmjs.org` — unless the package carries the labeled **`manual: fix available`** switch (below).
5. Only the fork's version is replaced: the rest of the upstream packument (other versions, dist-tags) is merged in, so ranges like `ms@2.0.0` or `ajv@^8` keep resolving to upstream.
6. Unmapped packages (including scoped `@scope/name`) are always proxied.

## Opt in (one-liner)

```bash
npm install <pkg> --registry http://127.0.0.1:4873
```

Or a project `.npmrc`:

```
registry=http://127.0.0.1:4873/
```

After you pick a host, replace with `https://<your-host>/`. See [DEPLOY.md](./DEPLOY.md).

### Safety

- **Opt-in only** — never the default registry.
- Only packages in `mapping.json` with `rewriteReady: true` are rewritten, and only while their light is dark.
- Registry is **read-only** (PUT/POST/DELETE → 405).
- Check [`/status`](http://127.0.0.1:4873/status) or open [`/`](http://127.0.0.1:4873/) for the landing page.
- **Opt out:** remove the `registry=` override and reinstall from `registry.npmjs.org`.
- **Lockfiles:** rewritten tarballs have different `integrity` hashes. Existing `package-lock.json` / `npm ci` will fail until you regenerate the lock while opted in (or opt out and use upstream).

## Quick start (local)

```bash
# Terminal 1
node server.mjs
# or: npm start

curl -s http://127.0.0.1:4873/health
open http://127.0.0.1:4873/          # landing
curl -s http://127.0.0.1:4873/status | jq .
```

### Demo: `broken-demo`

```bash
node flip-light.mjs dark
npm install broken-demo --registry http://127.0.0.1:4873
node -e "console.log(require('broken-demo'))"   # fork

node flip-light.mjs lit
rm -rf node_modules/broken-demo package-lock.json
npm install broken-demo --registry http://127.0.0.1:4873
# upstream throws on require
```

### Annotated `next` (CI-only fork)

The Next.js patch ([PR #100001](https://github.com/vercel/next.js/pull/100001), branch `rspack-manifest-fix`) changes **test manifests only**. A rebuilt `next` would match upstream runtime for the same version, so we **do not** build the monorepo.

Instead, when `vercel/next.js` is dark, patch-cloud serves an **annotated upstream** `next@16.4.0` tarball:

- `PATCH-CLOUD.md` inside the package
- `package.json#_patchCloud` → `{ fork, branch, pr, … }`

When the light is lit, requests for `next` are proxied to the public registry.

```bash
npm install next --registry http://127.0.0.1:4873
# then: ls node_modules/next/PATCH-CLOUD.md
```

Repack / refresh the annotated tarball:

```bash
node pack-annotated.mjs next \
  --fork fitzyracing1/next.js \
  --branch rspack-manifest-fix \
  --pr https://github.com/vercel/next.js/pull/100001 \
  --version 16.4.0
```

## Mapping (npm rewrite targets)

| Light repo | npm name | Rewrite |
|---|---|---|
| `local/broken-demo` | `broken-demo` | dark→fork, lit→local upstream |
| `vercel/next.js` | `next` | dark→annotated upstream tarball, lit→proxy |
| `react/react` | `react` | dark→annotated upstream react@19.3.0 (fork `fitzyracing1/react`, no code changes yet), lit→proxy |
| `ZJONSSON/node-unzipper` | `unzipper@0.12.5` | dark→[fork](https://github.com/fitzyracing1/node-unzipper/tree/patch-cloud): PR [#331](https://github.com/ZJONSSON/node-unzipper/pull/331), `@aws-sdk/client-s3` moved to dependencies |
| `jimp-dev/jimp` | `jimp@1.6.1` | dark→[fork](https://github.com/fitzyracing1/jimp/tree/patch-cloud): real browser bundle instead of the published stub ([#1402](https://github.com/jimp-dev/jimp/issues/1402)) |
| `vercel/ms` | `ms@2.1.3` | dark→[fork](https://github.com/fitzyracing1/ms/tree/patch-cloud): format/parse round-trip (port of [#299](https://github.com/vercel/ms/pull/299)) + `decimal` option ([#125](https://github.com/vercel/ms/pull/125)) |
| `prebuild/prebuild-install` | `prebuild-install@7.1.3` | dark→[fork](https://github.com/fitzyracing1/prebuild-install/tree/patch-cloud): `tar-fs ^2.1.4` (CVE-2025-59343, PR [#214](https://github.com/prebuild/prebuild-install/pull/214)) |
| `cli-table/cli-table3` | `cli-table3@0.6.5` | dark→[fork](https://github.com/fitzyracing1/cli-table3/tree/patch-cloud): rowSpan crash fix (PR [#359](https://github.com/cli-table/cli-table3/pull/359)) |
| `iamkun/dayjs` | `dayjs@1.11.23` | light **lit** → served via **manual: fix available** ([fork](https://github.com/fitzyracing1/dayjs/tree/patch-cloud): tz perf, port of PR [#2019](https://github.com/iamkun/dayjs/pull/2019)) |
| `ajv-validator/ajv` | `ajv` | **not rewritten** (`rewriteReady: false`): PR [#2591](https://github.com/ajv-validator/ajv/pull/2591)'s ReDoS could not be reproduced; corrected branch on the [fork](https://github.com/fitzyracing1/ajv/tree/patch-cloud) for review |
| deno / node / vscode / rust / cpython / fakegreen | — | not npm rewrite targets (see `ciPatch` on some) |

Each fork tarball keeps the upstream package name and version and adds `PATCH-CLOUD.md` plus `package.json#_patchCloud` describing exactly what changed. Built with `node annotate-fork.mjs <checkout> fork-specs/<pkg>.json` then `npm pack`. Focused repros live in `repros/`.

### Manual switch: `manual: fix available` ([#1](https://github.com/fitzyracing1/patch-cloud/issues/1))

Some fixes are real but CI can't see them (e.g. a performance bug). Faking a dark light would be dishonest, so a mapping entry can carry a clearly labeled override instead:

```json
"iamkun/dayjs": {
  "npmName": "dayjs", "version": "1.11.23", "rewriteReady": true,
  "forkTarball": "tarballs/dayjs-1.11.23.tgz",
  "manualRewrite": { "reason": "Upstream CI is green but the perf fix (PR #2019) is unmerged", "since": "2026-10-11" }
}
```

- Serves the fork while the light is **lit**; the light keeps its real CI conclusion and is never changed.
- Needs `rewriteReady: true` and a `reason`. If the light goes dark, the normal dark rewrite applies.
- `/status` shows `rewrite: "manual"`, a `manual` object (`label: "manual: fix available"`, reason, since) and counts it separately (`counts.manual`); HTML shows *Fork available (manual: fix waiting upstream)*.
- Responses carry `X-Patch-Cloud: manual` and `_patchCloud.source: "manual"`; tarballs are counted under `downloads.manual`, not `fork`.

### Status wording

The primary label says what an installer gets; the upstream CI result is a small secondary line linking to the run:

| Situation | Primary label | Secondary |
|---|---|---|
| light dark + fork packaged | **Fork available — download via patch-cloud** | upstream build: failing |
| manual switch | **Fork available (manual: fix waiting upstream)** | upstream build: passing |
| light dark, no fork | Upstream build failing — no fork yet | upstream build: failing |
| light lit | Upstream OK — normal npm | upstream build: passing |

## Config (env)

| Env | Default | Purpose |
|---|---|---|
| `PORT` / `PATCH_CLOUD_PORT` | `4873` | Listen port |
| `HOST` / `PATCH_CLOUD_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` in Docker) |
| `PUBLIC_URL` | _(empty)_ | Absolute base for `dist.tarball` URLs |
| `LIGHTS_FILE` | greenlight or `./lights.json` | Lights snapshot |
| `LIGHTS_CACHE_MINUTES` | `5` | Cache TTL |
| `LIGHTS_REFRESH` | off | `1` = refresh from GitHub when cache expires |
| `GITHUB_TOKEN` | — | Optional for API rate limits (recommended: 15 repos are tracked) |
| `LIGHTS_REFRESH_MINUTES` | cache minutes with token, `20` without | Min interval between GitHub lights refreshes; failed fetches keep the last known light |
| `UPSTREAM_REFRESH_MINUTES` | `10` with token, `60` without | Min interval between upstream PR/issue state checks |
| `PACKUMENT_CACHE_MINUTES` | `5` | Cache for upstream packuments merged into rewrites |
| `RATE_LIMIT_PER_MIN` | `120` | Per-IP; `0` = off |

## Tests

```bash
node test-server.mjs
```

Starts the server on a random port and checks dark/lit rewrite, proxy (incl. scoped), PUT rejection, every patch-cloud target (fork version merged into the upstream packument, deps from the fork tarball, PATCH-CLOUD.md), the manual switch, and the status wording.

## Deploy

Live on Railway: https://patch-cloud-production.up.railway.app (`railway up` from this directory; `.railwayignore` keeps fork checkouts out of the upload). See [DEPLOY.md](./DEPLOY.md) for other hosts.

## Ethics

Silently replacing popular packages in a production registry that people hit by accident would be wrong. This tool is opt-in, read-only, and documents every rewrite on `/` and `/status`.

## Files

| Path | Role |
|---|---|
| `server.mjs` | Registry (no npm deps) |
| `config.mjs` | Env-driven config |
| `mapping.json` | lightRepo → npm / tarballs / ciPatch / manualRewrite |
| `annotate-fork.mjs` | Adds `PATCH-CLOUD.md` + `_patchCloud` to a fork checkout before `npm pack` |
| `fork-specs/` | Per-package change/verification descriptions used for PATCH-CLOUD.md |
| `repros/` | Focused repros run against installed copies (unzipper, ms, cli-table3, dayjs, jimp, prebuild-install, ajv) |
| `pack-annotated.mjs` | Download upstream + annotate + repack |
| `test-server.mjs` | Integration tests |
| `Dockerfile` | Container image |
| `DEPLOY.md` | Host options (no accounts created) |
| `tarballs/` | Served `.tgz` files |
| `lights.json` | Bundled snapshot for deploy |
