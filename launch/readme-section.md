## Patch cloud

[patch-cloud](https://patch-cloud-production.up.railway.app/status) is an opt-in npm registry driven by the same build lights as fakegreen. It checks the latest CI run for each mapped repo on GitHub. While a repo's light is **dark** (CI failing), installs of its package get a patched fork under the same package name. While the light is **lit** (CI passing), requests go straight through to `registry.npmjs.org`.

Live status (lights, rewrite state, fork links, upstream PRs, download counts):
https://patch-cloud-production.up.railway.app/status

Opt in for one install:

```sh
npm install <pkg> --registry https://patch-cloud-production.up.railway.app
```

or for a whole project, add a line to `.npmrc`:

```ini
registry=https://patch-cloud-production.up.railway.app/
```

To opt out, remove that line (or the flag) and reinstall.

**Caveats**

- **Opt-in only.** Nothing is rewritten unless you point npm at this registry yourself. Unmapped packages, scoped ones included, are proxied unchanged. Publishing is disabled.
- **Lockfile integrity changes.** A rewritten tarball has a different `integrity` hash from the npm one, so an existing `package-lock.json` / `npm ci` won't match. Regenerate the lockfile while opted in, or stay on upstream.
- **`next` is annotated upstream for now.** Its fix only touches CI test manifests, so the `next` tarball served while the light is dark is upstream `next`, repacked with patch-cloud metadata (fork, branch, upstream PR). It runs the same as upstream.
- Only a few packages are mapped so far. The status page lists exactly which ones, and which are being rewritten right now.
