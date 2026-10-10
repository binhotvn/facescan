"""The fixed-shape detector copy for CoreML clients (needs onnx; skipped in CI)."""
import pytest

onnx = pytest.importorskip("onnx")
from onnx import TensorProto, helper  # noqa: E402

from facescan import clientmodels  # noqa: E402


def _fake_scrfd(path):
    """A graph shaped like SCRFD: dynamic input, nine outputs."""
    inp = helper.make_tensor_value_info("input.1", TensorProto.FLOAT, [1, 3, "?", "?"])
    outs, nodes = [], []
    for i in range(9):
        width = (1, 4, 10)[i // 3]
        outs.append(helper.make_tensor_value_info(f"o{i}", TensorProto.FLOAT, [12800, width]))
        nodes.append(helper.make_node("Identity", ["input.1"], [f"o{i}"]))
    onnx.save(helper.make_model(helper.make_graph(nodes, "g", [inp], outs)), str(path))


def test_static_detector_fixes_every_shape(tmp_path):
    src = tmp_path / "det.onnx"
    _fake_scrfd(src)
    out = clientmodels.static_detector(src, 1024, tmp_path / "models", "abc")
    m = onnx.load(str(out))
    dims = lambda v: [d.dim_value for d in v.type.tensor_type.shape.dim]  # noqa: E731
    assert dims(m.graph.input[0]) == [1, 3, 1024, 1024]
    assert dims(m.graph.output[0]) == [32768, 1]   # stride 8: 128*128 cells, 2 anchors
    assert dims(m.graph.output[5]) == [2048, 4]    # stride 32 boxes
    assert dims(m.graph.output[8]) == [2048, 10]   # stride 32 landmarks
    # built once, then reused
    assert clientmodels.static_detector(src, 1024, tmp_path / "models", "abc") == out
