from __future__ import annotations

import hashlib
import importlib.util
import logging
import math
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from workers.common.strategies import BaseEnhancer, EnhanceResult, ProgressFn, register

log = logging.getLogger(__name__)

WEIGHTS_URL = (
    "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"
)
WEIGHTS_NAME = "RealESRGAN_x4plus.pth"
WEIGHTS_BYTES = 67_040_989
WEIGHTS_SHA256 = "4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1"

SCALE = 4
DEFAULT_TILE = 256
DEFAULT_TILE_PAD = 16
MIN_TILE = 64
# Measured on the 4GB RTX 3050: a 256px tile peaks near 760MB. Past ~512px the
# allocation lands in a cuDNN workspace, which raises an uncatchable driver-level
# OOM that can leave the context unusable, so params.tile is clamped rather than trusted.
MAX_TILE = 512
MAX_INPUT_PIXELS = 16_000_000
PROBE_TIMEOUT_S = 8.0
UNREACHABLE_RECHECK_S = 60.0

_model_cache: tuple[str, Any, Any] | None = None
_reachable: tuple[bool, float] | None = None


class WeightsUnavailable(RuntimeError):
    """The x4plus checkpoint is neither cached nor downloadable."""


def _weights_path() -> Path:
    import torch

    return Path(torch.hub.get_dir()) / "checkpoints" / WEIGHTS_NAME


def _cached_weights() -> Path | None:
    try:
        path = _weights_path()
    except Exception:
        return None
    return path if path.is_file() and path.stat().st_size == WEIGHTS_BYTES else None


def _verify(path: Path) -> None:
    size = path.stat().st_size
    if size != WEIGHTS_BYTES:
        path.unlink(missing_ok=True)
        raise WeightsUnavailable(
            f"{WEIGHTS_NAME} is {size} bytes, expected {WEIGHTS_BYTES}; discarded the bad copy"
        )
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    if digest.hexdigest() != WEIGHTS_SHA256:
        path.unlink(missing_ok=True)
        raise WeightsUnavailable(
            f"{WEIGHTS_NAME} sha256 {digest.hexdigest()} != {WEIGHTS_SHA256}; discarded the bad copy"
        )


def _ensure_weights(progress: ProgressFn | None = None) -> Path:
    """Download once into TORCH_HOME and reuse it for every later job."""
    import torch

    cached = _cached_weights()
    if cached is not None:
        return cached

    path = _weights_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if progress is not None:
        progress(0.02, f"downloading {WEIGHTS_NAME} ({WEIGHTS_BYTES // 1_000_000}MB, first run only)")
    try:
        torch.hub.download_url_to_file(WEIGHTS_URL, str(path), progress=False)
    except (urllib.error.URLError, OSError) as exc:
        path.unlink(missing_ok=True)
        raise WeightsUnavailable(f"could not fetch {WEIGHTS_URL}: {exc}") from exc
    _verify(path)
    return path


def _weights_reachable() -> bool:
    global _reachable
    if _cached_weights() is not None:
        return True
    if _reachable is not None:
        ok, at = _reachable
        if ok or time.monotonic() - at < UNREACHABLE_RECHECK_S:
            return ok
    try:
        request = urllib.request.Request(WEIGHTS_URL, method="HEAD")
        with urllib.request.urlopen(request, timeout=PROBE_TIMEOUT_S) as response:
            ok = 200 <= response.status < 400
    except Exception as exc:
        log.warning("Real-ESRGAN weights unreachable: %s", exc)
        ok = False
    _reachable = (ok, time.monotonic())
    return ok


def _load_model(device: str, dtype: Any) -> Any:
    """One resident model per (device, dtype); jobs reuse it instead of re-reading 67MB."""
    global _model_cache
    import torch

    from workers.strategies.image._rrdbnet import RRDBNet

    key = f"{device}:{dtype}"
    if _model_cache is not None and _model_cache[0] == key:
        return _model_cache[1]

    path = _ensure_weights()
    state = torch.load(str(path), map_location="cpu", weights_only=True)
    state = state.get("params_ema") or state.get("params") or state
    net = RRDBNet()
    net.load_state_dict(state, strict=True)
    net.eval().to(device=device, dtype=dtype)
    _model_cache = (key, net, dtype)
    return net


def _upscale_tiled(
    net: Any,
    image: Any,
    device: str,
    dtype: Any,
    tile: int,
    pad: int,
    progress: ProgressFn,
) -> Any:
    """Tile the input, giving every tile `pad` px of real neighbouring context."""
    import cv2
    import numpy as np
    import torch

    height, width = image.shape[:2]
    padded = cv2.copyMakeBorder(image, pad, pad, pad, pad, cv2.BORDER_REFLECT)
    out = np.empty((height * SCALE, width * SCALE, 3), dtype=np.float32)

    cols, rows = math.ceil(width / tile), math.ceil(height / tile)
    total = cols * rows
    done = 0
    for row in range(rows):
        for col in range(cols):
            x0, y0 = col * tile, row * tile
            x1, y1 = min(x0 + tile, width), min(y0 + tile, height)
            patch = np.ascontiguousarray(padded[y0 : y1 + 2 * pad, x0 : x1 + 2 * pad])
            batch = (
                torch.from_numpy(patch)
                .permute(2, 0, 1)
                .unsqueeze(0)
                .to(device=device, dtype=dtype, non_blocking=True)
            )
            with torch.inference_mode():
                sr = net(batch)
            # clamp, not clamp_: in fp32 .float() is a no-op and an inference tensor
            # cannot be updated in place once inference_mode has exited.
            sr = sr.squeeze(0).permute(1, 2, 0).float().clamp(0.0, 1.0).cpu().numpy()
            del batch
            # Drop the context border so only the tile's own pixels are written.
            edge = pad * SCALE
            out[y0 * SCALE : y1 * SCALE, x0 * SCALE : x1 * SCALE] = sr[
                edge : edge + (y1 - y0) * SCALE, edge : edge + (x1 - x0) * SCALE
            ]
            done += 1
            progress(0.05 + 0.9 * done / total, f"tile {done}/{total} ({tile}px)")
    return out


def _is_oom(exc: BaseException) -> bool:
    """The allocator raises OutOfMemoryError; cuDNN workspaces raise a plain RuntimeError."""
    import torch

    return isinstance(exc, torch.cuda.OutOfMemoryError) or "out of memory" in str(exc).lower()


def _free_vram() -> None:
    import torch

    if not torch.cuda.is_available():
        return
    try:
        torch.cuda.empty_cache()
    except RuntimeError as exc:
        log.warning("could not reclaim VRAM: %s", exc)


def _run(net_for: Any, image: Any, device: str, tile: int, pad: int, progress: ProgressFn) -> tuple[Any, int, Any]:
    """Tiled pass with OOM backoff: halve the tile and retry rather than fail the job."""
    while True:
        net, dtype = net_for(tile)
        try:
            return _upscale_tiled(net, image, device, dtype, tile, pad, progress), tile, dtype
        except RuntimeError as exc:
            if not _is_oom(exc):
                raise
            _free_vram()
            if tile <= MIN_TILE:
                raise RuntimeError(
                    f"out of VRAM even at {MIN_TILE}px tiles; free GPU memory or rerun "
                    f"with params.device='cpu'"
                ) from exc
            tile = max(MIN_TILE, tile // 2)
            log.warning("CUDA OOM; retrying at tile=%d", tile)
            progress(0.05, f"out of VRAM, retrying with {tile}px tiles")


def _noop(*_args: Any, **_kwargs: Any) -> None:
    pass


class Upscaler:
    """One loaded x4plus model, driven across many frames.

    `RealEsrgan.enhance()` is a one-shot: it resolves the device, ensures the weights
    and runs a single tiled pass. Video needs the same pass hundreds of times without
    paying the model load each time, so the resident pieces live here and the tiling
    and OOM backoff stay in `_upscale_tiled` / `_run` where the image pool already
    exercises them. A tile that had to back off stays backed off for later frames,
    so a clip pays the OOM retry once rather than on every frame.
    """

    def __init__(
        self,
        *,
        device: str | None = None,
        half: bool = True,
        tile: int = DEFAULT_TILE,
        tile_pad: int = DEFAULT_TILE_PAD,
    ) -> None:
        import torch

        self.use_cuda = torch.cuda.is_available() and str(device or "").lower() != "cpu"
        self.device = "cuda" if self.use_cuda else "cpu"
        self.half = bool(half) and self.use_cuda
        self.tile = min(MAX_TILE, max(MIN_TILE, int(tile)))
        self.tile_pad = max(0, int(tile_pad))
        self.scale = SCALE

    @property
    def precision(self) -> str:
        return "fp16" if self.half else "fp32"

    def _net_for(self, _tile: int) -> tuple[Any, Any]:
        import torch

        dtype = torch.float16 if self.half else torch.float32
        return _load_model(self.device, dtype), dtype

    def load(self, progress: ProgressFn = _noop) -> "Upscaler":
        """Fetch the checkpoint and materialise the net once, before the frame loop."""
        import torch

        _ensure_weights(progress)
        self._net_for(self.tile)
        if self.use_cuda:
            torch.cuda.reset_peak_memory_stats()
        return self

    def upscale_bgr(self, bgr: Any, progress: ProgressFn = _noop) -> Any:
        """BGR uint8 frame in, 4x BGR uint8 frame out. Model stays resident."""
        import cv2
        import numpy as np

        image = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        result, tile_used, _ = _run(
            self._net_for, image, self.device, self.tile, self.tile_pad, progress
        )
        if self.half and not np.isfinite(result).all():
            log.warning("fp16 pass produced non-finite pixels; retrying in fp32")
            progress(0.05, "fp16 overflowed, retrying in fp32")
            self.half = False
            result, tile_used, _ = _run(
                self._net_for, image, self.device, self.tile, self.tile_pad, progress
            )
        self.tile = tile_used
        return cv2.cvtColor((result * 255.0).round().astype(np.uint8), cv2.COLOR_RGB2BGR)

    def peak_vram_mb(self) -> float:
        import torch

        return round(torch.cuda.max_memory_allocated() / 1e6, 1) if self.use_cuda else 0.0

    def close(self) -> None:
        """The pool is long-lived; hand the activations back before the next job."""
        _free_vram()

    def __enter__(self) -> "Upscaler":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()


def _int_param(params: dict[str, Any], key: str, default: int) -> int:
    """`or default` would swallow a deliberate 0, which is a valid tile_pad."""
    value = params.get(key)
    return default if value is None or value == "" else int(value)


def _write(path: Path, bgr: Any) -> None:
    import cv2

    params: list[int] = []
    if path.suffix.lower() in {".jpg", ".jpeg"}:
        params = [cv2.IMWRITE_JPEG_QUALITY, 95]
    elif path.suffix.lower() == ".webp":
        params = [cv2.IMWRITE_WEBP_QUALITY, 95]
    if not cv2.imwrite(str(path), bgr, params):
        raise RuntimeError(f"OpenCV could not encode {path.suffix or 'the output'}")


@register(default=True)
class RealEsrgan(BaseEnhancer):
    name = "realesrgan"
    label = "Real-ESRGAN x4"
    description = (
        "GAN super-resolution: 4x the pixel dimensions with the RealESRGAN_x4plus weights, "
        "reconstructing plausible detail rather than interpolating it. Best for small, soft "
        "or low-resolution photos you want to print or crop into. Runs tiled on the GPU "
        "(falls back to CPU, much slower); takes seconds, not milliseconds."
    )
    media_type = "image"

    @classmethod
    def available(cls) -> bool:
        if importlib.util.find_spec("torch") is None or importlib.util.find_spec("cv2") is None:
            return False
        return _weights_reachable()

    def enhance(
        self,
        input_path: Path,
        output_path: Path,
        params: dict[str, Any],
        progress: ProgressFn,
    ) -> EnhanceResult:
        import cv2
        import numpy as np
        import torch

        started = time.monotonic()
        source = cv2.imread(str(input_path), cv2.IMREAD_UNCHANGED)
        if source is None:
            raise ValueError(f"{input_path.name} is not a readable image")

        height, width = source.shape[:2]
        if height * width > MAX_INPUT_PIXELS:
            raise ValueError(
                f"{width}x{height} is {height * width / 1e6:.1f}MP; the x4 limit is "
                f"{MAX_INPUT_PIXELS / 1e6:.0f}MP"
            )

        alpha = None
        if source.ndim == 2:
            source = cv2.cvtColor(source, cv2.COLOR_GRAY2BGR)
        elif source.shape[2] == 4:
            alpha = source[:, :, 3]
            source = source[:, :, :3]
        if source.dtype == np.uint16:
            source = (source / 257.0).astype(np.uint8)

        requested = str(params.get("device") or "").lower()
        use_cuda = torch.cuda.is_available() and requested != "cpu"
        device = "cuda" if use_cuda else "cpu"
        half = bool(params.get("half", True)) and use_cuda
        tile = min(MAX_TILE, max(MIN_TILE, _int_param(params, "tile", DEFAULT_TILE)))
        pad = max(0, _int_param(params, "tile_pad", DEFAULT_TILE_PAD))

        progress(0.02, f"loading Real-ESRGAN x4plus on {device}")
        _ensure_weights(progress)

        # RGB float in 0..1; the checkpoint was trained on RGB, OpenCV hands back BGR.
        image = cv2.cvtColor(source, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0

        if use_cuda:
            torch.cuda.reset_peak_memory_stats()

        def net_for(_tile: int) -> tuple[Any, Any]:
            dtype = torch.float16 if half else torch.float32
            return _load_model(device, dtype), dtype

        try:
            result, tile_used, dtype = _run(net_for, image, device, tile, pad, progress)
            # fp16 RRDB can saturate to inf on extreme inputs; redo those rare cases in fp32.
            if half and not np.isfinite(result).all():
                log.warning("fp16 pass produced non-finite pixels; retrying in fp32")
                progress(0.05, "fp16 overflowed, retrying in fp32")
                half = False
                result, tile_used, dtype = _run(net_for, image, device, tile, pad, progress)
            peak_mb = (
                round(torch.cuda.max_memory_allocated() / 1e6, 1) if use_cuda else 0.0
            )
        finally:
            # The pool is long-lived; hand the activations back before the next job.
            _free_vram()

        progress(0.96, "encoding output")
        upscaled = cv2.cvtColor((result * 255.0).round().astype(np.uint8), cv2.COLOR_RGB2BGR)
        if alpha is not None:
            grown = cv2.resize(
                alpha, (width * SCALE, height * SCALE), interpolation=cv2.INTER_CUBIC
            )
            upscaled = np.dstack([upscaled, grown])
        _write(output_path, upscaled)

        elapsed = round(time.monotonic() - started, 2)
        return EnhanceResult(
            output_path=output_path,
            message=f"upscaled {width}x{height} to {width * SCALE}x{height * SCALE} on {device}",
            metrics={
                "device": device,
                "precision": "fp16" if dtype == torch.float16 else "fp32",
                "tile": tile_used,
                "tile_pad": pad,
                "width_in": width,
                "height_in": height,
                "width_out": width * SCALE,
                "height_out": height * SCALE,
                "peak_vram_mb": peak_mb,
                "seconds": elapsed,
            },
        )
