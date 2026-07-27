# /agents cutover — Next → Phoenix LiveView (UI port plan 4)

Every command here runs on the box (or against it) — Neil executes. Order matters.
Rollback at any point: restore the nginx site file from the `.bak` and reload.

This is the plan where the SSE bridge dissolves: `/api/runs/:id/stream`, `EventSource`, and
`RunTranscript.tsx` stop being used (though their code and route are not deleted yet — see §4
below). `/agents` and `/agents/runs/:run_id` become LiveViews with their own in-app steward gate,
because **nginx cannot gate a LiveView socket** — it connects at `/live/websocket`, which no
`location` block sees. After this cutover only `/` remains on Next.

## 0. Preconditions (from dev, then on the box)

    cd phoenix && mix test          # 447 tests, 0 failures

This branch (`ui-port-agents`) must be merged and deployed before nginx moves:

    npm run deploy                  # gate -> code -> migrate; applies 0013's grants
    bash scripts/deploy/deploy-api.sh

`npm run deploy` is what ships migration `0013_web_run_grants.sql` (`SELECT` on
`localfinds.runs` and `localfinds.run_events` for `localfinds_api`). Without it the pages 500 the
moment they try to read a run. `deploy-api.sh` ships the Phoenix release itself.

Then, on the box, prove the route exists and the in-app gate is live **before** nginx points at
it:

    curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4000/agents        # 302

302 is correct here, not 200 — this is an unauthenticated request, and `on_mount(:require_steward,
…)` redirects it to `/auth/log-in` for the disconnected render exactly as it will for a browser.
A 200 at this step would mean the gate is not wired; do not proceed to §2 until this reads 302.

## 1. Back up the site file (sudo)

    sudo cp /etc/nginx/sites-available/localfinds.me \
            /etc/nginx/sites-available/localfinds.me.bak-agents-cutover

## 2. Delete the Next-era `/agents` block

This is the block `agents-read-gate.md` added on 2026-07-23 (currently live). Remove it in full:

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

This is the **only** block this cutover deletes. Everything else in `agents-read-gate.md`'s
addition — `location /api/runs/` and `location @login` — stays. See §3.

## 3. What stays untouched, and why

Two things in this file are load-bearing. Do not delete them "for tidiness" while you're in here.

### 🔴 `location /api/runs/` must be KEPT exactly as it is

    location /api/runs/ {
        auth_request /auth/check;
        proxy_pass http://127.0.0.1:3001;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

The Next SSE route (`/api/runs/[runId]/stream`) survives this cutover — same as `/feed`'s Next
page survived its own cutover — purely so there is something to roll back to. **If this gated
block were deleted, `/api/runs/1/stream` would fall through to `location /` → Next**, which would
serve agent transcripts (personal-taste PII, the exact thing `agents-read-gate.md` exists to
protect) **with no gate at all** — Next's own route has no auth check of its own; the gate has
always lived in this nginx block. It is deleted in Plan 5, together with Next itself and this
whole route. Until then it is dead code behind a live gate, which is safe; an ungated live route
is not.

### 🔴 `location @login`, `location = /auth/check`, and `Plugs.RequireSteward` stay

    location @login { return 302 /auth/log-in; }

`/auth/check` (the internal `location = /auth/check` added in the P2 cutover) is not
`/agents`-specific — `@write_gate` (see `scripts/deploy/p2-auth-cutover.md`) still calls
`auth_request /auth/check` to gate non-GET requests on the remaining Next surface (`/`). Deleting
it, `@login`, or the Phoenix-side `Plugs.RequireSteward` pipeline it depends on would break that
gate for `/`, not just for `/agents`. All three retire together in Plan 5, when there is no Next
surface left for `@write_gate` to protect. Do not touch them here.

## 4. Add the Phoenix locations (sudo)

Edit `/etc/nginx/sites-available/localfinds.me`. Add, alongside the existing Phoenix locations
(`/feed`, `/places`, `/sources`), with the websocket upgrade headers and `X-Forwarded-Proto
$scheme` copied verbatim from the `/feed` blocks (`X-Forwarded-Proto https` is a Next-era literal;
Phoenix's `force_ssl` needs the real `$scheme` or it 301s the websocket upgrade to `PHX_HOST`,
which a websocket cannot survive):

    location = /agents {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location ^~ /agents/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

**Both are required.** `/agents/runs/:run_id` lives under the second (`^~ /agents/`); with only
the exact match, that path falls through to `location /` → Next → 404. They roll back together —
removing one without the other leaves either the console or the run-detail page dangling.

## 5. Test and reload (sudo)

Three checks, in order. They prove different things — none of them substitutes for another.

**Check A — the old block is actually gone. This is the one that matters.** Forgetting to delete
§2's block is the single most likely hand-edit mistake, and it fails *silently*: nginx's
exact-match/longest-prefix rules mean the new `= /agents` and `^~ /agents/` blocks still win
routing over a leftover `location /agents { … }` prefix block, so the site looks and behaves
correctly with the stale block still sitting there, gated but pointless, until someone trips over
it later. Confirm it's gone before trusting anything else:

    grep -c "location /agents {" /etc/nginx/sites-available/localfinds.me

Expect exactly `0`. Any other number means §2's block is still present — go back to §2 and delete
it, then repeat this check, before proceeding. (This exact string cannot match the two blocks §4
just added: `location = /agents {` and `location ^~ /agents/ {` both have another token between
`location` and `/agents`, so neither contains `location /agents {` as a substring — verified
against a synthetic file containing both new blocks and no old one, where this check reads `0`.)

**Check B — nothing else in the file moved.** Diff against the backup made in §1:

    diff /etc/nginx/sites-available/localfinds.me.bak-agents-cutover \
         /etc/nginx/sites-available/localfinds.me

Expect to see exactly one thing removed — the old `location /agents { … proxy_pass
http://127.0.0.1:3001; … }` block from §2 — and exactly one thing added — the two new `location =
/agents` / `location ^~ /agents/` blocks from §4, both proxying to `127.0.0.1:4000`. If the diff
shows anything else touched (a kept block from §3, an unrelated location, whitespace-only
reflow), stop and figure out why before reloading.

**Check C — confirm the new and kept blocks are present.** This does NOT prove the old block is
gone — a leftover copy of §2's block passes it too, since none of the five alternatives below
match the literal text `location /agents {` (this is the exact way the original version of this
runbook's own check failed to catch a leftover block in review — kept here only for what it
actually proves):

    grep -n "location \(= /agents\|\^~ /agents/\|/api/runs/\|@login\|= /auth/check\)" \
        /etc/nginx/sites-available/localfinds.me

Expect five matches: `location = /agents`, `location ^~ /agents/`, `location /api/runs/`,
`location @login`, `location = /auth/check`. **This count is derived from `agents-read-gate.md`'s
documented history of what's in the file today, not verified against the box's actual current
file.** Read the real output, don't just trust the number — if the file has picked up any other
`/agents`-shaped or `@login`/`/auth/check`-shaped line since 2026-07-23 that isn't accounted for
here, the count will be off, and that's worth investigating before reloading, not explaining away.

    sudo nginx -t && sudo systemctl reload nginx

## 6. Verify live

Logged out (no cookie):

    curl -sS -o /dev/null -w "%{http_code}\n" https://localfinds.me/agents              # 302
    curl -sS -o /dev/null -w "%{redirect_url}\n" https://localfinds.me/agents           # …/auth/log-in
    curl -sS -o /dev/null -w "%{http_code}\n" https://localfinds.me/agents/runs/1        # 302 (nested route gated by prefix)
    curl -sS -o /dev/null -w "%{http_code}\n" https://localfinds.me/                     # 200
    curl -sS -o /dev/null -w "%{http_code}\n" https://localfinds.me/feed                 # 200

Browser, authenticated **member** (non-steward): visit both routes → both redirect to
`/auth/log-in`, same outcome as logged out (the gate is steward-only, not just
authenticated-only). Both routes share the one `live_session :steward`, so this is low risk, but
check both rather than assuming the second follows from the first:

- `/agents` → redirected to `/auth/log-in`
- `/agents/runs/1` → redirected to `/auth/log-in`

Browser, **steward**: log in at `/auth/log-in`, then visit `/agents`.

- View source (the page must be server-rendered, not client-hydrated-empty) and confirm exactly
  one `data-phx-main` on the page — two would mean nginx is somehow routing the request through
  both Next and Phoenix; zero would mean it never left Next:

      view-source:https://localfinds.me/agents   →  Ctrl+F "data-phx-main"  →  1 match

- A real dated interest profile renders for at least one ROSTER agent (e.g. scout) — **not**
  "No profile yet". That copy is the data-dir canary on this page: if it shows for an agent that
  has actually run, `data/agents/<agent>/profile.md` isn't resolving on the box (wrong
  `DEPLOY_PATH`, or the file didn't get published by `deploy-code.sh`).
- Click a Run button (e.g. "Run" on scout, not "Run all") → the button goes to "starting…", then
  the active-run banner appears with a live-streaming transcript, and the button re-enables when
  the run ends. The run's row in its section table updates in place (status, duration, turns,
  cost, added/updated) with no page reload.
- `/agents/runs/<id>` for a run that already finished renders its stat block and full transcript
  (non-live: no further rows should stream in).

## 7. Rollback

    sudo cp /etc/nginx/sites-available/localfinds.me.bak-agents-cutover \
            /etc/nginx/sites-available/localfinds.me
    sudo nginx -t && sudo systemctl reload nginx

This restores `/agents` to Next **and** to nginx's `auth_request /auth/check` gate in one step —
the interest-profile PII stays protected either way, because the block being restored is the same
gated block §2 removed, not an ungated fallback. The Next pages, `RunTranscript.tsx`, and the SSE
route were never touched by this cutover, so they still work exactly as they did before it.
