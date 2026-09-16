# Overpass — Regional awareness

A tactical, responsive workspace for exploring public traffic cameras across the San Francisco Bay Area.

## Preview

**Hosted demo: https://overpass-zeta.vercel.app** — the live camera wall, map, search, and presentation view, with no setup. Vehicle analysis is not part of it: detection runs on a local processor, so the hosted AI panel says so and stays idle.

No API keys required. To get the vehicle boxes, start the local website and vehicle-analysis service together:

```sh
./run.sh
```

Open http://127.0.0.1:4173. The first run uses `uv` to install Python 3.11 and the pinned dependencies, then downloads the small YOLO11n model. Future runs reuse the model. Keep the terminal running while presenting. A plain static HTTP server still plays video, but cannot run the AI layer; served from any origin that is not `localhost` or `127.0.0.1`, the AI layer stands down entirely rather than reaching for a processor that is not there.

## Vehicle intelligence

Running locally, analysis is enabled for **every mounted live video**: all nine wall tiles and the spotlight. Rotating or filtering cameras automatically attaches analytics to the new feeds. It does not decode all 195 source streams in the background. Each request carries at most ten current frames, stale results are ignored, and the live-video display is never replaced by a still image.

- Detection identifies cars, motorcycles, buses, and trucks. Boxes carry camera-local track IDs.
- Each player has an isolated tracking session. IDs do not identify a vehicle across cameras, and no speeds are estimated.
- Vehicle counts describe currently detected objects, not cumulative traffic throughput. The model does not detect every distant or occluded vehicle.
- **Pause AI** stops inference without interrupting live video.

Brief buffering gaps have a 700 ms grace period before showing a reconnecting message, and verified video resumes immediately. Background reserve searches do not keep the camera controls disabled once the wall is populated.

Frames are processed by the local Python service and are not uploaded to an external AI provider or stored as video. Model weights live in `.runtime/`. The API and website bind only to `127.0.0.1`. Model readiness and processor errors appear in the AI panel, as does the hosted build's notice that analysis is local. The hosted build ships no model and makes no inference requests.

Inference runs on the Apple GPU when available (`CYCLONE_DEVICE=cpu` forces the CPU path) at one fixed input shape (640×480 on the GPU, 480×384 on the CPU fallback), so the GPU graph is compiled once. The GPU also compiles one graph per batch size, so each request is padded to one of six warmed batch sizes (1 to 10 frames) and a frame costs about 6 ms in a batch on the current Mac. The browser sends one request at a time, with the spotlight in every batch and wall tiles filling the remaining time budget, giving roughly 8 detections per second on the spotlight and 4–7 on each tile (bounded by the source frame rate). The AI panel shows the request rate, round trip, and device. Vehicles are linked between detections with a gate that scales with box size, speed, and elapsed time, so small or briefly missed vehicles keep their ID and velocity. Each camera also learns how established vehicles move through each part of its frame (in box lengths per second, so distance cancels), and a first sighting borrows that local flow when it is consistent and the box is a typical size there, so a new vehicle's box moves before its second detection confirms. Frames are captured inside video-frame callbacks so image pixels and analysis timestamps stay synchronized. Batches use those ready snapshots immediately; a stalled feed cannot delay the other cameras. Fast foreground vehicles retain motion prediction, and results from before a playback discontinuity are discarded. Each box is drawn on every presented video frame at its detection position extrapolated by the track's velocity (up to 600 ms), detection corrections ease in over about 70 ms with lag capped at one fifth of the box size, a missed detection keeps its box moving for up to 300 ms (longer on the tiles and the CPU path), and seeks or stalls reset the overlay. The batch budget follows the median of recent request times, so one slow request does not starve the tiles. A tile shows its vehicle count only once it has one; idle feeds carry no label. The GPU model plus ten decoding video streams fits comfortably on an 8 GB Mac; on machines without a supported GPU the CPU path keeps the spotlight responsive and slows the tiles.

The detector uses Ultralytics YOLO11n (Ultralytics AGPL-3.0/enterprise licensing: https://www.ultralytics.com/license). This project is licensed AGPL-3.0 to match; see [License](#license). The website itself continues to use key-free public map tiles.

### Validation

```sh
.venv/bin/python -m pytest -q
node tests/overlay-core.cjs
node tests/ai-scheduling.cjs
node tests/media-playback.cjs
node tests/ai-availability.cjs
```

The availability test checks that a hosted origin polls nothing, schedules nothing, mounts no overlay over the video, and explains itself in the AI panel, while any localhost origin still reaches the processor on 4173. The overlay test checks that boxes follow velocity to the presented frame, ease into corrections without overshoot, coast briefly and then drop, and reset on seeks and stalls. Backend tests cover stable IDs, velocity reporting, fast-vehicle association at slow cadence, re-linking small vehicles after a missed frame, neighbouring-lane ID stability, size-aware matching, class-aware matching, the learned flow prior (local, size-scaled, robust to wrong links, absent where traffic runs both ways or the box is unusual), time discontinuities, padded fixed-shape GPU batches and CPU batches, device selection, local API origin checks, and frame validation.

## Presenting

- **Present view** expands the workspace and requests browser fullscreen. Press Escape or use **Exit presentation** to leave.
- Select a map marker to inspect its camera. Select a camera card to bring its location into view.
- Search by road, location, or county; use the county selector to narrow the network.
- **Rotate cameras** shows the next group of up to nine feeds.
- A network connection is needed for maps, camera imagery, and CDN libraries.

## Data and reliability

Camera metadata: https://cwwp2.dot.ca.gov/data/d4/cctv/cctvStatusD04.json

The map, search results, camera wall, and spotlight include only video-enabled cameras. There is no still-image rendering, request, preview, or fallback. Counts in the summary reflect the source directory, not independently verified availability.

Six bounded workers validate HLS manifests to find up to nine video candidates and a reserve pool. LIVE appears only after playback advances and decoded frames contain scene detail. Solid gray/black/white frames and the provider outage graphic are rejected. Frame health is checked every two seconds. Failed players are removed and replaced, with a five-minute cooldown. Fewer cards are shown if not enough usable live streams are available; when none work, the site shows an explicit no-live-streams state. Changing filters cancels the previous scan.

Video elements remain rendered during startup so autoplay can proceed. HLS.js is preferred where supported; native HLS is the playback fallback. Streams have an 18-second startup window and a bounded buffering recovery window. The directory refresh time is the metadata fetch time, not the video capture time.

The last successfully fetched camera directory is saved locally for connection failures and explicitly labelled as saved data when reused. Recently verified camera IDs are saved to prioritize the next scan; their imagery is checked again. Images and map tiles are not bundled for offline use. If there is no saved directory, the site offers a retry action. There are no simulated events or invented uptime/latency metrics.

## Map without a CARTO API key

The map uses Leaflet 1.9.4 and standard OpenStreetMap raster tiles:

`https://tile.openstreetmap.org/{z}/{x}/{y}.png`

No CARTO account, API key, map token, or billing setup is required. A CSS filter gives the standard map a dark appearance. The provider URL is configured in `app.js` as `TILE_URL`.

OpenStreetMap's public tile service supports modest interactive use, requires visible attribution, honours normal browser caching, and offers no availability SLA. Do not bulk-download or prefetch tiles. For a large production deployment, choose a suitable hosted provider or self-hosted tiles. Policy: https://operations.osmfoundation.org/policies/tiles/

## Deploying

The hosted build is the static site only — `index.html`, `app.js`, `ai.js`, `overlay-core.js`, `styles.css`. `.vercelignore` keeps
`backend/`, `tests/`, `run.sh`, and the Python requirements out of the upload, and `vercel.json` pins a no-build static deployment
(`framework: null`, empty build and install commands) so the root `requirements.txt` is not mistaken for a Python app.

```sh
npx vercel --prod
```

The camera directory and the HLS hosts both send `Access-Control-Allow-Origin: *` and every stream URL is `https://`, so the video
wall, map, search, and presentation view all work unchanged from an HTTPS origin.

Do not add `COOP`/`COEP` headers. `require-corp` blocks the cross-origin HLS segments, map tiles, and fonts, which breaks the video.

## License

GNU Affero General Public License v3.0 — see `LICENSE`. The vehicle detector builds on Ultralytics YOLO11n, which is AGPL-3.0, so the
project carries the same license. Source: https://github.com/barratmohammad/overpass

## Files

- `index.html` — workspace and semantic page structure
- `styles.css` — responsive theme and presentation layout
- `app.js` — directory, map, live camera players, filtering, presentation controls
- `ai.js` — per-frame live overlays and inference scheduling
- `overlay-core.js` — box motion model shared with the node test
- `backend/` — fixed-shape local detector and per-player tracking
- `run.sh` — starts the local site and AI service
- `tests/` — analytics and API regression tests
- `vercel.json`, `.vercelignore` — static hosting config; the backend, tests, and Python requirements are never uploaded
- `LICENSE` — GNU AGPL-3.0

Dependencies load from CDNs: Leaflet 1.9.4 and hls.js 1.5.13; Google Fonts supplies the typefaces, with system fallbacks.

This is a concept demonstration using public infrastructure feeds. It does not identify or track individuals, is not affiliated with any government agency, and includes no private surveillance integration.
