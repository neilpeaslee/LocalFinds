# `/` cutover — Next → Phoenix LiveView (UI port plan 5)

Every command here runs on the box (or against it) — Neil executes. Order matters.
Rollback at any point: restore the nginx backup and reload.

**Precondition: this branch must be merged to `main` before running any step here.**
`npm run deploy` hard-fails if the current branch isn't `main`.

This is the **last discovery page** to move. After it, Next serves no page a visitor
reaches, and Plan 6 can retire it. Two things make this cutover different:

- 🔴 **The location is `= /` — an exact match, nothing more.** The catch-all `location /`
  stays pointed at Next, because `/_next/*` assets and the `/api/runs/` SSE route still
  live there until Plan 6. The danger is editing the existing catch-all in place to
  forward to Phoenix — syntactically valid, wrong semantically. This new block must be
  separate; nginx's exact-match rule routes `/` to it, leaving the catch-all for
  everything else. Do not add a `^~ /` prefix block — that is a longest-prefix match
  that would intercept both `/` and its children, taking `/_next/*` with it and breaking
  the rollback path for Plan 6.
- **No new grants are expected** — `localfinds.places` was granted in Plan 2 and
  `localfinds.finds` in Plan 3 — **but this has NOT been verified.** Reading the
  migrations does not count; run §0's grants query first. If it errors with `42501
  insufficient_privilege`, this task gains a migration (`db/migrations/0013_...sql`)
  that the runbook must sequence before the nginx flip. Three grant defects in Plan 3
  passed every local test and would have thrown `42501` in production.

## 0. Pre-flight (from dev, then on the box)

From dev:

    cd phoenix && mix test          # 539 tests, 0 failures
    cd phoenix && mix assets.build  # confirms Leaflet + supercluster bundle

On the box (via SSH or as Neil logged in):

**Run this grants query first.** This is the only verification that matters:

    psql -d localfinds -c "
      SET ROLE localfinds_web;
      SELECT count(*) FROM localfinds.places WHERE duplicate_of IS NULL;
      SELECT count(*) FROM localfinds.places
        WHERE duplicate_of IS NULL AND lat IS NOT NULL AND lng IS NOT NULL
          AND status <> 'closed' AND (brand IS NULL OR brand = '');
      RESET ROLE;"

Expected: two counts, no error. Any `42501 insufficient_privilege` means a grant is
missing — pause, diagnose, add the migration, then proceed from §1 (re-run `npm run deploy`).

Then, confirm the dry-run sees the right target:

    npm run deploy -- --dry-run     # gate -> code -> migrate; prints DEPLOY_HOST

## 1. Ship code

    npm run deploy
    bash scripts/deploy/deploy-api.sh

`npm run deploy` is the one that matters for this page — it's grant-safe per §0, but run it
anyway to keep the checkout and release in step. `deploy-api.sh` builds the release, including
the vendored map assets.

## 2. Verify Phoenix serves the page before nginx points at it

    curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4000/            # 200
    curl -sS http://127.0.0.1:4000/ | grep -c 'Loading map'                     # 1
    curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4000/assets/js/app.js   # 200

The `Loading map` hit is the disconnected render, which is correct: the map only
mounts once the socket connects. A `0` there means the page rendered without its
map container at all.

## 3. nginx: add the exact-match location

    sudo cp /etc/nginx/sites-available/localfinds.me \
            /etc/nginx/sites-available/localfinds.me.bak-home-cutover

Add alongside the existing Phoenix locations (do not edit the existing catch-all):

    location = / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

Match the header block of the existing `= /feed` location exactly rather than the
lines above if they differ — that one is known good.

    sudo nginx -t

Three checks, in order. Each proves different things — none substitutes for another.

**Check A — the catch-all was not touched.** Do not edit the existing `location / {`
catch-all block that points to Next; add only the new `location = /` block alongside
it. Confirm the old catch-all is still there:

    grep -n "location / {" /etc/nginx/sites-available/localfinds.me | head -1

Expect exactly one match (the catch-all). If you see zero, the catch-all was deleted —
restore from the backup and start over. If you see two or more, a duplicate exists — fix
it before reloading.

**Check B — nothing unintended moved.** Diff against the backup:

    diff /etc/nginx/sites-available/localfinds.me.bak-home-cutover \
         /etc/nginx/sites-available/localfinds.me

Expect to see exactly one block added: `location = / { … proxy_pass http://127.0.0.1:4000 …
}`. If the diff shows anything else changed (the catch-all edited, an unrelated location
touched, the existing Phoenix blocks moved), stop and figure out why before reloading.

**Check C — existing Phoenix locations survived.** Confirm the pre-existing blocks are
still present and untouched:

    grep -n "location \(= /feed\|^~ /feed/\|= /places\|^~ /places/\|= /sources\|^~ /sources/\)" \
        /etc/nginx/sites-available/localfinds.me

Expect six matches (exact-match and prefix blocks for `/feed`, `/places`, `/sources`).
This does NOT prove Check A — a leftover catch-all passes it — but it proves the existing
Phoenix surface survived your edits.

Then reload:

    sudo systemctl reload nginx

## 4. Verify live

**Test A — THE critical check: the catch-all still reaches Next.** This is the one that
proves the exact-match location is working as designed and Plan 6's rollback path survived:

    curl -sS -o /dev/null -w "%{http_code}\n" https://localfinds.me/_next/static/chunks/app.js
    # NOT 404 — proves /_next/* still hits the catch-all → Next

Any 404 here means the catch-all was clobbered or deleted. The whole point of this
cutover's location rule was to avoid this. Restore from the backup and try again.

**Test B — the exact-match location works:**

    curl -sS -o /dev/null -w "%{http_code}\n" https://localfinds.me/            # 200
    curl -sS https://localfinds.me/ | grep -c 'Loading map'                     # 1

**Test C — other Phoenix routes still work:**

    curl -sS -o /dev/null -w "%{http_code}\n" https://localfinds.me/places      # 200
    curl -sS -o /dev/null -w "%{http_code}\n" https://localfinds.me/feed        # 200

Then open https://localfinds.me/ in a browser and walk the ten checks from Task 8,
step 8. The map is the part no curl can verify.

## 5. Rollback

    sudo cp /etc/nginx/sites-available/localfinds.me.bak-home-cutover \
            /etc/nginx/sites-available/localfinds.me
    sudo nginx -t && sudo systemctl reload nginx

Next still has the page; nothing was deleted.

## 6. Record the cutover in git

Once live verification passes, make a follow-up commit that records this cutover as
executed. This is the README correction step: it flips the Architecture bullets to
describe the present state (Next retired, all UI now on Phoenix).

Edit README.md: find the `## Architecture` section and replace these two bullets:

Replace this (the `apps/web` bullet):

```markdown
- **apps/web** — Next.js UI: dashboard with the region map (`/`), the feed
  (`/feed`), places directory (`/places`), source registry (`/sources`), agent
  profiles + run history (`/agents`, steward-only).
```

with:

```markdown
- **apps/web** — the retired Next.js UI. It serves no page; every route moved to
  `phoenix/`. Still present because its SSE route is the rollback path for the
  agent run transcripts.
```

And replace this (the `phoenix/` bullet):

```markdown
- **phoenix/** — Elixir/Phoenix service exposing the external read-only OSM
  places API at `api.localfinds.me` (`GET /osm/places`, bearer-token auth,
  reads the same materialized view; excludes locally-curated places).
```

with:

```markdown
- **phoenix/** — Elixir/Phoenix app serving the whole web UI as LiveViews:
  dashboard with the region map (`/`), the feed (`/feed`), places directory
  (`/places`), source registry (`/sources`), agent profiles + run history
  (`/agents`, steward-only). Also exposes the external read-only OSM places API
  at `api.localfinds.me` (`GET /osm/places`, bearer-token auth, reads the same
  materialized view; excludes locally-curated places).
```

Then commit:

    git add README.md
    git commit -m "docs: / live — next.js retired from discovery pages"

This mirrors the pattern in `p2-auth-cutover.md` §8: record the cutover as executed
only after live verification passes and the change is real.
