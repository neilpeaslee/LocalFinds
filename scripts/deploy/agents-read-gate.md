# Read-gate /agents (steward-only) — runbook

Makes the `/agents` admin surface steward-only so agent interest profiles (personal taste PII,
published to the box by `deploy-code.sh`) are never served on a public GET. Reuses the P2
`auth_request /auth/check` gate. Every command below runs **on the box** — hand them to Neil.
nginx site file: `/etc/nginx/sites-available/localfinds.me`.

## 1. Back up the site file (sudo)

    sudo cp /etc/nginx/sites-available/localfinds.me /etc/nginx/sites-available/localfinds.me.bak-agents-gate

## 2. Add the gated locations (sudo)

Edit `/etc/nginx/sites-available/localfinds.me`, in the `localfinds.me` server block. Add as
siblings of `location /` (the proxy_* lines are copied verbatim from `@write_gate`, so `/agents`
proxies identically to the rest of the Next app on `127.0.0.1:3001`):

    # Steward-only admin surface: interest profiles, run history, live transcripts.
    location /agents {
        auth_request /auth/check;
        error_page 401 = @login;
        proxy_pass http://127.0.0.1:3001;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    # Live-transcript SSE stream — the one /agents dependency outside the /agents prefix.
    # No error_page redirect: EventSource can't follow one, so a bare 401 (ending the
    # stream) is correct.
    location /api/runs/ {
        auth_request /auth/check;
        proxy_pass http://127.0.0.1:3001;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    # Unauthenticated page GET lands on the login form, not a bare 401.
    location @login { return 302 /auth/log-in; }

`location = /auth/check` already exists from the P2 cutover — do NOT redefine it.

## 3. Sanity-check, test, reload (sudo)

The grep runs after §2's edit, so it should return **exactly the three lines you just added**
(`location /agents`, `location /api/runs/`, `location @login`). Any additional match is a
pre-existing `/agents` or `/api` block that would collide — resolve it before reloading.

    grep -n "location \(/agents\|/api\|@login\)" /etc/nginx/sites-available/localfinds.me
    sudo nginx -t && sudo systemctl reload nginx

## 4. Publish profiles + code (from dev, NOT the box)

    npm run deploy      # gate -> deploy:code (rsyncs data/agents/*/profile.md) -> migrate

## 5. Verify

Logged out (no cookie):

    curl -sS -o /dev/null -w "%{http_code}\n"    https://localfinds.me/agents                          # 302
    curl -sS -o /dev/null -w "%{redirect_url}\n" https://localfinds.me/agents                          # …/auth/log-in
    curl -sS -o /dev/null -w "%{http_code}\n"    https://localfinds.me/agents/runs/x                    # 302 (nested route gated by prefix)
    curl -sS -o /dev/null -w "%{http_code}\n"    https://localfinds.me/api/runs/x/stream               # 401
    curl -sS -o /dev/null -w "%{http_code}\n"    https://localfinds.me/                                # 200
    curl -sS -o /dev/null -w "%{http_code}\n"    https://localfinds.me/feed                            # 200
    curl -sS -o /dev/null -w "%{http_code}\n"    https://localfinds.me/places                          # 200
    curl -sS -o /dev/null -w "%{http_code}\n"    https://localfinds.me/sources                         # 200

Browser, steward: log in at `/auth/log-in` → visit `/agents` → each agent shows its real interest
profile (dated learned-preferences, not "No profile yet") → open a run → the live transcript
streams.

Browser, member (`member-test` account): visit `/agents` → redirected to `/auth/log-in` (the gate
is steward-only).

## 6. Rollback

Restore the backup and reload:

    sudo cp /etc/nginx/sites-available/localfinds.me.bak-agents-gate /etc/nginx/sites-available/localfinds.me
    sudo nginx -t && sudo systemctl reload nginx

Rolling back re-exposes `/agents` as a public GET, so the already-published profiles become
world-readable again. Roll back only briefly; if it must persist, also remove the published
profiles from the app checkout on the box. `$DEPLOY_PATH` is a dev-side variable (unset in a box
shell), so `cd` into the checkout dir first — it is the `DEPLOY_PATH` value in
`scripts/deploy/deploy.env`:

    cd <box app checkout>   # = DEPLOY_PATH from scripts/deploy/deploy.env
    rm data/agents/*/profile.md
