import base64
import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from backend import server


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(server, 'SESSIONS', {})
    return TestClient(server.app)


def frame():
    image = np.random.default_rng(5).integers(0, 256, (360,640,3), dtype=np.uint8)
    ok, data = cv2.imencode('.jpg', image)
    return base64.b64encode(data).decode()


class FakeDetector:
    def __init__(self, boxes):
        self.boxes = boxes
        self.calls = []

    def detect(self, images):
        self.calls.append(len(images))
        return [[{'box': box, 'category': 2, 'confidence': .9} for box in self.boxes] for _ in images]


def analyze(client, timestamp):
    return client.post('/api/analyze', json={'frames': [{'camera_id': '1', 'session_id': 'one', 'source': 'url', 'timestamp': timestamp, 'image': frame()}]})


def test_cross_origin_requests_rejected(client):
    response = client.post('/api/analyze', headers={'Origin':'https://unrelated.example'}, json={})
    assert response.status_code == 403


def test_private_files_not_served(client):
    assert client.get('/requirements.txt').status_code == 404
    assert client.get('/.runtime/yolo11n.pt').status_code == 404
    assert client.get('/calibration.js').status_code == 404
    for name in ('ai.js', 'overlay-core.js', 'app.js', 'styles.css'):
        assert client.get('/'+name).status_code == 200, name


def test_model_loading_is_explicit(client, monkeypatch):
    monkeypatch.setattr(server, 'MODEL_STATUS', 'loading')
    assert analyze(client, 1).status_code == 503


def test_invalid_frames_are_rejected(client, monkeypatch):
    monkeypatch.setattr(server, 'MODEL_STATUS', 'ready')
    monkeypatch.setattr(server, 'DETECTOR', FakeDetector([]), raising=False)
    response = client.post('/api/analyze', json={'frames': [{'camera_id': '1', 'session_id': 'one', 'source': 'url', 'timestamp': 1, 'image': 'bm90IGFuIGltYWdl'}]})
    assert response.status_code == 422


def test_analyze_reports_tracks_velocity_hits_and_device(client, monkeypatch):
    detector = FakeDetector([[.4, .1, .5, .2]])
    monkeypatch.setattr(server, 'MODEL_STATUS', 'ready')
    monkeypatch.setattr(server, 'DETECTOR', detector, raising=False)
    monkeypatch.setattr(server, 'DEVICE', 'cpu')
    body = analyze(client, 1).json()
    assert body['device'] == 'cpu'
    assert body['frames'][0]['count'] == 1
    track = body['frames'][0]['tracks'][0]
    assert track['id'] == 1 and track['label'] == 'car' and track['velocity'] == [0, 0]
    assert set(track) == {'box', 'category', 'confidence', 'id', 'label', 'velocity', 'hits'}
    detector.boxes = [[.4, .14, .5, .24]]
    track = analyze(client, 1.2).json()['frames'][0]['tracks'][0]
    assert track['hits'] == 2
    assert track['velocity'] == pytest.approx([0, .2], abs=1e-6)
    assert detector.calls == [1, 1]
    assert client.get('/api/health').json()['input'] == [480, 384]  # DEVICE is patched to cpu
