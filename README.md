# FaceScan

Find yourself in event photos. Built for marathons and similar events:

1. **Organizer** dumps all event photos into a folder and runs the ingest script — every face in every photo is detected and embedded (InsightFace / ArcFace) into a SQLite index.
2. **Runner** opens the web page, uploads a selfie or takes one with the camera, and instantly gets back every event photo they appear in, ranked by confidence.

No cloud APIs — everything runs locally (CPU is fine).

The web UI is a Vite + React app built with IBM's Carbon Design System (`@carbon/react`, g100 theme), served as static files by the FastAPI backend.

## Quick start (local)

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# build the Carbon/React frontend (once, and after frontend changes)
cd frontend && npm install && npm run build && cd ..

# 1. Put event photos in ./photos (any nested structure, jpg/png/webp)
# 2. Index them (first run downloads the model, ~300MB)
python -m facescan.ingest photos/

# 3. Start the web app
uvicorn app:app --host 0.0.0.0 --port 8000
# open http://localhost:8000
```

Re-run the ingest anytime — already-indexed photos are skipped, only new/changed ones are processed:

```bash
python -m facescan.ingest photos/          # incremental
python -m facescan.ingest photos/ --force  # full re-index
```

## Quick start (Docker — easiest deploy)

```bash
docker compose up -d --build
# index the photos inside the container:
docker compose exec facescan python -m facescan.ingest photos/
# open http://<server>:8000
```

`./photos` and `./data` are mounted as volumes, so drop new photos in and re-run the exec line. The model cache lives in a named volume so it only downloads once.

## CLI search (no web UI)

```bash
python -m facescan.search selfie.jpg
python -m facescan.search selfie.jpg --threshold 0.45 --json
```

## How matching works

- Detector + embedder: InsightFace `buffalo_l` (RetinaFace detection + ArcFace 512-d embeddings), run on CPU via ONNX Runtime.
- Every face in every event photo gets one embedding row in SQLite (`data/facescan.db`).
- A search embeds the **largest** face in the query image and ranks index faces by cosine similarity.
- Threshold guide: `0.30` loose (more results, some false positives) → `0.35` default → `0.50` strict. The web UI has a slider.

## Configuration (env vars)

| Variable | Default | Meaning |
|---|---|---|
| `FACESCAN_PHOTOS` | `photos` | Directory the web app is allowed to serve photos from |
| `FACESCAN_THRESHOLD` | `0.35` | Default similarity cutoff |
| `FACESCAN_MODEL` | `buffalo_l` | InsightFace model pack (`buffalo_s` = faster, less accurate) |
| `FACESCAN_DET_SIZE` | `1024` | Detector input size; raise to 1600 for huge crowd shots, lower to 640 for speed |

## Project layout

```
facescan/
  db.py        SQLite schema + embedding index load
  engine.py    InsightFace wrapper + cosine search
  ingest.py    CLI: index a folder of event photos
  search.py    CLI: query with a selfie
app.py         FastAPI backend (search API + serves the built frontend)
frontend/      Vite + React + Carbon Design System UI (npm run build -> static/dist)
frontend/      (dev mode: `npm run dev` proxies /api to the backend on :8000)
static/index.html  no-build fallback page (used if static/dist is absent)
photos/        your event photos (gitignored)
data/          SQLite index (gitignored)
```

## Production & scaling

Built in for scale:

- **Cached in-memory index** — embeddings load from SQLite once at startup and auto-reload when the DB file changes (e.g. after a new ingest run). `POST /api/refresh` forces a reload; `GET /healthz` reports index size for load balancers / Docker healthchecks.
- **FAISS acceleration** — if `faiss-cpu` is installed (the Docker image includes it), search transparently uses a FAISS inner-product index. Without it, brute-force numpy still handles ~1M faces in well under a second (~100k embeddings ≈ 200MB RAM).
- **Parallel ingest** — `python -m facescan.ingest photos/ --workers 8` runs one model per CPU worker (~1GB RAM each). Ingest is incremental, so you can keep dropping photos in during the event and re-run it.
- **WAL SQLite** — the web app keeps serving searches while an ingest is writing.
- **Thumbnails** — the results grid serves cached 480px JPEG thumbnails (`data/thumbs/`), not full-resolution originals.
- **Upload cap** — selfie uploads are limited to 15MB (`FACESCAN_MAX_UPLOAD_MB`).

Deployment shape for a real event:

- One box (8+ cores, 8GB RAM) comfortably handles a marathon-sized event: run ingest with `--workers N` as photographers upload, and the web app alongside it. CPU inference on the *query* selfie takes ~1s, so a single instance sustains roughly 1 search/sec; scale out by running more containers behind a load balancer sharing the same read-only `data/` + `photos/` volume.
- Put a reverse proxy (Caddy/nginx/Traefik) in front for TLS; the app itself is plain HTTP on :8000. Note the camera capture feature requires HTTPS on non-localhost origins.
- Ingest speed on CPU is roughly 1–3 photos/sec/worker at det_size 1024. The DB file is portable — you can ingest on a beefy machine and ship `data/facescan.db` to the web server.
- Privacy: you're storing biometric embeddings of attendees — check consent/GDPR requirements for your event, and delete `data/` after the event if required.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/photos?limit=&offset=` | Whole gallery, newest first (`total`, `photos[].url/thumb/medium/w/h`) |
| `POST /api/upload` | Push event photos in (multipart `files`); each is indexed before the response. Requires `X-Upload-Token` |
| `POST /api/download-zip` | Bundle a list of photo paths into one `.zip` |
| `GET /photo?path=&size=sm\|md\|full&download=1` | Serve a photo: 480px grid preview, 1600px viewer copy, or the original |
| `POST /api/search` | Upload a portrait, get matching photos with scores |
| `POST /api/refresh` | Reload the index after an ingest run |
| `GET /api/stats`, `GET /healthz` | Counts and liveness |

The UI is Vietnamese and gallery-first: every indexed photo is shown on load,
and uploading a portrait (or using the camera) filters the grid down to matches.
Match strictness is server-side (`FACESCAN_THRESHOLD`), not a user-facing control.

## Image sizes

Previews are re-encoded and capped by long edge: `sm` at 480px for the gallery
grid, `md` at 1600px for the full-screen viewer. Both are served as **WebP**
when the browser sends `Accept: image/webp`, and JPEG otherwise (the response
carries `Vary: Accept` so shared caches keep them apart). On a 368KB event
photo that is 31KB instead of 41KB for a grid preview. The **original file is
only ever served for downloads** (`size=full`, or the download button), never
for browsing. Rendered copies are cached on disk under `data/thumbs`, keyed by
path, mtime, size and format.

The gallery loads the first 12 photos eagerly and lazy-loads the rest, and the
viewer prefetches the neighbouring photo so swiping does not wait on the network.

Face detection runs on a copy capped at `FACESCAN_MAX_EDGE` (2560px), and query
selfies at `FACESCAN_QUERY_MAX_EDGE` (1600px). Measured on 3840px event photos,
the cap detects exactly the same faces with embeddings at 0.99+ cosine
similarity to full-resolution ones, while cutting decoded image memory by about
two thirds.

Resolution is not what makes scanning slow. On a 3840px photo with 11 faces:
decode 45ms, detection 289ms, recognition 929ms. The pack also ships
`landmark_3d_68`, `landmark_2d_106` and `genderage`, which ran on every face and
cost another ~780ms for output nothing here reads; loading only detection and
recognition **halves scan time** (2.00s to 0.96s per photo) and produces
byte-identical embeddings, so no re-index is needed. Beyond that the levers are
`--workers` (one model per process) and `FACESCAN_DET_SIZE` (640 instead of 1024
is about 30% faster but finds fewer small faces in crowds).

## Pushing photos in

`POST /api/upload` is how photographers add photos during the event — no shell
access needed. It is **disabled until `FACESCAN_UPLOAD_TOKEN` is set** (an open
upload endpoint on a public event site is a free file drop):

```bash
export TOKEN=$(openssl rand -hex 24)   # put this in .env as FACESCAN_UPLOAD_TOKEN

curl -X POST http://localhost:8000/api/upload \
  -H "X-Upload-Token: $TOKEN" \
  -F "files=@race-001.jpg" -F "files=@race-002.jpg"
```

Files land in `photos/uploads/` under a timestamped, sanitised name and appear
in the gallery straight away. **Face indexing runs on a background worker**, so
the request returns in seconds: a batch of crowd photos takes minutes to index
and would otherwise hit a reverse proxy's gateway timeout (504). `pending` in
`/api/stats` and `/healthz` reports how many photos are still queued. Bad files
are reported per-file without failing the batch, and content already indexed is
refused as a duplicate.

### `upload.py`: push a whole folder

`upload.py` walks a folder recursively and sends everything to that endpoint.
It needs no third-party packages and runs on Python 3.8+, so it works on
whatever laptop the photos are sitting on.

```bash
python upload.py ./uploads                  # ./uploads and every subfolder
python upload.py ./uploads --watch          # keep running, send new drops
python upload.py ./uploads --workers 4      # parallel uploads
python upload.py ./uploads --dry-run        # list what would be sent
python upload.py ./uploads --force          # ignore local state, re-send
```

**Settings.** `--url` and `--token` come from the environment, or from a `.env`
file in the current directory (the same file compose uses). Nothing is
hardcoded, so a token never lands in git:

```bash
# .env  (gitignored)
FACESCAN_URL=https://photos.example.com
FACESCAN_UPLOAD_TOKEN=...
```

**Duplicates.** Photos are matched by content, not by name. A copy under another
name is recognised locally and never leaves the machine, and the server refuses
content it has already indexed (it stores a SHA-256 per photo), so two people
running the script against the same folder cannot double up the gallery.

**Watch mode.** `--watch` keeps the process running and uploads files as they
are dropped into the folder, waiting until a file has stopped growing so a
half-copied photo is never sent. The live view shows progress, throughput,
counts and recent activity.

**Proxy limits.** Requests now return as soon as the files are stored, so a
gateway timeout during indexing is no longer possible. What is left is transfer
time and body size, which your reverse proxy caps: Cloudflare's free tier allows
100MB per request and 100s in total, nginx defaults to 1MB
(`client_max_body_size`) and 60s (`proxy_read_timeout`). The client keeps a
batch under 48MB, splits a batch in half on 502/504/408 and shrinks its batch
size for the rest of the run, so it adapts without configuration. Drop
`--batch 1` if a proxy is especially strict.

**Speed.** Startup does not hash the folder: it filters on mtime and size, then
hashes each batch inside the worker that uploads it, so transfers begin at once
and hashing overlaps the network. Batches are capped by count (`--batch`) and by
total bytes; network errors retry with backoff; 401/503/413 stop with an
explanation. `.facescan-upload.json` is written atomically after every batch, so
an interrupted run resumes where it stopped, and a file the server rejects stays
unmarked for the next run.

Bulk backfills of photos already on the server are still faster through the CLI
(`python -m facescan.ingest photos/ --workers 8`).

## Running the published image

CI publishes `ghcr.io/binhotvn/facescan` (linux/amd64 + linux/arm64) on every
push to `main` and on `v*` tags, and a `v*` tag also cuts a GitHub release.

```bash
curl -O https://raw.githubusercontent.com/binhotvn/facescan/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/binhotvn/facescan/main/.env.example
docker compose up -d                     # :latest
FACESCAN_TAG=1.0.0 docker compose up -d  # a specific release
```

To build from a checkout instead of pulling:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## The face model in containers

`docker build` runs `scripts/prefetch_model.py`, so buffalo_l (~300MB) is baked
into the image and containers start search-ready — no multi-minute stall for the
first person to search. `FACESCAN_WARMUP=1` (set in the Dockerfile) loads it at
startup too. Pick a different model with `--build-arg FACESCAN_MODEL=buffalo_s`.

`docker-compose.yml` mounts a named volume at `/root/.insightface`; Docker seeds
an empty named volume from the image, so the baked model survives the mount.

## Tests & CI

```bash
pip install -r requirements-ci.txt -r requirements-dev.txt
ruff check .
pytest
```

The suite stubs the face detector, so it runs without downloading the ~300MB
InsightFace model (`requirements-ci.txt` is `requirements.txt` minus
insightface/onnxruntime, with headless OpenCV).

GitHub Actions (`.github/workflows/`):

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | push to `main`, PRs | ruff + pytest on Python 3.11/3.12, `npm ci && npm run build` for the Carbon frontend, Docker image build (downloads the model once, then reuses the buildx GHA cache), a check that the `.onnx` weights are baked in, and a `/healthz` container smoke test |
| `docker-publish.yml` | push to `main`, `v*` tags | builds and pushes `ghcr.io/<owner>/<repo>` (`latest`, branch, `vX.Y.Z`, short-sha tags) using the repo's `GITHUB_TOKEN` |

Dependabot keeps pip, npm, Docker, and action versions current (`.github/dependabot.yml`).
