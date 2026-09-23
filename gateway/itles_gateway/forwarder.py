"""Moves queued records to the platform API; idempotent because the API dedupes by (source, time)."""

from __future__ import annotations

import json
import logging
import threading
import urllib.error
import urllib.request

from .queue import DurableQueue

log = logging.getLogger("itles.forwarder")

# rejections that will never succeed on retry
PERMANENT = {
    "bad_time", "time_too_old", "time_in_future", "bad_coordinates", "bad_engine_hours", "bad_odometer",
    "no_data", "not_an_object", "bad_sensor",
}


class Forwarder:
    def __init__(self, queue: DurableQueue, api_url: str, token: str, batch: int = 1000, timeout: float = 30.0):
        self.q = queue
        self.url = api_url.rstrip("/") + "/api/ingest"
        self.token = token
        self.batch = batch
        self.timeout = timeout
        self.stop = threading.Event()

    def post(self, records: list[dict]) -> dict:
        body = json.dumps({"records": records}, separators=(",", ":")).encode()
        req = urllib.request.Request(
            self.url,
            data=body,
            method="POST",
            headers={"content-type": "application/json", "authorization": f"Bearer {self.token}", "x-itles-client": "gateway"},
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            return json.loads(r.read())

    def run_once(self) -> int:
        items = self.q.take(self.batch)
        if not items:
            return 0
        records = [{**payload, "ext_id": ext} for (_i, ext, payload, _t) in items]
        ids = [i for (i, *_rest) in items]
        try:
            res = self.post(records)
        except urllib.error.HTTPError as e:
            log.warning("platform HTTP %s; keeping %d records", e.code, len(ids))
            self.q.retry(ids, f"http {e.code}")
            return 0
        except Exception as e:  # network, timeout, bad JSON: keep everything
            log.warning("platform unreachable (%s); keeping %d records", e, len(ids))
            self.q.retry(ids, str(e))
            return 0
        done: list[int] = []
        parked: list[int] = []
        retry: list[int] = []
        for r in res.get("results", []):
            if r.get("status") == "unknown_device":
                parked += [ids[i] for i in r.get("indexes", [])]
                continue
            bad = {x["index"]: x["reason"] for x in r.get("rejected", [])}
            indexes = [i for i, rec in enumerate(records) if rec["ext_id"] == r.get("ext_id")]
            for i in indexes:
                reason = bad.get(i)
                if reason is None or reason in PERMANENT:
                    done.append(ids[i])
                else:
                    retry.append(ids[i])
        self.q.ack(done)
        if parked:
            self.q.retry(parked, "unknown_device", park=True)
        if retry:
            self.q.retry(retry, "rejected_retryable")
        return len(done)

    def loop(self, idle: float = 1.0) -> None:
        while not self.stop.is_set():
            try:
                n = self.run_once()
            except Exception:
                log.exception("forwarder iteration failed")
                n = 0
            if n == 0:
                self.stop.wait(idle)
