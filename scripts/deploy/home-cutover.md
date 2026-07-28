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
  everything else.
- **No new grants are expected** — `localfinds.places` was granted in Plan 2 and
  `localfinds.finds` in Plan 3 — **but this has NOT been verified.** Reading the
  migrations does not count; run §0's grants query first. If it errors with `42501
  insufficient_privilege`, this task gains a migration (`db/migrations/0014_...sql`)
  that the runbook must sequence before the nginx flip. Three grant defects in Plan 3
  passed every local test and would have thrown `42501` in production.

## 0. Pre-flight (from dev, then on the box)

From dev:

    cd phoenix && mix test          # 539 tests, 0 failures
    cd phoenix && mix assets.build  # confirms Leaflet + supercluster bundle

On the box (via SSH or as Neil logged in):

**Run this grants query first.** This is the only verification that matters:

    sudo -u postgres psql -d localfinds -c "
      SET ROLE localfinds_api;
      SELECT count(*) FROM localfinds.places WHERE duplicate_of IS NULL;
      SELECT count(*) FROM localfinds.places
        WHERE duplicate_of IS NULL AND lat IS NOT NULL AND lng IS NOT NULL
          AND status <> 'closed' AND (brand IS NULL OR brand = '');
      SELECT count(*) FROM localfinds.finds
        WHERE status NOT IN ('hidden', 'provisional');
      RESET ROLE;"

Expected: three counts, no error. Any `42501 insufficient_privilege` means a grant is
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

`grep -c 'Loading map'` returning 1 only proves the placeholder shipped — that string is
the *disconnected* render and is present whether or not the hook actually works. Check the
box's own `mix assets.deploy` output directly, since nothing else here touches it and it's
the step this branch's spec flagged as most likely to break a deploy (esbuild's UMD
interop with the vendored Leaflet/supercluster bundles):

    curl -sS http://127.0.0.1:4000/assets/js/app.js  | grep -c "Leaflet 1.9"      # >= 1
    curl -sS http://127.0.0.1:4000/assets/css/app.css | grep -c "leaflet-container" # >= 1

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

    grep -c "location / {" /etc/nginx/sites-available/localfinds.me

Expect exactly `1` (the catch-all). If you see `0`, the catch-all was deleted —
restore from the backup and start over. If you see `2` or more, a duplicate exists — fix
it before reloading.

**Check B — nothing unintended moved.** Diff against the backup:

    diff /etc/nginx/sites-available/localfinds.me.bak-home-cutover \
         /etc/nginx/sites-available/localfinds.me

Expect to see exactly one block added: `location = / { … proxy_pass http://127.0.0.1:4000 …
}`. If the diff shows anything else changed (the catch-all edited, an unrelated location
touched, the existing Phoenix blocks moved), stop and figure out why before reloading.

**Check C — existing Phoenix locations survived.** Confirm the pre-existing blocks are
still present and untouched:

    grep -n "location \(= /feed\|\^~ /feed/\|= /places\|\^~ /places/\|= /sources\|\^~ /sources/\)" \
        /etc/nginx/sites-available/localfinds.me

Expect exactly 6 matches (exact-match and prefix blocks for `/feed`, `/places`, `/sources`).
This does NOT prove Check A — a leftover catch-all passes it — but it proves the existing
Phoenix surface survived your edits.

Then reload:

    sudo systemctl reload nginx

## 4. Verify live

**Test A — THE critical check: the catch-all still reaches Next.** This is the one that
proves the exact-match location is working as designed and Plan 6's rollback path survived.

First, confirm which nginx block actually owns `/_next/` on this box — the runbook has
never checked this, and this branch's own spec lists deleting `location /_next/` as Plan 6
work, so it may already have its own block rather than falling through to the catch-all:

    grep -n "_next" /etc/nginx/sites-available/localfinds.me

A status code cannot be the discriminator here. Next hashes every chunk filename
(`apps/web/.next/build-manifest.json` has names like `static/chunks/27q4d2lfe331u.js`), so
a guessed path like `/_next/static/chunks/app.js` doesn't exist — both Next and Phoenix
404 it, whether the catch-all is intact, repointed, or deleted. Probe the response body
instead, on a path neither app recognizes:

    curl -sS https://localfinds.me/__catchall_probe__ | grep -ci "__NEXT_DATA__\|next"

Expect a **non-zero** count. Next's own 404 page still embeds `__NEXT_DATA__` and the
literal word "next" (Phoenix's error page, by contrast, contains neither, case-insensitive
— see `error_html.ex`), so a nonzero count proves the body that answered was Next's, i.e.
the catch-all is intact. A **zero** count means Phoenix answered a path that should have
fallen through to Next — the catch-all was clobbered or deleted. Restore from the backup
and try again.

**Test B — the exact-match location works:**

    curl -sS -o /dev/null -w "%{http_code}\n" https://localfinds.me/            # 200
    curl -sS https://localfinds.me/ | grep -c 'Loading map'                     # 1

**Test C — other Phoenix routes still work:**

    curl -sS -o /dev/null -w "%{http_code}\n" https://localfinds.me/places      # 200
    curl -sS -o /dev/null -w "%{http_code}\n" https://localfinds.me/feed        # 200

Then open https://localfinds.me/ in a browser and walk these ten checks. The map is the
part no curl can verify, so this list — not a pointer to another document — is the
runbook's real map verification. (`docs/` is its own nested, gitignored repo; it never
ships to the box, so a step that only says "see Task 8" has nothing to point at here.)

 1. Tiles load and the map is framed on the coverage area, one zoom level tighter than
    the bare fit.
 2. The world outside the coverage boundary is dimmed; inside is clear.
 3. Town outlines are drawn, the primary town in amber and thicker; hovering a town shows
    its name centred.
 4. A town with no polygon shows a dashed rectangle instead.
 5. Cluster bubbles show a white bold number with NO white tooltip box behind it (this is
    the `.leaflet-tooltip.cluster-count` rule; a box means the CSS did not reach the
    bundle).
 6. Clicking a bubble flies in and it breaks apart.
 7. Individual pins are themed colours matching the legend, and hovering one names it.
 8. The legend sits top-right with a swatch per theme, then Other, then grey
    "more (zoom in)".
 9. Scroll-wheel over the map scrolls the page, not the map's zoom.
10. Open the browser console and confirm it is free of errors on load — in particular no
    Leaflet or hook exceptions.

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
