import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from urllib.parse import urlencode

import pytest

from stand.personal_autograph import AutographHandler, SCHEMA, UNITS, timespan


def test_timespan_matches_dotnet_format():
    assert timespan(26.5) == "1.02:30:00"
    assert timespan(3120) == "130.00:00:00"


@pytest.fixture()
def base(monkeypatch):
    monkeypatch.setattr(AutographHandler, "password", "a-long-private-test-password")
    monkeypatch.setattr(AutographHandler, "tokens", set())
    server = ThreadingHTTPServer(("127.0.0.1", 0), AutographHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}/ServiceJSON"
    server.shutdown()


def request(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def test_autograph_emulator_contract(base):
    assert request(base + "/Login", urlencode({"UserName": "itles-demo", "Password": "wrong"}).encode())[0] == 401
    status, token = request(base + "/Login", urlencode({"UserName": "itles-demo", "Password": "a-long-private-test-password"}).encode())
    assert status == 200 and len(token) == 128
    assert request(base + "/EnumSchemas")[0] == 401
    h = {"AG-Token": token}
    assert json.loads(request(base + "/EnumSchemas", headers=h)[1]) == [SCHEMA]
    items = json.loads(request(f"{base}/EnumDevices?schemaID={SCHEMA['ID']}", headers=h)[1])["Items"]
    assert [i["ID"] for i in items] == [u["id"] for u in UNITS]
    ids = ",".join(u["id"] for u in UNITS)
    online = json.loads(request(f"{base}/GetOnlineInfo?schemaID={SCHEMA['ID']}&IDs={ids}", headers=h)[1])
    assert "Rotation" in online["vds-k742"]["Final"] and "Rotation" not in online["vds-mtz82"]["Final"]
    assert online["vds-jd8r"]["Final"]["MotohoursByCANEmh"].count(":") == 2
    track = json.loads(request(f"{base}/GetTrack?schemaID={SCHEMA['ID']}&IDs=vds-k742&SD=20200101-000000&ED=20990101-000000", headers=h)[1])
    assert 500 < len(track["vds-k742"][0]["DT"]) <= 577
    too_many = ",".join(f"x{i}" for i in range(11))
    assert request(f"{base}/GetOnlineInfo?schemaID={SCHEMA['ID']}&IDs={too_many}", headers=h)[0] == 429
