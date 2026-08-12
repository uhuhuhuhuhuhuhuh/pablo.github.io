#!/usr/bin/env python3
"""Build a static exact-chunk catalog for Infinite Corridor IC2C.

Designed for S:\\train_ic2 and the v1.4 bulk trainer state. It re-streams
successfully learned public source objects, computes the same FastCDC chunking
used by the browser, verifies each complete source SHA-256 against the trainer
SQLite state, and writes a sharded catalog suitable for GitHub Pages.

Raw source objects are never retained. Per-source chunk-record files and a
small resume SQLite database are retained locally so interrupted builds resume.
"""
from __future__ import annotations

import argparse
import collections
import concurrent.futures as cf
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import struct
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone
from typing import Iterable

VERSION = "1.0"
FORMAT = "IC2_CORPUS_CATALOG_V1"
UA = "InfiniteCorridorCorpusCatalog/1.0"
FASTCDC_MIN = 16 * 1024
FASTCDC_AVG = 64 * 1024
FASTCDC_MAX = 256 * 1024
STREAM_CHUNK = 4 * 1024 * 1024
PREFIX_HEX_CHARS = 3
SOURCE_RECORD = struct.Struct("<32sQI")
SHARD_RECORD = struct.Struct("<32sIQI")
MAX_RETRIES = 4
PRINT_LOCK = threading.Lock()


def log(tag: str, msg: str) -> None:
    with PRINT_LOCK:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] [{tag:<10}] {msg}", flush=True)


def human_bytes(n: float | int) -> str:
    n = float(n)
    units = ["B", "KiB", "MiB", "GiB", "TiB"]
    u = 0
    while n >= 1024 and u < len(units) - 1:
        n /= 1024.0
        u += 1
    return f"{n:.2f} {units[u]}" if u else f"{int(n)} B"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def gear_table() -> list[int]:
    t: list[int] = []
    x = 0x9E3779B9
    for _ in range(256):
        x ^= (x << 13) & 0xFFFFFFFF
        x &= 0xFFFFFFFF
        x ^= x >> 17
        x &= 0xFFFFFFFF
        x ^= (x << 5) & 0xFFFFFFFF
        x &= 0xFFFFFFFF
        t.append(x)
    return t


GEAR = gear_table()


class FastCDCStream:
    def __init__(self) -> None:
        self.buf = bytearray()
        self.gear = 0
        self.offset = 0

    def feed(self, data: bytes) -> Iterable[tuple[int, bytes]]:
        for b in data:
            self.buf.append(b)
            self.gear = ((self.gear << 1) + GEAR[b]) & 0xFFFFFFFF
            n = len(self.buf)
            if n >= FASTCDC_MIN:
                mask = 0x1FFFF if n < FASTCDC_AVG else 0x7FFF
                if n >= FASTCDC_MAX or (self.gear & mask) == 0:
                    chunk = bytes(self.buf)
                    start = self.offset
                    self.offset += len(chunk)
                    self.buf.clear()
                    self.gear = 0
                    yield start, chunk

    def finish(self) -> Iterable[tuple[int, bytes]]:
        if self.buf:
            chunk = bytes(self.buf)
            start = self.offset
            self.offset += len(chunk)
            self.buf.clear()
            self.gear = 0
            yield start, chunk


def open_url(url: str, headers: dict[str, str] | None = None, timeout: int = 120):
    h = {"User-Agent": UA, "Accept-Encoding": "identity"}
    if headers:
        h.update(headers)
    return urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout)


def range_probe(url: str) -> bool:
    try:
        with open_url(url, {"Range": "bytes=0-0"}, timeout=45) as r:
            status = getattr(r, "status", 200)
            if status != 206:
                return False
            cr = str(r.headers.get("Content-Range") or "")
            return cr.lower().startswith("bytes 0-0/")
    except Exception:
        return False


class BuildState:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS sources(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          url TEXT UNIQUE NOT NULL,
          name TEXT,
          source TEXT,
          expected_size INTEGER NOT NULL DEFAULT 0,
          expected_sha256 TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          range_ok INTEGER,
          chunks INTEGER NOT NULL DEFAULT 0,
          bytes INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
        """)
        self.db.commit()

    def import_trainer(self, trainer_db: Path) -> int:
        src = sqlite3.connect(trainer_db)
        cols = {r[1] for r in src.execute("PRAGMA table_info(processed)")}
        learned_clause = "AND COALESCE(learned_unique,1)=1" if "learned_unique" in cols else ""
        rows = src.execute(f"""
            SELECT url,name,source,COALESCE(bytes_read,0),sha256
            FROM processed
            WHERE status='done' {learned_clause}
              AND url IS NOT NULL AND (url LIKE 'http://%' OR url LIKE 'https://%')
              AND sha256 IS NOT NULL
            ORDER BY rowid
        """).fetchall()
        src.close()
        added = 0
        for url, name, source, size, digest in rows:
            cur = self.db.execute("""
                INSERT OR IGNORE INTO sources(url,name,source,expected_size,expected_sha256,status,updated_at)
                VALUES(?,?,?,?,?,'pending',?)
            """, (url, name or "", source or "", int(size or 0), str(digest).lower(), now_iso()))
            added += cur.rowcount
        self.db.commit()
        return added

    def candidates(self, retry_errors: bool) -> list[tuple]:
        states = ("pending", "error", "skipped") if retry_errors else ("pending",)
        qs = ",".join("?" for _ in states)
        return self.db.execute(f"""
            SELECT id,url,name,source,expected_size,expected_sha256,attempts
            FROM sources WHERE status IN ({qs}) ORDER BY expected_size DESC,id
        """, states).fetchall()

    def done_sources(self) -> list[tuple]:
        return self.db.execute("""
            SELECT id,url,name,source,expected_size,expected_sha256,chunks,bytes
            FROM sources WHERE status='done' ORDER BY id
        """).fetchall()

    def mark(self, source_id: int, status: str, *, chunks: int = 0, size: int = 0,
             range_ok: int | None = None, error: str | None = None) -> None:
        self.db.execute("""
          UPDATE sources SET status=?,attempts=attempts+1,chunks=?,bytes=?,
            range_ok=COALESCE(?,range_ok),error=?,updated_at=? WHERE id=?
        """, (status, chunks, size, range_ok, error, now_iso(), source_id))
        self.db.commit()

    def summary(self) -> dict[str, int]:
        row = self.db.execute("""
            SELECT COUNT(*),
              COALESCE(SUM(CASE WHEN status='done' THEN 1 ELSE 0 END),0),
              COALESCE(SUM(CASE WHEN status='done' THEN bytes ELSE 0 END),0),
              COALESCE(SUM(CASE WHEN status='done' THEN chunks ELSE 0 END),0)
            FROM sources
        """).fetchone()
        return {"sources": int(row[0]), "done": int(row[1]), "bytes": int(row[2]), "chunks": int(row[3])}

    def close(self) -> None:
        self.db.close()


def process_source(row: tuple, records_dir: Path, max_source: int) -> dict:
    source_id, url, name, source, expected_size, expected_sha, attempts = row
    expected_size = int(expected_size or 0)
    if expected_size and expected_size > max_source:
        return {"id": source_id, "status": "skipped", "range_ok": 0, "error": f"size {expected_size} exceeds max source limit"}
    if not range_probe(url):
        return {"id": source_id, "status": "skipped", "range_ok": 0, "error": "server did not honor bytes=0-0 Range probe"}

    tmp = records_dir / f"{source_id:08d}.records.tmp"
    final = records_dir / f"{source_id:08d}.records"
    tmp.unlink(missing_ok=True)

    for attempt in range(1, MAX_RETRIES + 1):
        chunker = FastCDCStream(); full_hash = hashlib.sha256(); bytes_read = 0; chunks = 0
        try:
            with tmp.open("wb") as out:
                log("SOURCE", f"#{source_id} {name!r} attempt={attempt} expected={human_bytes(expected_size)}")
                with open_url(url, timeout=180) as r:
                    declared = int(r.headers.get("Content-Length") or 0)
                    if declared and declared > max_source:
                        raise RuntimeError(f"HTTP object {human_bytes(declared)} exceeds max source limit")
                    while True:
                        block = r.read(STREAM_CHUNK)
                        if not block:
                            break
                        full_hash.update(block); bytes_read += len(block)
                        if bytes_read > max_source:
                            raise RuntimeError("stream exceeded max source limit")
                        for offset, chunk in chunker.feed(block):
                            out.write(SOURCE_RECORD.pack(hashlib.sha256(chunk).digest(), offset, len(chunk)))
                            chunks += 1
                        if bytes_read and bytes_read % (512 * 1024 * 1024) < len(block):
                            log("PROGRESS", f"#{source_id} {name!r} {human_bytes(bytes_read)}")
                    for offset, chunk in chunker.finish():
                        out.write(SOURCE_RECORD.pack(hashlib.sha256(chunk).digest(), offset, len(chunk)))
                        chunks += 1
            digest = full_hash.hexdigest()
            if expected_sha and digest.lower() != str(expected_sha).lower():
                raise RuntimeError(f"full SHA-256 mismatch expected={expected_sha[:16]} got={digest[:16]}")
            if expected_size and bytes_read != expected_size:
                raise RuntimeError(f"size mismatch expected={expected_size} got={bytes_read}")
            os.replace(tmp, final)
            return {"id": source_id, "status": "done", "range_ok": 1, "chunks": chunks, "bytes": bytes_read, "error": None}
        except Exception as exc:
            tmp.unlink(missing_ok=True)
            if attempt >= MAX_RETRIES:
                return {"id": source_id, "status": "error", "range_ok": 1, "chunks": 0, "bytes": 0, "error": f"{type(exc).__name__}: {exc}"}
            wait = 2 ** attempt
            log("RETRY", f"#{source_id} {name!r}: {exc}; retry in {wait}s")
            time.sleep(wait)
    return {"id": source_id, "status": "error", "range_ok": 1, "error": "retry limit"}


class HandleLRU:
    def __init__(self, max_open: int = 64) -> None:
        self.max_open = max_open
        self.handles: collections.OrderedDict[Path, object] = collections.OrderedDict()

    def get(self, path: Path):
        h = self.handles.pop(path, None)
        if h is not None:
            self.handles[path] = h
            return h
        path.parent.mkdir(parents=True, exist_ok=True)
        h = path.open("ab")
        self.handles[path] = h
        if len(self.handles) > self.max_open:
            _, old = self.handles.popitem(last=False)
            old.close()
        return h

    def close(self) -> None:
        for h in self.handles.values():
            h.close()
        self.handles.clear()


def finalize_catalog(state: BuildState, work_dir: Path, output_dir: Path) -> dict:
    done = state.done_sources()
    if not done:
        raise RuntimeError("No range-capable verified sources were completed; catalog would be empty.")

    tmp_shards = work_dir / "shards-tmp"
    if tmp_shards.exists():
        shutil.rmtree(tmp_shards)
    tmp_shards.mkdir(parents=True)
    lru = HandleLRU(64)
    total_records = 0
    records_dir = work_dir / "records"
    try:
        for source_id, url, name, source, expected_size, expected_sha, chunks, size in done:
            rec_path = records_dir / f"{source_id:08d}.records"
            if not rec_path.exists():
                log("WARN", f"Missing record file for completed source #{source_id}; skipping it in final catalog")
                continue
            with rec_path.open("rb") as f:
                while True:
                    rec = f.read(SOURCE_RECORD.size)
                    if not rec:
                        break
                    if len(rec) != SOURCE_RECORD.size:
                        raise RuntimeError(f"truncated source record file: {rec_path}")
                    digest, offset, length = SOURCE_RECORD.unpack(rec)
                    hx = digest.hex(); prefix = hx[:PREFIX_HEX_CHARS]
                    shard = tmp_shards / prefix[:2] / f"{prefix[2:]}.bin"
                    lru.get(shard).write(SHARD_RECORD.pack(digest, int(source_id), offset, length))
                    total_records += 1
    finally:
        lru.close()

    chunks_out = output_dir / "chunks"
    if chunks_out.exists():
        shutil.rmtree(chunks_out)
    chunks_out.mkdir(parents=True)
    unique_records = 0
    shard_count = 0
    for src in sorted(tmp_shards.rglob("*.bin")):
        data = src.read_bytes()
        if len(data) % SHARD_RECORD.size:
            raise RuntimeError(f"invalid temporary shard: {src}")
        rows = [SHARD_RECORD.unpack_from(data, i) for i in range(0, len(data), SHARD_RECORD.size)]
        rows.sort(key=lambda r: (r[0], r[3], r[1], r[2]))
        dedup = []
        last_key = None
        for row in rows:
            key = (row[0], row[3])
            if key == last_key:
                continue
            dedup.append(row); last_key = key
        rel = src.relative_to(tmp_shards)
        dst = chunks_out / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        with dst.open("wb") as f:
            for row in dedup:
                f.write(SHARD_RECORD.pack(*row))
        unique_records += len(dedup); shard_count += 1

    sources = []
    source_bytes = 0
    for source_id, url, name, source, expected_size, expected_sha, chunks, size in done:
        rec_path = records_dir / f"{source_id:08d}.records"
        if not rec_path.exists():
            continue
        sources.append({
            "id": int(source_id), "url": url, "name": name or "", "source": source or "",
            "size": int(size or expected_size or 0), "sha256": expected_sha or ""
        })
        source_bytes += int(size or expected_size or 0)

    index = {
        "format": FORMAT,
        "version": 1,
        "generated_at": now_iso(),
        "prefix_hex_chars": PREFIX_HEX_CHARS,
        "record_bytes": SHARD_RECORD.size,
        "fastcdc": {"min": FASTCDC_MIN, "avg": FASTCDC_AVG, "max": FASTCDC_MAX, "version": 1},
        "sources": sources,
        "stats": {
            "source_files": len(sources), "source_bytes": source_bytes,
            "chunks": total_records, "unique_chunks": unique_records, "shards": shard_count
        },
        "warning": "IC2C shares using this catalog depend on the referenced public source URLs remaining byte-range accessible. Receivers verify every referenced chunk and the final file with SHA-256."
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    tmp_index = output_dir / "index.json.tmp"
    tmp_index.write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp_index, output_dir / "index.json")
    shutil.rmtree(tmp_shards, ignore_errors=True)
    return index


def parse_args():
    p = argparse.ArgumentParser(description="Build IC2C exact-chunk static catalog from ic2-bulk-state.sqlite3")
    p.add_argument("--trainer-state", default=r"S:\train_ic2\ic2-bulk-state.sqlite3")
    p.add_argument("--build-state", default=r"S:\train_ic2\ic2-corpus-build-state.sqlite3")
    p.add_argument("--work-dir", default=r"S:\train_ic2\ic2-corpus-build-work")
    p.add_argument("--output-dir", default=r"S:\train_ic2\corpus")
    p.add_argument("--workers", type=int, default=2)
    p.add_argument("--max-source-gb", type=float, default=2.25)
    p.add_argument("--retry-errors", action="store_true")
    p.add_argument("--finalize-only", action="store_true")
    return p.parse_args()


def main() -> int:
    a = parse_args()
    trainer = Path(a.trainer_state); build_db = Path(a.build_state); work = Path(a.work_dir); output = Path(a.output_dir)
    if not trainer.exists():
        print(f"ERROR: trainer state not found: {trainer}", file=sys.stderr); return 2
    work.mkdir(parents=True, exist_ok=True); (work / "records").mkdir(parents=True, exist_ok=True)
    state = BuildState(build_db)
    try:
        added = state.import_trainer(trainer)
        s = state.summary()
        log("START", f"IC2 corpus catalog builder {VERSION} | imported_new={added} | known_sources={s['sources']}")
        log("STATE", f"already verified={s['done']} sources / {human_bytes(s['bytes'])} / {s['chunks']:,} chunks")
        if not a.finalize_only:
            rows = state.candidates(a.retry_errors)
            log("QUEUE", f"{len(rows):,} public source objects remain to inspect; workers={max(1,a.workers)}")
            max_source = int(a.max_source_gb * 1024**3)
            with cf.ThreadPoolExecutor(max_workers=max(1, a.workers), thread_name_prefix="ic2-catalog") as ex:
                futs = {ex.submit(process_source, row, work / "records", max_source): row for row in rows}
                for fut in cf.as_completed(futs):
                    row = futs[fut]
                    try:
                        result = fut.result()
                    except KeyboardInterrupt:
                        raise
                    except Exception as exc:
                        result = {"id": row[0], "status": "error", "error": f"{type(exc).__name__}: {exc}"}
                    state.mark(result["id"], result["status"], chunks=int(result.get("chunks",0)), size=int(result.get("bytes",0)), range_ok=result.get("range_ok"), error=result.get("error"))
                    if result["status"] == "done":
                        log("ACCEPT", f"#{result['id']} {human_bytes(result['bytes'])} -> {result['chunks']:,} FastCDC chunks")
                    else:
                        log("SKIP", f"#{result['id']} {result.get('error','unknown error')}")
                    s = state.summary()
                    log("CORPUS", f"verified={s['done']}/{s['sources']} | source data={human_bytes(s['bytes'])} | chunks={s['chunks']:,}")
        log("FINALIZE", "Building 12-bit hash-prefix shards and deduplicating exact chunks...")
        index = finalize_catalog(state, work, output)
        st = index["stats"]
        log("DONE", f"catalog={output / 'index.json'} | sources={st['source_files']:,} | source data={human_bytes(st['source_bytes'])} | unique chunks={st['unique_chunks']:,} | shards={st['shards']:,}")
        log("DONE", f"Upload the entire {output} folder to the repository root as corpus/ (index.json + chunks/).")
        return 0
    except KeyboardInterrupt:
        log("STOP", "Interrupted. Completed per-source record files and SQLite state remain resumable.")
        return 130
    finally:
        state.close()


if __name__ == "__main__":
    raise SystemExit(main())
