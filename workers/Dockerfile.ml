# GPU-capable worker image, shared by the image / audio / video pools.
#
# Built on python:slim with PyTorch's cu129 wheels rather than an nvidia/cuda
# base: those wheels bundle the CUDA runtime, so the host driver visible through
# `--gpus all` is all that's needed and the image stays far smaller than a full
# CUDA devel base. Verified working against an RTX 3050 (4GB) on WSL2.
#
# Why cu129 exactly: cu124 stopped at torch 2.6.0, which has published
# advisories fixed in later releases; cu129 carries torch 2.13, past the last of
# them. Not cu130, though newer: faster-whisper's CTranslate2 is built against
# CUDA 12 and loads libcublas.so.12, which the CUDA 12 torch wheels bring along
# and the CUDA 13 ones do not - transcription failed on the GPU with cu130.
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
# per-pipeline dependency churn doesn't invalidate. CUDA wheels on x86; on ARM
# (Oracle's free Ampere machines, which have no GPU) the CPU build, since the
# CUDA index targets x86 hosts with NVIDIA cards. Docker sets TARGETARCH.
ARG TARGETARCH
RUN if [ "$TARGETARCH" = "arm64" ]; then \
      pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch torchvision; \
    else \
      pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cu129 torch torchvision; \
    fi

COPY workers/requirements-image.txt workers/requirements-audio.txt workers/requirements-video.txt ./
RUN pip install --no-cache-dir \
    -r requirements-image.txt \
    -r requirements-audio.txt \
    -r requirements-video.txt

COPY workers/requirements-errors.txt ./
RUN pip install --no-cache-dir -r requirements-errors.txt

# The installer tooling from the base image (pip, setuptools) carries known
# advisories; nothing at runtime uses it, but it is upgraded anyway, last, so
# the large layers above stay cached. (torch 2.11 capped setuptools below the
# fixed version; 2.13 no longer does.)
RUN pip install --no-cache-dir --upgrade "pip>=26.2" "setuptools>=83"

COPY workers workers

ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    TORCH_HOME=/models

CMD ["sh", "-c", "celery -A workers.common.app:app worker -Q \"$CELERY_QUEUES\" -c \"$CELERY_CONCURRENCY\" -l info"]
