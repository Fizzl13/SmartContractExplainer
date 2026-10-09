// Paying in USDC on Algorand: offered on both paid routes only with ALGORAND_PAY_TO (mainnet), settled by the
// Algorand facilitator (GoPlausible in production, a stand-in here), never by the URL facilitator.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { usdOf } = require('../usage-log');

const ALGORAND = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
const PAY_TO = 'SGLTUPAC7TKGKNNXKNPQ2QZCC7NJSLAKYZ7O7NOGGAPXWBFZTOLTPMSPPI';
const FEE_PAYER = 'ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA';

// A facilitator that says it supports the given networks.
function standInFacilitator(kinds) {
  return new Promise((ok) => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/supported')) return res.end(JSON.stringify({ kinds, extensions: [], signers: {} }));
      res.end(JSON.stringify({ isValid: false, success: false }));
    }).listen(0, () => ok(server));
  });
}

// Starts server.js with the env, asks a paid route for its 402 and returns the payment options.
async function acceptsWith(env) {
  const payai = await standInFacilitator([{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }, { x402Version: 2, scheme: 'exact', network: ALGORAND, extra: { feePayer: 'NOT-THIS-ONE' } }]);
  const algo = await standInFacilitator([{ x402Version: 2, scheme: 'exact', network: ALGORAND, extra: { feePayer: FEE_PAYER } }, { x402Version: 2, scheme: 'exact', network: 'eip155:8453' }]);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { PATH: process.env.PATH, PORT: String(port), X402_PAY_TO: '0x6B0F4651eD42893ab58139938175E4a69f175F25', X402_NETWORK: 'base', XRPL_PAY_TO: 'off', X402_FACILITATOR_URL: `http://127.0.0.1:${payai.address().port}`, ALGORAND_FACILITATOR_URL: `http://127.0.0.1:${algo.address().port}`, ...env },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/check-wallet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        if (res.status === 402) {
          const challenge = JSON.parse(Buffer.from(res.headers.get('payment-required'), 'base64').toString());
          return Object.assign(challenge.accepts, { extensions: challenge.extensions });
        }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('no 402');
  } finally {
    child.kill();
    payai.close();
    algo.close();
  }
}

test('with ALGORAND_PAY_TO: $0.04 in USDC (ASA 31566704) on Algorand, with the Algorand facilitator\'s fee payer', async () => {
  const accepts = await acceptsWith({ ALGORAND_PAY_TO: PAY_TO });
  const algo = accepts.find((a) => a.network === ALGORAND);
  assert.ok(algo, 'Algorand offered');
  assert.equal(algo.payTo, PAY_TO);
  assert.equal(algo.asset, '31566704');
  assert.equal(algo.amount, '40000');
  assert.equal(algo.extra.feePayer, FEE_PAYER, 'not the URL facilitator\'s');
  assert.ok(accepts.some((a) => a.network === 'eip155:8453'), 'Base still offered');
  // GoPlausible names the seller (one merchant per Algorand pay-to) from this.
  assert.equal(accepts.extensions['x402-merchant'].info.name, 'Fizzl');
  assert.equal(accepts.extensions['x402-merchant'].info.logo, 'https://fizzl.eu/logo-512.png');
});

test('without ALGORAND_PAY_TO, or "off": no Algorand', async () => {
  assert.ok(!(await acceptsWith({})).some((a) => a.network === ALGORAND));
  assert.ok(!(await acceptsWith({ ALGORAND_PAY_TO: 'off' })).some((a) => a.network === ALGORAND));
});

test('usage log: Algorand USDC counts in dollars', () => {
  assert.equal(usdOf({ network: ALGORAND, asset: '31566704', amount: '40000' }), 0.04);
});
