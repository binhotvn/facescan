#!/usr/bin/env python3
"""Index faces for a FaceScan hub from another machine.

    python worker.py --url http://hub:8000            # one model process
    python worker.py --url http://hub:8000 --procs 4  # four, ~1GB RAM each

The hub keeps the photos and the database; this only needs the face model.
It claims a few photos at a time, downloads each original, runs detection and
sends the faces back. Claims are leases: if this machine dies, the hub hands
its photos to someone else once the lease runs out. Start as many workers, on
as many machines, as the backlog needs; they never do the same photo twice.

Token: --token, $FACESCAN_WORKER_TOKEN or .env (the hub's upload token also
works when the hub has no separate worker token).
"""
from __future__ import annotations

import argparse
import base64
import json
import logging
import multiprocessing as mp
import os
import signal
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

log = logging.getLogger("facescan.worker")

IDLE_MIN, IDLE_MAX = 2.0, 15.0  # seconds between polls when there is no work
RETRY_CODES = {408, 425, 429, 500, 502, 503, 504}


class Hub:
    """The few HTTP calls a worker makes, with retries for a flaky network."""

    def __init__(self, url: str, token: str, timeout: float = 120):
        self.url, self.token, self.timeout = url.rstrip("/"), token, timeout

    def _call(self, method: str, path: str, body: dict | None = None, raw: bool = False):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, method=method)
        req.add_header("X-Worker-Token", self.token)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        delay = 1.0
        for attempt in range(5):
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    payload = resp.read()
                return payload if raw else json.loads(payload)
            except urllib.error.HTTPError as e:
                if e.code not in RETRY_CODES or attempt == 4:
                    raise
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                if attempt == 4:
                    raise
            time.sleep(delay)
            delay = min(delay * 2, 30)
        raise RuntimeError("unreachable")

    def claim(self, worker: str, limit: int) -> list[dict]:
        return self._call("POST", "/api/worker/claim", {"worker": worker, "limit": limit})["jobs"]

    def photo(self, job: dict) -> bytes:
        return self._call("GET", job["photo"], raw=True)

    def result(self, body: dict) -> dict:
        return self._call("POST", "/api/worker/result", body)


def encode_faces(result: dict) -> list[dict]:
    import numpy as np

    return [
        {
            "bbox": [float(v) for v in f["bbox"]],
            "det_score": float(f["det_score"]),
            "embedding": base64.b64encode(
                np.asarray(f["embedding"], dtype="<f4").tobytes()
            ).decode(),
        }
        for f in result["faces"]
    ]


def index_bytes(data: bytes) -> dict | None:
    """Decode and run the model; None if the bytes are not an image."""
    import cv2
    import numpy as np

    from facescan.ingest import process_image

    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return None
    return process_image(img)


def run(hub: Hub, name: str, batch: int, once: bool = False, process=index_bytes,
        stop=lambda: False) -> int:
    """Claim, index, report, repeat. Returns how many photos were stored."""
    stored, idle = 0, IDLE_MIN
    while not stop():
        try:
            jobs = hub.claim(name, batch)
        except urllib.error.HTTPError as e:
            if e.code in (401, 503):
                log.error("hub refused the worker token (%s); stopping", e.code)
                return stored
            log.warning("claim failed: %s", e)
            jobs = []
        except (urllib.error.URLError, OSError) as e:
            log.warning("hub unreachable: %s", e)
            jobs = []
        if not jobs:
            if once:
                return stored
            time.sleep(idle)
            idle = min(idle * 1.5, IDLE_MAX)
            continue
        idle = IDLE_MIN
        for job in jobs:
            body = {"id": job["id"], "worker": name}
            try:
                result = process(hub.photo(job))
                if result is None:
                    body["error"] = "unreadable image"
                else:
                    body.update(width=result["width"], height=result["height"],
                                faces=encode_faces(result))
            except urllib.error.HTTPError as e:
                if e.code == 404:  # deleted on the hub after we claimed it
                    continue
                body["error"] = f"download failed: HTTP {e.code}"
            except Exception as e:  # noqa: BLE001 - report it, keep the worker alive
                log.exception("photo %s failed", job["id"])
                body["error"] = f"{type(e).__name__}: {e}"[:500]
            try:
                reply = hub.result(body)
            except (urllib.error.URLError, OSError) as e:
                # the lease runs out and the hub gives the photo to someone else
                log.warning("could not report photo %s: %s", job["id"], e)
                continue
            if reply.get("stored"):
                stored += 1
                log.info("photo %s: %d faces", job["id"], len(body.get("faces", [])))
    return stored


def _proc_main(url: str, token: str, name: str, batch: int):
    logging.basicConfig(level=logging.INFO, format=f"%(asctime)s [{name}] %(message)s")
    stopping = []
    signal.signal(signal.SIGTERM, lambda *_: stopping.append(1))
    # load the model before the first claim, so a lease is not spent on startup
    from facescan.engine import get_engine

    get_engine()
    log.info("model loaded, polling %s", url)
    run(Hub(url, token), name, batch, stop=lambda: bool(stopping))


def load_dotenv(*candidates: Path) -> dict:
    for path in candidates:
        try:
            text = path.read_text()
        except OSError:
            continue
        values = {}
        for line in text.splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                values[k.strip()] = v.strip().strip("'\"")
        return values
    return {}


def main(argv=None) -> int:
    here = Path(__file__).resolve().parent
    env = load_dotenv(Path.cwd() / ".env", here / ".env")

    def setting(name, fallback=""):
        return os.environ.get(name) or env.get(name, "") or fallback

    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=setting("FACESCAN_HUB_URL", "http://localhost:8000"),
                    help="hub base URL ($FACESCAN_HUB_URL, default http://localhost:8000)")
    ap.add_argument("--token", default=setting("FACESCAN_WORKER_TOKEN",
                                               setting("FACESCAN_UPLOAD_TOKEN")),
                    help="worker token ($FACESCAN_WORKER_TOKEN, else $FACESCAN_UPLOAD_TOKEN)")
    ap.add_argument("--procs", type=int, default=int(setting("FACESCAN_WORKER_PROCS", "1")),
                    help="model processes on this machine, ~1GB RAM each (default 1)")
    ap.add_argument("--batch", type=int, default=2,
                    help="photos claimed per request (default 2; keep small so leases stay short)")
    ap.add_argument("--name", default=setting("FACESCAN_WORKER_NAME", socket.gethostname()),
                    help="name shown in the hub's logs (default: hostname)")
    args = ap.parse_args(argv)
    if not args.token:
        print("No worker token: pass --token or set FACESCAN_WORKER_TOKEN.", file=sys.stderr)
        return 2

    names = [f"{args.name}-{i}" for i in range(args.procs)]
    if args.procs == 1:
        _proc_main(args.url, args.token, names[0], args.batch)
        return 0
    ctx = mp.get_context("spawn")  # ONNX runtime sessions don't survive forking
    procs = [ctx.Process(target=_proc_main, args=(args.url, args.token, n, args.batch))
             for n in names]
    for p in procs:
        p.start()
    signal.signal(signal.SIGTERM, lambda *_: [p.terminate() for p in procs])
    try:
        for p in procs:
            p.join()
    except KeyboardInterrupt:
        for p in procs:
            p.terminate()
    return 0


if __name__ == "__main__":
    sys.exit(main())
