# SP7 provisioning — one-time, before the first API deploy

All commands run on the box (or in DNS/console) — Neil executes. Idempotent top to bottom.

## 1. DNS
A record: `api.localfinds.me` → 52.20.249.147 (the EIP). Wait for `dig +short api.localfinds.me`
to answer before section 5.

## 2. Erlang/Elixir via mise (matches dev: OTP 27, Elixir 1.18.4)

    sudo apt-get update && sudo apt-get install -y build-essential autoconf m4 \
      libncurses-dev libssl-dev
    curl https://mise.run | sh
    ~/.local/bin/mise use -g erlang@27 elixir@1.18.4-otp-27   # erlang compiles ~10-15 min

    ~/.local/share/mise/shims/elixir --version   # expect 1.18.4 / OTP 27

## 3. Read-only Postgres role

    PW=$(openssl rand -hex 24)
    sudo -u postgres psql -c "CREATE ROLE localfinds_api LOGIN PASSWORD '$PW'"
    sudo -u postgres psql -d localfinds -c "
      GRANT CONNECT ON DATABASE localfinds TO localfinds_api;
      GRANT USAGE ON SCHEMA public TO localfinds_api;
      GRANT SELECT ON public.osm_places TO localfinds_api;"
    echo "$PW"   # goes into DATABASE_URL below, then forget it

SELECT on the matview and nothing else: a bug in this app cannot write, let alone touch
the localfinds schema. (P2 will widen this to the two auth tables — nothing else.)

## 4. Environment file (mode 600, root-owned)

    sudo install -m 600 /dev/null /etc/localfinds-api.env
    sudo tee /etc/localfinds-api.env >/dev/null <<EOF
    DATABASE_URL=postgres://localfinds_api:<PW>@127.0.0.1:5432/localfinds
    SECRET_KEY_BASE=<run on dev: cd phoenix && mix phx.gen.secret>
    BEARER_TOKEN=<openssl rand -hex 32>
    PHX_HOST=api.localfinds.me
    PORT=4000
    PHX_SERVER=1
    EOF

## 5. nginx + cert

    sudo tee /etc/nginx/sites-available/localfinds-api >/dev/null <<'EOF'
    server {
        server_name api.localfinds.me;
        listen 80;
        location / {
            proxy_pass http://127.0.0.1:4000;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
    }
    EOF
    sudo ln -sf /etc/nginx/sites-available/localfinds-api /etc/nginx/sites-enabled/
    sudo nginx -t && sudo systemctl reload nginx
    sudo certbot --nginx -d api.localfinds.me

## 6. systemd unit + deploy sudoers rule

    sudo tee /etc/systemd/system/localfinds-api.service >/dev/null <<EOF
    [Unit]
    Description=LocalFinds Phoenix API
    After=network.target postgresql.service

    [Service]
    User=ubuntu
    WorkingDirectory=<DEPLOY_PATH>/phoenix
    EnvironmentFile=/etc/localfinds-api.env
    ExecStart=<DEPLOY_PATH>/phoenix/_build/prod/rel/localfinds/bin/localfinds start
    ExecStop=<DEPLOY_PATH>/phoenix/_build/prod/rel/localfinds/bin/localfinds stop
    Restart=on-failure
    RestartSec=5

    [Install]
    WantedBy=multi-user.target
    EOF
    sudo systemctl daemon-reload && sudo systemctl enable localfinds-api

    echo 'ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl restart localfinds-api' | \
      sudo tee /etc/sudoers.d/localfinds-api
    sudo chmod 440 /etc/sudoers.d/localfinds-api

Don't start the service yet — no release is built until the first deploy (Task 8).

## 7. Dev-side config

In data/config/deploy.env (gitignored) add:

    DEPLOY_MIX_PREFIX='export PATH="$HOME/.local/share/mise/shims:$PATH" && '
