"""Detection runs on a size-capped copy; coordinates must come back in
original-image space, and the stored dimensions must stay the original ones."""
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from facescan import engine, ingest  # noqa: E402

cv2 = pytest.importorskip("cv2")


def test_downscale_caps_the_long_edge_and_keeps_the_aspect():
    img = np.zeros((2000, 4000, 3), np.uint8)
    out, scale = engine.downscale(img, 1000)

    assert out.shape[1] == 1000
    assert out.shape[0] == 500
    assert scale == pytest.approx(0.25)


def test_downscale_caps_the_long_edge_of_a_portrait():
    out, scale = engine.downscale(np.zeros((4000, 3000, 3), np.uint8), 2000)
    assert (out.shape[0], out.shape[1]) == (2000, 1500)
    assert scale == pytest.approx(0.5)


def test_downscale_never_upscales():
    img = np.zeros((400, 600, 3), np.uint8)
    out, scale = engine.downscale(img, 2560)

    assert out is img  # same object: no copy, no work
    assert scale == 1.0


def test_downscale_uses_the_configured_default(monkeypatch):
    monkeypatch.setattr(engine, "MAX_EDGE", 800)
    out, _ = engine.downscale(np.zeros((1000, 2000, 3), np.uint8))
    assert out.shape[1] == 800


def test_process_one_reports_original_size_and_coordinates(tmp_path, monkeypatch):
    photo = tmp_path / "big.jpg"
    cv2.imwrite(str(photo), np.full((2000, 4000, 3), 128, np.uint8))
    monkeypatch.setattr(engine, "MAX_EDGE", 1000)  # forces a 0.25 scale

    seen = {}

    def fake_extract(img):
        seen["shape"] = img.shape[:2]
        # a face at (100,50)-(200,150) in the downscaled copy
        return [SimpleNamespace(
            bbox=np.array([100.0, 50.0, 200.0, 150.0]),
            det_score=0.9,
            normed_embedding=np.ones(512, np.float32) / np.sqrt(512),
        )]

    monkeypatch.setattr(engine, "extract_faces", fake_extract)

    result = ingest._process_one(str(photo))

    assert seen["shape"] == (500, 1000)          # detection saw the capped copy
    assert (result["width"], result["height"]) == (4000, 2000)  # original stored
    assert result["faces"][0]["bbox"] == [400.0, 200.0, 800.0, 600.0]  # x4 back


def test_process_one_returns_none_for_an_unreadable_file(tmp_path):
    bad = tmp_path / "bad.jpg"
    bad.write_bytes(b"not an image")
    assert ingest._process_one(str(bad)) is None
