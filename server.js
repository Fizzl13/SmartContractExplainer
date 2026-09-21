require('dotenv').config();
const express = require('express');
const path = require('path');
const { paymentMiddleware } = require('@x402/express');
const { x402ResourceServer, HTTPFacilitatorClient } = require('@x402/core/server');
const { ExactEvmScheme } = require('@x402/evm/exact/server');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// x402 v2 identifies networks by CAIP-2 chain id rather than a network name.
const CAIP2_NETWORKS = {
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532'
};

const x402PayTo = process.env.X402_PAY_TO;
if (x402PayTo) {
  const x402Network = process.env.X402_NETWORK || 'base-sepolia';
  const x402Caip2Network = CAIP2_NETWORKS[x402Network] || x402Network;
  const x402CheckPrice = process.env.X402_CHECK_PRICE || '$0.10';
  const x402ExplainPrice = process.env.X402_EXPLAIN_PRICE || '$0.05';
  const x402FacilitatorUrl = process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator';

  const facilitatorClient = new HTTPFacilitatorClient({ url: x402FacilitatorUrl });
  const x402Server = new x402ResourceServer(facilitatorClient);
  x402Server.register('eip155:*', new ExactEvmScheme());

  app.use(paymentMiddleware({
    'POST /api/check-wallet': {
      accepts: [{ scheme: 'exact', price: x402CheckPrice, network: x402Caip2Network, payTo: x402PayTo }],
      description: 'Explain wallet token approvals in plain language',
      mimeType: 'application/json'
    },
    'POST /api/explain': {
      accepts: [{ scheme: 'exact', price: x402ExplainPrice, network: x402Caip2Network, payTo: x402PayTo }],
      description: 'Explain a pasted approval payload in plain language',
      mimeType: 'application/json'
    }
  }, x402Server));

  console.log(`x402 paywall enabled for /api/check-wallet and /api/explain using facilitator ${x402FacilitatorUrl}`);
} else {
  console.log('x402 paywall disabled: set X402_PAY_TO in your environment to enable it.');
}

app.use(express.static(path.join(__dirname, 'public')));

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
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error('ANTHROPIC_API_KEY is not set on the server.'), { statusCode: 503 });
  }

  const prompt = `You are PlainText, an explainer for people with no crypto background who are about to review a wallet's token/NFT approvals.

Here is the technical approval data from a security scanner:
${JSON.stringify(approvalData, null, 2)}

Write an explanation in English, at most 5 short sentences, no jargon (never define terms like "approve", "spender", "unlimited" literally — just translate what they mean in practice):
1. What can each risky spender/operator actually do with the user's assets?
2. For how long (one-time, temporary, or forever until revoked)?
3. Are the counterparties known/verified or not?
4. Concrete advice: which approvals (if any) should the user consider revoking, and why.

Start your answer with exactly one of these three words followed by a colon: "SAFE:", "CAUTION:", or "RISK:" — choose based on the riskiest approval found. If there are no approvals or none look risky, start with "SAFE:".`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw Object.assign(new Error(`Anthropic API error: ${res.status} ${errText}`), { statusCode: 502 });
  }

  const data = await res.json();
  const text = data.content.map(b => b.text || '').join('\n').trim();

  const match = text.match(/^(SAFE|CAUTION|RISK):\s*([\s\S]*)/i);
  if (match) {
    return { verdict: match[1].toUpperCase(), explanation: match[2].trim() };
  }
  return { verdict: 'CAUTION', explanation: text };
}

// Look up and explain real approvals for a wallet address
app.post('/api/check-wallet', async (req, res) => {
  try {
    const { address, chain = 'ethereum', kind = 'token' } = req.body;
    if (!address) return res.status(400).json({ error: 'address is required' });

    const chainId = CHAINS[chain] || chain; // allow raw chain id too
    const approvalData = await fetchApprovals({ chainId, address, kind });

    if (Array.isArray(approvalData) && approvalData.length === 0) {
      res.json({
        verdict: 'SAFE',
        explanation: 'This wallet has no active token or NFT approvals on this chain right now — there is nothing a third party can currently move on your behalf.',
        raw: approvalData
      });
      return;
    }

    const { verdict, explanation } = await translateWithClaude(approvalData);

    res.json({ verdict, explanation, raw: approvalData });
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

    const { verdict, explanation } = await translateWithClaude(data);
    res.json({ verdict, explanation });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
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
// for the paid /api/explain endpoint.
app.post('/api/demo-explain', async (req, res) => {
  try {
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

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`PlainText server running on port ${PORT}`);
});
