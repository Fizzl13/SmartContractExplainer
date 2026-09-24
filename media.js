// Serves the explainer video and its poster from the explainer-video branch
// (written by .github/workflows/explainer-video.yml), so a re-render shows up
// on the homepage without committing video files to the main branch.
//
// Files are downloaded to a temp dir on first use (and at startup) and served
// with sendFile, which supports the byte-range requests iOS Safari needs.
// Until a download finishes, requests are redirected to the raw GitHub URL.

const fs = require('fs');
const os = require('os');
const path = require('path');

const RAW = 'https://raw.githubusercontent.com/Fizzl13/SmartContractExplainer/explainer-video';
const FILES = {
  'explainer.mp4': { source: 'plaintext-explainer.mp4', type: 'video/mp4' },
  'explainer.jpg': { source: 'poster.jpg', type: 'image/jpeg' },
  'explainer.srt': { source: 'plaintext-explainer.srt', type: 'text/plain; charset=utf-8' },
};
const TTL_MS = 6 * 60 * 60 * 1000;

function createMediaCache({ base = process.env.MEDIA_BASE_URL || RAW, dir = path.join(os.tmpdir(), 'plaintext-media'), fetchImpl = fetch } = {}) {
  const state = {};
  const loading = {};

  function refresh(name) {
    const file = FILES[name];
    if (!file || loading[name]) return loading[name];
    loading[name] = (async () => {
      const res = await fetchImpl(`${base}/${file.source}`, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, name);
      fs.writeFileSync(`${target}.tmp`, Buffer.from(await res.arrayBuffer()));
      fs.renameSync(`${target}.tmp`, target);
      state[name] = { at: Date.now(), path: target };
    })()
      .catch((err) => console.error(`[media] ${name}: ${err.message}`))
      .finally(() => {
        delete loading[name];
      });
    return loading[name];
  }

  function warm() {
    return Promise.all(Object.keys(FILES).map(refresh));
  }

  function handler(req, res) {
    const name = req.params.name;
    const file = FILES[name];
    if (!file) return res.status(404).end();
    const cached = state[name];
    if (!cached || Date.now() - cached.at > TTL_MS) refresh(name);
    if (!cached) return res.redirect(302, `${base}/${file.source}`);
    res.set('Cache-Control', 'public, max-age=3600');
    res.type(file.type);
    res.sendFile(cached.path);
  }

  return { handler, warm, refresh };
}

module.exports = { createMediaCache, FILES };
