"""Tests for the upload.py client: discovery, content dedupe, batching,
multipart encoding, state, threading and the watch loop."""
import json
import sys
import threading
from email.parser import BytesParser
from email.policy import default
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import upload  # noqa: E402


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """The developer's shell often exports these; tests must not depend on it."""
    monkeypatch.delenv("FACESCAN_UPLOAD_TOKEN", raising=False)
    monkeypatch.delenv("FACESCAN_URL", raising=False)


def _img(p: Path, content: bytes = b"aaa") -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"\xff\xd8\xff" + content)
    return p


# --- discovery and batching -------------------------------------------------


def test_iter_images_walks_subfolders_and_skips_non_images(tmp_path):
    _img(tmp_path / "a.jpg")
    _img(tmp_path / "day1" / "b.JPEG")
    _img(tmp_path / "day1" / "sub" / "c.png")
    (tmp_path / "notes.txt").write_text("hi")
    _img(tmp_path / ".hidden.jpg")

    assert [p.name for p in upload.iter_images(tmp_path)] == ["a.jpg", "b.JPEG", "c.png"]


def test_batches_split_by_count(tmp_path):
    files = [_img(tmp_path / f"{i}.jpg", bytes([i])) for i in range(5)]
    assert [len(b) for b in upload.batches(files, max_count=2)] == [2, 2, 1]


def test_batches_split_by_total_bytes(tmp_path):
    files = [_img(tmp_path / f"{i}.jpg", b"x" * 400) for i in range(4)]
    assert [len(b) for b in upload.batches(files, max_count=99, max_bytes=900)] == [2, 2]


def test_multipart_round_trips(tmp_path):
    files = [_img(tmp_path / "one.jpg"), _img(tmp_path / "two.png", b"bbb")]

    ctype, body = upload.multipart(files)
    parsed = BytesParser(policy=default).parsebytes(
        f"Content-Type: {ctype}\r\nMIME-Version: 1.0\r\n\r\n".encode() + body
    )
    parts = list(parsed.iter_parts())

    assert [p.get_filename() for p in parts] == ["one.jpg", "two.png"]
    assert parts[0].get_payload(decode=True) == files[0].read_bytes()
    assert parts[1].get_content_type() == "image/png"


# --- state ------------------------------------------------------------------


def test_state_recognises_content_under_a_new_name(tmp_path):
    a = _img(tmp_path / "a.jpg", b"same")
    b = _img(tmp_path / "copies" / "renamed.jpg", b"same")
    state = upload.State(tmp_path / "s.json")
    state.mark(a, upload.file_hash(a))

    assert state.seen(upload.file_hash(b))  # different path, same bytes


def test_state_rehashes_a_changed_file(tmp_path):
    p = _img(tmp_path / "a.jpg", b"one")
    state = upload.State(tmp_path / "s.json")
    state.mark(p, upload.file_hash(p))
    assert state.known_hash(p)

    p.write_bytes(b"\xff\xd8\xff" + b"two" * 50)  # edited: cache must miss
    assert state.known_hash(p) is None


def test_state_survives_a_corrupt_file(tmp_path):
    (tmp_path / "s.json").write_text("{not json")
    assert upload.State(tmp_path / "s.json").hashes == {}


def test_state_save_is_atomic(tmp_path):
    p = _img(tmp_path / "a.jpg")
    state = upload.State(tmp_path / "s.json")
    state.mark(p, "abc")
    state.save()

    assert json.loads((tmp_path / "s.json").read_text())["hashes"] == {"abc": str(p.resolve())}
    assert not (tmp_path / "s.tmp").exists()


# --- uploading --------------------------------------------------------------


@pytest.fixture
def server(monkeypatch):
    """Records batches and answers like /api/upload, including duplicates."""
    calls = []
    seen: set[bytes] = set()
    lock = threading.Lock()

    def fake_post(url, token, files, timeout=900):
        with lock:
            calls.append([f.name for f in files])
        photos = []
        for f in files:
            data = f.read_bytes()
            with lock:
                dup = data in seen
                seen.add(data)
            photos.append({"filename": f.name, "ok": True, "duplicate": dup,
                           "faces": 0 if dup else 3})
        return {
            "indexed": sum(0 if p["duplicate"] else 1 for p in photos),
            "faces": sum(p["faces"] for p in photos),
            "duplicates": sum(p["duplicate"] for p in photos),
            "photos": photos,
        }

    monkeypatch.setattr(upload, "post_batch", fake_post)
    return calls


def _run(tmp_path, *extra):
    return upload.main([str(tmp_path), "--token", "t", "--plain", *extra])


def test_scan_does_not_hash_before_uploading(tmp_path, server, monkeypatch):
    """Startup must not stall: hashing happens per batch, inside the workers."""
    for i in range(5):
        _img(tmp_path / f"p{i}.jpg", bytes([i]) * 10)
    hashed_before_first_post = []
    real_hash = upload.file_hash

    def counting_hash(p):
        hashed_before_first_post.append(len(server))
        return real_hash(p)

    monkeypatch.setattr(upload, "file_hash", counting_hash)

    assert _run(tmp_path, "--workers", "1", "--batch", "1") == 0
    # the second batch is hashed only after the first request went out
    assert max(hashed_before_first_post) > 0


def test_uploads_everything_then_resumes(tmp_path, server):
    _img(tmp_path / "a.jpg", b"one")
    _img(tmp_path / "day2" / "b.jpg", b"two")

    assert _run(tmp_path) == 0
    assert sorted(sum(server, [])) == ["a.jpg", "b.jpg"]

    assert _run(tmp_path) == 0
    assert len(sum(server, [])) == 2  # nothing re-sent

    _img(tmp_path / "day2" / "c.jpg", b"three")
    assert _run(tmp_path) == 0
    assert sum(server, [])[-1] == "c.jpg"


def test_identical_content_is_sent_once(tmp_path, server):
    _img(tmp_path / "a.jpg", b"same")
    _img(tmp_path / "backup" / "a-copy.jpg", b"same")

    assert _run(tmp_path) == 0

    assert len(sum(server, [])) == 1  # the copy never left the machine


def test_force_resends(tmp_path, server):
    _img(tmp_path / "a.jpg")
    _run(tmp_path)
    _run(tmp_path, "--force")
    assert len(sum(server, [])) == 2


def test_parallel_upload_covers_every_file(tmp_path, server):
    for i in range(20):
        _img(tmp_path / f"p{i:02d}.jpg", bytes([i]) * 10)

    assert _run(tmp_path, "--workers", "4", "--batch", "3") == 0

    sent = sorted(sum(server, []))
    assert len(sent) == 20 and len(set(sent)) == 20


def test_dry_run_sends_nothing(tmp_path, server, capsys):
    _img(tmp_path / "a.jpg")
    assert upload.main([str(tmp_path), "--dry-run"]) == 0
    assert server == []
    assert "would send" in capsys.readouterr().out


def test_requires_a_token(tmp_path, capsys, monkeypatch):
    monkeypatch.chdir(tmp_path)  # no .env in reach
    _img(tmp_path / "a.jpg")
    assert upload.main([str(tmp_path)]) == 2
    assert "token" in capsys.readouterr().err.lower()


def test_dotenv_supplies_the_token_and_url(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text(
        "# comment\nFACESCAN_URL=https://photos.example.com\n"
        'FACESCAN_UPLOAD_TOKEN="s3cret"\n'
    )
    monkeypatch.chdir(tmp_path)

    args = upload.build_parser(upload.load_dotenv(tmp_path / ".env")).parse_args([])

    assert args.url == "https://photos.example.com"
    assert args.token == "s3cret"  # quotes stripped


def test_environment_beats_dotenv(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("FACESCAN_UPLOAD_TOKEN=from-file\n")
    monkeypatch.setenv("FACESCAN_UPLOAD_TOKEN", "from-env")

    args = upload.build_parser(upload.load_dotenv(tmp_path / ".env")).parse_args([])

    assert args.token == "from-env"


def test_no_token_is_hardcoded_in_the_source():
    """A default token in the file would ship a live credential to git."""
    source = Path(upload.__file__).read_text()
    line = next(ln for ln in source.splitlines() if '"--token"' in ln)
    assert "setting(" in line and "default=\"" not in line


def test_rejects_a_missing_folder(tmp_path):
    assert upload.main([str(tmp_path / "nope"), "--token", "t"]) == 2


def test_failed_files_are_not_marked_uploaded(tmp_path, monkeypatch):
    _img(tmp_path / "good.jpg", b"g")
    _img(tmp_path / "bad.jpg", b"b")

    def fake_post(url, token, files, timeout=900):
        return {"indexed": 1, "faces": 1, "duplicates": 0, "photos": [
            {"filename": f.name, "ok": f.name == "good.jpg", "error": "Không đọc được ảnh."}
            for f in files]}

    monkeypatch.setattr(upload, "post_batch", fake_post)

    assert _run(tmp_path) == 1
    state = json.loads((tmp_path / upload.STATE_NAME).read_text())
    assert [Path(v).name for v in state["hashes"].values()] == ["good.jpg"]


def test_a_fatal_server_error_stops_immediately(tmp_path, monkeypatch):
    import urllib.error
    for i in range(6):
        _img(tmp_path / f"p{i}.jpg", bytes([i]))

    def fake_post(url, token, files, timeout=900):
        raise urllib.error.HTTPError(url, 401, "Unauthorized", {}, None)

    monkeypatch.setattr(upload, "post_batch", fake_post)

    assert _run(tmp_path, "--batch", "1", "--workers", "1") == 1
    assert not (tmp_path / upload.STATE_NAME).exists() or \
        json.loads((tmp_path / upload.STATE_NAME).read_text()).get("hashes") == {}


def test_network_errors_retry_then_succeed(tmp_path, monkeypatch):
    import urllib.error
    _img(tmp_path / "a.jpg")
    attempts = []

    def flaky(url, token, files, timeout=900):
        attempts.append(1)
        if len(attempts) == 1:
            raise urllib.error.URLError("connection reset")
        return {"indexed": 1, "faces": 2, "duplicates": 0,
                "photos": [{"filename": f.name, "ok": True, "faces": 2} for f in files]}

    monkeypatch.setattr(upload, "post_batch", flaky)
    monkeypatch.setattr(upload.time, "sleep", lambda *_: None)

    assert _run(tmp_path) == 0
    assert len(attempts) == 2


# --- watch mode -------------------------------------------------------------


def test_settled_ignores_a_file_still_being_written(tmp_path, monkeypatch):
    p = _img(tmp_path / "a.jpg")
    now = p.stat().st_mtime

    assert not upload.settled(p, now)                       # just written
    assert upload.settled(p, now + upload.SETTLE_SECONDS + 1)


def test_watch_picks_up_a_file_dropped_after_the_first_pass(tmp_path, server, monkeypatch):
    _img(tmp_path / "first.jpg", b"one")
    monkeypatch.setattr(upload, "SETTLE_SECONDS", 0)

    dropped = {"done": False}
    real_sleep = upload.time.sleep

    def fake_sleep(seconds):
        # the photographer copies a photo in while the watcher idles
        if not dropped["done"]:
            _img(tmp_path / "dropped.jpg", b"two")
            dropped["done"] = True
            return
        raise KeyboardInterrupt

    monkeypatch.setattr(upload.time, "sleep", fake_sleep)

    assert upload.main([str(tmp_path), "--token", "t", "--plain", "--watch"]) == 0
    assert real_sleep is not None
    assert sorted(sum(server, [])) == ["dropped.jpg", "first.jpg"]
