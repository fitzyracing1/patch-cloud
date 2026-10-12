#!/usr/bin/env bash
# Focused repro for prebuild-install#213 / PR #214 (tar-fs CVE-2025-59343, GHSA-vj76-c3g6-qr5v).
# usage: prebuild-install-audit.sh <install-spec-for-prebuild-install> [extra npm args...]
#   e.g. prebuild-install-audit.sh prebuild-install@7.1.3                       (upstream)
#        prebuild-install-audit.sh prebuild-install@7.1.3 --registry https://patch-cloud-production.up.railway.app/
# Simulates a project whose lockfile already holds a vulnerable tar-fs (2.1.1) under prebuild-install,
# then (re)installs prebuild-install and checks npm audit for the advisory.
set -uo pipefail
SPEC="$1"; shift
D=$(mktemp -d); cd "$D"
npm init -y >/dev/null
npm i --no-audit --no-fund --registry https://registry.npmjs.org/ prebuild-install@7.1.3 tar-fs@2.1.1 >/dev/null 2>&1
npm pkg delete dependencies.tar-fs >/dev/null
npm i --no-audit --no-fund --registry https://registry.npmjs.org/ >/dev/null 2>&1
echo "before: tar-fs $(node -p "require('./node_modules/tar-fs/package.json').version") (stale lockfile)"
npm i --no-audit --no-fund "$SPEC" "$@" >/dev/null 2>&1
PJ=$(node -p "const p=require('./node_modules/prebuild-install/package.json'); p.version+' tar-fs range '+p.dependencies['tar-fs']+(p._patchCloud?' (patch-cloud build)':' (upstream)')")
TF=$(node -p "try{require('./node_modules/prebuild-install/node_modules/tar-fs/package.json').version}catch{require('./node_modules/tar-fs/package.json').version}")
echo "after: prebuild-install $PJ; tar-fs used: $TF"
AUDIT=$(npm audit --json --registry https://registry.npmjs.org/ 2>/dev/null)
if printf '%s' "$AUDIT" | grep -q 'GHSA-vj76-c3g6-qr5v'; then echo "FAIL npm audit reports GHSA-vj76-c3g6-qr5v"; R=1; else echo "PASS npm audit: no GHSA-vj76-c3g6-qr5v"; R=0; fi
rm -rf "$D"; exit $R
