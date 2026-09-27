"""Video comprehension: a recorded lecture becomes a transcript and a summary.

It lives in the audio package on purpose. Comprehending a video is audio work -
the frames are irrelevant to a transcript - and the audio pool is where Whisper
is already loaded. Registered here with media_type "video", it is advertised by
the audio pool on the audio queue, and the gateway routes video comprehension
there. The alternative, transcribing inside the video pool, would load a second
Whisper onto the same 4GB card and queue every lecture behind upscales in a pool
that runs one job at a time.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from workers.common.strategies import EnhanceResult, ProgressFn, register
from workers.strategies.audio import _audio_io as aio
from workers.strategies.audio.comprehend import TranscribeAndSummarise


@register(default=True)
class VideoTranscribeAndSummarise(TranscribeAndSummarise):
    name = "comprehend"
    label = "Transcribe & summarise"
    description = (
        "Turns a recorded lecture or meeting into a timestamped transcript and a summary, "
        "from its soundtrack. Timestamps jump the video to that moment. The summary needs "
        "a language model configured; without one you still get the transcript."
    )
    media_type = "video"

    def enhance(
        self,
        input_path: Path,
        output_path: Path,
        params: dict[str, Any],
        progress: ProgressFn,
    ) -> EnhanceResult:
        # No extraction pass: ffmpeg and Whisper both read the audio stream
        # straight out of the container, so demuxing to a WAV first would only
        # add a copy. The probe is here to turn a silent clip into a clear
        # message instead of a decoder error.
        try:
            aio.probe(input_path)
        except aio.AudioIOError as exc:
            if "no audio stream" in str(exc):
                raise ValueError("this video has no soundtrack to transcribe") from exc
            raise
        return super().enhance(input_path, output_path, params, progress)
