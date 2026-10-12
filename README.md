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

1. The light computer fetches CI status for public repos into `lights.json` (● lit = success, ○ dark = failure; active-low).
2. You point `npm install` at this registry (explicit `--registry` or project `.npmrc`).
3. For a mapped package whose light is **dark** and `rewriteReady`, the registry serves **your fork / annotated tarball** under the **same package name**.
4. When the light is **lit**, it serves local upstream (demo) or **proxies** to `registry.npmjs.org`.
5. Unmapped packages (including scoped `@scope/name`) are always proxied.

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
| deno / node / vscode / rust / cpython / fakegreen | — | not npm rewrite targets (see `ciPatch` on some) |

## Config (env)

| Env | Default | Purpose |
|---|---|---|
| `PORT` / `PATCH_CLOUD_PORT` | `4873` | Listen port |
| `HOST` / `PATCH_CLOUD_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` in Docker) |
| `PUBLIC_URL` | _(empty)_ | Absolute base for `dist.tarball` URLs |
| `LIGHTS_FILE` | greenlight or `./lights.json` | Lights snapshot |
| `LIGHTS_CACHE_MINUTES` | `5` | Cache TTL |
| `LIGHTS_REFRESH` | off | `1` = refresh from GitHub when cache expires |
| `GITHUB_TOKEN` | — | Optional for API rate limits |
| `RATE_LIMIT_PER_MIN` | `120` | Per-IP; `0` = off |

## Tests

```bash
node test-server.mjs
```

Starts the server on a random port and checks dark/lit rewrite, proxy (incl. scoped), and PUT rejection.

## Deploy

Prepared but **not deployed**. See [DEPLOY.md](./DEPLOY.md) for Render / Railway / Fly.io current free-tier facts and steps. Joshua chooses the host.

## Ethics

Silently replacing popular packages in a production registry that people hit by accident would be wrong. This tool is opt-in, read-only, and documents every rewrite on `/` and `/status`.

## Files

| Path | Role |
|---|---|
| `server.mjs` | Registry (no npm deps) |
| `config.mjs` | Env-driven config |
| `mapping.json` | lightRepo → npm / tarballs / ciPatch |
| `pack-annotated.mjs` | Download upstream + annotate + repack |
| `test-server.mjs` | Integration tests |
| `Dockerfile` | Container image |
| `DEPLOY.md` | Host options (no accounts created) |
| `tarballs/` | Served `.tgz` files |
| `lights.json` | Bundled snapshot for deploy |
