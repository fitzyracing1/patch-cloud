#!/usr/bin/env bash
# Publish the staged @fitzyracing1/* tarballs to the public npm registry, then verify.
# Requires: `npm whoami` == an account that owns the @fitzyracing1 scope. If 2FA is on,
# pass a fresh code:  ./publish-all.sh --otp=123456   (codes expire in ~30s; re-run for the rest)
set -euo pipefail
cd "$(dirname "$0")"
REG=https://registry.npmjs.org/
who=$(npm whoami --registry $REG) || { echo "npm not logged in (run: npm login --registry $REG)"; exit 1; }
echo "publishing as $who"
for t in dist/fitzyracing1-*.tgz; do
  name=$(tar -xzOf "$t" package/package.json | node -p "JSON.parse(require('fs').readFileSync(0)).name")
  ver=$(tar -xzOf "$t" package/package.json | node -p "JSON.parse(require('fs').readFileSync(0)).version")
  if npm view "$name@$ver" version --registry $REG >/dev/null 2>&1; then echo "skip $name@$ver (already published)"; continue; fi
  npm publish "./$t" --access public --registry $REG "$@"
done
for t in dist/fitzyracing1-*.tgz; do
  name=$(tar -xzOf "$t" package/package.json | node -p "JSON.parse(require('fs').readFileSync(0)).name")
  ver=$(tar -xzOf "$t" package/package.json | node -p "JSON.parse(require('fs').readFileSync(0)).version")
  d=$(mktemp -d); (cd "$d" && npm init -y >/dev/null && npm i --no-audit --no-fund --cache "$(mktemp -d)" --registry $REG "$name@$ver" >/dev/null 2>&1 \
    && [ -f "node_modules/$name/PATCH-CLOUD.md" ] && echo "OK   $name@$ver installs from npm with PATCH-CLOUD.md" || echo "FAIL $name@$ver")
done
