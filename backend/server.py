"""Local inference service. Receives current video frames; never replaces video playback."""
import base64
from contextlib import asynccontextmanager
import os
from pathlib import Path
import threading
import time

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, ConfigDict

from backend.inference import INPUTS, load_detector, pick_device
from backend.vision import CameraTracker

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / '.runtime'
RUNTIME.mkdir(exist_ok=True)
(RUNTIME / 'ultralytics').mkdir(exist_ok=True)
os.environ.setdefault('YOLO_CONFIG_DIR', str(RUNTIME / 'ultralytics'))
LOCK = threading.RLock()  # serializes inference; analyze() refuses rather than queues
DETECTOR = None
MODEL_STATUS = 'loading'
MODEL_ERROR = None
DEVICE = pick_device()
SESSIONS = {}
ASSETS = {'app.js', 'ai.js', 'styles.css', 'overlay-core.js'}


def decode_frame(encoded):
    try:
        raw = base64.b64decode(encoded.split(',')[-1], validate=True)
        if len(raw) > 1_000_000:
            raise ValueError('Frame too large')
        image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError('Undecodable frame')
        height, width = image.shape[:2]
        if width > 1280 or height > 1280 or width < 32 or height < 32:
            raise ValueError('Unsupported frame dimensions')
        return image
    except Exception as exc:
        raise HTTPException(422, 'Invalid video frame') from exc


def load_model():
    global DETECTOR, MODEL_STATUS, MODEL_ERROR, DEVICE
    try:
        detector = load_detector(RUNTIME / 'yolo11n.pt', DEVICE)
        try:
            detector.warm()
        except Exception as exc:
            if DEVICE == 'cpu':
                raise
            DEVICE, MODEL_ERROR = 'cpu', f'GPU unavailable, using CPU ({exc})'
            detector = load_detector(RUNTIME / 'yolo11n.pt', 'cpu')
            detector.warm()
        with LOCK:
            DETECTOR = detector
            MODEL_STATUS = 'ready'
    except Exception as exc:
        MODEL_STATUS, MODEL_ERROR = 'error', str(exc)


@asynccontextmanager
async def lifespan(app):
    threading.Thread(target=load_model, daemon=True).start()
    yield


app = FastAPI(lifespan=lifespan)
ORIGINS = {'http://127.0.0.1:4173', 'http://127.0.0.1:4174', 'http://localhost:4173', 'http://localhost:4174'}
app.add_middleware(CORSMiddleware, allow_origins=list(ORIGINS), allow_methods=['GET', 'POST'], allow_headers=['Content-Type'])


@app.middleware('http')
async def local_requests(request: Request, call_next):
    from fastapi.responses import JSONResponse
    origin = request.headers.get('origin')
    if origin and origin not in ORIGINS:
        return JSONResponse({'detail': 'Local workspace origin required'}, status_code=403)
    try:
        if int(request.headers.get('content-length', '0')) > 12_000_000:
            return JSONResponse({'detail': 'Request too large'}, status_code=413)
    except ValueError:
        return JSONResponse({'detail': 'Invalid content length'}, status_code=400)
    response = await call_next(request)
    response.headers['Cache-Control'] = 'no-store'
    return response


class Frame(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    camera_id: str = Field(min_length=1, max_length=80)
    session_id: str = Field(min_length=1, max_length=100)
    source: str = Field(max_length=600)
    timestamp: float = Field(ge=0)
    image: str = Field(max_length=1_400_000)


class FrameBatch(BaseModel):
    frames: list[Frame] = Field(min_length=1, max_length=10)


@app.get('/api/health')
def health():
    return {'status': MODEL_STATUS, 'model': 'YOLO11n', 'device': DEVICE, 'input': list(INPUTS.get(DEVICE, INPUTS['cpu'])), 'error': MODEL_ERROR}


@app.post('/api/analyze')
def analyze(batch: FrameBatch):
    if MODEL_STATUS != 'ready' or DETECTOR is None:
        raise HTTPException(503, 'Vehicle model is still loading' if MODEL_STATUS == 'loading' else 'Vehicle model unavailable')
    if not LOCK.acquire(blocking=False):
        raise HTTPException(429, 'Processor busy; send the next current frame')
    try:
        start = time.monotonic()
        images = [decode_frame(frame.image) for frame in batch.frames]
        detections_per_frame = DETECTOR.detect(images)
        response = []
        now = time.monotonic()
        for frame, detections in zip(batch.frames, detections_per_frame):
            key = (frame.camera_id, frame.session_id, frame.source)
            session = SESSIONS.setdefault(key, {'tracker': CameraTracker(), 'seen': now})
            session['seen'] = now
            tracks = session['tracker'].update(detections, frame.timestamp)
            response.append({'camera_id': frame.camera_id, 'session_id': frame.session_id, 'timestamp': frame.timestamp, 'tracks': tracks, 'count': len(tracks)})
        for key in list(SESSIONS):
            if now-SESSIONS[key]['seen'] > 30:
                del SESSIONS[key]
        return {'frames': response, 'inference_ms': round((time.monotonic()-start)*1000), 'device': DEVICE}
    finally:
        LOCK.release()


@app.get('/')
def index():
    return FileResponse(ROOT / 'index.html')


@app.get('/{filename}')
def assets(filename: str):
    if filename not in ASSETS:
        raise HTTPException(404)
    return FileResponse(ROOT / filename)
