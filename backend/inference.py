"""Fixed-shape YOLO inference. One input tensor shape keeps Apple-GPU graphs compiled once."""
import os
import cv2
import numpy as np

# Fixed input canvases (width, height; multiples of 32). The GPU affords the sharper 640 px input
# the app originally used; the CPU fallback keeps 480 px so a ten-feed batch stays under half a second.
INPUTS = {'mps': (640, 480), 'cpu': (480, 384)}
# The Apple GPU compiles a graph per batch shape (about half a second each), so batches are padded to one of these.
BATCH_SIZES = (1, 2, 4, 6, 8, 10)
CLASSES = [2, 3, 5, 7]


def pick_device():
    override = os.environ.get('CYCLONE_DEVICE')
    if override:
        return override
    import torch
    return 'mps' if torch.backends.mps.is_available() else 'cpu'


def letterbox(image, size):
    """Scale to fit `size` and centre on a gray canvas. Returns the canvas and (scale, dx, dy)."""
    height, width = image.shape[:2]
    scale = min(size[0] / width, size[1] / height)
    new_width, new_height = max(1, round(width * scale)), max(1, round(height * scale))
    resized = cv2.resize(image, (new_width, new_height), interpolation=cv2.INTER_LINEAR if scale > 1 else cv2.INTER_AREA)
    canvas = np.full((size[1], size[0], 3), 114, np.uint8)
    dx, dy = (size[0] - new_width) // 2, (size[1] - new_height) // 2
    canvas[dy:dy+new_height, dx:dx+new_width] = resized
    return canvas, (scale, dx, dy)


def unletterbox(box, transform, width, height, size):
    """Map a canvas-normalized xyxy box back to source-normalized coordinates."""
    scale, dx, dy = transform
    x1 = (box[0] * size[0] - dx) / scale / width
    y1 = (box[1] * size[1] - dy) / scale / height
    x2 = (box[2] * size[0] - dx) / scale / width
    y2 = (box[3] * size[1] - dy) / scale / height
    return [float(min(1, max(0, value))) for value in (x1, y1, x2, y2)]


class Detector:
    def __init__(self, model, device):
        self.model, self.device = model, device
        self.input = INPUTS.get(device, INPUTS['cpu'])

    def warm(self):
        blank = np.zeros((self.input[1], self.input[0], 3), np.uint8)
        for size in BATCH_SIZES if self.device == 'mps' else (1,):
            self._predict([blank] * size)

    def _predict(self, canvases):
        return self.model.predict(canvases, imgsz=self.input[0], conf=.3, classes=CLASSES, max_det=80, device=self.device, verbose=False)

    def detect(self, images):
        canvases, transforms = [], []
        for image in images:
            canvas, transform = letterbox(image, self.input)
            canvases.append(canvas)
            transforms.append(transform)
        if self.device == 'mps':
            # Pad to the nearest warmed batch size so the GPU only ever sees compiled shapes. CPU batches freely.
            size = next((size for size in BATCH_SIZES if size >= len(canvases)), len(canvases))
            padding = [np.full((self.input[1], self.input[0], 3), 114, np.uint8)] * (size - len(canvases))
            predictions = self._predict(canvases + padding)[:len(canvases)]
        else:
            predictions = self._predict(canvases)
        results = []
        for image, transform, prediction in zip(images, transforms, predictions):
            height, width = image.shape[:2]
            detections = []
            for box, category, confidence in zip(prediction.boxes.xyxyn.cpu().tolist(), prediction.boxes.cls.cpu().tolist(), prediction.boxes.conf.cpu().tolist()):
                detections.append({'box': unletterbox(box, transform, width, height, self.input), 'category': int(category), 'confidence': round(confidence, 3)})
            results.append(detections)
        return results


def load_detector(weights, device):
    from ultralytics import YOLO
    import torch
    if device == 'cpu':
        torch.set_num_threads(4)
    return Detector(YOLO(str(weights)), device)
