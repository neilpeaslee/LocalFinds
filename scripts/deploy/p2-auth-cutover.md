# P2 auth cutover — basic auth → Phoenix auth_request

Every command here runs on the box (or against it) — Neil executes. Order matters.
Rollback at any point before step 8: restore the nginx site file from the .bak and reload.

## 1. Ship code + migrate (existing pipeline, from dev)

    npm run deploy            # gate → code → migrate; applies 0007
    bash scripts/deploy/deploy-api.sh   # rebuild + restart the Phoenix release

## 2. Grant the app role write on the two auth tables (on the box)

The Phoenix DATABASE_URL role is read-only (SP7). Find its name and the DB name:

    sudo grep DATABASE_URL /etc/localfinds-api.env
    # postgres://<ROLE>:...@127.0.0.1:5432/<DB>

    sudo -u postgres psql -d <DB> -c "
      GRANT USAGE ON SCHEMA localfinds TO <ROLE>;
      GRANT SELECT, INSERT, UPDATE, DELETE
        ON localfinds.users, localfinds.users_tokens TO <ROLE>;"

No sequence grants needed: identity columns, not serial.
If step 1's migrate failed on `CREATE EXTENSION citext` (role lacks CREATE on the DB):

    sudo -u postgres psql -d <DB> -c "CREATE EXTENSION IF NOT EXISTS citext;"

then re-run `npm run deploy:migrate` from dev.

## 3. Create the steward account (on the box)

    cd <release dir> && sudo ./bin/localfinds eval \
      'Localfinds.Release.create_user("npeaslee@gmail.com", "<CHOOSE>", "steward")'

Expected output: `created npeaslee@gmail.com (steward)`.
This doubles as the write-grant smoke test — it inserts as the app role.

## 4. nginx: add the Phoenix locations (sudo)

    sudo cp /etc/nginx/sites-available/localfinds /etc/nginx/sites-available/localfinds.bak-p2

Edit `/etc/nginx/sites-available/localfinds`, in the `localfinds.me` server block.
Add alongside the existing locations:

    # Phoenix auth surface: pages, assets, LiveView socket — all under /auth/
    location /auth/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    # Session check for auth_request — internal only, never client-reachable
    location = /auth/check {
        internal;
        proxy_pass http://127.0.0.1:4000;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Original-URI $request_uri;
    }

## 5. nginx: swap the write gate (sudo)

In `location /` (the Next proxy), REMOVE the `limit_except GET HEAD { auth_basic ... }`
block and add instead (nginx forbids auth_request inside limit_except — this is the
standard method-split workaround; the named-location redirect preserves method and body):

    error_page 418 = @write_gate;
    if ($request_method !~ ^(GET|HEAD)$) { return 418; }

And add as a sibling of `location /` (copy the proxy_* lines from `location /` so both
paths proxy identically):

    location @write_gate {
        auth_request /auth/check;
        proxy_pass http://127.0.0.1:3001;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

Also DELETE the `location = /login` block (the basic-auth priming page — obsolete).

    sudo nginx -t && sudo systemctl reload nginx

## 6. Verify

    curl -sS -o /dev/null -w "%{http_code}\n" https://localfinds.me/          # 200
    curl -sS -o /dev/null -w "%{http_code}\n" -X POST https://localfinds.me/  # 401

Browser: https://localfinds.me/auth/log-in → log in as the steward → use any write in the
UI (thumbs a find) → works. Log out (or clear cookies) → the same write fails.

Member negative test:

    sudo ./bin/localfinds eval \
      'Localfinds.Release.create_user("member-test@localfinds.me", "<CHOOSE2>", "member")'

Incognito window: log in as member-test → any UI write must FAIL (401).

## 7. Same session: docs + skill sync

- Update `.claude/skills/deploy-localfinds/SKILL.md`: auth row now "Phoenix session +
  nginx auth_request (steward role)"; delete the htpasswd reset recipe and the
  `/var/www/localfinds-auth` bootstrap step; add the create_user/set_password recipes.
- README: replace any mention of the shared write password with the login flow.

## 8. T+1 (not same-day): retire the basic-auth artifacts

After a day of normal use — agents ran, feed writes worked, no 401 surprises in
`journalctl -u localfinds-api` / nginx error log:

    rm /var/www/localfinds-auth/.htpasswd-localfinds
    rmdir --ignore-fail-on-non-empty /var/www/localfinds-auth
    sudo rm /etc/nginx/sites-available/localfinds.bak-p2
