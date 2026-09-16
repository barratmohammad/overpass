"""Camera-local vehicle tracking: stable IDs and image-space velocity for the overlay."""
from collections import deque
from dataclasses import dataclass, field
import math
import numpy as np
from scipy.optimize import linear_sum_assignment

VEHICLES = {2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck'}
FLOW_GRID = (16, 12)  # cells of the frame that remember how established vehicles move through them
FLOW_SAMPLES = 12


def size_of(box):
    return math.hypot(box[2]-box[0], box[3]-box[1])


def iou(a, b):
    left, top = max(a[0], b[0]), max(a[1], b[1])
    right, bottom = min(a[2], b[2]), min(a[3], b[3])
    intersection = max(0, right-left) * max(0, bottom-top)
    return intersection / max(1e-9, (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - intersection)


@dataclass
class Track:
    id: int
    box: list
    category: int
    time: float
    velocity: np.ndarray = field(default_factory=lambda: np.zeros(2))
    hits: int = 1


class CameraTracker:
    def __init__(self):
        self.tracks = {}
        self.next_id = 1
        self.last_time = None
        self.flow = {}  # cell -> recent velocities of established vehicles, in box lengths per second

    @staticmethod
    def cell(box):
        return (min(FLOW_GRID[0]-1, int((box[0]+box[2]) / 2 * FLOW_GRID[0])), min(FLOW_GRID[1]-1, int((box[1]+box[3]) / 2 * FLOW_GRID[1])))

    def learn_flow(self, track, measured, previous):
        """Remember how an established vehicle moves here. Box lengths per second cancel the depth difference within a cell."""
        if np.linalg.norm(measured - previous) > .5 * np.linalg.norm(previous) + .02:
            return  # a step that disagrees with the track's own motion is probably a wrong link
        size = max(1e-6, size_of(track.box))
        self.flow.setdefault(self.cell(track.box), deque(maxlen=FLOW_SAMPLES)).append([*(track.velocity / size), size])

    def flow_prior(self, box):
        """Velocity that established vehicles of this size show at this spot, or zero where flow is unknown or inconsistent."""
        samples = self.flow.get(self.cell(box))
        if not samples or len(samples) < 5:
            return np.zeros(2)
        samples = np.asarray(samples)
        rates, typical_size = np.median(samples[:, :2], axis=0), np.median(samples[:, 2])
        rate = np.linalg.norm(rates)
        agreeing = np.sum(np.linalg.norm(samples[:, :2] - rates, axis=1) < .5 * rate + .5)
        # A box far from the usual size here is a merged or partial detection, not a comparable vehicle.
        if rate < .5 or agreeing < .75 * len(samples) or not .5 < size_of(box) / typical_size < 2:
            return np.zeros(2)
        return rates * size_of(box)

    def update(self, detections, timestamp):
        if not math.isfinite(timestamp):
            raise ValueError('Invalid media timestamp')
        # A seek, HLS discontinuity, or long sampling gap ends track continuity.
        if self.last_time is not None and (timestamp <= self.last_time or timestamp - self.last_time > 1.5):
            self.tracks.clear()
        self.last_time = timestamp
        self.tracks = {key: track for key, track in self.tracks.items() if timestamp-track.time <= 1.5}
        prior = list(self.tracks.values())
        costs = np.full((len(prior), len(detections)), 1000.)
        for i, track in enumerate(prior):
            dt = timestamp - track.time
            size = math.hypot(track.box[2]-track.box[0], track.box[3]-track.box[1])
            speed = float(np.linalg.norm(track.velocity))
            # The link gate is the plausible prediction error: detection jitter scales with box size and velocity drift
            # with elapsed time. A first sighting moving on borrowed flow gets half again as much room; one without
            # any velocity gets fixed extra room.
            gate = .01 + .5*size + .5*speed*dt
            if track.hits < 2:
                gate = 1.5*gate if speed > 0 else .12 + .35*dt
            gate = min(.4, gate)
            predicted = np.asarray(track.box) + np.tile(track.velocity * dt, 2)
            old_center = (predicted[:2] + predicted[2:]) / 2
            for j, detection in enumerate(detections):
                box = detection['box']
                ratio = math.hypot(box[2]-box[0], box[3]-box[1]) / max(1e-6, size)
                if track.category != detection['category'] or not .5 < ratio < 2:
                    continue
                distance = np.linalg.norm((np.asarray(box[:2]) + box[2:]) / 2 - old_center)
                if distance < gate:
                    costs[i, j] = distance/max(1e-6, size) + 1 - iou(predicted, box)
        assigned = {}
        if costs.size:
            rows, cols = linear_sum_assignment(costs)
            for i, j in zip(rows, cols):
                if costs[i, j] < 1000:
                    assigned[j] = prior[i]
        result = []
        for j, detection in enumerate(detections):
            box = detection['box']
            track = assigned.get(j)
            if track is None:
                # A first sighting borrows the local flow so the overlay can move it before a second detection confirms.
                track = Track(self.next_id, box, detection['category'], timestamp, self.flow_prior(box))
                self.next_id += 1
                self.tracks[track.id] = track
            else:
                dt = timestamp-track.time
                measured = previous = None
                if dt > 0:
                    measured = (np.asarray(box[:2])+box[2:] - np.asarray(track.box[:2])-track.box[2:]) / 2 / dt
                    previous = track.velocity
                    if track.hits == 1:
                        track.velocity = measured
                    else:
                        blend = 1 - math.exp(-dt / .3)
                        track.velocity = (1-blend)*track.velocity + blend*measured
                track.hits += 1
                track.box, track.time = box, timestamp
                if track.hits >= 3 and measured is not None:
                    self.learn_flow(track, measured, previous)
            result.append({**detection, 'id': track.id, 'label': VEHICLES.get(track.category, 'vehicle'),
                           'velocity': [float(value) for value in track.velocity], 'hits': track.hits})
        return result
