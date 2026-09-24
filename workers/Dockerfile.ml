# GPU-capable worker image, shared by the image / audio / video pools.
#
# Built on python:slim with PyTorch's cu124 wheels rather than an nvidia/cuda
# base: those wheels bundle the CUDA runtime, so the host driver visible through
# `--gpus all` is all that's needed and the image stays far smaller than a full
# CUDA devel base. Verified working against an RTX 3050 (4GB) on WSL2.
FROM python:3.11-slim

WORKDIR /app

# ffmpeg is an external binary, not a pip package - the video pool shells out to
# it for frame extraction and remuxing.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY workers/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Torch first and on its own so the large CUDA wheels stay in a cached layer that
# per-pipeline dependency churn doesn't invalidate.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cu124 \
    torch torchvision

COPY workers/requirements-image.txt workers/requirements-audio.txt workers/requirements-video.txt ./
RUN pip install --no-cache-dir \
    -r requirements-image.txt \
    -r requirements-audio.txt \
    -r requirements-video.txt

COPY workers workers

ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    TORCH_HOME=/models

CMD ["sh", "-c", "celery -A workers.common.app:app worker -Q \"$CELERY_QUEUES\" -c \"$CELERY_CONCURRENCY\" -l info"]
