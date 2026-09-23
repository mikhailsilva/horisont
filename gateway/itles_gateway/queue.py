"""Durable FIFO in SQLite (WAL, synchronous=FULL).

A device deletes its archive after our ACK, so records are committed to disk before the ACK is
written to the socket. Records leave the queue only when the platform confirms them (stored or
duplicate) or rejects them as invalid; unknown trackers are parked and retried.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time

SCHEMA = """
create table if not exists q (
  id integer primary key autoincrement,
  ext_id text not null,
  proto text not null,
  received_at real not null,
  payload text not null,
  tries integer not null default 0,
  next_try real not null default 0,
  last_error text
);
create index if not exists q_next on q(next_try, id);
"""

PARK_MAX_S = 3600.0
RETENTION_S = 60 * 86400.0


class DurableQueue:
    def __init__(self, path: str):
        self.path = path
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.execute("pragma journal_mode=wal")
        self.db.execute("pragma synchronous=full")
        self.db.executescript(SCHEMA)

    def put(self, ext_id: str, proto: str, records: list[dict]) -> None:
        if not records:
            return
        now = time.time()
        with self.lock:
            self.db.execute("begin immediate")
            try:
                self.db.executemany(
                    "insert into q (ext_id, proto, received_at, payload) values (?, ?, ?, ?)",
                    [(ext_id, proto, now, json.dumps(r, separators=(",", ":"))) for r in records],
                )
                self.db.execute("commit")
            except Exception:
                self.db.execute("rollback")
                raise

    def take(self, limit: int = 1000) -> list[tuple[int, str, dict, int]]:
        with self.lock:
            rows = self.db.execute(
                "select id, ext_id, payload, tries from q where next_try <= ? order by id limit ?", (time.time(), limit)
            ).fetchall()
        return [(i, e, json.loads(p), t) for i, e, p, t in rows]

    def ack(self, ids: list[int]) -> None:
        if not ids:
            return
        with self.lock:
            self.db.execute("begin immediate")
            self.db.executemany("delete from q where id = ?", [(i,) for i in ids])
            self.db.execute("commit")

    def retry(self, ids: list[int], error: str, park: bool = False) -> None:
        now = time.time()
        with self.lock:
            self.db.execute("begin immediate")
            for i in ids:
                row = self.db.execute("select tries, received_at from q where id = ?", (i,)).fetchone()
                if not row:
                    continue
                tries, received = row
                if park and now - received > RETENTION_S:
                    self.db.execute("delete from q where id = ?", (i,))
                    continue
                delay = min(PARK_MAX_S if park else 300.0, 5.0 * (2 ** min(tries, 10)))
                self.db.execute(
                    "update q set tries = tries + 1, next_try = ?, last_error = ? where id = ?", (now + delay, error[:300], i)
                )
            self.db.execute("commit")

    def size(self) -> int:
        with self.lock:
            return self.db.execute("select count(*) from q").fetchone()[0]

    def close(self) -> None:
        self.db.close()
