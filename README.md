# PlainText — wallet approval translator

A small Node.js app that looks up a wallet's token/NFT approvals via the
GoPlus Security API and asks Claude to explain them in plain language.

## Project structure

```
plaintext-wallet/
├── server.js          Express backend (GoPlus + Anthropic calls)
├── package.json
├── render.yaml         Render deploy config (optional, see below)
├── .env.example         Copy to .env for local dev
└── public/
    └── index.html      Frontend (wallet check + demo scenarios)
```

## 1. Run it locally first

```bash
cd plaintext-wallet
npm install
cp .env.example .env
# edit .env and paste your ANTHROPIC_API_KEY
npm start
```

Open http://localhost:3000 — try the "Try a sample" tab first (no API keys
needed besides Anthropic), then "Check a wallet" with a real address once
you're happy it works.

## 2. Deploy to Render

**Option A — one-click via render.yaml (Blueprint)**
1. Push this folder to a new GitHub repo.
2. In the Render dashboard: **New +** → **Blueprint** → select your repo.
   Render reads `render.yaml` automatically and creates the web service.
3. When prompted, fill in the environment variables:
   - `ANTHROPIC_API_KEY` — required, from console.anthropic.com
   - `GOPLUS_ACCESS_TOKEN` — optional, only needed if you outgrow GoPlus's
     free 30 calls/minute limit (see console.gopluslabs.io)
4. Click **Apply** — Render builds and deploys automatically.

**Option B — manual web service (no render.yaml needed)**
1. Push this folder to a GitHub repo.
2. Render dashboard → **New +** → **Web Service** → connect your repo.
3. Settings:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free (fine for a prototype)
4. Under **Environment Variables**, add `ANTHROPIC_API_KEY` (and optionally
   `GOPLUS_ACCESS_TOKEN`).
5. Click **Create Web Service**. Render gives you a `https://<name>.onrender.com`
   URL once the build finishes.

Render's free tier spins the service down after inactivity — the first
request after idling will take ~30-50 seconds to wake up. That's normal
and fine for a prototype you're sharing for feedback.

## Notes on the GoPlus integration

- The wallet check calls `token_approval_security` or `nft721_approval_security`
  under `https://api.gopluslabs.io/api/v2/...`. This is documented but the
  GoPlus docs site is JS-rendered, so **before you rely on this in front of
  real users, do one manual test call** (e.g. with `curl`) against a wallet
  you control, and compare the actual JSON shape to what `server.js` expects
  — field names occasionally shift between GoPlus API versions.
- The free GoPlus tier is capped at 30 calls/minute — plenty for early
  testing, but rate-limit errors will surface as a plain error message in
  the UI if you exceed it.
- No user data is stored anywhere in this app — every check is a stateless
  round trip. If you later add accounts, saved wallets, or history, update
  this note (and your own privacy policy) accordingly.

## Costs to expect

- **Render free tier**: $0/month, with the cold-start behavior above. A paid
  tier ($7/month "Starter") removes the spin-down if this gets real usage.
- **Anthropic API**: pay-per-use, billed to whatever key you provide. A
  single explanation call is small (well under 1K tokens), so cost per
  check will be a fraction of a cent — but keep an eye on your usage
  dashboard if this gets shared widely, since there's no rate limiting
  built into this prototype yet.
