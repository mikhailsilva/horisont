"""Read-only АвтоГРАФ.WEB (ServiceJSON) API emulator for testing the ITles connector on a VDS.

Implements only Login, EnumSchemas, EnumDevices, GetOnlineInfo and GetTrack with the behaviour observed on the
vendor's public server https://demo.tk-nav.com (plain-text token, AG-Token header, 401 on bad credentials,
429 above 10 objects). The three machines and all readings are synthetic, not field data.
"""

from __future__ import annotations

import hmac
import json
import math
import os
import secrets
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

SCHEMA = {"ID": "vds-autograph-schema", "Name": "ITles · VDS эмулятор АвтоГРАФ", "Group": "", "GroupID": "", "State": True}
UNITS = (
    {"id": "vds-k742", "serial": 3500101, "name": "VDS — Кировец К-742М · АвтоГРАФ-SX (CAN)", "reg": "23 КК 7421", "lat": 45.3102, "lon": 39.1105, "can": True, "hours0": 3120.0, "lph": 38.0},
    {"id": "vds-jd8r", "serial": 3500102, "name": "VDS — John Deere 8R 410 · АвтоГРАФ-GX (CAN)", "reg": "23 КК 8410", "lat": 45.2795, "lon": 39.0561, "can": True, "hours0": 1875.0, "lph": 45.0},
    {"id": "vds-mtz82", "serial": 3500103, "name": "VDS — МТЗ-82.1 · АвтоГРАФ-SL + ДУТ (без CAN)", "reg": "23 КК 0821", "lat": 45.3344, "lon": 39.1712, "can": False, "hours0": 9640.0, "lph": 9.0},
)
ANCHOR = datetime(2026, 1, 1, tzinfo=timezone.utc)
STEP = timedelta(minutes=5)
HISTORY_LIMIT = timedelta(hours=48)
MAX_IDS = 10


def iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def timespan(hours: float) -> str:
    total = int(hours * 3600)
    d, rest = divmod(total, 86400)
    return f"{d}.{rest // 3600:02d}:{rest % 3600 // 60:02d}:{rest % 60:02d}"


def sample(unit: dict, t: datetime) -> dict:
    n = UNITS.index(unit)
    phase = t.timestamp() / 7200 + n * 2.1
    hours = unit["hours0"] + max(0.0, (t - ANCHOR).total_seconds() / 3600) * 0.55
    working = math.sin(phase) > -0.3
    tank = 700 - (t.timestamp() / 3600 * unit["lph"]) % 500
    return {
        "lat": unit["lat"] + math.sin(phase) * 0.004,
        "lon": unit["lon"] + math.cos(phase * 0.9) * 0.006,
        "speed": round(7 + abs(math.sin(phase * 3)) * 5, 1) if working else 0.0,
        "course": round((phase * 40) % 360, 1),
        "hours": hours,
        "fuel": round(tank if unit["can"] else tank * 0.25, 1),
        "rpm": round(1500 + math.sin(phase * 5) * 250) if working else 800,
        "coolant": round(86 + math.sin(phase * 2) * 4, 1) if working else 70.0,
        "consumption": round((hours - unit["hours0"]) * unit["lph"], 1),
    }


def parse_stamp(value: str) -> datetime:
    return datetime.strptime(value, "%Y%m%d-%H%M%S").replace(tzinfo=timezone.utc)


def online(unit: dict, now: datetime) -> dict:
    s = sample(unit, now)
    final = {"MotohoursByCANEmh": timespan(s["hours"]), "FuelLevel": s["fuel"], "Speed": s["speed"]}
    if unit["can"]:
        final.update({"Rotation": s["rpm"], "СoolantTemper": s["coolant"], "Consumption": s["consumption"]})
    return {
        "ID": unit["id"], "Name": unit["name"], "_LastCoords": iso(now), "_LastData": iso(now), "DT": iso(now),
        "LastPosition": {"Lat": s["lat"], "Lng": s["lon"]}, "Speed": s["speed"], "Course": s["course"], "State": 1, "Final": final,
    }


def track(unit: dict, start: datetime, end: datetime) -> list:
    t = datetime.fromtimestamp(math.ceil(start.timestamp() / STEP.total_seconds()) * STEP.total_seconds(), timezone.utc)
    cols: dict[str, list] = {"DT": [], "Lat": [], "Lng": [], "Speed": []}
    while t <= end:
        s = sample(unit, t)
        cols["DT"].append(iso(t)); cols["Lat"].append(s["lat"]); cols["Lng"].append(s["lon"]); cols["Speed"].append(s["speed"])
        t += STEP
    return [{"Index": 0, **cols}] if cols["DT"] else []


class AutographHandler(BaseHTTPRequestHandler):
    username = os.environ.get("AUTOGRAPH_DEMO_USER", "itles-demo")
    password = os.environ.get("AUTOGRAPH_DEMO_PASSWORD", "")
    tokens: set[str] = set()
    server_version = "ITles-AutoGRAPH-emulator"

    def log_message(self, fmt: str, *args) -> None:  # no credentials or tokens in logs
        pass

    def send(self, status: int, body: object = b"", ctype: str = "application/json; charset=utf-8") -> None:
        raw = body if isinstance(body, bytes) else (body.encode() if isinstance(body, str) else json.dumps(body, ensure_ascii=False).encode())
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self) -> None:
        url = urlsplit(self.path)
        if not url.path.endswith("/ServiceJSON/Login"):
            return self.send(404)
        length = min(int(self.headers.get("Content-Length") or 0), 4096)
        form = parse_qs(self.rfile.read(length).decode("utf-8", "replace"))
        user, pw = form.get("UserName", [""])[0], form.get("Password", [""])[0]
        if not self.password or not (hmac.compare_digest(user, self.username) and hmac.compare_digest(pw, self.password)):
            return self.send(401)
        token = secrets.token_hex(64).upper()
        self.tokens.add(token)
        self.send(200, token, "text/plain")

    def do_GET(self) -> None:
        url = urlsplit(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        method = url.path.rsplit("/", 1)[-1]
        if "/ServiceJSON/" not in url.path:
            return self.send(404)
        token = self.headers.get("AG-Token") or q.get("session", "")
        if token not in self.tokens:
            return self.send(401)
        if method == "EnumSchemas":
            return self.send(200, [SCHEMA])
        if q.get("schemaID") != SCHEMA["ID"]:
            return self.send(400, {"ok": False, "msg": "Неизвестная схема"})
        if method == "EnumDevices":
            items = [{"ID": u["id"], "ParentID": "g", "Name": u["name"], "Serial": u["serial"], "Allowed": True,
                      "Properties": [{"Inherited": False, "Type": 0, "Name": "VehicleRegNumber", "Value": u["reg"]}]} for u in UNITS]
            return self.send(200, {"ID": SCHEMA["ID"], "Groups": [{"ID": "g", "ParentID": None, "Name": "Поле 12"}], "Items": items})
        ids = [i for i in q.get("IDs", "").split(",") if i]
        if len(ids) > MAX_IDS:
            return self.send(429, {"ok": False, "msg": f"В запросе {len(ids)} объектов мониторинга, количество в одном запросе не должно превышать {MAX_IDS}."})
        chosen = [u for u in UNITS if u["id"] in ids]
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        if method == "GetOnlineInfo":
            return self.send(200, {u["id"]: online(u, now) for u in chosen})
        if method == "GetTrack":
            try:
                start, end = parse_stamp(q["SD"]), parse_stamp(q["ED"])
            except (KeyError, ValueError):
                return self.send(400, {"ok": False, "msg": "SD/ED: yyyyMMdd-HHmmss"})
            start, end = max(start, now - HISTORY_LIMIT), min(end, now)
            return self.send(200, {u["id"]: track(u, start, end) for u in chosen})
        self.send(404)


def main() -> None:
    if len(AutographHandler.password) < 16:
        raise SystemExit("AUTOGRAPH_DEMO_PASSWORD must be set (16+ characters)")
    port = int(os.environ.get("PORT", "8766"))
    ThreadingHTTPServer(("127.0.0.1", port), AutographHandler).serve_forever()


if __name__ == "__main__":
    main()
