# Personal Traccar connector demo

## Available directly in ITles

The real (non-demo) FUCHS superadministrator can open **Подключения → Traccar → Заполнить личный тест · 3 машины**. This fills the base URL and a scoped 24-hour token without saving a connector. Choose a separate test customer and click **Проверить без сохранения**; **Подключить** explicitly imports three synthetic machines. The token cannot log into ITles and stops working if its owner is disabled or loses superadministrator access. Renew the test credentials after expiry; do not treat the temporary demo as a permanent production source.

This fallback runs in the ITles HTTP backend, **not on the VPS**. It implements the connector-facing Traccar API, not an installation of Traccar software. It requires no extra account password and does not expose production tracker data. Histories are limited to 48 hours. Local verification used actual HTTP requests through the UI and connector, with synthetic positions only.

## VPS status — 2026-09-25 07:05 UTC

Deployed on the Zo machine (Debian 12 under gVisor, **no systemd**) in `/home/workspace/itles-traccar-demo`, separate from the ITles gateway/stand, which were not restarted. `run.sh` loads credentials from `.env` there (mode 0600, login `itles-demo`, random password — never commit it). Registration of a Zo user service returned HTTP 403, so public HTTPS goes through a **temporary Cloudflare Quick Tunnel** (`cloudflared`, outbound only, no account). Its `*.trycloudflare.com` URL changes whenever the tunnel restarts and is written to `public-url.txt`; the processes do not survive a Zo machine restart. Restart both with `stand/start-personal-traccar-zo.sh` (copied to the VPS as `start.sh`).

Verified on 2026-09-25: public HTTPS without credentials → 401; with credentials → 3 devices and current positions; the ITles connector dry-run (`/api/connectors/test`) against the public URL returned 3 devices. For a permanent address, register a Zo HTTP service on local port 8765 from the Zo UI or use a named Cloudflare tunnel.

This is a small, read-only **Traccar-compatible API emulator**, not Traccar server software. It serves three synthetic devices at `/api/devices` and latest/history records at `/api/positions`, which is enough to exercise ITles' existing Traccar connector and its dry-run check. Its Teltonika identifiers match the existing `yugtech` demo fleet. Coordinates and sensor readings are generated synthetic data; no tracker or customer is involved.

## Deployment

The optional `stand/install-personal-traccar.sh` installs a separate hardened systemd service on `127.0.0.1:8765`. It does not restart or change the gateway or fleet simulator. First install generates a random Basic-auth password in `/etc/itles/personal-traccar.env` (root-owned, mode `0600`) and prints only the non-secret login and credential-file path. Re-running preserves that credential. Never check the environment file into git or paste its contents into chat.

Put a route on an **already configured TLS reverse proxy**; do not expose port 8765 to the public network. For nginx, a site can map `/traccar-demo/` to loopback and strip the prefix:

```nginx
location ^~ /traccar-demo/ {
    proxy_pass http://127.0.0.1:8765/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Authorization $http_authorization;
}
```

Set the ITles Traccar connector base URL to `https://<existing-proxy-host>/traccar-demo` (without a trailing `/api`), login to `itles-demo`, and use the password stored on the VPS. The proxy host must already resolve to that VPS and have valid HTTPS. Do not use a Vercel URL unless it actually proxies requests to this VPS.

## API scope and verification

Basic authentication is mandatory. Only `GET /api/server`, `GET /api/devices`, and `GET /api/positions` are implemented; write requests are rejected. Position history is bounded to 30 days and 2,881 15-minute samples per device/request. This is enough for connector smoke/dry-run testing, not a replacement for protocol acceptance, Traccar device registration, or a mounted-machine test.

Run `.venv/bin/python -m pytest -q tests/test_personal_traccar.py` for local protocol/API checks. The app-side dry-run endpoint can verify connectivity once its UI/API change is integrated.
