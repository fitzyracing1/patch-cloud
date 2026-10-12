# Deploying patch-cloud (prepare only — Joshua picks the host)

Do **not** publish this as a transparent MITM of the public npm registry.
Users must **opt in** with `--registry` or a project `.npmrc`.

This guide covers three cheap hosts. Nothing here creates accounts or deploys.

## Required env

| Variable | Example | Notes |
|---|---|---|
| `HOST` | `0.0.0.0` | Bind all interfaces in containers |
| `PORT` | `4873` | Or the port the platform injects (`PORT`) |
| `PUBLIC_URL` | `https://patch-cloud.example.com` | **Required in production** — used in `dist.tarball` URLs npm clients download |
| `LIGHTS_FILE` | `/app/lights.json` | Snapshot shipped in the image |
| `LIGHTS_CACHE_MINUTES` | `5` | Re-read / refresh at most this often |
| `LIGHTS_REFRESH` | `1` | Re-fetch GitHub Actions conclusions when cache expires |
| `GITHUB_TOKEN` | `ghp_…` (optional) | Raises API rate limits for lights refresh |
| `RATE_LIMIT_PER_MIN` | `120` | Per-IP GET budget; `0` disables |

Docker image: see `Dockerfile` in this directory.

```bash
docker build -t patch-cloud .
docker run --rm -p 4873:4873 \
  -e PUBLIC_URL=https://your.host \
  -e GITHUB_TOKEN \
  patch-cloud
```

---

## 1. Render (best free tier for a small web service)

Facts as of 2026-10 (see [render.com/docs/free](https://render.com/docs/free), [render.com/pricing](https://render.com/pricing)):

- **Hobby workspace:** $0/month plan fee
- **Free web service:** 0.1 CPU / 512 MB RAM, **750 free instance-hours/month**
- Spins down after **15 minutes** idle; cold start ~1 minute
- Hobby outbound bandwidth included: **5 GB/month** ($0.15/GB overage) — **important:** serving the annotated `next` tarball (~44 MB) will burn bandwidth quickly if many people install
- Build minutes: 500/month on Hobby

**Steps (you do these):**

1. Push this repo (or only `patch-cloud/`) to GitHub when ready — *not done by this prep*.
2. New → Web Service → connect repo → Runtime **Docker** (or Native Node: `node server.mjs`).
3. Instance type: **Free**.
4. Set env: `PUBLIC_URL=https://<your-service>.onrender.com`, `HOST=0.0.0.0`, `LIGHTS_REFRESH=1`, optional `GITHUB_TOKEN`.
5. Health check path: `/health`.

**Caveats:** cold starts break `npm install` timeouts; bandwidth is tight for large tarballs. Prefer a paid always-on instance ($7/mo “less than 1 CPU”) if others will use it.

---

## 2. Railway

Facts as of 2026-10 (see [railway.app/pricing](https://railway.app/pricing)):

- **Free plan:** $0/mo + **$1/month** usage credit; max **1 vCPU / 0.5 GB**, 1 replica
- **Trial:** one-time **$5** credit for 30 days (new accounts)
- **Hobby:** **$5/month** includes $5 usage credit (floor, not a cap if you exceed)
- Usage metered (CPU/RAM/egress); practical for a tiny always-on Node service on Hobby

**Steps:**

1. New project → Deploy from Dockerfile (root or set Dockerfile path).
2. Variables: `PUBLIC_URL=https://<your-app>.up.railway.app`, `HOST=0.0.0.0`, `LIGHTS_REFRESH=1`, optional `GITHUB_TOKEN`.
3. Generate a public domain in Networking; set `PUBLIC_URL` to that HTTPS URL.
4. Healthcheck: `/health`.

**Caveats:** Free $1 credit is easy to exhaust with egress of large tarballs. Hobby ($5) is the realistic floor.

---

## 3. Fly.io

Facts as of 2026-10 (see [Fly pricing](https://docs.fly.io/about/pricing/), [free trial](https://fly.io/docs/about/free-trial/)):

- **No free tier** for new orgs (legacy Hobby allowances discontinued for new accounts)
- **Free trial:** 2 VM-hours or 7 days (whichever first); trial machines auto-stop after 5 minutes
- Cheapest always-on: `shared-cpu-1x` + 256 MB ≈ **$2.19 / 30 days** (iad/ewr) + egress (~$0.02/GB NA/EU)
- Pay-as-you-go; card required after trial

**Steps:**

```bash
# after: fly auth login && fly launch (from patch-cloud/)
fly secrets set PUBLIC_URL=https://<app>.fly.dev GITHUB_TOKEN=...
fly deploy
```

`fly.toml` sketch:

```toml
app = "patch-cloud-YOURNAME"
primary_region = "iad"

[http_service]
  internal_port = 4873
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
```

Set `PUBLIC_URL` to the Fly HTTPS hostname. For fewer cold starts, `min_machines_running = 1` (~$2+/mo).

---

## Bandwidth warning

The annotated `next@16.4.0` fork tarball is ~**44 MB**. Free tiers with low egress (Render Hobby 5 GB, Railway Free $1 credit) are fine for demos, not for “everyone installs next through us.” Consider:

- Only mapping small demo packages on free hosts, or
- Paying for always-on + enough bandwidth, or
- Keeping `next` rewrite for private/friends use

## After deploy — tell users

```bash
npm install next --registry https://YOUR_HOST
# or project .npmrc:
# registry=https://YOUR_HOST/
```

Open `https://YOUR_HOST/` for the landing page and `https://YOUR_HOST/status` for JSON.

## Download counts (persistent volume)

- Railway volume `patch-cloud-volume` (id 670b46da-c74c-4708-9674-bcbda490a47c) is mounted at `/data` on the service.
- Service variables: `COUNTS_DIR=/data` (counts go to `/data/downloads.json`, flushed with a debounce of `COUNTS_FLUSH_MS`, default 2000 ms, and again on SIGTERM), and `RAILWAY_RUN_UID=0`. The volume is root-owned, and the Dockerfile uses `USER node`, so without this the app can't write to it.
- If `COUNTS_DIR` is unset or can't be written, counts are kept in memory and /status says "counts since last restart <time> (not persisted)".
- What gets counted, per mapped package: tarballs served from the fork, tarballs served or proxied from upstream, and metadata GETs. Unmapped packages share one "other" bucket. `/`, `/status`, `/health` and the audit POSTs are not counted. No IPs are stored.
