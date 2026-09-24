"""Frame-level decode/encode shared by the video strategies. ffmpeg does the container work.

The shape of a video job is always the same, so it lives here once:

    probe() -> plan() -> extract_frames() -> [strategy's per-frame work] -> FrameEncoder -> mux()

Frames go to a scratch directory on disk, never into a list in RAM: a 15s 1080p clip
is ~1.4GB of decoded pixels and the video pool runs with CELERY_CONCURRENCY=1 on a
4GB card. Only the frames that are actually enhanced are ever extracted (see `Plan`),
and the enhanced ones are streamed straight into x264 rather than written back out.
"""

from __future__ import annotations

import json
import math
import shutil
import subprocess
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterator

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"

FRAME_GLOB = "*.png"
FRAME_PATTERN = "%06d.png"

# Below this a "video" is not worth enhancing; it only guards degenerate fits.
MIN_FIT_SIDE = 64
CRF = "20"
PRESET = "veryfast"
AUDIO_FALLBACK_BITRATE = "192k"
ERR_TAIL = 300


class VideoIOError(RuntimeError):
    """ffmpeg could not read, write or remux the video."""


class OverCap(ValueError):
    """The input is outside the limits this pool can finish in a sane time."""


@dataclass(frozen=True)
class VideoInfo:
    width: int
    height: int
    fps: float
    duration_s: float
    has_audio: bool
    video_codec: str
    audio_codec: str | None

    @property
    def pixels(self) -> int:
        return self.width * self.height


@dataclass(frozen=True)
class Caps:
    """Limits, all measured on the target 4GB RTX 3050 - see the strategy modules."""

    max_duration_s: float
    max_pixels: int
    max_processed_frames: int
    max_output_pixels: int = 0  # 0 = unbounded


@dataclass(frozen=True)
class Plan:
    """What we are actually going to run, after the caps have had their say."""

    info: VideoInfo
    fps_out: float
    stride: int
    processed: int
    total_frames: int
    #: Downscaled decode size when the source is too large for the per-frame
    #: budget, else None. Aspect ratio preserved.
    fit: tuple[int, int] | None = None

    @property
    def process_fps(self) -> float:
        return self.fps_out / self.stride


@lru_cache(maxsize=1)
def ffmpeg_available() -> bool:
    return bool(shutil.which(FFMPEG)) and bool(shutil.which(FFPROBE))


def _run(cmd: list[str], what: str) -> str:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise VideoIOError(f"{what}: {proc.stderr.strip()[-ERR_TAIL:]}")
    return proc.stdout


def _rate(value: str | None) -> float:
    """avg_frame_rate arrives as "24/1", and as "0/0" for streams with no idea."""
    if not value or "/" not in value:
        try:
            return float(value or 0.0)
        except ValueError:
            return 0.0
    num, _, den = value.partition("/")
    try:
        numerator, denominator = float(num), float(den)
    except ValueError:
        return 0.0
    return numerator / denominator if denominator else 0.0


def probe(path: Path) -> VideoInfo:
    out = _run(
        [
            FFPROBE, "-v", "error",
            "-show_entries",
            "stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate:format=duration",
            "-of", "json", str(path),
        ],
        f"ffprobe failed on {path.name}",
    )
    data = json.loads(out or "{}")
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if video is None:
        raise VideoIOError(f"no video stream in {path.name}")

    fps = _rate(video.get("avg_frame_rate")) or _rate(video.get("r_frame_rate"))
    try:
        duration = float(data.get("format", {}).get("duration"))
    except (TypeError, ValueError):
        duration = 0.0
    width, height = int(video.get("width") or 0), int(video.get("height") or 0)
    if width <= 0 or height <= 0:
        raise VideoIOError(f"{path.name} reports no frame size")
    if duration <= 0:
        raise VideoIOError(f"{path.name} reports no duration; it may be truncated")

    return VideoInfo(
        width=width,
        height=height,
        fps=fps if fps > 0 else 25.0,
        duration_s=duration,
        has_audio=audio is not None,
        video_codec=str(video.get("codec_name") or "?"),
        audio_codec=str(audio.get("codec_name")) if audio else None,
    )


def _float_param(params: dict[str, Any], key: str, default: float) -> float:
    value = params.get(key)
    return default if value is None or value == "" else float(value)


def _int_param(params: dict[str, Any], key: str, default: int) -> int:
    value = params.get(key)
    return default if value is None or value == "" else int(value)


def plan(info: VideoInfo, caps: Caps, params: dict[str, Any], scale: int = 1) -> Plan:
    """Apply the caps, then derive the frame stride from what's left.

    Duration and resolution are hard rejections with the real number in the message -
    silently downscaling someone's clip is worse than telling them. Processing fps is
    not a rejection: it is the lever, so an over-long-but-legal clip just gets a
    bigger stride and the model runs on fewer frames.
    """
    max_duration = _float_param(params, "max_duration_s", caps.max_duration_s)
    max_pixels = _int_param(params, "max_pixels", caps.max_pixels)
    max_frames = max(1, _int_param(params, "max_frames", caps.max_processed_frames))

    if info.duration_s > max_duration:
        raise OverCap(
            f"{info.duration_s:.1f}s clip is over the {max_duration:.0f}s limit for this "
            f"strategy; trim it, or pass params.max_duration_s to override"
        )
    # Resolution is fitted, not rejected: a 640x360 clip is a perfectly normal
    # thing to upload, and dead-ending it leaves no way forward from the UI. The
    # per-frame GPU budget is what actually matters, so decode smaller and say so.
    budget = max_pixels
    if caps.max_output_pixels:
        budget = min(budget, caps.max_output_pixels // (scale * scale))
    fit: tuple[int, int] | None = None
    if info.pixels > budget:
        ratio = math.sqrt(budget / info.pixels)
        fit = (
            even(max(MIN_FIT_SIDE, int(info.width * ratio))),
            even(max(MIN_FIT_SIDE, int(info.height * ratio))),
        )

    fps_out = max(1.0, min(info.fps, _float_param(params, "fps", info.fps)))
    total_frames = max(1, round(info.duration_s * fps_out))

    requested_fps = params.get("process_fps")
    if requested_fps not in (None, ""):
        stride = max(1, round(fps_out / max(0.1, float(requested_fps))))
    else:
        stride = max(1, _int_param(params, "stride", 0)) if params.get("stride") else 1
    # Whatever was asked for, the frame budget wins.
    stride = max(stride, math.ceil(total_frames / max_frames))
    processed = math.ceil(total_frames / stride)

    return Plan(
        info=info,
        fps_out=fps_out,
        stride=stride,
        processed=processed,
        total_frames=total_frames,
        fit=fit,
    )


@contextmanager
def scratch_dir(prefix: str = "rmcollab-video-") -> Iterator[Path]:
    """A temp dir that goes away on the way out, success or failure."""
    path = Path(tempfile.mkdtemp(prefix=prefix))
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def extract_frames(
    source: Path, dest: Path, rate: float, fit: tuple[int, int] | None = None
) -> list[Path]:
    """Decode to PNGs at `rate` fps. Only the frames that will be enhanced.

    Skipped frames never need their own pixels (the enhanced frame is held over
    them), so decoding at fps_out/stride is both correct and a lot less disk.
    """
    dest.mkdir(parents=True, exist_ok=True)
    vf = f"fps={rate:.6f}"
    if fit:
        vf += f",scale={fit[0]}:{fit[1]}:flags=lanczos"
    _run(
        [
            FFMPEG, "-v", "error", "-nostdin", "-y", "-i", str(source),
            "-map", "0:v:0", "-vf", vf, "-start_number", "0",
            str(dest / FRAME_PATTERN),
        ],
        f"ffmpeg could not extract frames from {source.name}",
    )
    frames = sorted(dest.glob(FRAME_GLOB))
    if not frames:
        raise VideoIOError(f"ffmpeg decoded no frames from {source.name}")
    return frames


def even(size: int) -> int:
    """yuv420p subsamples chroma 2x2, so an odd dimension simply will not encode."""
    return size if size % 2 == 0 else size - 1


class FrameEncoder:
    """Streams BGR frames into H.264/yuv420p through x264's stdin. One frame in RAM."""

    def __init__(self, path: Path, width: int, height: int, fps: float) -> None:
        self.width, self.height = even(width), even(height)
        if self.width < 2 or self.height < 2:
            raise VideoIOError(f"{width}x{height} is too small to encode")
        self.path = path
        self._proc = subprocess.Popen(
            [
                FFMPEG, "-v", "error", "-nostdin", "-y",
                "-f", "rawvideo", "-pix_fmt", "bgr24",
                "-s", f"{self.width}x{self.height}", "-r", f"{fps:.6f}", "-i", "-",
                "-an", "-c:v", "libx264", "-preset", PRESET, "-crf", CRF,
                "-pix_fmt", "yuv420p", str(path),
            ],
            stdin=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.frames_written = 0

    def write(self, bgr: Any) -> None:
        import numpy as np

        assert self._proc.stdin is not None
        frame = bgr[: self.height, : self.width]
        if frame.shape[0] != self.height or frame.shape[1] != self.width:
            raise VideoIOError(
                f"frame is {frame.shape[1]}x{frame.shape[0]}, encoder expects "
                f"{self.width}x{self.height}"
            )
        if self._proc.poll() is not None:
            raise VideoIOError(f"x264 exited early: {self._stderr()}")
        self._proc.stdin.write(np.ascontiguousarray(frame, dtype="uint8").tobytes())
        self.frames_written += 1

    def _stderr(self) -> str:
        if self._proc.stderr is None:
            return ""
        return self._proc.stderr.read().decode(errors="replace").strip()[-ERR_TAIL:]

    def close(self) -> None:
        if self._proc.stdin is not None and not self._proc.stdin.closed:
            self._proc.stdin.close()
        stderr = self._stderr()
        code = self._proc.wait()
        if self._proc.stderr is not None:
            self._proc.stderr.close()
        if code != 0:
            raise VideoIOError(f"x264 could not write {self.path.name}: {stderr}")

    def __enter__(self) -> "FrameEncoder":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if exc_type is not None:
            if self._proc.poll() is None:
                self._proc.kill()
                self._proc.wait()
            if self._proc.stdin is not None and not self._proc.stdin.closed:
                self._proc.stdin.close()
            if self._proc.stderr is not None:
                self._proc.stderr.close()
            return
        self.close()


def mux(video: Path, source: Path, output: Path, has_audio: bool) -> str:
    """Put the original audio back on the enhanced video without touching either.

    `-c:a copy` is tried first so an already-AAC track is bit-identical; only a codec
    mp4 cannot carry (opus, vorbis) falls through to a single AAC re-encode.
    """
    common = [
        FFMPEG, "-v", "error", "-nostdin", "-y", "-i", str(video),
    ]
    tail = ["-movflags", "+faststart", str(output)]
    if not has_audio:
        _run([*common, "-c", "copy", *tail], f"ffmpeg could not finalise {output.name}")
        return "none"

    maps = ["-i", str(source), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-shortest"]
    proc = subprocess.run(
        [*common, *maps, "-c:a", "copy", *tail], capture_output=True, text=True
    )
    if proc.returncode == 0:
        return "copied"
    _run(
        [*common, *maps, "-c:a", "aac", "-b:a", AUDIO_FALLBACK_BITRATE, *tail],
        f"ffmpeg could not remux audio into {output.name}",
    )
    return "aac"


def output_target(output_path: Path) -> Path:
    """The gateway names the output after the upload; an .webm name would be a lie."""
    return output_path if output_path.suffix.lower() == ".mp4" else output_path.with_suffix(".mp4")


FrameFn = Any  # (bgr_in, progress) -> bgr_out


EXTRACT_FRACTION = 0.04
FRAMES_FROM = 0.06
FRAMES_TO = 0.92


def run_clip(
    source: Path,
    output_path: Path,
    plan_: Plan,
    frame_fn: FrameFn,
    progress: Any,
) -> tuple[Path, dict[str, Any]]:
    """Decode -> per-frame work -> encode -> remux, with the scratch dir cleaned up.

    Both video strategies are this loop with a different `frame_fn`, so it lives here
    rather than twice. Frames the stride skips reuse the last enhanced frame, which is
    why only `plan_.processed` frames are ever decoded.
    """
    import cv2

    target = output_target(output_path)
    with scratch_dir() as scratch:
        progress(EXTRACT_FRACTION, f"decoding {plan_.processed} frames at {plan_.process_fps:.1f}fps")
        frames = extract_frames(source, scratch / "frames", plan_.process_fps, plan_.fit)

        silent = scratch / "video.mp4"
        encoder: FrameEncoder | None = None
        span = FRAMES_TO - FRAMES_FROM
        written = 0
        try:
            for index, frame_path in enumerate(frames):
                bgr = cv2.imread(str(frame_path), cv2.IMREAD_COLOR)
                if bgr is None:
                    raise VideoIOError(f"could not read decoded frame {frame_path.name}")

                base = FRAMES_FROM + span * index / len(frames)
                width = span / len(frames)

                def sub(fraction: float, message: str, _b: float = base, _w: float = width) -> None:
                    progress(_b + _w * max(0.0, min(1.0, fraction)), message)

                out = frame_fn(bgr, sub)
                if encoder is None:
                    encoder = FrameEncoder(silent, out.shape[1], out.shape[0], plan_.fps_out)
                for _ in range(plan_.stride):
                    if written >= plan_.total_frames:
                        break
                    encoder.write(out)
                    written += 1
                # Reported against source frames, which is what the viewer sees.
                progress(
                    FRAMES_FROM + span * (index + 1) / len(frames),
                    f"frame {min(written, plan_.total_frames)}/{plan_.total_frames}",
                )
                frame_path.unlink(missing_ok=True)
            if encoder is None:
                raise VideoIOError("no frames were enhanced")
            encoder.close()
            encoder = None
        finally:
            if encoder is not None:
                encoder.__exit__(RuntimeError, None, None)

        progress(0.95, "remuxing with the original audio")
        audio = mux(silent, source, target, plan_.info.has_audio)

    probed = probe(target)
    return target, {
        "duration_s": round(probed.duration_s, 2),
        "fps_out": round(plan_.fps_out, 3),
        "process_fps": round(plan_.process_fps, 3),
        "stride": plan_.stride,
        "frames_enhanced": len(frames),
        "frames_written": written,
        "width_in": plan_.info.width,
        "height_in": plan_.info.height,
        "fit_to": f"{plan_.fit[0]}x{plan_.fit[1]}" if plan_.fit else None,
        "width_out": probed.width,
        "height_out": probed.height,
        "audio": audio,
        "audio_codec": probed.audio_codec,
    }
