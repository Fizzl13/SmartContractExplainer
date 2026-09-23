// Records the explainer video's picture: drives a real browser through the
// live PlainText page, timed to the narration (out/durations.json), with
// burned-in captions. Writes out/screen.webm and out/timeline.json (when each
// segment starts, so build.py can place the voice exactly there).
//
//   node record.js                                   # live site (GitHub Actions)
//   SITE_URL=http://127.0.0.1:3000 node record.js    # local test
//
// Only the free demo is used. The pay window is opened with a stand-in
// browser wallet that never answers, so nothing is ever signed or paid.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const OUT = process.env.OUT || path.join(__dirname, 'out');
const SITE = (process.env.SITE_URL || 'https://smartcontractexplainer.onrender.com').replace(/\/$/, '');
// A well-known public contract address, so no personal wallet is shown.
const SAMPLE_ADDRESS = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';
const W = 1920;
const H = 1080;
const ZOOM = 2.0;

const script = JSON.parse(fs.readFileSync(path.join(__dirname, 'script.json'), 'utf8'));
const durations = JSON.parse(fs.readFileSync(path.join(OUT, 'durations.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

const FONTS = '<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500&family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;600&display=swap" rel="stylesheet">';
const THEME = `
  :root { --paper:#f4efe6; --ink:#1c1a17; --soft:#6b6459; --line:#d8d0c2; --accent:#2f4b3c; --mono-bg:#211f1c; --mono:#e8e2d4; --safe:#7fbf8f; --warn:#d9a54a; }
  html, body { margin:0; height:100%; background:var(--paper); color:var(--ink); font-family:Inter,-apple-system,'Segoe UI',sans-serif; }
`;

function cardHtml({ title, sub, note }) {
  return `<!doctype html><html><head>${FONTS}<style>${THEME}
    body { display:flex; align-items:center; justify-content:center; }
    .c { text-align:center; animation: in .6s ease-out both; padding: 0 120px; }
    h1 { font-family: Fraunces, serif; font-weight: 500; font-size: 124px; margin: 0 0 24px; letter-spacing: -0.01em; }
    p { font-family: Fraunces, serif; font-size: 52px; color: var(--soft); margin: 0; }
    .note { font-family: 'IBM Plex Mono', monospace; font-size: 32px; margin-top: 44px; color: var(--accent); }
    @keyframes in { from { opacity:0; transform: translateY(24px);} to { opacity:1; transform:none; } }
  </style></head><body><div class="c"><h1>${esc(title)}</h1><p>${esc(sub || '')}</p>${note ? `<p class="note">${esc(note)}</p>` : ''}</div></body></html>`;
}

function terminalHtml(lines) {
  return `<!doctype html><html><head>${FONTS}<style>${THEME}
    body { display:flex; align-items:center; justify-content:center; }
    .t { width: 1500px; background: var(--mono-bg); color: var(--mono); border-radius: 18px; padding: 36px 44px; box-shadow: 0 30px 80px rgba(0,0,0,.25); }
    .bar { display:flex; gap:10px; margin-bottom: 26px; } .bar i { width:16px; height:16px; border-radius:50%; background:#4a453d; display:block; }
    .label { color: #a89f8d; font-size: 24px; margin: -8px 0 22px; }
    pre { margin:0; font: 30px/1.55 'IBM Plex Mono', 'DejaVu Sans Mono', monospace; white-space: pre-wrap; }
    .l { opacity: 0; transition: opacity .35s; } .l.on { opacity: 1; }
    .in { color: var(--warn); } .ok { color: var(--safe); } .dim { color: #a89f8d; }
    .hl { background: rgba(127,191,143,.18); border-radius: 6px; outline: 2px solid var(--safe); }
  </style></head><body><div class="t"><div class="bar"><i></i><i></i><i></i></div><div class="label">An AI agent calling PlainText</div><pre>${lines
    .map((l, i) => `<div class="l ${l.cls || ''}" id="l${i}">${esc(l.text)}</div>`)
    .join('')}</pre></div></body></html>`;
}

// Captions: a bar at the bottom of every page, re-created after navigation.
async function caption(page, text) {
  await page.evaluate(
    ({ text }) => {
      let el = document.getElementById('__cap');
      if (!el) {
        el = document.createElement('div');
        el.id = '__cap';
        el.style.cssText = 'position:fixed;left:50%;bottom:48px;transform:translateX(-50%);max-width:1500px;z-index:2147483647;' +
          'background:rgba(28,26,23,.86);color:#fff;font:600 38px/1.35 Inter,-apple-system,"Segoe UI",sans-serif;' +
          'padding:14px 28px;border-radius:14px;text-align:center;';
        document.body.appendChild(el);
      }
      // Same caption size on zoomed pages as on cards.
      el.style.zoom = String(1 / (parseFloat(document.documentElement.style.zoom) || 1));
      el.style.display = text ? 'block' : 'none';
      el.textContent = text;
    },
    { text }
  );
}

async function zoomPage(page) {
  await page.evaluate((z) => {
    document.documentElement.style.zoom = String(z);
  }, ZOOM);
}

const center = (page, selector) =>
  page.evaluate((s) => document.querySelector(s).scrollIntoView({ behavior: 'smooth', block: 'center' }), selector);

// Marks the lines of the sample's code box that contain `key`, one at a time.
async function markLine(page, key) {
  await page.evaluate((key) => {
    const raw = document.getElementById('demoRaw');
    if (!raw.querySelector('.__line')) {
      raw.innerHTML = raw.textContent
        .split('\n')
        .map((line) => `<span class="__line" style="display:block;border-radius:4px;transition:background .3s">${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>`)
        .join('');
    }
    for (const el of raw.querySelectorAll('.__line')) {
      if (el.textContent.includes(key)) el.style.background = 'rgba(217,165,74,.38)';
    }
  }, key);
}

async function markBox(page, selector, color) {
  await page.evaluate(
    ({ selector, color }) => {
      const el = document.querySelector(selector);
      el.style.transition = 'box-shadow .3s';
      el.style.boxShadow = `0 0 0 4px ${color}`;
    },
    { selector, color }
  );
}

// The demo's verdict comes from Claude. The narration names it, so wait for
// it and ask again (at most twice) if it differs from the script.
async function explainUntil(page, want) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await page.click('#translateBtn');
    await page.waitForFunction(
      () => /\b(safe|caution|risk)\b/.test(document.getElementById('demoVerdict').className) && document.getElementById('demoPlainText').textContent.length > 20 && !document.getElementById('translateBtn').disabled,
      null,
      { timeout: 60000 }
    );
    const got = await page.evaluate(() => document.getElementById('demoVerdict').className);
    if (got.includes(want)) return;
    console.log(`verdict "${got}", wanted ${want}: asking again`);
  }
  throw new Error(`the demo did not return ${want}`);
}

// The 402 challenge an agent gets, fetched live for the terminal scene.
async function liveChallenge() {
  const res = await fetch(`${SITE}/api/check-wallet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (res.status !== 402) throw new Error(`expected 402 from /api/check-wallet, got ${res.status}`);
  const challenge = JSON.parse(Buffer.from(res.headers.get('payment-required'), 'base64').toString('utf8'));
  const names = { 'eip155:8453': 'Base', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'Solana' };
  return challenge.accepts.map((a) => ({ network: names[a.network] || a.network, usd: (Number(a.amount) / 1e6).toFixed(2) }));
}

async function warmUp() {
  await fetch(`${SITE}/api/health`).catch(() => {});
  await fetch(SITE).catch(() => {});
}

async function main() {
  await warmUp();
  const options = process.env.MOCK_DEMO === '1' ? [{ network: 'Base', usd: '0.10' }, { network: 'Solana', usd: '0.10' }] : await liveChallenge();
  const terminalLines = [
    { cls: '', text: '$ POST smartcontractexplainer.onrender.com/api/check-wallet' },
    { cls: 'in', text: '← 402 Payment Required, pay with any of:' },
    ...options.map((o) => ({ cls: 'ok', text: `   ${o.network.padEnd(7)} $${o.usd} USDC` })),
    { cls: 'dim', text: '→ agent signs the payment and retries' },
    { cls: 'ok', text: '← 200 OK  { "verdict": "RISK", "explanation": "…" }' },
  ];

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: OUT, size: { width: W, height: H } }, colorScheme: 'light' });
  // A stand-in browser wallet: lets the page open its pay window, never signs.
  await context.addInitScript(() => {
    window.ethereum = { request: () => new Promise(() => {}), on() {}, removeListener() {} };
  });
  if (process.env.MOCK_DEMO === '1') {
    await context.route('**/api/demo-explain', async (route) => {
      const { data } = JSON.parse(route.request().postData());
      const risky = data.spender_verified === false;
      await sleep(1500);
      await route.fulfill({ json: { verdict: risky ? 'RISK' : 'SAFE', explanation: risky ? 'Test: this address could take all of your USDC, forever.' : 'Test: a small, short-lived permission to a trusted app.' } });
    });
  }
  const page = await context.newPage();
  const t0 = Date.now();
  const timeline = [];

  const scenes = {
    async card(seg) {
      await page.setContent(cardHtml(seg.card), { waitUntil: 'load' });
    },
    async 'prepare:hook-code'() {
      await page.goto(SITE, { waitUntil: 'networkidle', timeout: 90000 });
      await zoomPage(page);
      // Room below the footer, so it can scroll to the middle, above the captions.
      await page.evaluate(() => { document.body.style.paddingBottom = '60vh'; });
      await page.click('.tab[data-tab="demo"]');
      await page.click('.scenario-btn >> nth=0');
      await page.evaluate(() => document.getElementById('demoRaw').scrollIntoView({ block: 'center' }));
      await sleep(400);
    },
    async 'hook-code'(seg, ms) {
      await sleep(ms * 0.45);
      await markBox(page, '#demoRaw', 'rgba(161,58,47,.55)');
    },
    async hero() {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    },
    async 'trap-fields'(seg, ms) {
      await center(page, '#demoStage');
      await sleep(ms * 0.2);
      for (const key of ['"approved_amount"', '"spender_verified"', '"spender_age_days"']) {
        await markLine(page, key);
        await sleep(ms * 0.22);
      }
    },
    async 'explain-risk'() {
      await center(page, '#translateBtn');
      await sleep(500);
      await page.click('#translateBtn');
    },
    async 'prepare:show-risk'() {
      await explainUntil(page, 'risk');
      await center(page, '#demoResult');
      await sleep(600);
    },
    async 'show-risk'() {
      await markBox(page, '#demoVerdict', 'rgba(161,58,47,.35)');
    },
    async contrast(seg, ms) {
      await center(page, '.scenarios');
      await sleep(500);
      await page.click('.scenario-btn >> nth=2');
      await sleep(300);
      await center(page, '#demoStage');
      for (const key of ['"spender"', '"approved_amount"', '"duration"']) {
        await markLine(page, key);
        await sleep(ms * 0.14);
      }
      await page.click('#translateBtn');
    },
    async 'prepare:show-safe'() {
      await explainUntil(page, 'safe');
      await center(page, '#demoResult');
      await sleep(600);
    },
    async 'show-safe'() {
      await markBox(page, '#demoVerdict', 'rgba(47,107,63,.35)');
    },
    async 'prepare:wallet'() {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      await sleep(500);
      await page.click('.tab[data-tab="wallet"]');
      await page.fill('#walletAddress', '');
    },
    async wallet(seg, ms) {
      await center(page, '#panel-wallet');
      await page.type('#walletAddress', SAMPLE_ADDRESS, { delay: 22 });
      await sleep(ms * 0.12);
      await markBox(page, '#chainSelect', 'rgba(47,75,60,.45)');
      await page.selectOption('#chainSelect', 'base');
      await sleep(ms * 0.15);
      await markBox(page, '#checkWalletBtn', 'rgba(47,75,60,.45)');
    },
    async 'prepare:price'() {
      await page.click('#checkWalletBtn');
      await page.waitForSelector('#payModal.visible', { timeout: 10000 });
    },
    async price(seg, ms) {
      await page.evaluate(() => {
        const strong = document.querySelector('#payModal .modal-body strong');
        strong.style.cssText = 'background:rgba(217,165,74,.38);border-radius:4px;padding:0 4px;';
      });
      await sleep(ms * 0.5);
      await page.click('#closePayModalBtn');
      await page.evaluate(() => {
        const footer = document.querySelector('footer');
        footer.innerHTML = footer.innerHTML.replace('Nothing is stored', '<mark style="background:rgba(217,165,74,.38);color:inherit;border-radius:4px;padding:0 4px">Nothing is stored</mark>');
        footer.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    },
    async 'prepare:agents'() {
      await page.setContent(terminalHtml(terminalLines), { waitUntil: 'load' });
    },
    async agents(seg, ms) {
      for (let i = 0; i < terminalLines.length; i++) {
        await page.evaluate((i) => document.getElementById(`l${i}`).classList.add('on'), i);
        await sleep(Math.max(250, (ms * 0.8) / terminalLines.length));
      }
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('.l.ok')) if (/USDC/.test(el.textContent)) el.classList.add('hl');
      });
    },
  };

  for (const seg of script.segments) {
    const ms = Math.round((durations[seg.id] || 3) * 1000);
    const scene = scenes[seg.scene];
    if (!scene) throw new Error(`unknown scene ${seg.scene}`);
    // Scene changes that load a page happen before the voice starts, so the
    // line is heard over the finished page.
    let action = null;
    if (scenes[`prepare:${seg.scene}`]) await scenes[`prepare:${seg.scene}`](seg, ms);
    if (seg.scene === 'card') await scene(seg, ms);
    else action = scene(seg, ms);
    await caption(page, seg.text);
    const start = (Date.now() - t0) / 1000;
    timeline.push({ id: seg.id, start, duration: ms / 1000 });
    const minEnd = Date.now() + ms + 450;
    if (action) await action;
    const rest = minEnd - Date.now();
    if (rest > 0) await sleep(rest);
    console.log(`${seg.id}: ${start.toFixed(2)} s`);
  }
  await caption(page, '').catch(() => {});
  await sleep(1200);
  const total = (Date.now() - t0) / 1000;

  const videoPath = await page.video().path();
  await context.close();
  await browser.close();
  fs.renameSync(videoPath, path.join(OUT, 'screen.webm'));
  fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify({ total, segments: timeline }, null, 2));
  console.log(`recorded ${total.toFixed(1)} s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
