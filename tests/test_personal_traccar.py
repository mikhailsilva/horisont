import base64
import json
import threading
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from urllib.parse import urlencode

from stand.personal_traccar import SAMPLES, TraccarHandler, sample_position


def test_personal_counters_use_elapsed_time():
    p = sample_position(SAMPLES[0], datetime(2026, 9, 25, tzinfo=timezone.utc))
    assert 4200 < p["attributes"]["hours"] / 3_600_000 < 6000
    assert 80_000 < p["attributes"]["odometer"] / 1000 < 100_000


def test_personal_traccar_compat_api(monkeypatch):
    monkeypatch.setattr(TraccarHandler, "username", "demo-user")
    monkeypatch.setattr(TraccarHandler, "password", "a-long-private-test-password")
    server = ThreadingHTTPServer(("127.0.0.1", 0), TraccarHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    auth = "Basic " + base64.b64encode(b"demo-user:a-long-private-test-password").decode()

    def get(path, authorization=auth):
        headers = {"Authorization": authorization} if authorization else {}
        request = urllib.request.Request(base + path, headers=headers)
        with urllib.request.urlopen(request) as response:
            return response.status, response.headers, response.read()

    try:
        status, _, raw = get("/api/server")
        assert status == 200
        assert json.loads(raw)["version"] == "compatible-emulator-1.0"

        status, headers, raw = get("/api/devices")
        assert status == 200
        assert headers["Cache-Control"] == "no-store"
        devices = json.loads(raw)
        assert len(devices) == 3
        assert {d["uniqueId"] for d in devices} == {d["uniqueId"] for d in SAMPLES}

        status, _, raw = get("/api/positions")
        positions = json.loads(raw)
        assert status == 200 and len(positions) == 3
        assert all(p["valid"] and p["attributes"]["hours"] > 0 for p in positions)

        start = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        end = datetime.now(timezone.utc).isoformat()
        history = json.loads(get("/api/positions?" + urlencode({
            "deviceId": "101", "from": start, "to": end,
        }))[2])
        assert 1 <= len(history) <= 5
        assert all(p["deviceId"] == 101 for p in history)

        try:
            get("/api/devices", "Basic " + base64.b64encode(b"demo-user:wrong").decode())
        except urllib.error.HTTPError as error:
            assert error.code == 401
            assert error.headers["WWW-Authenticate"].startswith("Basic ")
        else:
            raise AssertionError("invalid credentials should fail")

        request = urllib.request.Request(base + "/api/devices", data=b"{}", method="POST", headers={"Authorization": auth})
        try:
            urllib.request.urlopen(request)
        except urllib.error.HTTPError as error:
            assert error.code == 405
        else:
            raise AssertionError("write operations should be rejected")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
