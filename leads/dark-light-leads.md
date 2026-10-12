# Dark-light leads: bounty / consulting opportunities

**For:** fakegreen consulting (Fitzyracing1@gmail.com)
**Date:** 2026-10-11, ~23:30 ET. **Research only.** Nobody was contacted, and nothing was forked, filed, commented on, or posted.

**Sources:**
- `/workspace/mirror/dig.json` + `notes.json` (npmmirror dark-CI scan: 573 packages, 496 repos, 33 dark). Report: `targets/mirror-dark.md`.
- Existing patch-cloud targets: `mapping.json`, `lights.json` (refreshed 2026-10-11 ~23:10 ET with dark-since), `targets/report.md`.
- GitHub repo metadata (open issues incl. PRs, last push, archived) and api.npmjs.org last-week downloads, pulled 2026-10-11 ~23:20 ET.

**Light rule:** dark = the project's latest default-branch CI run did not pass. That is the project's own build, **not** a broken install. Days dark: from the first red run after the last passing one. "≥" means no passing run was in the window checked.

## How these were ranked

Each lead scores on four things:
1. **Reach:** npm weekly downloads, plus npmmirror Sep-2026 for China reach.
2. **Time dark:** longer means nobody is watching CI.
3. **Maintainer signal:** solo maintainer, last push, open backlog, archived, or an explicit funding ask.
4. **Paying audience:** companies that depend on it directly or through a big framework, plus whether we already have a working fix or fork (it proves we can deliver).

A one-line CI fix alone is **not** a consulting lead. It's a credibility opener. The money is in (a) companies that depend on an unmaintained package, or (b) maintainers or foundations with a budget.

## Top 10

| # | package(s) | npm / week | dark | maintainer signal | what we already have |
|---|---|---:|---|---|---|
| 1 | **follow-redirects** | 109M | 3–181 days (red since 2026-10-01; last passing 2026-04-13) | **README: "Maintenance paused until funding found"**. One volunteer for 10+ years; asks companies for invoice-based funding or a security support agreement. 20 open issues/PRs. | Node 24 test hang **reproduced**; 3-line `server.closeAllConnections()` harness fix verified (257/257 on Node 24.21 and 20) |
| 2 | **prebuild-install** | 22.9M | ≥ 246 days | **Repo now archived** (last push 2026-02-19). 23 open. | patch-cloud fork **served now**: `tar-fs ^2.1.4` (CVE-2025-59343, PR #214) |
| 3 | **lru-cache** | 594M | 23–174 days (8 red pushes since 2026-04-20) | Solo maintainer (isaacs). 2 unrelated open PRs. | Root cause known: `.taprc` lists `@tapjs/clock`, which isn't installed (Windows jobs only) |
| 4 | **isaacs/tapjs tiny-module cluster:** inherits, isexe, fs.realpath, chownr, signal-exit | 211M + 316M + 96M + 112M + 302M ≈ **1.0B** combined | ≥ 321–351 days | Last pushes 2025-10/11 (a license-change sweep). CI died on Node 12/14 macOS arm64 and Node 18 drift. | Causes identified for inherits/fs.realpath (macOS arm64 has no Node 12/14). signal-exit/isexe/chownr logs expired, so they need a repro. |
| 5 | **ts-node** | 46M | 30+ red scheduled runs | **Last push 2024-07-18.** 231 open. Scheduled CI auto-fails on deprecated `upload-artifact@v1`. | Cause known (bump to v4). Real value is a migration path. |
| 6 | **statuses** (Express / jshttp) | 200M | 376–390 days | Dependabot PRs #72/#75–#78 stuck since 2025. 7 open. | Needs a local repro (logs expired) |
| 7 | **unzipper** | 26M | 98 days | 1-line fix PR #331 rotting 800+ days. 91 open. Solo maintainer. | patch-cloud fork **served now** (`@aws-sdk/client-s3` → dependencies) |
| 8 | **ajv** | 393M | 170 days | 383 open. Security-sensitive (JSON Schema validation everywhere). | Fork branch with a corrected #2591. The ReDoS claim **could not be reproduced**, so ajv is not rewritten; that's an honest audit result. |
| 9 | **jimp** | 3.3M | 187 days | 189 open. The published 1.6.1 browser build is an empty stub (#1402, +21). | patch-cloud fork **served now** with a real browser bundle |
| 10 | **cli-table3** | 34.7M | ≥ 175 days | 29 open. rowSpan crash PR #359 unmerged. | patch-cloud fork **served now** (#359 applied) |

Also worth a look: **jsPDF** (15.8M/wk; red since TS 6 broke the typings test; fix PR #3989 closed unmerged), **rxjs** (106M/wk; scheduled fuzz workflow points at files that aren't on main; Angular depends on it), and **sqlite3** (TryGhost/node-sqlite3 is **archived**, so it's a migration lead to `better-sqlite3` / `node:sqlite`).

## Why each one, and a suggested outreach angle

All outreach below is a **suggestion for Joshua to decide on**. Nothing has been sent. Lead with a working fix, not a sales pitch.

### 1. follow-redirects: the clearest paid lead
- **Why:** The maintainer has publicly paused maintenance until funding is found and invites invoice-based funding and **security support agreements**. axios depends on it, and so does most of the Node HTTP ecosystem. CI has been red since 2026-10-01 because of Node 24, and we have a verified fix.
- **Angle:** Two tracks. (a) Offer the maintainer the verified Node 24 harness fix as goodwill, and offer to be paid contract help (CI/release/triage) **through his funding channel**, not around it. (b) Pitch companies that ship axios (API SDK vendors, fintech, SaaS with Node backends) a "follow-redirects continuity" retainer: track security advisories, keep a patched build ready (patch-cloud already does this mechanically), and co-fund the maintainer. **Don't fork-and-compete.** The maintainer asked for funding, so the honest play is helping route money to him.

### 2. prebuild-install: archived, CVE-fixed fork already live
- **Why:** The repo is archived, it's still at 22.9M/week, and it's a native-addon install path at many companies. Our fork already fixes the `tar-fs` CVE.
- **Angle:** Migration consulting for teams shipping native addons: move from prebuild-install to `prebuildify` + `node-gyp-build` or `@napi-rs`, with the patch-cloud fork as the stopgap. Audience: maintainers of packages that still depend on prebuild-install (a dependents scan via deps.dev is a good next step).

### 3. lru-cache: biggest reach, small fix
- **Why:** 594M/week, red for 8 pushes since April, and the cause is pinned (missing `@tapjs/clock` devDep on Windows).
- **Angle:** Not a paid lead by itself, since the maintainer is well known and self-sufficient. Use it as a **public credibility piece**: "we found why the lru-cache Windows CI has been red for 6 months." That feeds the fakegreen story. Bundle it with #4.

### 4. isaacs/tapjs cluster: one sweep, about 1B weekly downloads
- **Why:** Five foundational modules have had red CI for about a year from runner and Node-matrix drift, not code bugs.
- **Angle:** Offer one "CI matrix modernization" pass covering all five (drop or exclude dead Node/macOS combos, re-green). For sponsors, pitch it as supply-chain hygiene: companies that pay for OpenSSF-style scorecards care that their transitive deps have working CI.

### 5. ts-node: dormant, still heavily used
- **Why:** No push since July 2024, 231 open issues/PRs, 46M/week. Enterprises are stuck on it through old Jest/Mocha/TypeORM setups.
- **Angle:** **Migration consulting**: ts-node → `tsx` or Node's native type stripping, with codemods and a CI check. Target companies with ts-node in their public repos' `package.json`. This is likely the best pure consulting (not bounty) lead.

### 6. statuses (Express ecosystem)
- **Why:** Red for over a year on a core Express dependency, with Dependabot PRs stuck.
- **Angle:** Express/jshttp sit under the OpenJS Foundation, which has security/maintenance funding programs (unverified for jshttp specifically). Offer to clear the CI and Dependabot backlog across the jshttp packages as a scoped, fundable work item. Check the OpenJS / Express TC funding process first.

### 7. unzipper
- **Why:** A solo maintainer, a fix PR waiting 800+ days, and 91 open issues/PRs. Used in S3/ETL pipelines.
- **Angle:** Offer co-maintenance (triage, releases) and point to the patch-cloud fork as proof. Companies doing S3 zip streaming are the paying audience.

### 8. ajv
- **Why:** 393M/week, security-sensitive, a large backlog, and dark for 170 days. We have a real audit result: the claimed ReDoS in #2591 did not reproduce.
- **Angle:** "Security triage as a service." Write up the non-repro professionally and offer the same triage for their open security reports. ajv has had grant/sponsor funding in the past (from memory: Mozilla MOSS, Microsoft FOSS Fund; verify), so check its current sponsors before pitching.

### 9. jimp
- **Why:** The published browser build is a stub, so users are actually broken (not just CI), and it's been dark for 187 days.
- **Angle:** Offer the working browser bundle (already in our fork) upstream, and offer image-pipeline consulting to apps using jimp in the browser. Smaller market (3.3M/week), but the pain is concrete.

### 10. cli-table3
- **Why:** A rowSpan crash with a ready PR, red for at least 175 days, and 34.7M/week (CLI tooling everywhere).
- **Angle:** Low-dollar. Offer maintainer help, and use it as a portfolio piece.

## Not leads (and why)
- **ms** (557M/week, dark 144 days): it's Vercel's. A corporate maintainer, so no consulting angle. The fork stays a patch-cloud demo.
- **DefinitelyTyped, vite, typescript-eslint, tailwindcss, jest, pnpm:** active, funded teams with one-off or transient reds.
- **sindresorhus has-flag / escape-string-regexp / resolve-from / strip-bom / pify / object-assign / indent-string:** easy fixes, but frozen legacy majors with low merge odds.
- **DefinitelyTyped @types/\*:** transient scheduled-run breakage in a huge monorepo.

## Bounties
No posted bounties (Algora, IssueHunt, Polar, GitHub-sponsored issues) were searched for or found in this pass. The money signals above come from READMEs (follow-redirects) and from archived or dormant status. A follow-up could check Polar/Algora for these repos.

## Next steps, if Joshua wants them (none taken)
1. Look up companies depending on follow-redirects/axios, ts-node, and prebuild-install (deps.dev / GitHub dependents) to build named target lists.
2. Draft (don't send) a short note to the follow-redirects maintainer offering the verified Node 24 fix plus paid help through his funding channel.
3. Open the Node 24 fix as a PR on a fitzyracing1 fork. **Upstream PRs need Joshua's go-ahead.**
