from __future__ import annotations

from pathlib import Path

import pytest

# The image stack (OpenCV, numpy) is only in the GPU image.
cv2 = pytest.importorskip("cv2")
np = pytest.importorskip("numpy")

from workers.common import llm  # noqa: E402
from workers.strategies.image import notes  # noqa: E402

pytestmark = pytest.mark.ml


def png(width: int, height: int) -> bytes:
    ok, data = cv2.imencode(".png", np.full((height, width, 3), 255, dtype=np.uint8))
    assert ok
    return data.tobytes()


class TestPrepare:
    def test_a_large_photo_is_downscaled_to_what_the_model_reads(self):
        data, mime = notes.prepare(png(4000, 3000))
        image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
        assert mime == "image/jpeg"
        assert max(image.shape[:2]) == notes.MAX_EDGE_PX
        assert image.shape[1] / image.shape[0] == pytest.approx(4 / 3, rel=0.01)

    def test_a_small_image_keeps_its_size(self):
        data, _ = notes.prepare(png(800, 600))
        image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
        assert image.shape[:2] == (600, 800)

    def test_something_that_is_not_an_image_says_so(self):
        with pytest.raises(ValueError, match="could not be read as an image"):
            notes.prepare(b"definitely not an image")


class TestImageNotes:
    def test_writes_markdown_notes_as_a_summary_artifact(self, monkeypatch, tmp_path: Path):
        sent: dict = {}

        def fake_complete(system, user, *, task=None, images=(), max_tokens=None):
            sent.update(task=task, images=images)
            return llm.LLMResult(text="## Board\n- Queues", provider="stub", model="vision-1")

        monkeypatch.setattr(notes.llm, "complete", fake_complete)
        source = tmp_path / "board.png"
        source.write_bytes(png(2000, 1000))
        result = notes.ImageNotes().enhance(source, tmp_path / "out.png", {}, lambda *a: None)

        (artifact,) = result.produced()
        assert (artifact.kind, artifact.label, artifact.mime_type) == ("summary", "Notes", "text/markdown")
        assert artifact.path.read_text(encoding="utf-8").startswith("## Board")
        assert sent["task"] == llm.VISION
        assert sent["images"][0].mime_type == "image/jpeg"

    def test_is_only_offered_when_a_vision_model_is_configured(self, monkeypatch):
        monkeypatch.setattr(notes.llm, "vision_available", lambda: False)
        assert notes.ImageNotes.available() is False
