"""Ingest event photos: detect faces, embed, store in SQLite.

Usage:
    python -m facescan.ingest photos/            # index a folder (recursive)
    python -m facescan.ingest photos/ --force    # re-index everything
"""
import argparse
import sys
from pathlib import Path

import cv2
from tqdm import tqdm

from . import db
from .engine import extract_faces

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def iter_images(root: Path):
    for p in sorted(root.rglob("*")):
        if p.suffix.lower() in IMAGE_EXTS and p.is_file():
            yield p


def ingest(folder: Path, force: bool = False, db_path: Path = db.DB_PATH):
    conn = db.connect(db_path)
    images = list(iter_images(folder))
    if not images:
        print(f"No images found in {folder}", file=sys.stderr)
        return

    indexed = skipped = failed = total_faces = 0
    for img_path in tqdm(images, desc="Indexing", unit="img"):
        rel = str(img_path)
        mtime = img_path.stat().st_mtime
        if not force and db.photo_is_indexed(conn, rel, mtime):
            skipped += 1
            continue
        img = cv2.imread(str(img_path))
        if img is None:
            tqdm.write(f"  ! unreadable: {img_path}")
            failed += 1
            continue
        h, w = img.shape[:2]
        faces = extract_faces(img)
        photo_id = db.upsert_photo(conn, rel, mtime, w, h)
        for f in faces:
            db.add_face(conn, photo_id, f.bbox, f.det_score, f.normed_embedding)
        db.set_face_count(conn, photo_id, len(faces))
        conn.commit()
        indexed += 1
        total_faces += len(faces)

    s = db.stats(conn)
    print(f"\nDone. Indexed {indexed} new photos ({total_faces} faces), "
          f"skipped {skipped} unchanged, {failed} failed.")
    print(f"Database now holds {s['photos']} photos / {s['faces']} faces.")


def main():
    ap = argparse.ArgumentParser(description="Index event photos for face search.")
    ap.add_argument("folder", type=Path, help="Folder of event photos (recursive)")
    ap.add_argument("--force", action="store_true", help="Re-index even if unchanged")
    ap.add_argument("--db", type=Path, default=db.DB_PATH, help="SQLite database path")
    args = ap.parse_args()
    ingest(args.folder, force=args.force, db_path=args.db)


if __name__ == "__main__":
    main()
