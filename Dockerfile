# patch-cloud — read-only opt-in npm registry
# deps: @fitzyracing1/light-core comes from a pinned git tag, so install it where git exists
FROM node:22-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules

# App sources (tarballs/ may be large — next annotated package ~44MB)
COPY package.json config.mjs server.mjs check-upstream.mjs mapping.json ./
COPY lights.json upstream-status.json watchlist.json merged.json ./
# Demo override: keeps local/broken-demo dark so the fork rewrite is visible
COPY local-lights.example.json ./local-lights.json
COPY tarballs/ ./tarballs/
COPY forks/ ./forks/
COPY upstream/ ./upstream/

ENV HOST=0.0.0.0
ENV PORT=4873
ENV LIGHTS_FILE=/app/lights.json
ENV LIGHTS_CACHE_MINUTES=5
ENV LIGHTS_REFRESH=1
ENV RATE_LIMIT_PER_MIN=120
# Set PUBLIC_URL at deploy time to your https://hostname (used in dist.tarball URLs)

EXPOSE 4873
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4873)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "server.mjs"]
