#!/usr/bin/env bash
# (Re)start the АвтоГРАФ.WEB emulator + temporary Cloudflare quick tunnel. Does not touch the ITles stand/gateway
# or the Traccar demo. Credentials live in .env (mode 0600) next to this script and are never printed.
cd /home/workspace/itles-autograph-demo || exit 1
for p in $(pgrep -f "[p]ersonal_autograph.py") $(pgrep -f "[c]loudflared tunnel --no-autoupdate --url http://127.0.0.1:8766"); do kill "$p" 2>/dev/null; done
sleep 1
setsid nohup bash -c 'set -a; . ./.env; set +a; exec python3 personal_autograph.py' > /dev/shm/itles-autograph.log 2>&1 < /dev/null &
setsid nohup ../itles-traccar-demo/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8766 > /dev/shm/itles-autograph-tunnel.log 2>&1 < /dev/null &
for i in $(seq 1 40); do u=$(grep -o "https://[a-z0-9-]*\.trycloudflare\.com" /dev/shm/itles-autograph-tunnel.log | head -1); [ -n "$u" ] && break; sleep 1; done
echo "${u:-tunnel URL not ready}" | tee public-url.txt
