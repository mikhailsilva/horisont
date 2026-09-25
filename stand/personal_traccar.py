"""Small read-only Traccar REST API emulator for testing the ITles connector."""

from __future__ import annotations

import base64
import hmac
import json
import math
import os
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

SAMPLES = (
    {"id": 101, "uniqueId": "352102127408282", "name": "Трактор — тест", "model": "FMC650"},
    {"id": 102, "uniqueId": "352102124612720", "name": "Экскаватор — тест", "model": "FMB640"},
    {"id": 103, "uniqueId": "352102120046360", "name": "Погрузчик — тест", "model": "FMC650"},
)


def iso_time(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.utcoffset() is None:
        raise ValueError("position times must include a timezone")
    return parsed.astimezone(timezone.utc)


def sample_position(device: dict, instant: datetime) -> dict:
    tick = int(instant.timestamp() // 900)
    elapsed_hours = max(0, (instant - datetime(2026, 1, 1, tzinfo=timezone.utc)).total_seconds() / 3600)
    phase = tick / 18 + device["id"]
    lat = 45.03 + 0.0018 * math.sin(phase)
    lon = 39.04 + 0.0025 * math.cos(phase * 0.77)
    moving = tick % 5 < 4
    return {
        "id": device["id"] * 1_000_000 + tick,
        "deviceId": device["id"],
        "protocol": "demo",
        "serverTime": iso_time(instant),
        "deviceTime": iso_time(instant),
        "fixTime": iso_time(instant),
        "valid": True,
        "latitude": round(lat, 6),
        "longitude": round(lon, 6),
        "altitude": 62.0,
        "speed": 9.7 if moving else 0.0,
        "course": int((tick * 11 + device["id"]) % 360),
        "attributes": {
            "sat": 12,
            "hdop": 0.8,
            "hours": (4200 + (device["id"] - 101) * 320 + elapsed_hours * 0.08) * 3_600_000,
            "odometer": (80_000 + (device["id"] - 101) * 120 + elapsed_hours * 1.4) * 1000,
        },
    }


def positions(device_id: int | None, start: datetime | None, end: datetime | None, now: datetime) -> list[dict]:
    devices = [d for d in SAMPLES if device_id is None or d["id"] == device_id]
    if not devices:
        return []
    if start is None:
        samples = [now - timedelta(seconds=int(now.timestamp()) % 900)]
    else:
        end = min(end or now, now)
        start = max(start, now - timedelta(days=30))
        if end < start:
            return []
        first = int(start.timestamp() // 900)
        last = int(end.timestamp() // 900)
        if last - first > 2880:
            raise ValueError("history range exceeds 30 days")
        samples = [datetime.fromtimestamp(t * 900, timezone.utc) for t in range(first, last + 1)]
    return [sample_position(d, t) for d in devices for t in samples]


class TraccarHandler(BaseHTTPRequestHandler):
    server_version = "Traccar-compatible-test/1.0"
    sys_version = ""
    username = os.environ.get("TRACCAR_DEMO_USER", "itles-demo")
    password = os.environ.get("TRACCAR_DEMO_PASSWORD", "")

    def log_message(self, _format: str, *_args) -> None:
        return

    def send_json(self, status: int, data, extra_headers: dict[str, str] | None = None) -> None:
        body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def authorized(self) -> bool:
        if not self.password:
            self.send_json(503, {"error": "demo credentials are not configured"})
            return False
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            self.send_json(401, {"error": "unauthorized"}, {"WWW-Authenticate": 'Basic realm="ITles demo"'})
            return False
        try:
            supplied = base64.b64decode(header[6:], validate=True).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            supplied = ""
        expected = f"{self.username}:{self.password}"
        if not hmac.compare_digest(supplied, expected):
            self.send_json(401, {"error": "unauthorized"}, {"WWW-Authenticate": 'Basic realm="ITles demo"'})
            return False
        return True

    def do_GET(self) -> None:
        if not self.authorized():
            return
        parsed = urlsplit(self.path)
        query = parse_qs(parsed.query)
        if parsed.path == "/api/server":
            self.send_json(200, {"id": 1, "version": "compatible-emulator-1.0", "registration": False})
            return
        if parsed.path == "/api/devices":
            now = datetime.now(timezone.utc)
            result = []
            for device in SAMPLES:
                latest = positions(device["id"], None, None, now)[0]
                result.append({
                    **device,
                    "status": "online",
                    "disabled": False,
                    "lastUpdate": latest["fixTime"],
                    "positionId": latest["id"],
                    "groupId": 1,
                    "attributes": {},
                })
            self.send_json(200, result)
            return
        if parsed.path == "/api/positions":
            try:
                raw_device_id = query.get("deviceId", [None])[0]
                device_id = int(raw_device_id) if raw_device_id is not None else None
                known_ids = {d["id"] for d in SAMPLES}
                if device_id is not None and device_id not in known_ids:
                    self.send_json(200, [])
                    return
                from_raw, to_raw = query.get("from", [None])[0], query.get("to", [None])[0]
                start = parse_time(from_raw) if from_raw else None
                end = parse_time(to_raw) if to_raw else None
                result = positions(device_id, start, end, datetime.now(timezone.utc))
            except (ValueError, OverflowError):
                self.send_json(400, {"error": "invalid or excessive position query"})
                return
            self.send_json(200, result)
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        self.send_json(405, {"error": "read-only demo"}, {"Allow": "GET"})

    def do_PUT(self) -> None:
        self.do_POST()

    def do_DELETE(self) -> None:
        self.do_POST()


def main() -> None:
    host = os.environ.get("TRACCAR_DEMO_BIND", "127.0.0.1")
    port = int(os.environ.get("TRACCAR_DEMO_PORT", "8765"))
    if not TraccarHandler.password:
        raise SystemExit("TRACCAR_DEMO_PASSWORD must be set in the private environment file")
    server = ThreadingHTTPServer((host, port), TraccarHandler)
    server.daemon_threads = True
    print(f"Traccar-compatible demo listening on {host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
