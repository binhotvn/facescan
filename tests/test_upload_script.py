"""Tests for the upload.py CLI (batching, resume state, multipart encoding)."""
import json
import sys
from email.parser import BytesParser
from email.policy import default
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import upload  # noqa: E402


def _img(p: Path, size: int = 100) -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"\xff\xd8\xff" + b"x" * size)
    return p


def test_iter_images_walks_subfolders_and_skips_non_images(tmp_path):
    _img(tmp_path / "a.jpg")
    _img(tmp_path / "day1" / "b.JPEG")
    _img(tmp_path / "day1" / "sub" / "c.png")
    (tmp_path / "notes.txt").write_text("hi")
    _img(tmp_path / ".hidden.jpg")

    names = [p.name for p in upload.iter_images(tmp_path)]

    assert names == ["a.jpg", "b.JPEG", "c.png"]


def test_batches_split_by_count(tmp_path):
    files = [_img(tmp_path / f"{i}.jpg") for i in range(5)]
    assert [len(b) for b in upload.batches(files, max_count=2)] == [2, 2, 1]


def test_batches_split_by_total_bytes(tmp_path):
    files = [_img(tmp_path / f"{i}.jpg", size=400) for i in range(4)]
    # ~403 bytes each: a 900-byte cap fits two per request
    assert [len(b) for b in upload.batches(files, max_count=99, max_bytes=900)] == [2, 2]


def test_multipart_round_trips(tmp_path):
    files = [_img(tmp_path / "one.jpg"), _img(tmp_path / "two.png")]

    ctype, body = upload.multipart(files)
    parsed = BytesParser(policy=default).parsebytes(
        f"Content-Type: {ctype}\r\nMIME-Version: 1.0\r\n\r\n".encode() + body
    )
    parts = list(parsed.iter_parts())

    assert [p.get_filename() for p in parts] == ["one.jpg", "two.png"]
    assert all(p.get_param("name", header="content-disposition") == "files" for p in parts)
    assert parts[0].get_payload(decode=True) == files[0].read_bytes()
    assert parts[1].get_content_type() == "image/png"


def test_state_round_trip_and_change_detection(tmp_path):
    f = _img(tmp_path / "a.jpg")
    state = {str(f.resolve()): upload.key_of(f)}
    upload.save_state(tmp_path / "s.json", state)

    assert upload.load_state(tmp_path / "s.json") == state

    f.write_bytes(b"\xff\xd8\xff" + b"y" * 999)  # edited -> different key
    assert upload.key_of(f) != state[str(f.resolve())]


def test_load_state_survives_a_corrupt_file(tmp_path):
    (tmp_path / "s.json").write_text("{not json")
    assert upload.load_state(tmp_path / "s.json") == {}


@pytest.fixture
def fake_server(monkeypatch):
    """Capture what main() would POST, and answer as the API does."""
    calls = []

    def fake_post(url, token, files, timeout=600):
        calls.append({"url": url, "token": token, "names": [f.name for f in files]})
        return {
            "indexed": len(files),
            "faces": 2 * len(files),
            "photos": [{"filename": f.name, "ok": True, "faces": 2} for f in files],
        }

    monkeypatch.setattr(upload, "post_batch", fake_post)
    return calls


def test_main_uploads_everything_then_resumes(tmp_path, fake_server, capsys):
    _img(tmp_path / "a.jpg")
    _img(tmp_path / "day2" / "b.jpg")

    assert upload.main([str(tmp_path), "--token", "t"]) == 0
    assert sorted(fake_server[0]["names"]) == ["a.jpg", "b.jpg"]
    assert "2 uploaded" in capsys.readouterr().out

    # second run: nothing new
    assert upload.main([str(tmp_path), "--token", "t"]) == 0
    assert len(fake_server) == 1

    # a new photo appears mid-event
    _img(tmp_path / "day2" / "c.jpg")
    assert upload.main([str(tmp_path), "--token", "t"]) == 0
    assert fake_server[1]["names"] == ["c.jpg"]


def test_main_force_resends(tmp_path, fake_server):
    _img(tmp_path / "a.jpg")
    upload.main([str(tmp_path), "--token", "t"])
    upload.main([str(tmp_path), "--token", "t", "--force"])
    assert len(fake_server) == 2


def test_main_dry_run_sends_nothing(tmp_path, fake_server, capsys):
    _img(tmp_path / "a.jpg")
    assert upload.main([str(tmp_path), "--dry-run"]) == 0
    assert fake_server == []
    assert "would send" in capsys.readouterr().out


def test_main_requires_a_token(tmp_path, capsys):
    _img(tmp_path / "a.jpg")
    assert upload.main([str(tmp_path)]) == 2
    assert "token" in capsys.readouterr().err.lower()


def test_main_rejects_a_missing_folder(tmp_path):
    assert upload.main([str(tmp_path / "nope"), "--token", "t"]) == 2


def test_failed_files_are_not_marked_uploaded(tmp_path, monkeypatch):
    _img(tmp_path / "good.jpg")
    _img(tmp_path / "bad.jpg")

    def fake_post(url, token, files, timeout=600):
        return {
            "indexed": 1,
            "faces": 1,
            "photos": [
                {"filename": f.name, "ok": f.name == "good.jpg", "error": "Không đọc được ảnh."}
                for f in files
            ],
        }

    monkeypatch.setattr(upload, "post_batch", fake_post)

    assert upload.main([str(tmp_path), "--token", "t"]) == 1  # non-zero: something failed
    state = json.loads((tmp_path / upload.STATE_NAME).read_text())
    assert [Path(k).name for k in state] == ["good.jpg"]  # the bad one will be retried
