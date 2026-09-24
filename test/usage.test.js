const test = require('node:test');
const assert = require('node:assert/strict');
const { describePlainTextCall } = require('../usage');

const req = (method, path, body, headers = {}) => ({ method, path, body, get: (k) => headers[k.toLowerCase()] });

test('usage log: wallet checks and pasted payloads with what was filled in', () => {
  const wallet = describePlainTextCall(req('POST', '/api/check-wallet', { address: '0xabc', chain: 'base', kind: 'token' }, { 'sec-fetch-site': 'same-origin' }), {}, { verdict: 'CAUTION' });
  assert.deepEqual(wallet, { route: 'check-wallet', via: 'web', input: { address: '0xabc', chain: 'base', kind: 'token' }, result: { verdict: 'CAUTION', error: undefined } });
  const explain = describePlainTextCall(req('POST', '/api/explain', { data: { spender: '0x1' } }), {}, { verdict: 'RISK' });
  assert.equal(explain.via, 'api');
  assert.deepEqual(explain.input, { data: { spender: '0x1' } });
});

test('usage log: MCP tool calls with the verdict; handshakes and other routes are skipped', () => {
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_wallet_approvals', arguments: { address: '0xabc' } } };
  const out = describePlainTextCall(req('POST', '/mcp', call), {}, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'SAFE: nothing to worry about' }] } });
  assert.deepEqual([out.route, out.via, out.result], ['check_wallet_approvals', 'mcp', { verdict: 'SAFE' }]);
  assert.equal(describePlainTextCall(req('POST', '/mcp', { jsonrpc: '2.0', method: 'tools/list' }), {}, {}), null);
  assert.equal(describePlainTextCall(req('GET', '/api/health'), {}, {}), null);
});
