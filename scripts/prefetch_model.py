"""Download the InsightFace model into the image at build time.

Without this the ~300MB buffalo_l download happens on the first search request
inside a running container — a multi-minute stall for whoever hits it first.
"""
from facescan.engine import get_engine

if __name__ == "__main__":
    app = get_engine()
    print(f"model ready: {[m for m in app.models]}")
