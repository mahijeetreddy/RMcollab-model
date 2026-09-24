from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from workers.common.strategies import BaseEnhancer, EnhanceResult, ProgressFn, register

try:
    import cv2
    import numpy as np
except ImportError:  # a pool without requirements-image.txt still imports this module
    cv2 = np = None  # type: ignore[assignment]

TARGET_LUMA = 0.5
GAMMA_RANGE = (0.45, 2.2)
DEFAULT_CLIP_LIMIT = 2.0
DEFAULT_GRID = 8
DEFAULT_SHARPEN = 0.5


def _auto_gamma(gray: np.ndarray) -> float:
    """Gamma that pulls mean luminance to mid-grey: under-exposed shots lift, blown ones pull down."""
    mean = float(gray.mean()) / 255.0
    if mean <= 0.01 or mean >= 0.99:
        return 1.0
    # _apply_gamma raises pixels to 1/gamma, so gamma > 1 brightens.
    gamma = np.log(mean) / np.log(TARGET_LUMA)
    return float(np.clip(gamma, *GAMMA_RANGE))


def _apply_gamma(bgr: np.ndarray, gamma: float) -> np.ndarray:
    table = np.clip(((np.arange(256) / 255.0) ** (1.0 / gamma)) * 255.0, 0, 255).astype(np.uint8)
    return cv2.LUT(bgr, table)


def _unsharp(bgr: np.ndarray, amount: float) -> np.ndarray:
    blurred = cv2.GaussianBlur(bgr, (0, 0), 1.2)
    return cv2.addWeighted(bgr, 1.0 + amount, blurred, -amount, 0)


def _noop(*_args: Any, **_kwargs: Any) -> None:
    pass


def enhance_bgr(
    bgr: np.ndarray,
    *,
    gamma: float | None = None,
    clip_limit: float = DEFAULT_CLIP_LIMIT,
    grid: int = DEFAULT_GRID,
    sharpen: float = DEFAULT_SHARPEN,
    denoise: bool = False,
    progress: ProgressFn = _noop,
) -> tuple[np.ndarray, float]:
    """The pixel pipeline on an in-memory BGR uint8 frame. No file I/O.

    `gamma=None` measures the gamma from this frame; the value actually used comes
    back so a caller running many frames (the video pool) can measure once and lock
    it, which is what keeps a clip from flickering frame to frame.
    """
    progress(0.15, "measuring exposure")
    if gamma is None:
        gamma = _auto_gamma(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY))

    progress(0.3, f"gamma {gamma:.2f}")
    out = _apply_gamma(bgr, gamma) if abs(gamma - 1.0) > 1e-3 else bgr

    progress(0.5, f"CLAHE clip {clip_limit:.1f}")
    # Lightness only, so contrast changes never shift hue.
    lab = cv2.cvtColor(out, cv2.COLOR_BGR2LAB)
    clahe = cv2.createCLAHE(clipLimit=clip_limit, tileGridSize=(grid, grid))
    lab[:, :, 0] = clahe.apply(lab[:, :, 0])
    out = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)

    if denoise:
        progress(0.7, "denoising")
        out = cv2.fastNlMeansDenoisingColored(out, None, 3, 3, 7, 21)

    if sharpen > 0:
        progress(0.85, f"unsharp {sharpen:.2f}")
        out = _unsharp(out, sharpen)

    return out, gamma


@register
class ClassicalImage(BaseEnhancer):
    name = "classical"
    label = "Classical (gamma + CLAHE)"
    description = (
        "Tone and contrast only, no model: auto gamma to correct exposure, CLAHE to recover "
        "local contrast in shadows and skies without blowing highlights, then optional denoise "
        "and unsharp mask. Keeps the original resolution and every real pixel — nothing is "
        "invented. Sub-second on CPU, so it is the honest baseline to compare Real-ESRGAN "
        "against, and the right pick for dark or flat photos that are already sharp enough."
    )
    media_type = "image"

    @classmethod
    def available(cls) -> bool:
        return cv2 is not None

    def enhance(
        self,
        input_path: Path,
        output_path: Path,
        params: dict[str, Any],
        progress: ProgressFn,
    ) -> EnhanceResult:
        started = time.monotonic()
        source = cv2.imread(str(input_path), cv2.IMREAD_UNCHANGED)
        if source is None:
            raise ValueError(f"{input_path.name} is not a readable image")

        alpha = None
        if source.ndim == 2:
            source = cv2.cvtColor(source, cv2.COLOR_GRAY2BGR)
        elif source.shape[2] == 4:
            alpha, source = source[:, :, 3], source[:, :, :3]
        if source.dtype == np.uint16:
            source = (source / 257.0).astype(np.uint8)

        height, width = source.shape[:2]
        clip_limit = float(params.get("clip_limit") or DEFAULT_CLIP_LIMIT)
        grid = max(1, int(params.get("grid") or DEFAULT_GRID))
        sharpen = float(params.get("sharpen", DEFAULT_SHARPEN))
        denoise = bool(params.get("denoise", False))

        requested = params.get("gamma")
        out, gamma = enhance_bgr(
            source,
            gamma=None if requested in (None, "", "auto") else float(requested),
            clip_limit=clip_limit,
            grid=grid,
            sharpen=sharpen,
            denoise=denoise,
            progress=progress,
        )

        if alpha is not None:
            out = np.dstack([out, alpha])

        progress(0.95, "encoding output")
        encode: list[int] = []
        if output_path.suffix.lower() in {".jpg", ".jpeg"}:
            encode = [cv2.IMWRITE_JPEG_QUALITY, 95]
        if not cv2.imwrite(str(output_path), out, encode):
            raise RuntimeError(f"OpenCV could not encode {output_path.suffix or 'the output'}")

        return EnhanceResult(
            output_path=output_path,
            message=f"gamma {gamma:.2f} + CLAHE at {width}x{height}",
            metrics={
                "gamma": round(gamma, 3),
                "clip_limit": clip_limit,
                "grid": grid,
                "sharpen": sharpen,
                "denoise": denoise,
                "width_in": width,
                "height_in": height,
                "width_out": width,
                "height_out": height,
                "seconds": round(time.monotonic() - started, 3),
            },
        )
