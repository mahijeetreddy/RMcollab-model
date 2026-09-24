from __future__ import annotations

import logging
import os
import sys
import time
import types
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np

from workers.common.strategies import BaseEnhancer, EnhanceResult, ProgressFn, register
from workers.strategies.audio._audio_io import LevelMeter, Writer, blocks_with_context, probe

log = logging.getLogger(__name__)

MODEL_NAME = "DeepFilterNet3"
MODEL_SAMPLE_RATE = 48_000
CHUNK_S = 8.0
# The model's recurrent state needs about a second of lead-in to settle; measured
# on a 12s clip, less context costs ~5 dB against processing the clip in one go.
CONTEXT_S = 1.0
MIN_FREE_VRAM_MB = 1_200

# DeepFilterNet downloads its weights on first use into appdirs' cache directory;
# point that at the mounted model volume so the pool downloads them once.
if os.getenv("TORCH_HOME") and not os.getenv("XDG_CACHE_HOME"):
    os.environ["XDG_CACHE_HOME"] = os.environ["TORCH_HOME"]


def _stub_torchaudio() -> None:
    """Satisfy df.io's torchaudio imports, which the inference path never calls.

    df.io uses torchaudio only to load/save files; we decode and encode with ffmpeg.
    Real torchaudio is optional and its `backend.common` module was removed in 2.2,
    so both the missing-package and the moved-module case are patched here rather
    than pinning a torch-family package over the image's cu124 wheels.
    """
    def unsupported(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("torchaudio is not installed; this worker does audio I/O with ffmpeg")

    try:
        import torchaudio  # noqa: F401
    except ImportError:
        torchaudio = types.ModuleType("torchaudio")
        for attr in ("load", "save", "info"):
            setattr(torchaudio, attr, unsupported)
        sys.modules["torchaudio"] = torchaudio
        # df.io resolves its resampler from these at import time.
        for name, attrs in (
            ("functional", ("resample",)),
            ("transforms", ("Resample",)),
            ("compliance", ()),
            ("compliance.kaldi", ("resample_waveform",)),
        ):
            module = types.ModuleType(f"torchaudio.{name}")
            for attr in attrs:
                setattr(module, attr, unsupported)
            sys.modules[f"torchaudio.{name}"] = module

    try:
        import torchaudio.backend.common  # noqa: F401
    except ImportError:
        common = types.ModuleType("torchaudio.backend.common")
        common.AudioMetaData = getattr(
            sys.modules["torchaudio"], "AudioMetaData", type("AudioMetaData", (), {})
        )
        sys.modules.setdefault("torchaudio.backend", types.ModuleType("torchaudio.backend"))
        sys.modules["torchaudio.backend.common"] = common


@lru_cache(maxsize=1)
def _df_modules() -> tuple[Any, ...] | None:
    """(torch, init_df, enhance, config) once importable, else None."""
    try:
        import torch

        _stub_torchaudio()
        # `df.enhance` the module, not the function df/__init__.py re-exports.
        from df.enhance import enhance, init_df
        from df.config import config
    except Exception as exc:  # noqa: BLE001 - any import failure means "not available"
        log.warning("DeepFilterNet unavailable: %s: %s", type(exc).__name__, exc)
        return None
    return torch, init_df, enhance, config


def _pick_device(requested: str | None) -> str:
    torch = _df_modules()[0]  # type: ignore[index]
    wanted = (requested or os.getenv("DF_DEVICE") or "").strip().lower()
    if wanted:
        return wanted if wanted != "cuda" or torch.cuda.is_available() else "cpu"
    if not torch.cuda.is_available():
        return "cpu"
    try:
        free_bytes = torch.cuda.mem_get_info()[0]
    except Exception:  # noqa: BLE001 - driver quirks shouldn't cost us the job
        return "cpu"
    # The image pool shares this GPU; leave it alone when it is already busy.
    return "cuda" if free_bytes >= MIN_FREE_VRAM_MB * 1024**2 else "cpu"


@lru_cache(maxsize=2)
def _load_model(device: str) -> tuple[Any, Any]:
    _, init_df, _, _ = _df_modules()  # type: ignore[misc]
    try:
        # log_level="none" keeps df from taking over the worker's stdout logging and
        # skips its startup banner, which shells out to a `git` the image doesn't have.
        model, df_state, _ = init_df(
            MODEL_NAME, log_file=None, log_level="none", config_allow_defaults=True
        )
    except SystemExit as exc:  # init_df calls exit() on a failed weight download
        raise RuntimeError(f"could not load {MODEL_NAME} weights") from exc
    return model.to(device).eval(), df_state


def _model_for(device: str) -> tuple[Any, Any]:
    """init_df places the model by df's own device probe; pin both it and the
    feature tensors enhance() builds later to the device we picked."""
    *_, config = _df_modules()  # type: ignore[misc]
    model, df_state = _load_model(device)
    config.set("DEVICE", device, str, "train")
    return model, df_state


def _is_oom(exc: BaseException) -> bool:
    return "out of memory" in str(exc).lower()


@register
class DeepFilterNet(BaseEnhancer):
    name = "deepfilternet"
    label = "DeepFilterNet 3"
    description = (
        "Learned real-time speech enhancement: a two-stage ERB + deep-filtering network "
        "that separates voice from noise instead of gating bands. Runs on the GPU when "
        "there is room, otherwise on CPU. Downloads ~10MB of weights on first use."
    )
    media_type = "audio"

    @classmethod
    def available(cls) -> bool:
        return _df_modules() is not None

    def enhance(
        self,
        input_path: Path,
        output_path: Path,
        params: dict[str, Any],
        progress: ProgressFn,
    ) -> EnhanceResult:
        modules = _df_modules()
        if modules is None:
            raise RuntimeError("the deepfilternet package is not installed on this worker")
        torch, _, run_enhance, _ = modules

        info = probe(input_path)
        channels = info.channels
        device = _pick_device(params.get("device"))
        atten_lim_db = params.get("atten_lim_db")

        progress(0.02, f"loading {MODEL_NAME} on {device}")
        model, df_state = _model_for(device)

        chunk_frames = int(CHUNK_S * MODEL_SAMPLE_RATE)
        context_frames = int(CONTEXT_S * MODEL_SAMPLE_RATE)
        total_frames = max(int(info.duration_s * MODEL_SAMPLE_RATE), 1)

        before, after = LevelMeter(), LevelMeter()
        done_frames = 0
        chunks = 0
        started = time.monotonic()

        with Writer(output_path, MODEL_SAMPLE_RATE, channels) as writer:
            for buffer, start, end in blocks_with_context(
                input_path, MODEL_SAMPLE_RATE, channels, chunk_frames, context_frames
            ):
                before.add(buffer[start:end])
                noisy = torch.from_numpy(np.ascontiguousarray(buffer.T))

                try:
                    enhanced = run_enhance(
                        model,
                        df_state,
                        noisy,
                        atten_lim_db=float(atten_lim_db) if atten_lim_db else None,
                    )
                except RuntimeError as exc:
                    if device == "cpu" or not _is_oom(exc):
                        raise
                    log.warning("CUDA OOM on %s; finishing on CPU", input_path.name)
                    device = "cpu"
                    torch.cuda.empty_cache()
                    model, df_state = _model_for(device)
                    progress(
                        min(0.98, done_frames / total_frames), "GPU was full, continuing on CPU"
                    )
                    enhanced = run_enhance(model, df_state, noisy)

                core = enhanced.cpu().numpy().T[start:end].astype(np.float32)
                after.add(core)
                writer.write(core)

                chunks += 1
                done_frames += end - start
                progress(
                    min(0.98, done_frames / total_frames),
                    f"denoised {done_frames / MODEL_SAMPLE_RATE:.0f}s of {info.duration_s:.0f}s",
                )

        if not chunks:
            raise ValueError(f"{input_path.name} decoded to no audio")

        elapsed = time.monotonic() - started
        audio_s = done_frames / MODEL_SAMPLE_RATE
        floor_drop = before.floor_db - after.floor_db
        return EnhanceResult(
            output_path=writer.path,
            message=f"{MODEL_NAME} on {device} dropped the noise floor by {floor_drop:.1f} dB",
            metrics={
                "device": device,
                "model": MODEL_NAME,
                "sample_rate": MODEL_SAMPLE_RATE,
                "channels": channels,
                "chunks": chunks,
                "duration_s": round(audio_s, 2),
                "realtime_factor": round(elapsed / audio_s, 3) if audio_s else None,
                "noise_floor_db_in": round(before.floor_db, 2),
                "noise_floor_db_out": round(after.floor_db, 2),
                "snr_db_in": round(before.snr_db, 2),
                "snr_db_out": round(after.snr_db, 2),
            },
        )
