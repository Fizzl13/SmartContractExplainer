require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
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
async function fetchApprovals({ chainId, address, kind }) {
  const endpoint = kind === 'nft' ? 'nft721_approval_security' : 'token_approval_security';
  const url = `${GOPLUS_BASE}/${endpoint}/${chainId}?addresses=${address}`;

  const headers = {};
  if (process.env.GOPLUS_ACCESS_TOKEN) {
    headers['access_token'] = process.env.GOPLUS_ACCESS_TOKEN;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GoPlus API error: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  // code 1 = full success, code 2 = partial data obtained (still usable)
  if (json.code !== 1 && json.code !== 2) {
    throw new Error(`GoPlus API returned code ${json.code}: ${json.message || 'unknown error'}`);
  }
  if (!json.result || Object.keys(json.result).length === 0) {
    throw new Error('GoPlus returned no approval data for this address — it may have no on-chain approvals yet.');
  }
  return json.result;
}

/**
 * Ask Claude to translate raw approval data into plain language.
 */
async function translateWithClaude(approvalData) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set on the server.');
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
    throw new Error(`Anthropic API error: ${res.status} ${errText}`);
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
    const { verdict, explanation } = await translateWithClaude(approvalData);

    res.json({ verdict, explanation, raw: approvalData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Explain a manually pasted piece of approval/contract JSON (for demo scenarios)
app.post('/api/explain', async (req, res) => {
  try {
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: 'data is required' });

    const { verdict, explanation } = await translateWithClaude(data);
    res.json({ verdict, explanation });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`PlainText server running on port ${PORT}`);
});
