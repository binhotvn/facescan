#!/usr/bin/env python3
"""Push a folder of event photos to a running FaceScan server.

    python upload.py ./uploads                # send everything under ./uploads
    python upload.py ./uploads --watch        # keep running, send new drops
    python upload.py ./uploads --workers 4    # parallel uploads

Photos are matched by content, not by name: a file already sent is never sent
again, and the server refuses content it has already indexed. Re-running after
an interrupted session picks up exactly where it stopped.

Token: --token, or $FACESCAN_UPLOAD_TOKEN.

Runs on Python 3.8+ with no third-party packages: it has to work on whatever
laptop the photos are sitting on.
"""
from __future__ import annotations  # so "str | None" parses on Python < 3.10

import argparse
import hashlib
import json
import mimetypes
import os
import shutil
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
STATE_NAME = ".facescan-upload.json"
MAX_BATCH_BYTES = 64 * 1024 * 1024  # one request is built in memory
WATCH_INTERVAL = 3.0
SETTLE_SECONDS = 1.5  # a file still being copied in must stop growing first


# --------------------------------------------------------------------------
# files
# --------------------------------------------------------------------------
def iter_images(root: Path):
    for p in sorted(root.rglob("*")):
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS and not p.name.startswith("."):
            yield p


def file_key(p: Path) -> str:
    st = p.stat()
    return f"{st.st_mtime:.0f}:{st.st_size}"


def file_hash(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def batches(paths, max_count: int, max_bytes: int = MAX_BATCH_BYTES):
    batch, size = [], 0
    for p in paths:
        n = p.stat().st_size
        if batch and (len(batch) >= max_count or size + n > max_bytes):
            yield batch
            batch, size = [], 0
        batch.append(p)
        size += n
    if batch:
        yield batch


# --------------------------------------------------------------------------
# state: what has already gone up
# --------------------------------------------------------------------------
class State:
    """Remembers uploads by content hash, with a path cache to avoid rehashing.

    Hashing every file on every run would read the whole folder from disk. The
    path cache skips files whose mtime and size are unchanged; the hash set is
    what actually decides, so a renamed or copied photo is still recognised.
    """

    def __init__(self, path: Path):
        self.path = path
        raw = self._read()
        self.hashes: dict[str, str] = raw.get("hashes", {})   # hash -> first path seen
        self.paths: dict[str, str] = raw.get("paths", {})     # path -> "key:hash"
        self._lock = threading.Lock()
        self._dirty = False

    def _read(self) -> dict:
        try:
            return json.loads(self.path.read_text())
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {}

    def known_hash(self, p: Path) -> str | None:
        """Cached hash for an unchanged file, else None (caller must hash)."""
        entry = self.paths.get(str(p.resolve()))
        if not entry:
            return None
        key, _, digest = entry.partition("|")
        return digest if key == file_key(p) else None

    def seen(self, digest: str) -> bool:
        return digest in self.hashes

    def mark(self, p: Path, digest: str):
        with self._lock:
            self.hashes.setdefault(digest, str(p.resolve()))
            self.paths[str(p.resolve())] = f"{file_key(p)}|{digest}"
            self._dirty = True

    def note_path(self, p: Path, digest: str):
        """Record a path->hash mapping without claiming the content was sent."""
        with self._lock:
            self.paths[str(p.resolve())] = f"{file_key(p)}|{digest}"
            self._dirty = True

    def save(self):
        with self._lock:
            if not self._dirty:
                return
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"hashes": self.hashes, "paths": self.paths},
                                      indent=1, sort_keys=True))
            tmp.replace(self.path)  # atomic: a Ctrl-C never leaves half a file
            self._dirty = False


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
def multipart(files, field: str = "files"):
    boundary = uuid.uuid4().hex
    body = bytearray()
    for p in files:
        ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        body += f"--{boundary}\r\n".encode()
        body += (
            f'Content-Disposition: form-data; name="{field}"; filename="{p.name}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n"
        ).encode()
        body += p.read_bytes()
        body += b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return f"multipart/form-data; boundary={boundary}", bytes(body)


def post_batch(url: str, token: str, files, timeout: int = 900) -> dict:
    ctype, body = multipart(files)
    req = urllib.request.Request(
        url.rstrip("/") + "/api/upload",
        data=body,
        headers={"Content-Type": ctype, "X-Upload-Token": token},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


class Fatal(Exception):
    """Server said something a retry will not fix."""


def explain(err: urllib.error.HTTPError) -> str:
    if err.code == 401:
        return "Sai mã tải lên (401). Check --token / $FACESCAN_UPLOAD_TOKEN."
    if err.code == 503:
        return "Server has uploads disabled (503). Set FACESCAN_UPLOAD_TOKEN there."
    if err.code == 413:
        return "Batch too large (413). Try a smaller --batch."
    try:
        return f"HTTP {err.code}: {json.load(err).get('detail', '')}"
    except Exception:  # noqa: BLE001 - the error body is not always JSON
        return f"HTTP {err.code}"


# --------------------------------------------------------------------------
# stats
# --------------------------------------------------------------------------
@dataclass
class Stats:
    queued: int = 0
    uploaded: int = 0
    duplicates: int = 0
    skipped: int = 0
    failed: int = 0
    faces: int = 0
    bytes_sent: int = 0
    started: float = field(default_factory=time.monotonic)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def add(self, **kw):
        with self._lock:
            for k, v in kw.items():
                setattr(self, k, getattr(self, k) + v)

    @property
    def done(self) -> int:
        return self.uploaded + self.duplicates + self.failed

    @property
    def rate(self) -> float:
        elapsed = time.monotonic() - self.started
        return self.done / elapsed if elapsed > 0.5 else 0.0

    @property
    def mb(self) -> float:
        return self.bytes_sent / 1e6


# --------------------------------------------------------------------------
# terminal UI
# --------------------------------------------------------------------------
class PlainUI:
    """Line-by-line output: pipes, CI logs, and terminals without ANSI."""

    def __init__(self, stats: Stats, title: str):
        self.stats = stats
        print(title)

    def log(self, msg: str, level: str = "info"):
        stream = sys.stderr if level == "error" else sys.stdout
        print(("  ! " if level == "error" else "  ") + msg, file=stream, flush=True)

    def set_status(self, status: str):
        pass

    def refresh(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        s = self.stats
        print(f"\n{s.uploaded} uploaded, {s.faces} faces, {s.duplicates} duplicates, "
              f"{s.skipped} skipped, {s.failed} failed ({s.mb:.0f}MB)")


class LiveUI:
    """A small live dashboard: progress bar, counters, and a recent-events tail.

    Hand-rolled ANSI rather than a dependency: the script has to run wherever
    the photographer's laptop is, without a pip install first.
    """

    BAR_WIDTH = 34
    TAIL = 8

    def __init__(self, stats: Stats, title: str, watching: bool = False):
        self.stats = stats
        self.title = title
        self.watching = watching
        self.events: list[tuple[str, str]] = []
        self.status = "starting"
        self._lock = threading.Lock()
        self._lines = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    # -- lifecycle
    def __enter__(self):
        sys.stdout.write("\x1b[?25l")  # hide cursor
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._thread.join(timeout=1)
        self._draw(final=True)
        sys.stdout.write("\x1b[?25h\n")  # show cursor
        sys.stdout.flush()

    def _loop(self):
        while not self._stop.wait(0.2):
            self._draw()

    # -- input
    def log(self, msg: str, level: str = "info"):
        with self._lock:
            self.events.append((level, msg))
            del self.events[:-self.TAIL]

    def set_status(self, status: str):
        self.status = status

    def refresh(self):
        self._draw()

    # -- drawing
    def _bar(self) -> str:
        s = self.stats
        total = max(s.queued, 1)
        frac = min(s.done / total, 1.0)
        filled = round(self.BAR_WIDTH * frac)
        return f"[{'#' * filled}{'.' * (self.BAR_WIDTH - filled)}] {frac * 100:5.1f}%"

    def _render(self) -> list[str]:
        s = self.stats
        width = min(shutil.get_terminal_size((100, 24)).columns, 100)
        c = {"cyan": "\x1b[36m", "green": "\x1b[32m", "yellow": "\x1b[33m",
             "red": "\x1b[31m", "dim": "\x1b[2m", "off": "\x1b[0m", "bold": "\x1b[1m"}

        lines = [f"{c['bold']}{self.title}{c['off']}", ""]
        lines.append(f"  {c['cyan']}{self._bar()}{c['off']}  "
                     f"{s.done}/{s.queued}   {s.rate:4.1f} ảnh/s   {s.mb:6.1f}MB")
        lines.append(
            f"  {c['green']}{s.uploaded:5d} uploaded{c['off']}   "
            f"{s.faces:5d} faces   "
            f"{c['yellow']}{s.duplicates:4d} dup{c['off']}   "
            f"{s.skipped:4d} skipped   "
            f"{c['red'] if s.failed else c['dim']}{s.failed:3d} failed{c['off']}"
        )
        lines.append(f"  {c['dim']}{self.status}{c['off']}")
        lines.append("")
        for level, msg in self.events[-self.TAIL:]:
            colour = c["red"] if level == "error" else c["dim"] if level == "dim" else ""
            lines.append(f"  {colour}{msg[:width - 4]}{c['off']}")
        if self.watching:
            lines += ["", f"  {c['dim']}watching for new files, ctrl-c to stop{c['off']}"]
        return lines

    def _draw(self, final: bool = False):
        with self._lock:
            out = self._render()
            buf = []
            if self._lines:
                buf.append(f"\x1b[{self._lines}A")  # back to the top of the block
            for line in out:
                buf.append("\x1b[2K" + line + "\n")
            sys.stdout.write("".join(buf))
            sys.stdout.flush()
            self._lines = 0 if final else len(out)


def make_ui(stats: Stats, title: str, watching: bool, force_plain: bool):
    interactive = sys.stdout.isatty() and os.environ.get("TERM") not in (None, "dumb")
    if force_plain or not interactive:
        return PlainUI(stats, title)
    return LiveUI(stats, title, watching)


# --------------------------------------------------------------------------
# uploader
# --------------------------------------------------------------------------
class Uploader:
    def __init__(self, args, state: State, stats: Stats, ui):
        self.args, self.state, self.stats, self.ui = args, state, stats, ui
        self.fatal: str | None = None
        self._seen_lock = threading.Lock()
        self._in_flight: set[str] = set()

    def plan(self, paths):
        """Cheap pass: drop files this folder has already sent.

        Only mtime and size are consulted here, never file contents. Hashing
        hundreds of photos up front is what made startup feel frozen; content
        hashing now happens per batch inside the workers, overlapped with the
        network.
        """
        todo = []
        for p in paths:
            if self.state.known_hash(p):
                self.stats.add(skipped=1)
            else:
                todo.append(p)
        return todo

    def _hash_batch(self, paths):
        """Hash a batch and drop anything already sent. Returns (path, digest)."""
        items = []
        for p in paths:
            try:
                digest = file_hash(p)
            except OSError as e:
                self.stats.add(failed=1)
                self.ui.log(f"{p.name}: {e}", "error")
                continue
            if self.state.seen(digest):
                self.state.note_path(p, digest)
                self.stats.add(skipped=1, queued=-1)
                continue
            with self._seen_lock:
                if digest in self._in_flight:  # the same photo twice in one run
                    self.stats.add(skipped=1, queued=-1)
                    self.ui.log(f"bỏ qua bản trùng: {p.name}", "dim")
                    continue
                self._in_flight.add(digest)
            items.append((p, digest))
        return items

    def send(self, batch_paths):
        """Hash, then upload one batch with retries."""
        if self.fatal:
            return
        items = self._hash_batch(batch_paths)
        if not items:
            return
        paths = [p for p, _ in items]
        size = sum(p.stat().st_size for p in paths)
        for attempt in range(self.args.retries + 1):
            if self.fatal:
                return
            try:
                result = post_batch(self.args.url, self.args.token, paths,
                                    timeout=self.args.timeout)
                self._record(items, result, size)
                return
            except urllib.error.HTTPError as e:
                self.fatal = explain(e)
                self.ui.log(self.fatal, "error")
                return
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
                if attempt == self.args.retries:
                    self.stats.add(failed=len(paths))
                    self.ui.log(f"giving up on {len(paths)} file(s): {e}", "error")
                    return
                wait = 2 ** attempt
                self.ui.log(f"network error, retry in {wait}s ({e})", "error")
                time.sleep(wait)

    def _record(self, items, result: dict, size: int):
        by_name = {p["filename"]: p for p in result.get("photos", [])}
        for p, digest in items:
            entry = by_name.get(p.name, {})
            if entry.get("ok"):
                self.state.mark(p, digest)
                if entry.get("duplicate"):
                    self.stats.add(duplicates=1)
                    self.ui.log(f"already on server: {p.name}", "dim")
                else:
                    self.stats.add(uploaded=1, faces=entry.get("faces", 0))
                    self.ui.log(f"{p.name}  ({entry.get('faces', 0)} faces)")
            else:
                self.stats.add(failed=1)
                self.ui.log(f"{p.name}: {entry.get('error', 'rejected')}", "error")
        self.stats.add(bytes_sent=size)
        self.state.save()

    def run(self, paths) -> bool:
        """Plan, batch and upload. False if a fatal server error stopped us."""
        todo = self.plan(paths)
        if not todo:
            return True
        self.stats.add(queued=len(todo))
        self.ui.set_status(f"sending {len(todo)} photo(s), {self.args.workers} at a time")
        groups = list(batches(todo, self.args.batch))
        with ThreadPoolExecutor(max_workers=self.args.workers) as pool:
            futures = [pool.submit(self.send, g) for g in groups]
            for f in futures:
                f.result()
        self.state.save()
        return self.fatal is None


def settled(p: Path, now: float) -> bool:
    """True once a file has stopped being written to (a copy in progress)."""
    try:
        return now - p.stat().st_mtime >= SETTLE_SECONDS
    except OSError:
        return False


def watch(args, state: State, stats: Stats, ui, uploader: Uploader):
    """Keep scanning the folder and upload whatever appears."""
    while True:
        now = time.time()
        fresh = [p for p in iter_images(args.folder)
                 if settled(p, now) and not state.known_hash(p)]
        if fresh:
            ui.set_status(f"uploading {len(fresh)} new file(s)")
            if not uploader.run(fresh):
                return False
        ui.set_status(f"idle, watching {args.folder}")
        ui.refresh()
        time.sleep(args.interval)


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------
def load_dotenv(*candidates: Path) -> dict:
    """Read KEY=value lines from the first .env found.

    Keeps the token out of the source file (and out of git) while still
    allowing a bare `python upload.py` with no flags.
    """
    for path in candidates:
        try:
            text = path.read_text()
        except (FileNotFoundError, IsADirectoryError, OSError):
            continue
        values = {}
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip("'\"")
        return values
    return {}


def build_parser(env: dict | None = None):
    env = env if env is not None else {}

    def setting(name: str, fallback: str = "") -> str:
        return os.environ.get(name) or env.get(name, "") or fallback

    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", type=Path, nargs="?", default=Path("uploads"),
                    help="folder of photos, searched recursively (default: ./uploads)")
    ap.add_argument("--url", default=setting("FACESCAN_URL", "http://localhost:8000"),
                    help="server base URL ($FACESCAN_URL or .env, default http://localhost:8000)")
    ap.add_argument("--token", default=setting("FACESCAN_UPLOAD_TOKEN"),
                    help="upload token ($FACESCAN_UPLOAD_TOKEN or .env)")
    ap.add_argument("--watch", action="store_true",
                    help="keep running and upload files as they are dropped in")
    ap.add_argument("--interval", type=float, default=WATCH_INTERVAL,
                    help=f"seconds between watch scans (default: {WATCH_INTERVAL})")
    ap.add_argument("--workers", type=int, default=3, help="parallel uploads (default: 3)")
    ap.add_argument("--batch", type=int, default=8, help="photos per request (default: 8)")
    ap.add_argument("--timeout", type=int, default=900, help="per-request timeout in seconds")
    ap.add_argument("--retries", type=int, default=2, help="retries per batch on network errors")
    ap.add_argument("--force", action="store_true", help="ignore local state and re-send")
    ap.add_argument("--dry-run", action="store_true", help="list what would be sent")
    ap.add_argument("--plain", action="store_true", help="plain output instead of the live view")
    ap.add_argument("--state", type=Path, help=f"state file (default: <folder>/{STATE_NAME})")
    return ap


def main(argv=None) -> int:
    here = Path(__file__).resolve().parent
    args = build_parser(load_dotenv(Path.cwd() / ".env", here / ".env")).parse_args(argv)

    if not args.folder.is_dir():
        print(f"No such folder: {args.folder}", file=sys.stderr)
        return 2
    if not args.token and not args.dry_run:
        print("No upload token. Pass --token or set FACESCAN_UPLOAD_TOKEN.", file=sys.stderr)
        return 2

    state_path = args.state or args.folder / STATE_NAME
    if args.force and state_path.exists():
        state_path.unlink()
    state = State(state_path)
    stats = Stats()

    if args.dry_run:
        found = list(iter_images(args.folder))
        todo = [p for p in found if not state.known_hash(p)]
        print(f"{len(found)} images, {len(todo)} to send")
        for p in todo:
            print("  would send", p)
        return 0

    title = f"FaceScan upload  {args.folder}  ->  {args.url}"
    ui = make_ui(stats, title, args.watch, args.plain)
    uploader = Uploader(args, state, stats, ui)
    ok = True
    with ui:
        try:
            ui.set_status("scanning")
            ok = uploader.run(list(iter_images(args.folder)))
            if ok and args.watch:
                watch(args, state, stats, ui, uploader)
        except KeyboardInterrupt:
            ui.set_status("stopped")
        finally:
            state.save()

    if uploader.fatal:
        return 1
    return 1 if stats.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
