#!/usr/bin/env bash
# Run AFTER `railway whoami` succeeds. Deploys patch-cloud from local files (no GitHub push).
set -euo pipefail
cd /workspace/patch-cloud
railway whoami
railway init --name patch-cloud
railway up --detach --service patch-cloud 2>/dev/null || railway up --detach   # first up creates the service
SVC=$(railway status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const e=j.services?.edges?.[0]?.node;console.log(e?.name||"")}catch{console.log("")}})')
[ -n "$SVC" ] && railway service "$SVC"
railway variables --set HOST=0.0.0.0 --set LIGHTS_REFRESH=1 --skip-deploys
[ -n "${GITHUB_TOKEN:-}" ] && railway variables --set "GITHUB_TOKEN=$GITHUB_TOKEN" --skip-deploys || true
DOMAIN=$(railway domain 2>&1 | grep -oE 'https://[a-zA-Z0-9.-]+\.up\.railway\.app' | head -1)
echo "DOMAIN=$DOMAIN"
railway variables --set "PUBLIC_URL=$DOMAIN"   # triggers redeploy
railway up --detach
echo "Wait for deploy, then: curl $DOMAIN/health ; curl $DOMAIN/status"
