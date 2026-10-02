require('dotenv').config();
const express = require('express');
const path = require('path');
const { paymentMiddleware } = require('@x402/express');
const { x402ResourceServer, HTTPFacilitatorClient } = require('@x402/core/server');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { ExactSvmScheme } = require('@x402/svm/exact/server');
const { createFacilitatorConfig } = require('@coinbase/x402');
const { fizzlCors } = require('./fizzl-cors');
const { declareDiscoveryExtension } = require('@x402/extensions/bazaar');
const { McpServer, createMcpHandler } = require('@modelcontextprotocol/server');
const { z } = require('zod/v4');
const { createMediaCache } = require('./media');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createUsageLog, agentOf } = require('./usage-log');
const { createFeedback } = require('./feedback');
const { describePlainTextCall } = require('./usage');
const { trustProxyHops } = require('./proxy');

const app = express();
const PORT = process.env.PORT || 3000;

// Render sits behind three proxies; see proxy.js. The count matters: too few and
// req.ip is Render's address for everyone, too many (true) and the caller can
// pick their own req.ip with an X-Forwarded-For header.
app.set('trust proxy', trustProxyHops());

app.use(express.json());

// Usage log: every call with what was filled in, for the dashboard at
// x402-doctor.fizzl.eu/admin/usage. Does nothing without USAGE_LOG_TOKEN.
const usageLog = createUsageLog({ service: 'plaintext' });
app.use(usageLog.middleware(describePlainTextCall));

// POST /feedback (and the MCP tool feedback): agents report a bug or a missing
// feature. Free; it lands in the usage log and a person reads it (feedback.js).
const feedback = createFeedback({ service: 'plaintext', record: usageLog.record, agentOf });
app.use(feedback.router(express));
// The MCP handler builds its server without the request: the caller (for the
// feedback limit) travels along in async context.
const mcpCaller = new AsyncLocalStorage();

// x402 v2 identifies networks by CAIP-2 chain id rather than a network name.
const CAIP2_NETWORKS = {
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532'
};
const SOLANA_NETWORKS = {
  mainnet: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  devnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
};

// @x402/express puts the v2 challenge only in the PAYMENT-REQUIRED header and
// sends an empty {} body; some clients read accepts[] from the body, so mirror
// it there.
function mirrorChallengeIntoBody(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 402 && !(body && Array.isArray(body.accepts))) {
      const header = res.getHeader('PAYMENT-REQUIRED');
      if (header) {
        try {
          const challenge = JSON.parse(Buffer.from(String(header), 'base64').toString('utf8'));
          if (Array.isArray(challenge.accepts)) {
            // the whole challenge: x402 v2 carries resource next to accepts
            body = { ...(body || {}), ...challenge };
          }
        } catch {
          // leave the body as is
        }
      }
    }
    return json(body);
  };
  next();
}

const x402PayTo = process.env.X402_PAY_TO;
if (x402PayTo) {
  const x402Network = process.env.X402_NETWORK || 'base-sepolia';
  const x402Caip2Network = CAIP2_NETWORKS[x402Network] || x402Network;
  const x402CheckPrice = process.env.X402_CHECK_PRICE || '$0.04';
  const x402ExplainPrice = process.env.X402_EXPLAIN_PRICE || '$0.03';
  // x402.org/facilitator is testnet-only; on mainnet the fallback is PayAI
  // (production, Base + Solana, no account needed).
  const x402FacilitatorUrl = process.env.X402_FACILITATOR_URL
    || (x402Caip2Network === CAIP2_NETWORKS.base ? 'https://facilitator.payai.network' : 'https://x402.org/facilitator');

  // Optional second payment option: USDC on Solana (mainnet next to Base, devnet
  // next to Base Sepolia). Set X402_PAY_TO_SOLANA to a Solana wallet that has a
  // USDC token account; without it only the EVM option is offered.
  const x402PayToSolana = process.env.X402_PAY_TO_SOLANA;
  const x402SolanaNetwork = process.env.X402_SOLANA_NETWORK
    || (x402Caip2Network === CAIP2_NETWORKS.base ? SOLANA_NETWORKS.mainnet : SOLANA_NETWORKS.devnet);

  // Prefer the Coinbase CDP facilitator when credentials are set — it's the only
  // facilitator that gets this app indexed in Coinbase's x402 Bazaar. The
  // URL-based facilitator (PayAI in production) stays as fallback: the first
  // facilitator that supports a network handles it.
  const usingCdp = Boolean(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);
  const facilitators = [];
  if (usingCdp) facilitators.push(new HTTPFacilitatorClient(createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET)));
  facilitators.push(new HTTPFacilitatorClient({ url: x402FacilitatorUrl }));

  const x402Server = new x402ResourceServer(facilitators);
  x402Server.register('eip155:*', new ExactEvmScheme());
  if (x402PayToSolana) x402Server.register(x402SolanaNetwork, new ExactSvmScheme());

  // Diagnostic logging only — doesn't change behavior. The 402 response a client
  // sees on verify/settle failure carries no detail, so log the real reason here.
  x402Server.onVerifyFailure(async (ctx) => {
    console.error('[x402] verify failed:', ctx.error && ctx.error.message, '| requirements:', JSON.stringify(ctx.requirements));
  });
  x402Server.onSettleFailure(async (ctx) => {
    console.error('[x402] settle failed:', ctx.error && ctx.error.message, '| requirements:', JSON.stringify(ctx.requirements));
  });

  // Bazaar discovery metadata: lets agents that browse the x402 Bazaar (and
  // indexers like x402scan) see the request body and response shape, not just
  // the price. Kept in sync with public/openapi.json.
  const verdictSchema = {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['SAFE', 'CAUTION', 'RISK'] },
      explanation: { type: 'string' }
    },
    required: ['verdict', 'explanation']
  };
  const checkWalletDiscovery = declareDiscoveryExtension({
    method: 'POST',
    bodyType: 'json',
    input: { address: '0x6B0F4651eD42893ab58139938175E4a69f175F25', chain: 'base', kind: 'token' },
    inputSchema: {
      properties: {
        address: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$', description: 'EVM wallet address to check' },
        chain: { type: 'string', enum: ['ethereum', 'bsc', 'polygon', 'arbitrum', 'optimism', 'base', 'avalanche'], description: 'Chain to check approvals on (default: ethereum)' },
        kind: { type: 'string', enum: ['token', 'nft'], description: 'Approval type to check (default: token)' }
      },
      required: ['address']
    },
    output: {
      schema: verdictSchema,
      example: { verdict: 'SAFE', explanation: 'This wallet has no active token approvals, so no app can move its tokens without asking first.' }
    }
  });
  const explainDiscovery = declareDiscoveryExtension({
    method: 'POST',
    bodyType: 'json',
    input: { data: { function: 'approve', token: 'USDC', spender: '0x7a3f...92e1', spender_verified: false, approved_amount: 'unlimited' } },
    inputSchema: {
      properties: {
        data: { type: 'object', description: 'Approval/permission JSON payload to explain (max 5000 characters)' }
      },
      required: ['data']
    },
    output: {
      schema: verdictSchema,
      example: { verdict: 'RISK', explanation: 'You would let an unverified, days-old address spend all of your USDC, forever.' }
    }
  });
  const serviceMetadata = { serviceName: 'PlainText', tags: ['wallet-security', 'approvals', 'crypto', 'explainer'] };

  app.use(mirrorChallengeIntoBody);
  // Refuse oversized payloads before the paywall, so nobody pays for a request
  // that cannot be served. An empty body still gets the 402 (discovery probes).
  app.post('/api/explain', (req, res, next) => {
    const data = req.body && req.body.data;
    if (data !== undefined && JSON.stringify(data).length > 5000) {
      return res.status(413).json({ error: 'Payload too large (max 5000 characters). Nothing was charged.' });
    }
    next();
  });
  const acceptsFor = (price) => [
    { scheme: 'exact', price, network: x402Caip2Network, payTo: x402PayTo },
    ...(x402PayToSolana ? [{ scheme: 'exact', price, network: x402SolanaNetwork, payTo: x402PayToSolana }] : [])
  ];

  app.use(paymentMiddleware({
    'POST /api/check-wallet': {
      accepts: acceptsFor(x402CheckPrice),
      description: "Check an EVM wallet's live token/NFT approvals and get a plain-language verdict (SAFE, CAUTION or RISK) with an explanation",
      mimeType: 'application/json',
      ...serviceMetadata,
      extensions: checkWalletDiscovery
    },
    'POST /api/explain': {
      accepts: acceptsFor(x402ExplainPrice),
      description: 'Explain a pasted approval/permission payload in plain language, with a SAFE, CAUTION or RISK verdict',
      mimeType: 'application/json',
      ...serviceMetadata,
      extensions: explainDiscovery
    }
  }, x402Server));

  const networks = [x402Caip2Network, ...(x402PayToSolana ? [x402SolanaNetwork] : [])].join(' + ');
  console.log(`x402 paywall enabled for /api/check-wallet and /api/explain on ${networks} using facilitator ${usingCdp ? `Coinbase CDP (fallback ${x402FacilitatorUrl})` : x402FacilitatorUrl}`);
} else {
  console.log('x402 paywall disabled: set X402_PAY_TO in your environment to enable it.');
}

app.use(express.static(path.join(__dirname, 'public')));

// The explainer video, poster and captions, served from the explainer-video
// branch (see media.js).
const media = createMediaCache();
app.get('/media/:name', media.handler);

const GOPLUS_BASE = 'https://api.gopluslabs.io/api/v2';

// Common EVM chain IDs GoPlus supports
const CHAINS = {
  ethereum: '1',
  bsc: '56',
  polygon: '137',
  arbitrum: '42161',
  optimism: '10',
  base: '8453',
  avalanche: '43114'
};

/**
 * Fetch approval data for a wallet address from GoPlus.
 * kind: 'token' (ERC-20) or 'nft' (ERC-721)
 */
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const CHAIN_ID_RE = /^[a-zA-Z0-9-]+$/;

// Simple in-memory per-key rate limit, for free endpoints where the x402
// paywall doesn't already cap cost exposure. Fine for a single-instance
// deployment; would need a shared store (e.g. Redis) across replicas.
function createRateLimiter(limit, windowMs) {
  const hits = new Map();
  return function check(key) {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
  };
}

const MAX_EXPLAIN_PAYLOAD_CHARS = 5000;

async function fetchApprovals({ chainId, address, kind }) {
  if (!ADDRESS_RE.test(address)) {
    throw Object.assign(new Error('Invalid wallet address format.'), { statusCode: 400 });
  }
  if (!CHAIN_ID_RE.test(String(chainId))) {
    throw Object.assign(new Error('Invalid chain.'), { statusCode: 400 });
  }

  const endpoint = kind === 'nft' ? 'nft721_approval_security' : 'token_approval_security';
  const normalizedAddress = address.toLowerCase();
  const url = `${GOPLUS_BASE}/${endpoint}/${encodeURIComponent(chainId)}?addresses=${encodeURIComponent(normalizedAddress)}`;

  const headers = {};
  if (process.env.GOPLUS_ACCESS_TOKEN) {
    headers['access_token'] = process.env.GOPLUS_ACCESS_TOKEN;
  }

  const res = await fetch(url, { headers });
  const rawText = await res.text();
  if (process.env.GOPLUS_DEBUG_LOG === 'true') {
    console.log('--- GoPlus raw response ---');
    console.log('URL:', url);
    console.log('HTTP status:', res.status);
    console.log('Body:', rawText);
    console.log('---------------------------');
  }

  if (!res.ok) {
    throw Object.assign(new Error(`GoPlus API error: ${res.status} ${res.statusText}`), { statusCode: 502 });
  }

  let json;
  try {
    json = JSON.parse(rawText);
  } catch (e) {
    throw Object.assign(new Error('GoPlus returned a non-JSON response — check server logs.'), { statusCode: 502 });
  }

  // code 1 = full success, code 2 = partial data obtained (still usable)
  if (json.code !== 1 && json.code !== 2) {
    throw Object.assign(new Error(`GoPlus API returned code ${json.code}: ${json.message || 'unknown error'}`), { statusCode: 502 });
  }
  // No result / empty result means the wallet simply has no on-chain approvals —
  // that's the best possible outcome, not a failure, so return an empty result
  // instead of throwing.
  if (!json.result || (Array.isArray(json.result) && json.result.length === 0) || (!Array.isArray(json.result) && Object.keys(json.result).length === 0)) {
    return [];
  }
  return json.result;
}

/**
 * Ask Claude to translate raw approval data into plain language.
 */
async function translateWithClaude(approvalData) {
  const prompt = `You are PlainText, an explainer for people with no crypto background who are about to review a wallet's token/NFT approvals.

Here is the technical approval data from a security scanner:
${JSON.stringify(approvalData, null, 2)}

Write an explanation in English, at most 5 short sentences, no jargon (never define terms like "approve", "spender", "unlimited" literally — just translate what they mean in practice):
1. What can each risky spender/operator actually do with the user's assets?
2. For how long (one-time, temporary, or forever until revoked)?
3. Are the counterparties known/verified or not?
4. Concrete advice: which approvals (if any) should the user consider revoking, and why.

Start your answer with exactly one of these three words followed by a colon: "SAFE:", "CAUTION:", or "RISK:" — choose based on the riskiest approval found. If there are no approvals or none look risky, start with "SAFE:".`;

  const text = await callClaude(prompt);

  const match = text.match(/^(SAFE|CAUTION|RISK):\s*([\s\S]*)/i);
  if (match) {
    return { verdict: match[1].toUpperCase(), explanation: match[2].trim() };
  }
  return { verdict: 'CAUTION', explanation: text };
}

// --- presign-guard as the source of the verdict (presign.js) ---
// With FIZZL_INTERNAL_KEY set (the same value as on presign-guard, Render only),
// PlainText asks presign-guard for the verdict and its reasons and only writes the
// plain-language explanation with Claude; otherwise the old path (GoPlus + Claude).
const { VERDICT_OF, presignEnabled, askPresign, presignCheckInput, trimReasons } = require('./presign');

async function callClaude(prompt) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error('ANTHROPIC_API_KEY is not set on the server.'), { statusCode: 503 });
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 500, messages: [{ role: 'user', content: prompt }] })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw Object.assign(new Error(`Anthropic API error: ${res.status} ${errText}`), { statusCode: 502 });
  }
  const data = await res.json();
  return data.content.map((b) => b.text || '').join('\n').trim();
}

// Plain-language explanation of a verdict that presign-guard already decided:
// Claude explains, it does not judge.
async function explainVerdict(verdict, findings, subject) {
  const prompt = `You are PlainText, an explainer for people with no crypto background.

A security check has already decided the verdict for ${subject}: ${verdict}. Do not change it or second-guess it.
Here are its findings (reason codes with severity, and details):
${JSON.stringify(findings, null, 2)}

Write an explanation in English, at most 5 short sentences, no jargon (translate what each finding means in practice instead of naming the codes). Call a token by its tokenSymbol when one is given (for example "your USDC"):
1. What could happen to the user's money if they go ahead (or, for a wallet, what the risky approvals allow)?
2. Who is on the other side, and is that party known or new?
3. Concrete advice that fits the verdict ${verdict}.
Do not start with the verdict word; it is shown separately.`;
  return callClaude(prompt);
}

// Shared by the paid HTTP route and the free MCP tool: explain a pasted payload.
async function explainPayload(data) {
  const input = presignEnabled() ? presignCheckInput(data) : null;
  if (input) {
    try {
      const r = await askPresign('POST', '/v1/check', { body: input });
      const verdict = VERDICT_OF[r.verdict];
      const reasons = trimReasons(r.reasons);
      const explanation = await explainVerdict(verdict, { reasons, subject: r.subject }, 'what the user is about to sign');
      return { verdict, explanation, source: 'presign-guard', reasons, ...(r.receipt ? { receipt: r.receipt } : {}) };
    } catch (err) {
      console.warn(`[presign] check fell back to the model: ${err.message}`);
    }
  }
  const { verdict, explanation } = await translateWithClaude(data);
  return { verdict, explanation, source: 'model' };
}

// Shared by the paid HTTP route and the free MCP tool below.
async function getWalletVerdict({ address, chain = 'ethereum', kind = 'token' }) {
  if (!ADDRESS_RE.test(String(address || ''))) {
    throw Object.assign(new Error('Invalid wallet address format.'), { statusCode: 400 });
  }
  if (presignEnabled() && kind !== 'nft' && /^[a-z]+$/.test(String(chain))) {
    try {
      const r = await askPresign('GET', '/v1/approvals', { query: { chain, address } });
      const verdict = VERDICT_OF[r.verdict];
      const approvals = Array.isArray(r.approvals) ? r.approvals : [];
      const explanation = approvals.length
        ? await explainVerdict(verdict, { one_liner: r.one_liner, summary: r.summary, approvals: approvals.slice(0, 20) }, "this wallet's open token approvals")
        : 'This wallet has no active token approvals on this chain right now — there is nothing a third party can currently move on your behalf.';
      return { verdict, explanation, raw: approvals, source: 'presign-guard', reasons: trimReasons(r.reasons), grade: r.grade, one_liner: r.one_liner, revoke_url: r.revokeUrl, ...(r.receipt ? { receipt: r.receipt } : {}) };
    } catch (err) {
      console.warn(`[presign] approvals fell back to GoPlus: ${err.message}`);
    }
  }
  const chainId = CHAINS[chain] || chain; // allow raw chain id too
  const approvalData = await fetchApprovals({ chainId, address, kind });

  if (Array.isArray(approvalData) && approvalData.length === 0) {
    return {
      verdict: 'SAFE',
      explanation: 'This wallet has no active token or NFT approvals on this chain right now — there is nothing a third party can currently move on your behalf.',
      raw: approvalData,
      source: 'goplus'
    };
  }

  const { verdict, explanation } = await translateWithClaude(approvalData);
  return { verdict, explanation, raw: approvalData, source: 'goplus' };
}

// Look up and explain real approvals for a wallet address
app.post('/api/check-wallet', async (req, res) => {
  try {
    const { address, chain = 'ethereum', kind = 'token' } = req.body;
    if (!address) return res.status(400).json({ error: 'address is required' });

    const result = await getWalletVerdict({ address, chain, kind });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Explain a manually pasted piece of approval/contract JSON (paid endpoint)
app.post('/api/explain', async (req, res) => {
  try {
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: 'data is required' });

    res.json(await explainPayload(data));
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// --- Free checks for people on this site (3 per visitor per day, 150 in all) ---
// The same answers as the paid routes, for people without an x402 wallet; agents
// keep paying /api/check-wallet and /api/explain. Not offered to other origins.
const { createQuota } = require('./free-quota');
const freeQuota = createQuota({ perVisitor: Number(process.env.FREE_PER_VISITOR) || 3, perDay: Number(process.env.FREE_PER_DAY) || 150 });
const MAX_FREE_PAYLOAD_CHARS = 2000;
const freeLimitMessage = (reason) => (reason === 'day'
  ? "Today's free checks are used up. Try again tomorrow, or pay per check with a wallet."
  : "You've used your 3 free checks for today. Come back tomorrow, or pay per check with a wallet.");

app.get('/api/free/quota', (req, res) => res.json({ left: freeQuota.left(req.ip), per_day: Number(process.env.FREE_PER_VISITOR) || 3 }));

async function freeRoute(req, res, run) {
  const taken = freeQuota.take(req.ip);
  if (!taken.ok) return res.status(429).json({ error: freeLimitMessage(taken.reason), left: 0 });
  try {
    const result = await run();
    res.json({ ...result, free_left: taken.left });
  } catch (err) {
    if ((err.statusCode || 500) >= 500) freeQuota.refund(req.ip); // our failure: the check doesn't count
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message, left: freeQuota.left(req.ip) });
  }
}

app.post('/api/free/check-wallet', (req, res) => {
  const { address, chain = 'ethereum', kind = 'token' } = req.body || {};
  if (!address) return res.status(400).json({ error: 'address is required' });
  if (!ADDRESS_RE.test(String(address))) return res.status(400).json({ error: 'Invalid wallet address format.' });
  return freeRoute(req, res, () => getWalletVerdict({ address, chain, kind }));
});

app.post('/api/free/explain', (req, res) => {
  const { data } = req.body || {};
  if (!data) return res.status(400).json({ error: 'data is required' });
  const size = JSON.stringify(data).length;
  if (size > MAX_FREE_PAYLOAD_CHARS) return res.status(400).json({ error: `Too long for a free check (${size} characters, max ${MAX_FREE_PAYLOAD_CHARS}).` });
  return freeRoute(req, res, () => explainPayload(data));
});

// Free demo scenarios shown on the "Try a sample" tab, kept in sync with public/index.html.
// This is a fixed, known set — not a general free-explain backdoor around the x402 paywall.
const DEMO_SCENARIOS = [
  { function: 'approve', token: 'USDC', spender: '0x7a3f...92e1', spender_verified: false, approved_amount: 'unlimited', duration: 'until manually revoked', spender_age_days: 4 },
  { function: 'setApprovalForAll', collection: 'BoredApeYachtClub', operator: '0x1e0049...marketplace', operator_verified: true, operator_label: 'OpenSea Seaport 1.6', approved: 'all tokens', duration: 'until manually revoked' },
  { function: 'permit2', token: 'ETH (wrapped)', spender: 'Uniswap Universal Router', spender_verified: true, approved_amount: '0.5 ETH', duration: 'expires in 30 minutes' }
];

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => deepEqual(a[key], b[key]));
}

// Free endpoint for the "Try a sample" demo tab — not behind the x402 paywall, but
// restricted to the fixed DEMO_SCENARIOS list so it can't be used as a free stand-in
// for the paid /api/explain endpoint. Also rate-limited since it's free and callable
// directly (bypassing the UI) by anyone who finds the route.
const checkDemoRateLimit = createRateLimiter(20, 60 * 60 * 1000);

// The free sample demo may also be called from the live demo on fizzl.eu (browser, CORS).
app.use('/api/demo-explain', fizzlCors);

app.post('/api/demo-explain', async (req, res) => {
  try {
    if (!checkDemoRateLimit(req.ip)) {
      return res.status(429).json({ error: 'Rate limit exceeded — try again later.' });
    }
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: 'data is required' });
    if (!DEMO_SCENARIOS.some((scenario) => deepEqual(scenario, data))) {
      return res.status(400).json({ error: 'Unknown demo scenario.' });
    }

    const { verdict, explanation } = await translateWithClaude(data);
    res.json({ verdict, explanation });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// --- Free MCP tools, rate-limited (see /api/check-wallet and /api/explain
// above for the paid HTTP equivalents) ---

function buildMcpServer() {
  const server = new McpServer({ name: 'plaintext-wallet-checker', version: '1.0.0' });

  server.registerTool(
    'check_wallet_approvals',
    {
      title: 'Check Wallet Approvals',
      description: "Check an EVM wallet's live token/NFT approvals and get a plain-language safety verdict (SAFE, CAUTION, or RISK) with an explanation. The verdict comes from presign-guard's approval audit (who each spender is, which to revoke).",
      inputSchema: z.object({
        address: z.string().regex(ADDRESS_RE).describe('EVM wallet address to check, e.g. 0x...'),
        chain: z.enum(Object.keys(CHAINS)).optional().describe('Chain to check approvals on (default: ethereum)'),
        kind: z.enum(['token', 'nft']).optional().describe('Approval type to check (default: token)')
      })
    },
    async ({ address, chain, kind }) => {
      try {
        const result = await getWalletVerdict({ address, chain, kind });
        return { content: [{ type: 'text', text: `${result.verdict}: ${result.explanation}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    'explain_approval',
    {
      title: 'Explain Approval Payload',
      description: "Explain an arbitrary approval/permission JSON payload in plain language, when you already have the data instead of needing an on-chain lookup.",
      inputSchema: z.object({
        data: z.record(z.string(), z.any()).describe('Arbitrary approval/permission JSON payload to explain')
      })
    },
    async ({ data }) => {
      try {
        const size = JSON.stringify(data).length;
        if (size > MAX_EXPLAIN_PAYLOAD_CHARS) {
          return { content: [{ type: 'text', text: `Error: payload too large (${size} chars, max ${MAX_EXPLAIN_PAYLOAD_CHARS}).` }], isError: true };
        }
        const { verdict, explanation } = await explainPayload(data);
        return { content: [{ type: 'text', text: `${verdict}: ${explanation}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    feedback.mcpTool.name,
    {
      title: feedback.mcpTool.title,
      description: feedback.mcpTool.description,
      inputSchema: z.object(feedback.mcpShape(z))
    },
    async (args) => feedback.mcpCall(args, mcpCaller.getStore() || {})
  );

  return server;
}

const checkMcpRateLimit = createRateLimiter(20, 60 * 60 * 1000);

const mcpHandler = createMcpHandler(buildMcpServer, { responseMode: 'json' });

app.all('/mcp', async (req, res) => {
  if (!checkMcpRateLimit(req.ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded — try again later.' });
  }

  try {
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
      else if (value !== undefined) headers.set(key, value);
    }

    const init = { method: req.method, headers };
    if (!['GET', 'HEAD'].includes(req.method) && req.body && Object.keys(req.body).length) {
      init.body = JSON.stringify(req.body);
    }

    const webResponse = await mcpCaller.run({ ip: req.ip, userAgent: req.headers['user-agent'] }, () => mcpHandler.fetch(new Request(url, init)));

    res.status(webResponse.status);
    webResponse.headers.forEach((value, key) => {
      if (!['content-length', 'content-encoding'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    res.send(Buffer.from(await webResponse.arrayBuffer()));
  } catch (err) {
    console.error('[mcp] error:', err);
    res.status(500).json({ error: 'MCP handler error' });
  }
});

// x402 discovery manifest per draft-hawkins-x402-dns-discovery: a
// resource-server (not a facilitator — this app sells resources, it doesn't
// verify/settle payments for others) publishing its x402 capability
// out-of-band so clients/indexers can discover it without prior config.
// x402scan and similar indexers read {version: 1, resources: [url, ...]};
// methods, prices and schemas come from /openapi.json (x-payment-info).
const PUBLIC_ORIGIN = 'https://plaintext.fizzl.eu';
const X402_WELL_KNOWN_MANIFEST = {
  version: 1,
  resources: [`${PUBLIC_ORIGIN}/api/check-wallet`, `${PUBLIC_ORIGIN}/api/explain`],
  x402Version: 2,
  kind: 'resource-server',
  name: 'PlainText — wallet approval translator',
  description: "Checks a wallet's token/NFT approvals via GoPlus and explains risk in plain language.",
  endpoints: [
    { url: `${PUBLIC_ORIGIN}/api/check-wallet`, method: 'POST', description: 'Explain wallet token approvals in plain language' },
    { url: `${PUBLIC_ORIGIN}/api/explain`, method: 'POST', description: 'Explain a pasted approval payload in plain language' }
  ],
  openapi: `${PUBLIC_ORIGIN}/openapi.json`,
  docs: `${PUBLIC_ORIGIN}/openapi.json`,
  contact: 'Fizzl13@protonmail.com',
  updated: '2026-09-23T00:00:00Z'
};

// Instructions an AI agent can read and follow ("Connect to plaintext.fizzl.eu/skill.md").
app.get('/skill.md', (_req, res) => res.set('cache-control', 'public, max-age=300').type('text/markdown; charset=utf-8').sendFile(path.join(__dirname, 'public', 'skill.md')));
app.get('/.well-known/x402', (req, res) => res.json(X402_WELL_KNOWN_MANIFEST));

// Agent registration (ERC-8004 format) for the Metaplex Agent Registry on Solana:
// the document the registered agent points to. registrations gets the asset
// address once the agent is minted.
app.get('/.well-known/agent-registration.json', (req, res) => res.json({
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'PlainText',
  description: "Explains crypto wallet approvals in plain language: checks a wallet's token and NFT approvals (via GoPlus) and translates a pasted approval or signature payload into what it lets someone do. Free MCP tools with a rate limit; paid calls over x402 in USDC on Base or Solana.",
  image: `${PUBLIC_ORIGIN}/og.jpg`,
  services: [
    { name: 'web', endpoint: `${PUBLIC_ORIGIN}/` },
    { name: 'MCP', endpoint: `${PUBLIC_ORIGIN}/mcp`, version: '2025-06-18' }
  ],
  active: true,
  x402Support: true,
  registrations: [],
  supportedTrust: []
}));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  media.warm();
  console.log(`PlainText server running on port ${PORT}`);
});
