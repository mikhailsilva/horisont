"""АвтоГРАФ delivery paths into the ITles gateway, simulated byte-for-byte on three modelled machines.

The paths come from ТехноКом documentation (docs/guide/autograph-technokom.md): a Series X controller sends a copy of
its data to a second server (SRV2TRANSPORT 1 = EGTS, 5 = Wialon IPS 2.1; USER_MANUAL_AG-X-SMS v3.2), or the
АвтоГРАФ.Сервер retranslates the whole fleet over EGTS. Encoders are the stand's (sim/protocols), decoders are the
gateway's. Machines, IDs and readings are synthetic; this is not a capture from a real АвтоГРАФ terminal.
"""

import math

from gateway.itles_gateway.protocols.egts import EgtsSession
from gateway.itles_gateway.protocols.wialon_ips import WialonIpsSession
from gateway.itles_gateway.records import Mapping
from sim.protocols import egts, egts_retranslator, wialon_ips

T0 = 1_790_035_200  # 2026-09-22 00:00 UTC
STEP = 300
DAY = 24 * 3600 // STEP
# serial, synthetic IMEI, CAN?, start engine hours, fuel l/h — the guide's three machines
MACHINES = [
    ("3500101", "860000035001017", True, 3120.0, 38.0),  # Кировец К-742М + АвтоГРАФ-SX, CAN J1939
    ("3500102", "860000035001025", True, 1875.0, 45.0),  # John Deere 8R 410 + АвтоГРАФ-GX, CAN J1939
    ("3500103", "860000035001033", False, 9640.0, 9.0),  # МТЗ-82.1 + АвтоГРАФ-SL, ignition input + fuel sensor
]


def state(n: int, i: int, hours0: float, lph: float):
    working = (i % 96) < 60  # 5 h of work, then 3 h parked
    hours = hours0 + sum(1 for k in range(i) if (k % 96) < 60) * STEP / 3600
    lat = 45.31 + 0.004 * math.sin(i / 20 + n)
    lon = 39.11 + 0.006 * math.cos(i / 23 + n)
    return working, hours, lat, lon, max(40.0, 600 - hours * lph % 500)


def egts_point(t, lat, lon, working, hours):
    return egts.EgtsPoint(t, lat, lon, True, 9.5 if working else 0.0, 90, 0.0, int(working), 120, 14, 0.8, working, False, {3: round(hours * 10)})


def test_second_server_egts_three_machines_one_day():
    for n, (serial, imei, _can, hours0, lph) in enumerate(MACHINES):
        s = EgtsSession(Mapping(egts_hours_counter=3, egts_hours_scale=0.1))
        s.feed(egts.transport(egts.record(1, egts.SERVICE_AUTH, egts.term_identity(int(serial), imei)), 0))
        assert s.ext_id == imei
        got = []
        for i in range(DAY):
            working, hours, lat, lon, _fuel = state(n, i, hours0, lph)
            p = egts_point(T0 + i * STEP, lat, lon, working, hours)
            subs = egts.pos_data(p) + egts.ext_pos_data(p) + egts.abs_counters(p.counters)
            for recs, reply in s.feed(egts.transport(egts.record(i + 2, egts.SERVICE_TELEDATA, subs), i + 1)):
                assert egts.decode(egts.split_frames(reply)[0][0])["result"] == 0
                got += recs
        assert len(got) == DAY
        eh = [r["engine_hours"] for r in got]
        assert eh == sorted(eh) and abs(eh[0] - hours0) < 0.1 and 14.9 < eh[-1] - eh[0] < 15.1
        assert all(45.3 < r["lat"] < 45.32 and 39.1 < r["lon"] < 39.12 for r in got)


def test_second_server_wialon_ips_three_machines_blackbox():
    for n, (serial, imei, can, hours0, lph) in enumerate(MACHINES):
        s = WialonIpsSession()
        s.feed(wialon_ips.login(imei, "NA"))
        msgs = []
        for i in range(DAY):
            working, hours, lat, lon, fuel = state(n, i, hours0, lph)
            # CAN machines report ECU hours; МТЗ-82.1 counts them from the ignition input in the controller
            params = {"can_engine_hours": round(hours, 2)} if can else {"engine_hours": round(hours, 2)}
            msgs.append(wialon_ips.WialonMessage(T0 + i * STEP, lat, lon, 9.5 if working else 0, 90, 120, 14, 0.8, int(working), params))
        got = []
        for k in range(0, DAY, 48):
            (recs, ack), = s.feed(wialon_ips.blackbox(msgs[k:k + 48]))
            assert ack == f"#AB#{len(recs)}\r\n".encode()
            got += recs
        assert len(got) == DAY
        assert {r["engine_hours_method"] for r in got} == {"ecu" if can else "tracker"}


def test_autograph_server_egts_retranslation_of_fleet():
    s = EgtsSession(Mapping(egts_hours_counter=3, egts_hours_scale=0.1))
    s.mappings = {serial: Mapping(egts_hours_counter=3, egts_hours_scale=0.1, sensors={"fuel_level_l": {"egts_lls": 1}}) for serial, *_ in MACHINES}
    (recs, _reply), = s.feed(egts.transport(egts.record(1, egts.SERVICE_AUTH, egts_retranslator.dispatcher_identity(35001, description="АвтоГРАФ.Сервер")), 0))
    assert recs == [] and s.dispatcher
    got = []
    for i in range(0, DAY, 6):
        body = b""
        for n, (serial, _imei, _can, hours0, lph) in enumerate(MACHINES):
            working, hours, lat, lon, fuel = state(n, i, hours0, lph)
            p = egts_point(T0 + i * STEP, lat, lon, working, hours)
            subs = egts.pos_data(p) + egts.ext_pos_data(p) + egts.abs_counters(p.counters) + egts_retranslator.liquid_level(1, fuel)
            body += egts.record(i * 3 + n + 2, egts.SERVICE_TELEDATA, subs, object_id=int(serial))
        (recs, reply), = s.feed(egts.transport(body, i + 1))
        assert egts.decode(egts.split_frames(reply)[0][0])["result"] == 0
        got += recs
    assert sorted({r["_ext"] for r in got}) == [m[0] for m in MACHINES]
    assert len(got) == 3 * DAY // 6
    assert all(r["sensors"]["fuel_level_l"] >= 40 and r["engine_hours"] > 1800 for r in got)
