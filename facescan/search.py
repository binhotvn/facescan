"""Search the index with a query face photo.

Usage:
    python -m facescan.search selfie.jpg
    python -m facescan.search selfie.jpg --threshold 0.4 --json
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

from . import db
from .engine import cosine_search, detect_query_face


def search_image(query_path: Path, threshold: float = 0.35, db_path: Path = db.DB_PATH):
    """Returns list of {path, score, bbox} for photos containing the query face,
    best score per photo, sorted desc."""
    img = cv2.imread(str(query_path))
    if img is None:
        raise ValueError(f"Cannot read image: {query_path}")
    face = detect_query_face(img)
    if face is None:
        raise ValueError("No face detected in the query photo.")
    return search_embedding(face.normed_embedding, threshold, db_path)


def search_embedding(embedding: np.ndarray, threshold: float, db_path: Path = db.DB_PATH):
    conn = db.connect(db_path)
    embs, meta = db.load_index(conn)
    idx, scores = cosine_search(np.asarray(embedding), embs, threshold)
    best = {}  # photo path -> result (keep best-scoring face per photo)
    for i, s in zip(idx, scores):
        m = meta[int(i)]
        if m["path"] not in best or s > best[m["path"]]["score"]:
            best[m["path"]] = {"path": m["path"], "score": float(s), "bbox": m["bbox"]}
    return sorted(best.values(), key=lambda r: -r["score"])


def main():
    ap = argparse.ArgumentParser(description="Find event photos containing a face.")
    ap.add_argument("query", type=Path, help="Selfie / portrait of the person")
    ap.add_argument("--threshold", type=float, default=0.35,
                    help="Cosine similarity cutoff (0.3 loose … 0.5 strict)")
    ap.add_argument("--db", type=Path, default=db.DB_PATH)
    ap.add_argument("--json", action="store_true", help="Output JSON")
    args = ap.parse_args()

    try:
        results = search_image(args.query, args.threshold, args.db)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        if not results:
            print("No matching photos found.")
        for r in results:
            print(f"{r['score']:.3f}  {r['path']}")


if __name__ == "__main__":
    main()
