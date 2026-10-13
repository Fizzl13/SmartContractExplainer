// /.well-known/x402: the paid resources on this origin, for x402 indexers. Each resource carries a short name and a
// one-line description: the XRPL AI Hub (xrpl-ai.org) lists each resource by those (without them it shows the long
// 402 text). The endpoints list stays for existing readers.
function wellKnown(origin) {
  return {
    version: 1,
    resources: [
      { url: `${origin}/api/check-wallet`, method: 'POST', name: 'Wallet approval check', description: "A wallet's open token and NFT approvals (via GoPlus), with a SAFE, CAUTION or RISK verdict explained in plain language." },
      { url: `${origin}/api/explain`, method: 'POST', name: 'Signature explainer', description: 'What would signing this allow? A SAFE, CAUTION or RISK verdict and a plain-language explanation of a pasted approval, transaction or signature.' },
    ],
    x402Version: 2,
    kind: 'resource-server',
    name: 'PlainText — wallet approval translator',
    serviceName: 'PlainText',
    category: 'security',
    iconUrl: `${origin}/icon.png`,
    tags: ['wallet-security', 'approvals', 'crypto', 'explainer'],
    description: "Checks a wallet's token/NFT approvals via GoPlus and explains risk in plain language. Pay in USDC on Base, Solana or Algorand, or RLUSD on the XRP Ledger.",
    endpoints: [
      { url: `${origin}/api/check-wallet`, method: 'POST', description: 'Explain wallet token approvals in plain language' },
      { url: `${origin}/api/explain`, method: 'POST', description: 'What would signing this allow? A SAFE, CAUTION or RISK verdict with a plain-language explanation of a pasted approval, transaction or signature' },
    ],
    openapi: `${origin}/openapi.json`,
    docs: `${origin}/openapi.json`,
    contact: 'Fizzl13@protonmail.com',
    updated: '2026-10-13T00:00:00Z',
  };
}

module.exports = { wellKnown };
