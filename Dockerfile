FROM python:3.11-slim

# libgl/libglib needed by opencv; g++ for insightface's small Cython build
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY facescan/ facescan/
COPY static/ static/
COPY app.py .

ENV FACESCAN_PHOTOS=/app/photos
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
