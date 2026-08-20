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
| `GET /api/photos?limit=&offset=` | Whole gallery, newest first (`total`, `photos[].url/thumb/faces`) |
| `POST /api/search` | Upload a portrait, get matching photos with scores |
| `POST /api/refresh` | Reload the index after an ingest run |
| `GET /api/stats`, `GET /healthz` | Counts and liveness |

The UI is Vietnamese and gallery-first: every indexed photo is shown on load,
and uploading a portrait (or using the camera) filters the grid down to matches.
Match strictness is server-side (`FACESCAN_THRESHOLD`), not a user-facing control.

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
