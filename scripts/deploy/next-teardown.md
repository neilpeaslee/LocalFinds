# Next teardown — wave 1 (box)

Every command here runs on the box, or from dev against it — Neil executes; Claude
never SSHes it. Order matters. Rollback at any point: see §8.

Wave 1 changes routing only. Next's code stays on disk, so rollback is nginx plus
pm2 — seconds, nothing to rebuild. Wave 2 (code deletion) is blocked until the
T+1 check in §9 passes.

**Do not run the script with sudo.** pm2 keeps per-user daemons; under sudo it
would address root's, not `ubuntu`'s. The script refuses to start as root.

## 0. Get the script onto the box

**Precondition: this branch must be merged to `main` before running any step here.**
`npm run deploy` refuses to run on any branch but `main`, and refuses on a dirty
tree (`gate.sh`, the first of its three stages) — the same precondition
`home-cutover.md` states for its own cutover.

From dev:

    npm run deploy

This ships the committed tree — `retire-next.sh`'s `--stop-next` mode and this
runbook included — via `gate → deploy-code → migrate`. `deploy-code` also runs
`npm run build -w @localfinds/web`, i.e. it rebuilds Next. That's expected and
harmless here: this branch doesn't touch Next's code, and nginx keeps routing to it
(pm2 keeps it running) until §4's reload flips the catch-all to Phoenix.

On the box, `cd` into the checkout before running anything below — every later
section assumes this working directory:

    cd /var/www/localfinds

Confirm the script arrived:

    ls -l scripts/deploy/retire-next.sh

Then continue at §1.

## 1. Look before touching

    bash scripts/deploy/retire-next.sh --check

It prints the routing inventory, asserts the config is in the pre-edit state, and
probes the live site to confirm the catch-all is still serving Next. If it aborts,
stop and send the output back — the config is not what the runbook assumes.

## 2. Back up

    sudo cp /etc/nginx/sites-available/localfinds.me \
            /etc/nginx/sites-available/localfinds.me.bak-next-teardown

## 3. Edit the config by hand

    sudo nano /etc/nginx/sites-available/localfinds.me

Five changes. `scripts/deploy/fixtures/nginx-after-teardown.conf` in this repo is a
worked example of the end state if you want to compare.

**a. Repoint the catch-all.** In `location / { … }` — the bare one, not `location = /` —
change:

    proxy_pass http://127.0.0.1:3001;

to:

    proxy_pass http://127.0.0.1:4000;

**b. Delete the write-gate split from inside that same block:**

    error_page 418 = @write_gate;
    if ($request_method !~ ^(GET|HEAD)$) { return 418; }

**c. Delete these three blocks entirely:**

    location @write_gate { … }
    location /api/runs/ { … }
    location @login { return 302 /auth/log-in; }

**d. Delete the internal auth_request target:**

    location = /auth/check { … }

**e. If `location /_next/ { … }` exists, delete it.** §1's `--check` output says
whether it does — look for the `note: /_next/ …` line.

Leave everything else alone — every `location` proxying to `127.0.0.1:4000` stays.

## 4. Test and reload

    sudo nginx -t
    sudo systemctl reload nginx

If `nginx -t` fails, restore the backup from §2 and start over; nothing was reloaded.

## 5. Verify

    bash scripts/deploy/retire-next.sh --verify

It asserts the config invariants and probes the live site. Any abort means stop and
roll back (§8).

## 6. Stop Next

    bash scripts/deploy/retire-next.sh --stop-next

`pm2 stop`, not delete — the process definition is the rollback path for the whole soak.

**A deploy between now and the T+1 check (§9) touches the pm2 process.**
`migrate.sh` runs `pm2 reload localfinds` unconditionally on every `npm run
deploy` — confirmed from source, not gated on whether the process is running. So
a deploy during the soak (a Phoenix change, a doc fix, anything that touches
`main`) reloads the same pm2 process this step just stopped, and Next may come
back up as a result. It is not an incident either way: nginx stopped routing to
`:3001` at §4, so nothing is newly reachable regardless of what pm2 does with it.
The action is the same whichever way pm2 behaves: if §9's `pm2 list` shows
`localfinds` running and a deploy happened during the soak, that is the
explanation — re-run `bash scripts/deploy/retire-next.sh --stop-next` and
continue.

Optional, not required: settle the mechanism for yourself in seconds —
`pm2 stop localfinds && pm2 reload localfinds && pm2 list`.

## 7. Browser walk

curl cannot verify a map. Open https://localfinds.me/ and confirm:

1. Tiles load, framed on the coverage area; outside is dimmed, inside is clear.
2. Town outlines draw, primary town in amber; hover shows the name.
3. Cluster bubbles show a white bold number with no white tooltip box behind it.
4. Clicking a bubble flies in and breaks it apart; pins are themed; hover names one.
5. Legend top-right: a swatch per theme, then Other, then grey "more (zoom in)".
6. Scroll-wheel over the map scrolls the page, not the zoom.
7. Console free of errors on load — no Leaflet or hook exceptions.

Then, logged in as steward: /feed loads and its settings form saves; /agents loads
and a run transcript streams; /places and /sources paginate.

## 8. Rollback

    sudo cp /etc/nginx/sites-available/localfinds.me.bak-next-teardown \
            /etc/nginx/sites-available/localfinds.me
    sudo nginx -t && sudo systemctl reload nginx
    pm2 start localfinds

## 9. T+1 — the gate on wave 2

Next morning, after the 04:17 UTC replication + matview refresh and the 07:00 agent
cron have both run:

    bash scripts/deploy/retire-next.sh --verify
    pm2 list
    tail -20 /var/log/localfinds/replication.log
    sudo -u postgres psql -d localfinds -c \
      "SELECT agent, status, started_at FROM localfinds.runs ORDER BY started_at DESC LIMIT 5;"

Expect: `--verify` green — its probes prove Next isn't serving anything, independent
of pm2's state. `pm2 list` showing `localfinds` stopped is the clean case; if it
shows running instead, see §6 before treating it as a failure — pm2's state alone
doesn't mean something is wrong. A clean replication log and a run row from this
morning's cron complete the picture. `--verify` green, a clean log, and a fresh run
row unblock wave 2 regardless of what `pm2 list` shows.
