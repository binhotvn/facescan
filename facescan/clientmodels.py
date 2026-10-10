"""The server's face models, shared with machines that index on their own.

The desktop uploader can run detection + embedding on the photographer's
laptop (Apple GPU through CoreML, DirectML on Windows) and send the faces with
the photo. Two things make that safe:

* it downloads these exact model files from this server, so both sides run
  the same weights; and
* the server only stores client faces whose `signature` matches its own: the
  hash of both model files plus every parameter that changes the result
  (detector size, the long-edge cap, the detection threshold). Change any of
  them here and stale clients fall back to having the server index for them.

CoreML refuses SCRFD's dynamic input shape, so the detector is also offered as
a fixed-size copy (1 x 3 x det_size x det_size). It is the same graph and
weights with the shapes written in.
"""
from __future__ import annotations

import hashlib
import logging
import threading
from pathlib import Path

log = logging.getLogger("facescan.clientmodels")

_lock = threading.Lock()
_cached: dict | None = None


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def static_detector(src: Path, size: int, out_dir: Path, tag: str) -> Path:
    """A copy of the SCRFD model with a fixed 1x3xSxS input (built once)."""
    out = out_dir / f"det-static-{size}-{tag[:12]}.onnx"
    if out.is_file():
        return out
    import onnx  # only the server needs it, and only to build this file once

    model = onnx.load(str(src))

    def fix(dim, value):
        dim.ClearField("dim_param")
        dim.dim_value = int(value)

    dims = model.graph.input[0].type.tensor_type.shape.dim
    fix(dims[0], 1)
    fix(dims[2], size)
    fix(dims[3], size)
    outputs = model.graph.output
    if len(outputs) != 9:  # scores, boxes, landmarks at strides 8/16/32
        raise RuntimeError(f"unexpected SCRFD outputs: {len(outputs)}")
    for i, value in enumerate(outputs):
        od = value.type.tensor_type.shape.dim
        if len(od) == 3:
            fix(od[0], 1)
        stride = (8, 16, 32)[i % 3]
        fix(od[len(od) - 2], (size // stride) ** 2 * 2)  # two anchors per cell
        fix(od[-1], (1, 4, 10)[i // 3])
    del model.graph.value_info[:]  # stale dynamic shapes would contradict the fixed ones
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    onnx.save(model, str(tmp))
    tmp.replace(out)
    return out


def manifest(engine, data_dir: Path, max_edge: int) -> dict:
    """What a client downloads, and the signature its results must carry."""
    global _cached
    with _lock:
        if _cached is not None:
            return _cached
        det = engine.models["detection"]
        rec = engine.models["recognition"]
        det_size = int(det.input_size[0])
        det_thresh = float(engine.det_thresh)
        det_sha = sha256_file(Path(det.model_file))
        rec_sha = sha256_file(Path(rec.model_file))
        static = static_detector(Path(det.model_file), det_size, data_dir / "models", det_sha)
        signature = hashlib.sha256(
            f"{det_sha}:{rec_sha}:{det_size}:{max_edge}:{det_thresh}".encode()
        ).hexdigest()
        files = {}
        for role, path in (("detection", static), ("recognition", Path(rec.model_file))):
            files[role] = {
                "path": path,
                "name": path.name,
                "size": path.stat().st_size,
                "sha256": sha256_file(path),
            }
        _cached = {
            "signature": signature,
            "det_size": det_size,
            "det_thresh": det_thresh,
            "max_edge": int(max_edge),
            "files": files,
        }
        log.info("client models ready (signature %s)", signature[:12])
        return _cached


def public(m: dict) -> dict:
    """The manifest without server paths."""
    return {**m, "files": {k: {f: v for f, v in d.items() if f != "path"}
                           for k, d in m["files"].items()}}
