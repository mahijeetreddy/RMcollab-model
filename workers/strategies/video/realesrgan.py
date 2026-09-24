from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from workers.common.strategies import BaseEnhancer, EnhanceResult, ProgressFn, register
from workers.strategies.image.realesrgan import SCALE, RealEsrgan, Upscaler
from workers.strategies.video import _video_io as vio

# Measured in the ML image on the target 4GB RTX 3050, fp16, model resident, tile 256:
#   model load (once)      2.16 s
#   320x180 -> 1280x720    1.08 s/frame   peak 567 MB VRAM
#   480x270 -> 1920x1080   2.55 s/frame   peak 756 MB VRAM
#   640x360 -> 2560x1440   4.26 s/frame   peak 756 MB VRAM
# The 12.1s figure for a single 320x180 image is almost all model load and file I/O;
# once the net is resident the cost of a job is (frames enhanced) x (s/frame) and
# nothing else. 15s at 24fps is 360 frames, so a naive pass at 480x270 would be 15
# minutes - hence a hard frame budget rather than a hard fps.
#
# MAX_PIXELS 480x270: the largest input whose 4x output is still a normal 1920x1080,
#   and the size at which peak VRAM (756 MB) has already plateaued.
# MAX_PROCESSED_FRAMES 60: 60 x 2.55s = ~2.5 minutes of GPU at the worst legal input,
#   ~1.1 minutes at 320x180. That is the "bounded, not open-ended" budget.
# MAX_DURATION_S 20: 20s at 30fps is 600 source frames, so the budget gives stride 10
#   = 3fps processed. Below ~3fps the held frames read as a slideshow, so the duration
#   cap is really a floor on the processed frame rate.
MAX_DURATION_S = 20.0
MAX_PIXELS = 480 * 270  # 129,600 - 4x of this is 1920x1080 out
MAX_PROCESSED_FRAMES = 60
MAX_OUTPUT_PIXELS = 1920 * 1088  # x264 above 1080p per frame becomes its own bottleneck

CAPS = vio.Caps(
    max_duration_s=MAX_DURATION_S,
    max_pixels=MAX_PIXELS,
    max_processed_frames=MAX_PROCESSED_FRAMES,
    max_output_pixels=MAX_OUTPUT_PIXELS,
)


@register
class RealEsrganVideo(BaseEnhancer):
    name = "realesrgan"
    label = "Real-ESRGAN x4 (per frame)"
    description = (
        "GAN super-resolution frame by frame: 4x the pixel dimensions with the "
        "RealESRGAN_x4plus weights, then remuxed with the original audio untouched. "
        "SLOW - expect many minutes even for a short clip: the model costs about a "
        "second per frame on a 4GB GPU, so the frames are enhanced at a reduced rate "
        f"(at most {MAX_PROCESSED_FRAMES} of them) and held across the frames in "
        "between, which trades motion smoothness for detail. A 15s clip takes roughly "
        "1-3 minutes. Opt in for a short, small, soft clip you want sharp. Limits: "
        f"{MAX_DURATION_S:.0f}s and 480x270 in (1920x1080 out); use classical for "
        "anything longer."
    )
    media_type = "video"

    @classmethod
    def available(cls) -> bool:
        return vio.ffmpeg_available() and RealEsrgan.available()

    def enhance(
        self,
        input_path: Path,
        output_path: Path,
        params: dict[str, Any],
        progress: ProgressFn,
    ) -> EnhanceResult:
        started = time.monotonic()
        progress(0.005, "probing clip")
        info = vio.probe(input_path)
        plan = vio.plan(info, CAPS, params, scale=SCALE)

        upscaler = Upscaler(
            device=params.get("device"),
            half=bool(params.get("half", True)),
            tile=int(params.get("tile") or 256),
            tile_pad=int(params.get("tile_pad") or 16),
        )
        progress(0.01, f"loading Real-ESRGAN x4plus on {upscaler.device}")
        upscaler.load(progress)

        seen = {"i": 0}

        def frame_fn(bgr: Any, sub: ProgressFn) -> Any:
            seen["i"] += 1
            index = seen["i"]

            def tiles(fraction: float, message: str) -> None:
                sub(fraction, f"frame {index}/{plan.processed} - {message}")

            return upscaler.upscale_bgr(bgr, tiles)

        try:
            target, metrics = vio.run_clip(input_path, output_path, plan, frame_fn, progress)
            peak = upscaler.peak_vram_mb()
        finally:
            upscaler.close()

        elapsed = time.monotonic() - started
        metrics.update(
            {
                "device": upscaler.device,
                "precision": upscaler.precision,
                "tile": upscaler.tile,
                "scale": SCALE,
                "peak_vram_mb": peak,
                "seconds": round(elapsed, 2),
                "seconds_per_frame": round(elapsed / max(1, metrics["frames_enhanced"]), 3),
            }
        )
        return EnhanceResult(
            output_path=target,
            message=(
                f"upscaled {metrics['frames_enhanced']} frames {info.width}x{info.height} to "
                f"{metrics['width_out']}x{metrics['height_out']} on {upscaler.device}, "
                + (f"fitted to {metrics['fit_to']} first, " if metrics.get("fit_to") else "")
                + f"{plan.process_fps:.1f}fps processed, audio {metrics['audio']}"
            ),
            metrics=metrics,
        )
