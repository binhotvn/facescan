# --- Stage 1: build the Carbon/React frontend ---
FROM node:26-slim AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ .
# vite.config outDir is ../static/dist relative to frontend/
RUN mkdir -p /static && npm run build -- --outDir /static/dist

# --- Stage 2: Python app ---
FROM python:3.11-slim

# libgl/libglib needed by opencv; g++ for insightface's small Cython build
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt faiss-cpu

COPY facescan/ facescan/
COPY static/ static/
COPY app.py .
COPY --from=frontend /static/dist static/dist

ENV FACESCAN_PHOTOS=/app/photos
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/healthz')"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
