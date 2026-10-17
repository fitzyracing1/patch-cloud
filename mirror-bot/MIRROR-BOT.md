# mirror bot (prototype, branch try/mirror-bot)

A requesting bot asks for an npm package to be downloaded on a machine. The mirror bot on
that machine checks the request and gives an okay or a refuse. The download starts only after an okay.

Lit/dark (active-low): **lit = 0 = okay**, **dark = 1 = everything else**. Unknown is dark.

## Flow
1. Requesting bot writes a request into `$MIRROR_BOT_HOME/queue/*.json`:
   `{ "package", "version" (exact x.y.z), "requester", "nonce", "createdAt", "sig" }`.
   `sig` = HMAC-SHA256 over the sorted JSON (minus `sig`) with `MIRROR_BOT_SECRET`
   (`node mirror-bot/mirror-bot.mjs sign <file>` does this).
2. Mirror bot (`node mirror-bot/mirror-bot.mjs run`) checks, in order. Any miss = refuse (dark 1):
   - shape: exact version only (no ranges, tags, URLs)
   - requester is on `allowlist.json`
   - HMAC signature is valid; request is under 15 min old; nonce not seen before (replay)
   - package@version exists on the registry with a sha512 `dist.integrity`
   - package light is lit: patch cloud `/status` first, else the latest completed GitHub Actions
     run on the repo's default branch (`success` = lit, all else dark), else unknown = dark
3. On okay it writes a signed okay record to `$MIRROR_BOT_HOME/okays/<id>.json`
   (exact package@version, integrity, light, expires in 10 min, single use).
4. Downloader reads the okay back, re-checks signature / expiry / not used, marks it used, then runs
   `npm pack <name>@<version> --ignore-scripts` into `$MIRROR_BOT_DOWNLOADS` (a scratch folder with
   no package.json). It hashes the tarball and compares with the okay's `dist.integrity`; a
   mismatch deletes the tarball and is dark.
5. Every okay/refuse goes to `$MIRROR_BOT_HOME/log.jsonl` with its light word and bit.
   The run's exit code is 0 (lit) only if every request was okayed and downloaded, else 1 (dark).

## Scope
One okay = one download of one exact package@version. No installs, no global installs, no package
scripts, no standing control. The secret comes from env only and is never printed or logged.

## Env
`MIRROR_BOT_SECRET` (required), `MIRROR_BOT_HOME` (default /workspace/mirror-bot-state),
`MIRROR_BOT_DOWNLOADS` (default /workspace/mirror-bot-downloads), `MIRROR_BOT_ALLOWLIST`,
`MIRROR_BOT_REGISTRY` (default https://registry.npmjs.org), `PATCH_CLOUD_STATUS`, `GITHUB_TOKEN` (optional).

## Tests
`node --test mirror-bot/mirror-bot.test.mjs` (offline: fake registry, patch cloud, GitHub, npm pack).
