# The sample room

What "Try a sample room" on the landing page opens (`gateway/src/demo.ts`). A
visitor without a lecture recording to hand still sees what the app does.

The results here are real outputs of this app, saved from earlier runs - not
written to look good:

| File | What it is |
| --- | --- |
| `lecture.mp3` | a 15-second test lecture |
| `lecture-transcript.txt` | its transcript, from faster-whisper `small` |
| `lecture-summary.md` | its summary, from `openai/gpt-oss-120b` on Groq |
| `whiteboard.jpg` | a photographed whiteboard |
| `whiteboard-notes.md` | what the vision model (`gemini-3.5-flash`) read from it |
| `meeting.txt` | a plain-text meeting note, as someone would paste it |

A sample room is assembled from these without running any job, so opening one
costs no GPU time and no model quota. Its passages are embedded like any other
room's, so Ask the room works on it; answering a question there does use the
answer model, under the same limits as everywhere else. Sample rooms expire
like any session.
