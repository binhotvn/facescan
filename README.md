# FaceScan

Find yourself in event photos. Built for marathons and similar events:

1. **Organizer** dumps all event photos into a folder and runs the ingest script — every face in every photo is detected and embedded (InsightFace / ArcFace) into a SQLite index.
2. **Runner** opens the web page, uploads a selfie or takes one with the camera, and instantly gets back every event photo they appear in, ranked by confidence.

No cloud APIs — everything runs locally (CPU is fine).

## Quick start (local)

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

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
app.py         FastAPI web app (upload/camera → matches)
static/index.html  single-page UI
photos/        your event photos (gitignored)
data/          SQLite index (gitignored)
```

## Notes for large events

- ~10k photos with ~10 faces each = 100k embeddings ≈ 200MB in RAM as a numpy matrix; brute-force cosine search over that is still <100ms. Beyond ~1M faces, swap the numpy search in `engine.cosine_search` for FAISS.
- Ingest speed on CPU is roughly 1–3 photos/sec at det_size 1024. Run it on the beefiest machine you have; the DB file is portable.
- Privacy: you're storing biometric embeddings of attendees — check consent/GDPR requirements for your event, and delete `data/` after the event if required.
