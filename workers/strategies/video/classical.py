from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from workers.common.strategies import BaseEnhancer, EnhanceResult, ProgressFn, register
from workers.strategies.image.classical import (
    DEFAULT_CLIP_LIMIT,
    DEFAULT_GRID,
    DEFAULT_SHARPEN,
    enhance_bgr,
)
from workers.strategies.video import _video_io as vio

try:
    import cv2
except ImportError:  # a pool without requirements-image.txt still imports this module
    cv2 = None  # type: ignore[assignment]

# Measured in the ML image on the target box (see workers/README.md phase notes):
# the in-memory gamma+CLAHE+unsharp pass costs ~1.5ms at 320x180 and ~22ms at
# 1920x1080, so the wall clock of a clip is dominated by PNG decode and x264, not by
# the filter. 1080p at 30fps is ~55ms/frame end to end, so the 3600-frame budget below
# is a ~3.5 minute worst case and a typical 15s 720p clip lands in well under a minute.
MAX_DURATION_S = 120.0
MAX_PIXELS = 1920 * 1080
MAX_PROCESSED_FRAMES = 3600

CAPS = vio.Caps(
    max_duration_s=MAX_DURATION_S,
    max_pixels=MAX_PIXELS,
    max_processed_frames=MAX_PROCESSED_FRAMES,
)


@register(default=True)
class ClassicalVideo(BaseEnhancer):
    name = "classical"
    label = "Classical (gamma + CLAHE per frame)"
    description = (
        "Tone and contrast only, no model: the image pool's auto-gamma + CLAHE + unsharp "
        "pass run over every frame, then remuxed with the original audio untouched. The "
        "gamma is measured once on the first frame and locked for the clip, so exposure "
        "does not pulse between frames. Keeps the original resolution and frame rate and "
        "invents nothing. Milliseconds per frame, so a real clip finishes in seconds to a "
        f"minute - the sane default. Limits: {MAX_DURATION_S:.0f}s and 1920x1080 in."
    )
    media_type = "video"

    @classmethod
    def available(cls) -> bool:
        return cv2 is not None and vio.ffmpeg_available()

    def enhance(
        self,
        input_path: Path,
        output_path: Path,
        params: dict[str, Any],
        progress: ProgressFn,
    ) -> EnhanceResult:
        started = time.monotonic()
        progress(0.01, "probing clip")
        info = vio.probe(input_path)
        plan = vio.plan(info, CAPS, params)

        clip_limit = float(params.get("clip_limit") or DEFAULT_CLIP_LIMIT)
        grid = max(1, int(params.get("grid") or DEFAULT_GRID))
        sharpen = float(params.get("sharpen", DEFAULT_SHARPEN))
        denoise = bool(params.get("denoise", False))
        requested = params.get("gamma")
        # None means "measure it"; the first frame's answer is then reused for the rest.
        locked: float | None = None if requested in (None, "", "auto") else float(requested)

        def frame_fn(bgr: Any, _sub: ProgressFn) -> Any:
            nonlocal locked
            out, used = enhance_bgr(
                bgr,
                gamma=locked,
                clip_limit=clip_limit,
                grid=grid,
                sharpen=sharpen,
                denoise=denoise,
            )
            locked = used
            return out

        target, metrics = vio.run_clip(input_path, output_path, plan, frame_fn, progress)

        elapsed = time.monotonic() - started
        metrics.update(
            {
                "gamma": round(locked, 3) if locked is not None else None,
                "clip_limit": clip_limit,
                "grid": grid,
                "sharpen": sharpen,
                "denoise": denoise,
                "seconds": round(elapsed, 2),
                "seconds_per_frame": round(elapsed / max(1, metrics["frames_enhanced"]), 4),
            }
        )
        return EnhanceResult(
            output_path=target,
            message=(
                f"gamma {locked:.2f} + CLAHE over {metrics['frames_enhanced']} frames at "
                f"{info.width}x{info.height}, audio {metrics['audio']}"
                if locked is not None
                else f"CLAHE over {metrics['frames_enhanced']} frames"
            ),
            metrics=metrics,
        )
