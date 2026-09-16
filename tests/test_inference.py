import types
import numpy as np
import pytest
import torch
from backend import inference


class FakeModel:
    """Records predict calls and returns one centred box per image, like ultralytics results."""
    def __init__(self):
        self.calls = []

    def predict(self, images, **kwargs):
        self.calls.append([image.shape for image in images])
        boxes = types.SimpleNamespace(xyxyn=torch.tensor([[.25, .25, .75, .75]]), cls=torch.tensor([2.]), conf=torch.tensor([.9]))
        return [types.SimpleNamespace(boxes=boxes) for _ in images]


@pytest.mark.parametrize('width,height', [(320, 240), (720, 480), (1920, 1080)])
@pytest.mark.parametrize('size', [(640, 480), (480, 384)])
def test_letterbox_round_trips_boxes_to_source_coordinates(width, height, size):
    canvas, transform = inference.letterbox(np.zeros((height, width, 3), np.uint8), size)
    assert canvas.shape == (size[1], size[0], 3)
    scale, dx, dy = transform
    source = [.3, .4, .6, .9]
    on_canvas = [(source[0]*width*scale+dx)/size[0], (source[1]*height*scale+dy)/size[1],
                 (source[2]*width*scale+dx)/size[0], (source[3]*height*scale+dy)/size[1]]
    assert inference.unletterbox(on_canvas, transform, width, height, size) == pytest.approx(source, abs=1e-6)


def test_gpu_uses_the_sharper_640_input_and_cpu_the_cheaper_480():
    assert inference.INPUTS['mps'] == (640, 480)
    assert inference.INPUTS['cpu'] == (480, 384)
    assert inference.Detector(FakeModel(), 'mps').input == (640, 480)
    assert inference.Detector(FakeModel(), 'cpu').input == (480, 384)


def test_mps_detector_pads_each_batch_to_a_warmed_size():
    model = FakeModel()
    detector = inference.Detector(model, 'mps')
    images = [np.zeros((240, 320, 3), np.uint8), np.zeros((1080, 1920, 3), np.uint8), np.zeros((480, 720, 3), np.uint8)]
    results = detector.detect(images)
    # Three frames ride in the four-slot batch; only compiled shapes are ever sent to the GPU.
    assert model.calls == [[(480, 640, 3)] * 4]
    assert len(results) == 3 and all(len(result) == 1 for result in results)
    # 320x240 scales exactly 2x into 640x480, so the box maps back unchanged.
    assert results[0][0]['box'] == pytest.approx([.25, .25, .75, .75], abs=1e-6)
    # 1920x1080 scales to 640x360 inside a 60 px vertical margin, so the canvas box covers more of the source rows.
    assert results[1][0]['box'] == pytest.approx([.25, .1667, .75, .8333], abs=1e-3)
    assert results[0][0]['category'] == 2 and results[0][0]['confidence'] == .9


def test_mps_warm_up_compiles_every_batch_size_once():
    model = FakeModel()
    inference.Detector(model, 'mps').warm()
    assert [len(call) for call in model.calls] == list(inference.BATCH_SIZES) == [1, 2, 4, 6, 8, 10]
    assert all(shape == (480, 640, 3) for call in model.calls for shape in call)


def test_cpu_detector_predicts_the_whole_batch_once():
    model = FakeModel()
    results = inference.Detector(model, 'cpu').detect([np.zeros((240, 320, 3), np.uint8)] * 4)
    assert model.calls == [[(384, 480, 3)] * 4]
    assert len(results) == 4


def test_pick_device_prefers_apple_gpu_unless_overridden(monkeypatch):
    monkeypatch.delenv('CYCLONE_DEVICE', raising=False)
    monkeypatch.setattr(torch.backends.mps, 'is_available', lambda: True)
    assert inference.pick_device() == 'mps'
    monkeypatch.setattr(torch.backends.mps, 'is_available', lambda: False)
    assert inference.pick_device() == 'cpu'
    monkeypatch.setenv('CYCLONE_DEVICE', 'cpu')
    monkeypatch.setattr(torch.backends.mps, 'is_available', lambda: True)
    assert inference.pick_device() == 'cpu'
