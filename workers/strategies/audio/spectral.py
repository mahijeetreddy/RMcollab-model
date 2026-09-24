from __future__ import annotations

from pathlib import Path
from typing import Any

import noisereduce as nr
import numpy as np

from workers.common.strategies import BaseEnhancer, EnhanceResult, ProgressFn, register
from workers.strategies.audio._audio_io import (
    LevelMeter,
    Writer,
    blocks_with_context,
    clamp_sample_rate,
    probe,
)

CHUNK_S = 5.0
CONTEXT_S = 0.5
NOISE_WINDOW_S = 0.4
DEFAULT_PROP_DECREASE = 0.9
DEFAULT_STD_THRESH = 1.5


def _quietest_window(buffer: np.ndarray, sample_rate: int) -> np.ndarray:
    """The lowest-energy slice of the first chunk, used as the noise profile."""
    mono = buffer.mean(axis=1)
    window = min(int(NOISE_WINDOW_S * sample_rate), len(mono))
    if window < sample_rate // 10:
        return mono
    hop = max(window // 4, 1)
    starts = range(0, len(mono) - window + 1, hop)
    quietest = min(starts, key=lambda s: float(np.mean(np.square(mono[s : s + window]))))
    return mono[quietest : quietest + window]


@register(default=True)
class SpectralGate(BaseEnhancer):
    name = "spectral"
    label = "Spectral gate"
    description = (
        "Classical spectral-gating noise reduction: builds a noise profile from the "
        "quietest moment and gates every band that sits under it. CPU-only, no model "
        "weights, no network."
    )
    media_type = "audio"

    def enhance(
        self,
        input_path: Path,
        output_path: Path,
        params: dict[str, Any],
        progress: ProgressFn,
    ) -> EnhanceResult:
        info = probe(input_path)
        sample_rate = clamp_sample_rate(info.sample_rate)
        channels = info.channels
        prop_decrease = float(params.get("prop_decrease", DEFAULT_PROP_DECREASE))
        stationary = bool(params.get("stationary", True))
        std_thresh = float(params.get("n_std_thresh", DEFAULT_STD_THRESH))

        progress(0.02, f"decoding {info.duration_s:.0f}s at {sample_rate} Hz")
        chunk_frames = int(CHUNK_S * sample_rate)
        context_frames = int(CONTEXT_S * sample_rate)
        total_frames = max(int(info.duration_s * sample_rate), 1)

        before, after = LevelMeter(), LevelMeter()
        noise_profile: np.ndarray | None = None
        done_frames = 0
        chunks = 0

        with Writer(output_path, sample_rate, channels) as writer:
            for buffer, start, end in blocks_with_context(
                input_path, sample_rate, channels, chunk_frames, context_frames
            ):
                if noise_profile is None:
                    noise_profile = _quietest_window(buffer, sample_rate)
                before.add(buffer[start:end])

                reduced = nr.reduce_noise(
                    y=buffer.T,
                    sr=sample_rate,
                    y_noise=noise_profile,
                    stationary=stationary,
                    prop_decrease=prop_decrease,
                    n_std_thresh_stationary=std_thresh,
                    use_tqdm=False,
                    n_jobs=1,
                ).T.astype(np.float32)

                core = reduced[start:end]
                after.add(core)
                writer.write(core)

                chunks += 1
                done_frames += end - start
                progress(
                    min(0.98, done_frames / total_frames),
                    f"gated {done_frames / sample_rate:.0f}s of {info.duration_s:.0f}s",
                )

        if not chunks:
            raise ValueError(f"{input_path.name} decoded to no audio")

        floor_drop = before.floor_db - after.floor_db
        return EnhanceResult(
            output_path=writer.path,
            message=f"spectral gate dropped the noise floor by {floor_drop:.1f} dB",
            metrics={
                "sample_rate": sample_rate,
                "channels": channels,
                "chunks": chunks,
                "duration_s": round(done_frames / sample_rate, 2),
                "prop_decrease": prop_decrease,
                "stationary": stationary,
                "noise_floor_db_in": round(before.floor_db, 2),
                "noise_floor_db_out": round(after.floor_db, 2),
                "snr_db_in": round(before.snr_db, 2),
                "snr_db_out": round(after.snr_db, 2),
            },
        )
