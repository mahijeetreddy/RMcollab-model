"""Streaming decode/encode shared by the audio strategies. ffmpeg does the format work."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Iterator

import numpy as np

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"
MP3_BITRATE = "192k"
MAX_CHANNELS = 2
MIN_SAMPLE_RATE = 8_000
MAX_SAMPLE_RATE = 48_000


class AudioIOError(RuntimeError):
    """ffmpeg could not read or write the audio."""


@dataclass(frozen=True)
class AudioInfo:
    sample_rate: int
    channels: int
    duration_s: float


def probe(path: Path) -> AudioInfo:
    cmd = [
        FFPROBE, "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=sample_rate,channels:format=duration",
        "-of", "json", str(path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise AudioIOError(f"ffprobe failed on {path.name}: {proc.stderr.strip()[-200:]}")
    data = json.loads(proc.stdout or "{}")
    streams = data.get("streams") or []
    if not streams:
        raise AudioIOError(f"no audio stream in {path.name}")
    sample_rate = int(streams[0].get("sample_rate") or 0)
    channels = int(streams[0].get("channels") or 0)
    try:
        duration = float(data.get("format", {}).get("duration"))
    except (TypeError, ValueError):
        duration = 0.0
    return AudioInfo(
        sample_rate=sample_rate or MAX_SAMPLE_RATE,
        channels=min(max(channels, 1), MAX_CHANNELS),
        duration_s=max(duration, 0.0),
    )


def clamp_sample_rate(sample_rate: int) -> int:
    return max(MIN_SAMPLE_RATE, min(MAX_SAMPLE_RATE, sample_rate or MAX_SAMPLE_RATE))


def read_blocks(
    path: Path, sample_rate: int, channels: int, block_frames: int
) -> Iterator[np.ndarray]:
    """Decoded float32 blocks of shape [frames, channels], resampled by ffmpeg."""
    cmd = [
        FFMPEG, "-v", "error", "-nostdin", "-i", str(path), "-map", "0:a:0",
        "-f", "f32le", "-acodec", "pcm_f32le",
        "-ac", str(channels), "-ar", str(sample_rate), "-",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_bytes = 4 * channels
    try:
        assert proc.stdout is not None
        while True:
            raw = proc.stdout.read(block_frames * frame_bytes)
            if not raw:
                break
            usable = len(raw) - len(raw) % frame_bytes
            if not usable:
                break
            yield np.frombuffer(raw[:usable], dtype="<f4").reshape(-1, channels).astype(np.float32)
        stderr = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
        if proc.wait() != 0:
            raise AudioIOError(f"ffmpeg could not decode {path.name}: {stderr.strip()[-200:]}")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        for stream in (proc.stdout, proc.stderr):
            if stream is not None:
                stream.close()


def blocks_with_context(
    path: Path, sample_rate: int, channels: int, core_frames: int, context_frames: int
) -> Iterator[tuple[np.ndarray, int, int]]:
    """Yields (buffer, start, end) where buffer[start:end] is the core to keep.

    The surrounding frames are neighbouring audio, so a per-chunk filter has real
    context to work from and the seams don't click.
    """
    empty = np.zeros((0, channels), dtype=np.float32)
    left = empty
    current: np.ndarray | None = None
    for block in read_blocks(path, sample_rate, channels, core_frames):
        if current is not None:
            buffer = np.concatenate([left, current, block[:context_frames]])
            yield buffer, len(left), len(left) + len(current)
            left = current[-context_frames:] if context_frames else empty
        current = block
    if current is not None:
        buffer = np.concatenate([left, current])
        yield buffer, len(left), len(left) + len(current)


@lru_cache(maxsize=1)
def _has_mp3_encoder() -> bool:
    proc = subprocess.run(
        [FFMPEG, "-v", "error", "-hide_banner", "-encoders"], capture_output=True, text=True
    )
    return "libmp3lame" in proc.stdout


class Writer:
    """Streams float32 blocks to a browser-playable file beside the requested output path.

    The gateway names the output after the upload's extension; an .m4a or .weba name
    would be a lie once the audio has been re-encoded, so the suffix is corrected here
    and the real path is reported back through EnhanceResult.
    """

    def __init__(self, output_path: Path, sample_rate: int, channels: int) -> None:
        wanted = output_path.suffix.lower()
        as_wav = wanted == ".wav" or not _has_mp3_encoder()
        self.path = output_path.with_suffix(".wav" if as_wav else ".mp3")
        codec = (
            ["-c:a", "pcm_s16le"] if as_wav else ["-c:a", "libmp3lame", "-b:a", MP3_BITRATE]
        )
        self._proc = subprocess.Popen(
            [
                FFMPEG, "-v", "error", "-nostdin", "-y",
                "-f", "f32le", "-ar", str(sample_rate), "-ac", str(channels), "-i", "-",
                *codec, str(self.path),
            ],
            stdin=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def write(self, block: np.ndarray) -> None:
        assert self._proc.stdin is not None
        data = np.ascontiguousarray(np.clip(block, -1.0, 1.0), dtype="<f4")
        self._proc.stdin.write(data.tobytes())

    def close(self) -> None:
        if self._proc.stdin is not None and not self._proc.stdin.closed:
            self._proc.stdin.close()
        stderr = self._proc.stderr.read().decode(errors="replace") if self._proc.stderr else ""
        code = self._proc.wait()
        if self._proc.stderr is not None:
            self._proc.stderr.close()
        if code != 0:
            raise AudioIOError(f"ffmpeg could not write {self.path.name}: {stderr.strip()[-200:]}")

    def __enter__(self) -> "Writer":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if exc_type is not None:
            if self._proc.poll() is None:
                self._proc.kill()
                self._proc.wait()
            return
        self.close()


class LevelMeter:
    """Frame RMS histogram, so a strategy can report what it did in decibels."""

    FRAME = 1024

    def __init__(self) -> None:
        self._rms: list[np.ndarray] = []

    def add(self, block: np.ndarray) -> None:
        mono = block.mean(axis=1) if block.ndim == 2 else block
        usable = len(mono) - len(mono) % self.FRAME
        if usable < self.FRAME:
            return
        frames = mono[:usable].reshape(-1, self.FRAME)
        self._rms.append(np.sqrt(np.mean(np.square(frames, dtype=np.float64), axis=1)))

    def _percentile(self, q: float) -> float:
        if not self._rms:
            return float("nan")
        value = float(np.percentile(np.concatenate(self._rms), q))
        return 20.0 * np.log10(max(value, 1e-9))

    @property
    def floor_db(self) -> float:
        """Level of the quiet frames: the noise the listener hears between words."""
        return self._percentile(10.0)

    @property
    def peak_db(self) -> float:
        return self._percentile(95.0)

    @property
    def snr_db(self) -> float:
        """Loud-frame level minus quiet-frame level. An estimate, not a true SNR."""
        return self.peak_db - self.floor_db
