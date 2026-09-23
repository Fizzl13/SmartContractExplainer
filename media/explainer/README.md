# Explainer video

A ~70-second narrated walkthrough of PlainText, made from the live site.

- `script.json`: the narration, one segment per scene (captions use the same text).
- `tts.py`: the voice (Kokoro, open weights); `--engine silent` for timing tests.
- `record.js`: drives a real browser through the page, timed to the voice. It only uses
  the free demo; the pay window is opened with a stand-in wallet that never signs.
- `build.py`: mixes the voice onto the recording (loudness -16 LUFS), writes the MP4,
  captions (SRT) and a poster frame.

Run it with the **Explainer video** workflow (Actions tab). The result is published to the
`explainer-video` branch and attached to the run.

Local test without a Claude key or network access to the facilitator:

```sh
python tts.py --engine silent
MOCK_DEMO=1 SITE_URL=http://127.0.0.1:3000 node record.js
python build.py
```
