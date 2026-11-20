# pnpm-plugin-patch-cloud

An opt-in [pnpm config dependency](https://pnpm.io/config-dependencies) for [patch-cloud](https://patch-cloud-production.up.railway.app/status).
When a dependency's upstream CI light is **dark** and patch-cloud has a fork ready for it, pnpm installs the fork. Packages whose light is **lit** are left alone.

## Opt in (one line)

```bash
pnpm add --config pnpm-plugin-patch-cloud
```

This adds the plugin to `configDependencies` in `pnpm-workspace.yaml`, and pnpm loads it on every install after that. Requires pnpm 10.13 or newer, since older pnpm doesn't auto-load `pnpm-plugin-*` config dependencies. pnpm 11.1 or newer is recommended (see [How it points at the fork](#how-it-points-at-the-fork)).

To opt out, run `pnpm remove --config pnpm-plugin-patch-cloud` (or delete the entry from `pnpm-workspace.yaml`). To turn it off for one install, run `PATCH_CLOUD_DISABLE=1 pnpm install`.

> Not on npm yet. Until it's published, the line above only works against a registry that has the package (the end-to-end test uses a local one).

## Why: saves compute on reruns against dark deps

When an upstream dependency's CI is dark, projects that depend on it keep re-running their own CI. The same break comes back on every run until upstream merges a fix. patch-cloud keeps forks with that fix. This plugin lets a project opt in to the fork while the light is dark, so it doesn't spend reruns on a break it can't fix itself.

The plugin doesn't estimate how much compute that saves. It records what it actually swapped (see [Compute-saved record](#compute-saved-record)) so you can count it yourself.

## What it does

1. Once per install, it fetches `GET <PATCH_CLOUD_URL>/status?format=json`, with a short timeout (3 s by default).
2. A package is served from the fork only when its light is `dark` **and** patch-cloud marks it rewrite-ready (`rewrite: "active"`), or when patch-cloud's labeled manual switch is serving it now (`manual.servingNow: true`).
3. pnpm's `readPackage` hook rewrites matching entries in `dependencies`, `optionalDependencies` and `devDependencies` of every manifest, direct and transitive. An entry is only rewritten when its range allows the fork's version (for example `^2.0.0` allows fork `2.1.3`, `^1` doesn't). Tags (`latest`), `npm:` aliases, git, file, URL, `workspace:` and `catalog:` specs are never touched, and neither are `peerDependencies`.
4. It never fails the install. If the feed is unreachable, slow or returns an error, nothing changes and one line is logged:
   `patch-cloud: status feed <url> unreachable (<reason>); installing unchanged.`

### How it points at the fork

| pnpm | Rewritten spec | Notes |
|---|---|---|
| 11.1 or newer | `patch-cloud:<name>@<version>` | A [named registry](https://pnpm.io/settings/dependency-resolution) added by the plugin's `updateConfig` hook. It's a registry source, so pnpm's `blockExoticSubdeps` (on by default in newer pnpm) still allows it for transitive deps. |
| 10.13 to 11.0 | `<PATCH_CLOUD_URL>/<name>/-/<name>-<version>.tgz` | A direct tarball URL. If `blockExoticSubdeps` is on, pnpm would reject these, so the plugin changes nothing and logs one line. |

Set `PATCH_CLOUD_MODE=registry` or `PATCH_CLOUD_MODE=tarball` to force a mode.

Known limit on pnpm 10: if the fork tarball was already in the store from another project, pnpm 10 can lock it without an `integrity` field, and `--frozen-lockfile` then refuses it (`ERR_PNPM_MISSING_TARBALL_INTEGRITY`). pnpm 11.1 or newer doesn't hit this.

### Lockfile and CI

Lights change, but lockfiles shouldn't break because of that.

- **In CI** (when `CI` is set) **or with `--frozen-lockfile`** (where pnpm exposes it), the policy is **`keep`**. Any dependency already in `pnpm-lock.yaml` stays exactly as locked, whether that's a fork pin or upstream. Frozen installs keep working when a light turns lit or dark, and new dependencies still follow the lights.
- **Locally**, the policy is **follow the lights**. When you re-resolve (`pnpm install`, `pnpm update <pkg>`), dark rewrite-ready packages switch to the fork and lit ones switch back to upstream. Commit the lockfile and CI picks it up.
- Override it with `PATCH_CLOUD_LOCKFILE=keep` or `PATCH_CLOUD_LOCKFILE=follow`.

pnpm 12 doesn't tell hooks about `--frozen-lockfile`, so outside CI set `PATCH_CLOUD_LOCKFILE=keep` for frozen installs.

## Compute-saved record

Each time the plugin installs a package from a fork, it appends one JSON line to `node_modules/.patch-cloud/swaps.ndjson`:

```json
{"ts":"2026-11-20T00:55:02.114Z","package":"ms","version":"2.1.3","light":"dark","reason":"dark","requested":"^2.0.0","fork":"patch-cloud:ms@2.1.3","repo":"vercel/ms","lightRun":"https://github.com/vercel/ms/actions/runs/..."}
```

`reason` is `dark` (light dark, fork ready), `manual` (patch-cloud's manual switch) or `lockfile` (kept from `pnpm-lock.yaml` under the keep policy). After resolution it also prints one summary line:
`patch-cloud: N package(s) installed from patch-cloud forks this install: ms@2.1.3, ...`

Set `PATCH_CLOUD_RECORD=off` to turn the record off, or `PATCH_CLOUD_RECORD=/path/file.ndjson` to write it somewhere else. The record stays on your machine.

### Anonymous ping (off, not implemented yet)

`PATCH_CLOUD_PING=1` is reserved for an opt-in anonymous count (package, version, light state, no personal data) sent to patch-cloud. patch-cloud has no endpoint for it today, so **nothing is ever sent**. With the variable set, the plugin logs that nothing was sent.

TODO: add a POST endpoint to patch-cloud (separate change and deploy), then send `{package, version, light, ts}` only when `PATCH_CLOUD_PING=1`.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PATCH_CLOUD_URL` | `https://patch-cloud-production.up.railway.app` | patch-cloud base URL (status feed and fork registry) |
| `PATCH_CLOUD_DISABLE` | off | `1` turns the plugin off for this install |
| `PATCH_CLOUD_TIMEOUT_MS` | `3000` | Status feed timeout |
| `PATCH_CLOUD_MODE` | `auto` | `registry` or `tarball` (see above) |
| `PATCH_CLOUD_LOCKFILE` | `keep` in CI, else follow | `keep` or `follow` |
| `PATCH_CLOUD_RECORD` | `node_modules/.patch-cloud/swaps.ndjson` | `off` or a file path |
| `PATCH_CLOUD_PING` | off | Reserved; nothing is sent (no endpoint yet) |
| `PATCH_CLOUD_QUIET` | off | `1` silences the plugin's log lines |

## Tests

```bash
npm test                                  # unit + end-to-end (real pnpm, local mock registry + mock patch-cloud)
PNPM_BINS="pnpm,/path/to/pnpm12" npm test # run the end-to-end suite against several pnpm binaries
npm run test:live                         # optional: reads the live status feed only (no tarball downloads)
```

The end-to-end test packs this plugin and installs it with `pnpm add --config` from a local registry, then runs `pnpm install` on a project with a dark package, a lit package, and a package that depends on the dark one. It checks:

- the dark package, direct and transitive, comes from the fork, and the lit package doesn't;
- the lockfile pins the fork, and a record line is written;
- an unreachable feed changes nothing;
- `PATCH_CLOUD_DISABLE=1` changes nothing;
- a CI frozen install keeps the locked fork after the light turns lit;
- a frozen install stays upstream after the light turns dark;
- a local re-resolve follows the lights.

## License

MIT, Copyright (c) 2026 Joshua Almeida
