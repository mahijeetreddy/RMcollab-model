FROM python:3.11-slim

WORKDIR /app

COPY workers/requirements.txt workers/requirements.txt
RUN pip install --no-cache-dir -r workers/requirements.txt

COPY workers workers

ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1

# CELERY_QUEUES decides what this container drains, so one image serves every
# worker pool — later phases run the same image with a single queue and a
# concurrency matched to the GPU.
CMD ["sh", "-c", "celery -A workers.common.app:app worker -Q \"$CELERY_QUEUES\" -c \"$CELERY_CONCURRENCY\" -l info"]
