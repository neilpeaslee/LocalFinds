# `/` cutover — Next → Phoenix LiveView (UI port plan 5)

Every command here runs on the box (or against it) — Neil executes. Order matters.
Rollback at any point: restore the nginx backup and reload.

This is the **last discovery page** to move. After it, Next serves no page a visitor
reaches, and Plan 6 can retire it. Two things make this cutover different:

- **The location is `= /` — an exact match, nothing more.** The catch-all `location /`
  stays pointed at Next, because `/_next/*` assets and the `/api/runs/` SSE route still
  live there until Plan 6. Adding `^~ /` here would take those with it.
- **No new grants and no migration.** Verified before writing this runbook by running
  the page's two queries as the web role. `npm run deploy` is therefore not strictly
  required — but run it anyway to keep the checkout and the release in step.

## 0. Pre-flight (from dev)

    cd phoenix && mix test          # all green
    cd phoenix && mix assets.build  # confirms Leaflet + supercluster bundle
    npm run deploy -- --dry-run     # confirms this targets the localfinds box

## 1. Ship code

    npm run deploy
    bash scripts/deploy/deploy-api.sh

`deploy-api.sh` is the one that matters — it builds the release, including the
vendored map assets. `npm run deploy` alone leaves the old release running.

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

Add alongside the existing Phoenix locations:

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

    sudo nginx -t && sudo systemctl reload nginx

## 4. Verify live

    curl -sS -o /dev/null -w "%{http_code}\n" https://localfinds.me/            # 200
    curl -sS https://localfinds.me/ | grep -c 'Loading map'                     # 1
    curl -sS -o /dev/null -w "%{http_code}\n" https://localfinds.me/places      # 200 (still Phoenix)
    curl -sS -o /dev/null -w "%{http_code}\n" https://localfinds.me/api/runs/1/stream
    # NOT 404 — proves the catch-all is still on Next and Plan 6's rollback path survives

Then open https://localfinds.me/ in a browser and walk the ten checks from Task 8,
step 8. The map is the part no curl can verify.

## 5. Rollback

    sudo cp /etc/nginx/sites-available/localfinds.me.bak-home-cutover \
            /etc/nginx/sites-available/localfinds.me
    sudo nginx -t && sudo systemctl reload nginx

Next still has the page; nothing was deleted.
