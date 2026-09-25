#!/usr/bin/env bash
# (Re)start the personal Traccar demo + temporary Cloudflare quick tunnel. Does not touch the ITles stand/gateway.
cd /home/workspace/itles-traccar-demo || exit 1
for p in $(pgrep -f "[p]ersonal_traccar.py") $(pgrep -f "[c]loudflared tunnel --url http://127.0.0.1:8765"); do kill "$p" 2>/dev/null; done
sleep 1
setsid nohup ./run.sh > /dev/shm/itles-traccar.log 2>&1 < /dev/null &
setsid nohup ./cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8765 > /dev/shm/itles-traccar-tunnel.log 2>&1 < /dev/null &
for i in $(seq 1 30); do u=$(grep -o "https://[a-z0-9-]*\.trycloudflare\.com" /dev/shm/itles-traccar-tunnel.log | head -1); [ -n "$u" ] && break; sleep 1; done
echo "${u:-tunnel URL not ready}" | tee public-url.txt
