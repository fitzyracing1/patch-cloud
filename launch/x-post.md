# X post (draft — not posted)

## Single post

(Under 280 by X's count, which treats each link as 23 chars. Under 280 raw characters too.)

```
patch-cloud: an npm registry that watches real CI build lights on GitHub. If a package's build goes red, it serves a patched fork.

Opt-in, one flag:
npm i <pkg> --registry https://patch-cloud-production.up.railway.app

https://patch-cloud-production.up.railway.app/status
```

## Optional thread (3 posts)

1/
```
I built patch-cloud, a small npm registry that watches real CI build lights on GitHub. When a package's build goes red, it serves a patched fork under the same name. When it's green, it passes through to registry.npmjs.org.
```

2/
```
It's opt-in only. Nothing changes unless you point npm at it:

npm i <pkg> --registry https://patch-cloud-production.up.railway.app

Unmapped packages are proxied unchanged, and publish is disabled.
```

3/
```
Caveats: only a few packages are mapped so far, and the next.js "fork" is upstream repacked with patch notes. Swapped tarballs also change lockfile integrity hashes.

Lights, forks and upstream PRs are all on the status page:
https://patch-cloud-production.up.railway.app/status
```
