FROM python:3.12-slim

# ffmpeg provides video thumbnails; without it images still work.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Files live here. Mount a volume at this path, otherwise uploads are lost
# when the container is replaced.
ENV STORAGE_ROOT=/data \
    THUMBNAIL_CACHE_DIR=/data/.thumbs \
    PORT=8080
VOLUME ["/data"]

EXPOSE 8080

# gunicorn with threads rather than workers: uploads and Range-streamed video
# are long-lived connections, and threads handle those without the memory
# overhead of extra processes. --timeout must exceed the slowest large upload.
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "8", "--timeout", "900", "app:app"]
