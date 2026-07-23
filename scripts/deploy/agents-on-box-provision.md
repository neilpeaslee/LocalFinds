# Provision agents on the box (self-sufficient roster + on-demand) — runbook

Relocates agent execution onto the production box so the site runs without dev. Every command
runs **on the box** (user `ubuntu`, app dir `/var/www/localfinds`) — hand them to Neil. Prereq:
this branch is deployed (`npm run deploy`), so `actions.ts`, `run-agents.sh`, and
`data/config/agents.json.example` are on the box.

## 1. Create the box agent env (chmod 600)

The agent CLI (`loadEnv()`) reads `/var/www/localfinds/.env`. It needs the Claude key and a
**write** Postgres DSN — role `localfinds`, against the SAME Postgres the web app already reads
(same host/port/db as `apps/web/.env.production`'s `LOCALFINDS_DATABASE_URL`, just the write role):

    cd /var/www/localfinds
    umask 077
    cat > .env <<'ENV'
    ANTHROPIC_API_KEY=<the sk-ant-… key>
    LOCALFINDS_DATABASE_URL=postgresql://localfinds:<localfinds-password>@<pg-host>:<pg-port>/<db>?sslmode=disable
    ENV
    chmod 600 .env
    ls -l .env      # -rw------- ubuntu ubuntu

(If you prefer the password in `~/.pgpass`: add `<pg-host>:<pg-port>:<db>:localfinds:<password>`
to `~/.pgpass`, `chmod 600 ~/.pgpass`, and drop `:<password>` from the DSN.)

## 2. Verify the agent runtime is installed

    cd /var/www/localfinds
    npx tsx --version                                                    # a version, not "not found"
    node -e "require.resolve('@anthropic-ai/claude-agent-sdk'); console.log('sdk ok')"

If `tsx` is missing, the deploy pruned devDependencies — run `npm ci` in `/var/www/localfinds`
(or promote `tsx` to a dependency in package.json and redeploy).

## 3. Smoke test one capped run (proves auth AND write access)

    cd /var/www/localfinds
    npm run agent -- scout --max-turns 4

Expect: no "Please run /login" (auth via the .env key), a short run that finishes, and — because
the run records itself — a new row in `localfinds.run_events`/`runs` (proves the `localfinds`
write role works). If it fails with a permission error, fix the role/DSN in step 1. Then open
https://localfinds.me/agents (steward) → the run appears with its transcript, cost within the
`agents.json` cap.

## 4. Install the daily cron

Find the box node bin dir (cron's PATH is minimal):

    dirname "$(command -v node)"      # e.g. /home/ubuntu/.nvm/versions/node/vXX/bin

`crontab -e` and add (substitute <node-bin-dir>):

    0 7 * * * PATH=<node-bin-dir>:/usr/local/bin:/usr/bin:/bin /var/www/localfinds/scripts/run-agents.sh

Verify + test the exact cron environment now (don't wait for 07:00):

    crontab -l | grep run-agents
    env -i PATH=<node-bin-dir>:/usr/local/bin:/usr/bin:/bin HOME=/home/ubuntu /var/www/localfinds/scripts/run-agents.sh
    tail -n 20 /var/www/localfinds/data/agents/cron.log      # shows a full roster cycle

## 5. Verify the on-demand trigger

Steward: on https://localfinds.me/agents click a run trigger (e.g. scout). It should start a run —
the spawned CLI now gets the WRITE DSN because `actions.ts` strips the inherited read-only one —
visible live on the page. Logged-out/member cannot trigger (the write gate).

## 6. Deploy-safe check

`.env` is gitignored and the crontab lives outside the checkout, so both survive `npm run deploy`
(`deploy-code.sh`'s `git clean` runs without `-x`). Re-run step 3's smoke after a later deploy.

## Rollback

    crontab -e                       # delete the run-agents line
    rm /var/www/localfinds/.env      # removes the box agent key + write DSN
