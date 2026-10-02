"""How fast the heavy strategies run without a GPU, for sizing a CPU-only host.

    docker run --rm --cpus=4 -e CUDA_VISIBLE_DEVICES= -v rmcollab_models:/models \\
      -e TORCH_HOME=/models -e XDG_CACHE_HOME=/models \\
      -v "$PWD/e2e/fixtures:/fixtures:ro" rmcollab-worker-ml:latest \\
      python -m workers.tools.cpu_bench /fixtures/lecture.mp3 /fixtures/whiteboard.jpg

Reports Whisper's real-time factor per model size (seconds of work per second
of audio) and Real-ESRGAN's time per megapixel. Measured on whatever CPU runs
it: an x86 desktop capped at 4 cores is a guide to a 4-core ARM VM, not a
substitute - run it on the server itself for the real numbers.
"""

from __future__ import annotations

import os
import sys
import time


def whisper(audio: str) -> None:
    from faster_whisper import WhisperModel

    threads = os.cpu_count() or 4
    for size in ("base", "small"):
        model = WhisperModel(size, device="cpu", compute_type="int8", cpu_threads=threads)
        started = time.perf_counter()
        segments, info = model.transcribe(audio, beam_size=5, vad_filter=True)
        words = sum(len(s.text.split()) for s in segments)  # the generator does the work
        took = time.perf_counter() - started
        print(
            f"whisper {size:5s}  {info.duration:5.1f}s audio in {took:5.1f}s  "
            f"real-time factor {took / info.duration:.2f}  ({words} words)"
        )


def upscale(image: str) -> None:
    import cv2
    import torch

    from workers.strategies.image import realesrgan

    torch.set_num_threads(os.cpu_count() or 4)
    picture = cv2.imread(image)
    height, width = picture.shape[:2]
    megapixels = height * width / 1e6
    upscaler = realesrgan.Upscaler(device="cpu").load()
    started = time.perf_counter()
    upscaler.upscale_bgr(picture)
    took = time.perf_counter() - started
    print(f"real-esrgan  {width}x{height} ({megapixels:.2f} MP) in {took:.1f}s  -> {took / megapixels:.1f}s per MP")


if __name__ == "__main__":
    print(f"cpus visible: {os.cpu_count()}")
    whisper(sys.argv[1])
    if len(sys.argv) > 2:
        try:
            upscale(sys.argv[2])
        except Exception as err:
            print(f"real-esrgan  skipped: {err!r}")
