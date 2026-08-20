#!/usr/bin/env python3
"""Push a folder of event photos to a running FaceScan server.

    python upload.py ./uploads                       # everything under ./uploads, recursively
    python upload.py ./uploads --url https://photos.example.com
    python upload.py ./uploads --force               # re-send files already sent

The server indexes each photo as it arrives (POST /api/upload), so photos show
up in the gallery within seconds. Re-running only sends what is new or changed:
a small state file next to the folder remembers what went up.

Token: --token, or $FACESCAN_UPLOAD_TOKEN. The server rejects uploads without it.
"""
import argparse
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
STATE_NAME = ".facescan-upload.json"
# One request is built in memory, so cap a batch by bytes as well as by count.
MAX_BATCH_BYTES = 64 * 1024 * 1024


def iter_images(root: Path):
    """Every image under root, recursively, in a stable order."""
    for p in sorted(root.rglob("*")):
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS and not p.name.startswith("."):
            yield p


def load_state(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(path: Path, state: dict):
    path.write_text(json.dumps(state, indent=1, sort_keys=True))


def key_of(p: Path) -> str:
    """Identity of a file for resume purposes: edited or replaced -> re-sent."""
    st = p.stat()
    return f"{st.st_mtime:.0f}:{st.st_size}"


def batches(paths, max_count: int, max_bytes: int = MAX_BATCH_BYTES):
    """Group files so one request stays small enough to hold in memory."""
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


def multipart(files, field: str = "files"):
    """Encode files as multipart/form-data. Returns (content_type, body)."""
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


def post_batch(url: str, token: str, files, timeout: int = 600) -> dict:
    ctype, body = multipart(files)
    req = urllib.request.Request(
        url.rstrip("/") + "/api/upload",
        data=body,
        headers={"Content-Type": ctype, "X-Upload-Token": token},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def explain(err: urllib.error.HTTPError) -> str:
    if err.code == 401:
        return "Sai mã tải lên (401). Check --token / $FACESCAN_UPLOAD_TOKEN."
    if err.code == 503:
        return "Server has uploads disabled (503). Set FACESCAN_UPLOAD_TOKEN there and restart."
    if err.code == 413:
        return "Batch too large (413). Try a smaller --batch."
    try:
        return f"HTTP {err.code}: {json.load(err).get('detail', '')}"
    except Exception:  # noqa: BLE001 - error body is not always JSON
        return f"HTTP {err.code}"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", type=Path, nargs="?", default=Path("uploads"),
                    help="folder of photos, searched recursively (default: ./uploads)")
    ap.add_argument("--url", default=os.environ.get("FACESCAN_URL", "http://localhost:8000"),
                    help="server base URL (default: $FACESCAN_URL or http://localhost:8000)")
    ap.add_argument("--token", default=os.environ.get("FACESCAN_UPLOAD_TOKEN", ""),
                    help="upload token (default: $FACESCAN_UPLOAD_TOKEN)")
    ap.add_argument("--batch", type=int, default=10, help="photos per request (default: 10)")
    ap.add_argument("--force", action="store_true", help="re-send files already uploaded")
    ap.add_argument("--dry-run", action="store_true", help="list what would be sent, send nothing")
    ap.add_argument("--retries", type=int, default=2, help="retries per batch on network errors")
    ap.add_argument("--state", type=Path, help=f"state file (default: <folder>/{STATE_NAME})")
    args = ap.parse_args(argv)

    if not args.folder.is_dir():
        print(f"No such folder: {args.folder}", file=sys.stderr)
        return 2
    if not args.token and not args.dry_run:
        print("No upload token. Pass --token or set FACESCAN_UPLOAD_TOKEN.", file=sys.stderr)
        return 2

    state_path = args.state or args.folder / STATE_NAME
    state = {} if args.force else load_state(state_path)

    found = list(iter_images(args.folder))
    todo = [p for p in found if state.get(str(p.resolve())) != key_of(p)]
    skipped = len(found) - len(todo)

    print(f"{len(found)} images under {args.folder}"
          f"{f', {skipped} already uploaded' if skipped else ''}"
          f" -> {len(todo)} to send")
    if not todo:
        return 0
    if args.dry_run:
        for p in todo:
            print("  would send", p)
        return 0

    sent = faces = failed = 0
    for batch in batches(todo, args.batch):
        for attempt in range(args.retries + 1):
            try:
                result = post_batch(args.url, args.token, batch)
                break
            except urllib.error.HTTPError as e:
                print(f"  ! {explain(e)}", file=sys.stderr)
                return 1  # a rejected request will not succeed on retry
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if attempt == args.retries:
                    print(f"  ! giving up on {len(batch)} file(s): {e}", file=sys.stderr)
                    failed += len(batch)
                    result = None
                    break
                wait = 2 ** attempt
                print(f"  . network error ({e}); retrying in {wait}s", file=sys.stderr)
                time.sleep(wait)
        if result is None:
            continue

        by_name = {p["filename"]: p for p in result["photos"]}
        for p in batch:
            entry = by_name.get(p.name)
            if entry and entry["ok"]:
                state[str(p.resolve())] = key_of(p)
            else:
                failed += 1
                print(f"  ! {p.name}: {(entry or {}).get('error', 'rejected')}", file=sys.stderr)
        sent += result["indexed"]
        faces += result["faces"]
        save_state(state_path, state)  # checkpoint: a Ctrl-C keeps the progress
        print(f"  {sent}/{len(todo)} uploaded ({faces} faces)")

    print(f"\nDone. {sent} uploaded, {faces} faces indexed, {failed} failed, {skipped} skipped.")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
