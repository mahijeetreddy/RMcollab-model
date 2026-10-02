FROM python:3.11-slim

WORKDIR /app

COPY workers/requirements.txt workers/requirements-ask.txt workers/requirements-errors.txt workers/
RUN pip install --no-cache-dir -r workers/requirements.txt -r workers/requirements-ask.txt -r workers/requirements-errors.txt

# The installer tooling from the base image (pip, setuptools) carries known
# advisories; nothing at runtime uses it, but it is upgraded anyway, last.
RUN pip install --no-cache-dir --upgrade "pip>=26.2" "setuptools>=83"

COPY workers workers

ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1

# CELERY_QUEUES decides what this container drains, so one image serves every
# worker pool — later phases run the same image with a single queue and a
# concurrency matched to the GPU.
CMD ["sh", "-c", "celery -A workers.common.app:app worker -Q \"$CELERY_QUEUES\" -c \"$CELERY_CONCURRENCY\" -l info"]
