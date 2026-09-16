import pytest
from backend.vision import CameraTracker


def detection(y, x=.4):
    return {'box': [x, y-.1, x+.1, y], 'category': 2, 'confidence': .9}


def test_a_moving_vehicle_keeps_one_id():
    tracker = CameraTracker()
    for i in range(10):
        tracks = tracker.update([detection(.2+i*.02)], i*.2)
        assert tracks[0]['id'] == 1
    assert tracks[0]['label'] == 'car'


@pytest.mark.parametrize('timestamp', [-1, 10])
def test_seek_or_long_gap_starts_new_tracks(timestamp):
    tracker = CameraTracker()
    for i in range(5):
        tracker.update([detection(.2+i*.04)], i*.2)
    assert tracker.update([detection(.4)], timestamp)[0]['id'] == 2


def test_camera_tracker_state_is_independent():
    first, second = CameraTracker(), CameraTracker()
    for i in range(5):
        first.update([detection(.2+i*.04)], i*.2)
    assert second.update([detection(.3)], 1.6)[0]['id'] == 1


def test_velocity_is_measured_from_the_first_pair():
    tracker = CameraTracker()
    tracker.update([detection(.2)], 0)
    track = tracker.update([detection(.24)], .2)[0]
    assert track['hits'] == 2
    assert track['velocity'] == pytest.approx([0, .2], abs=1e-6)


@pytest.mark.parametrize('step,dt', [(.06, .125), (.2, .5), (.13, .1)])
def test_fast_vehicle_keeps_its_id(step, dt):
    tracker = CameraTracker()
    for i in range(4):
        tracks = tracker.update([detection(.1+i*step)], i*dt)
    assert tracks[0]['id'] == 1


def test_different_vehicle_classes_do_not_swap_ids():
    tracker = CameraTracker()
    tracker.update([detection(.2), {**detection(.2, x=.6), 'category': 7}], 0)
    tracks = tracker.update([{**detection(.22, x=.6), 'category': 7}, detection(.22)], .1)
    assert [track['id'] for track in tracks] == [2, 1]


def small(y, x=.4, size=.028):
    """A distant car on a 320 px feed: about 9 px square."""
    return {'box': [x, y, x+size, y+size], 'category': 2, 'confidence': .6}


def test_small_vehicle_relinks_after_a_missed_frame_even_when_it_sped_up():
    # Seen twice, missed once, then found again further along than the two-sighting velocity predicts.
    tracker = CameraTracker()
    tracker.update([small(.10)], 0)
    tracker.update([small(.14)], .27)
    track = tracker.update([small(.26)], .81)[0]
    assert track['id'] == 1 and track['hits'] == 3


def test_adjacent_vehicles_in_neighbouring_lanes_keep_their_ids():
    tracker = CameraTracker()
    ids = []
    for i in range(8):
        y = .1+i*.05
        tracks = tracker.update([small(y, x=.40), small(y+.01, x=.44)], i*.27)
        ids.append(tuple(track['id'] for track in tracks))
    assert ids == [(1, 2)]*8


def test_detection_of_a_much_larger_vehicle_is_not_linked_to_a_small_track():
    tracker = CameraTracker()
    tracker.update([small(.10)], 0)
    tracker.update([small(.14)], .27)
    truck = {'box': [.36, .14, .48, .26], 'category': 2, 'confidence': .8}
    assert tracker.update([truck], .54)[0]['id'] == 2


def flow(tracker, x, direction=1, start=0.0, vehicles=5):
    """Drive small vehicles one after another through the cell around (x, .5) at .2 units/s; returns the last timestamp."""
    for vehicle in range(vehicles):
        for i in range(6):
            tracker.update([small((.35 if direction > 0 else .65)+direction*i*.06, x=x)], start+i*.3)
        start += 4
    return start


def test_a_first_sighting_inherits_the_local_flow_velocity():
    tracker = CameraTracker()
    end = flow(tracker, .4)
    track = tracker.update([small(.5, x=.41)], end)[0]
    assert track['hits'] == 1
    assert track['velocity'] == pytest.approx([0, .2], abs=.03)


def test_no_flow_prior_where_traffic_runs_both_ways_or_was_never_seen():
    tracker = CameraTracker()
    end = flow(tracker, .4, vehicles=3)
    end = flow(tracker, .4, direction=-1, start=end, vehicles=3)
    mixed, elsewhere = tracker.update([small(.5, x=.41), small(.5, x=.8)], end)
    assert mixed['velocity'] == [0, 0]
    assert elsewhere['velocity'] == [0, 0]


def test_flow_prior_is_not_skewed_by_a_wrongly_linked_step():
    tracker = CameraTracker()
    end = flow(tracker, .4)
    # One vehicle whose fourth sighting lands almost twice too far (a wrong link within the gate) in the cell under test.
    for i, y in enumerate([.29, .35, .41, .52, .58, .64]):
        tracker.update([small(y)], end+i*.3)
    track = tracker.update([small(.5, x=.41)], end+4)[0]
    assert track['velocity'] == pytest.approx([0, .2], abs=.01)


def test_flow_prior_needs_several_consistent_vehicles():
    tracker = CameraTracker()
    end = flow(tracker, .4, vehicles=3)
    assert tracker.update([small(.5, x=.41)], end)[0]['velocity'] == [0, 0]


def test_flow_prior_scales_with_the_size_of_the_new_vehicle():
    # Apparent speed and apparent size both shrink with distance, so a smaller first sighting moves proportionally slower.
    tracker = CameraTracker()
    end = flow(tracker, .4)
    nearer, farther = tracker.update([small(.5, x=.40, size=.042), small(.5, x=.41, size=.019)], end)
    assert nearer['velocity'] == pytest.approx([0, .3], abs=.02)
    assert farther['velocity'] == pytest.approx([0, .136], abs=.01)


def test_a_first_sighting_with_a_flow_prior_does_not_grab_a_vehicle_off_its_path():
    tracker = CameraTracker()
    end = flow(tracker, .4)
    tracker.update([small(.5, x=.41)], end)
    # The only detection next frame sits behind where the flow says this vehicle went: it is another vehicle.
    assert tracker.update([small(.45, x=.41)], end+.3)[0]['hits'] == 1


def test_no_flow_prior_for_a_first_sighting_of_an_unusual_size():
    # A box three times the size of vehicles seen here is a merged or partial detection, not a comparable vehicle.
    tracker = CameraTracker()
    end = flow(tracker, .4)
    assert tracker.update([small(.5, x=.35, size=.09)], end)[0]['velocity'] == [0, 0]
