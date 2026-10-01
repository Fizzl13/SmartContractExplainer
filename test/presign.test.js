// presign-guard as the source of the verdict: what goes there, and what comes back.
const { test } = require('node:test');
const assert = require('node:assert');
const { presignEnabled, askPresign, presignCheckInput, VERDICT_OF } = require('../presign');

const KEY = 'k'.repeat(40);
const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SPENDER = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

test('only on with a key of at least 32 characters', () => {
  assert.equal(presignEnabled({}), false);
  assert.equal(presignEnabled({ FIZZL_INTERNAL_KEY: 'short' }), false);
  assert.equal(presignEnabled({ FIZZL_INTERNAL_KEY: KEY }), true);
});

test('verdicts map to SAFE / CAUTION / RISK', () => {
  assert.deepEqual(VERDICT_OF, { green: 'SAFE', orange: 'CAUTION', red: 'RISK' });
});

test('payloads presign-guard can judge become a /v1/check request', () => {
  assert.deepEqual(presignCheckInput({ chainId: 8453, token: TOKEN, spender: SPENDER, amount: '1000000' }), { type: 'approval', chainId: 8453, token: TOKEN, spender: SPENDER, amount: '1000000' });
  assert.deepEqual(presignCheckInput({ chainId: '8453', to: TOKEN, data: '0x095ea7b3' + '0'.repeat(128), origin: 'app.example' }), { type: 'transaction', chainId: 8453, to: TOKEN, data: '0x095ea7b3' + '0'.repeat(128), origin: 'app.example' });
  const td = { domain: { chainId: 8453, verifyingContract: TOKEN }, primaryType: 'Permit', message: { spender: SPENDER }, types: {} };
  assert.deepEqual(presignCheckInput(td), { type: 'signature', chainId: 8453, typedData: td });
  assert.deepEqual(presignCheckInput({ typedData: td }), { type: 'signature', chainId: 8453, typedData: td });
});

test('free text, shortened addresses or no chain stay with the model', () => {
  assert.equal(presignCheckInput({ function: 'approve', token: 'USDC', spender: '0x7a3f...92e1', approved_amount: 'unlimited' }), null);
  assert.equal(presignCheckInput({ token: TOKEN, spender: SPENDER, amount: '1' }), null, 'no chain');
  assert.equal(presignCheckInput('approve USDC'), null);
  assert.equal(presignCheckInput([1, 2]), null);
});

test('askPresign sends the internal key and returns the verdict', async () => {
  let seen;
  const fetchFn = async (url, init) => { seen = { url: String(url), init }; return { ok: true, status: 200, json: async () => ({ verdict: 'red', reasons: [] }) }; };
  const r = await askPresign('GET', '/v1/approvals', { query: { chain: 'base', address: SPENDER } }, { env: { FIZZL_INTERNAL_KEY: KEY }, fetchFn });
  assert.equal(r.verdict, 'red');
  assert.equal(seen.url, `https://presign-guard.fizzl.eu/v1/approvals?chain=base&address=${SPENDER}`);
  assert.equal(seen.init.headers['x-fizzl-internal'], KEY);
});

test('askPresign fails on a 402, an error or a missing verdict (so PlainText falls back)', async () => {
  for (const [status, body] of [[402, { accepts: [] }], [503, { error: 'upstream_unavailable' }], [200, { verdict: null }]]) {
    const fetchFn = async () => ({ ok: status === 200, status, json: async () => body });
    await assert.rejects(askPresign('POST', '/v1/check', { body: {} }, { env: { FIZZL_INTERNAL_KEY: KEY }, fetchFn }));
  }
});
