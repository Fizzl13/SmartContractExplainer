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

// The middleware itself, with a fake GitHub that keeps the written lines.
async function logged(handler, request) {
  const express = require('express');
  const { createUsageLog } = require('../usage-log');
  const written = [];
  const fetchFn = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'GET') return new Response('{}', { status: 404 });
    written.push(Buffer.from(JSON.parse(opts.body).content, 'base64').toString('utf8'));
    return Response.json({}, { status: 201 });
  };
  const log = createUsageLog({ service: 'plaintext', env: { USAGE_LOG_TOKEN: 't' }, fetchFn, log: { warn() {}, error() {} } });
  const app = express();
  app.use(express.json());
  app.use(log.middleware(describePlainTextCall));
  app.all('*', handler);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  await fetch(`http://127.0.0.1:${server.address().port}${request.path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': request.agent || 'node' }, body: JSON.stringify(request.body || {}) });
  await new Promise((r) => setTimeout(r, 30));
  await log.flush();
  server.close();
  return written.length ? JSON.parse(written[0].trim().split('\n').pop()) : null;
}

test('usage log: a 402 is logged as a price shown, with the caller and a visitor code (never the IP)', async () => {
  const e = await logged((_req, res) => res.status(402).json({ x402Version: 2, accepts: [] }), { path: '/api/check-wallet', agent: 'CarbonMonitor/0.1' });
  assert.equal(e.status, 402);
  assert.equal(e.quote, true);
  assert.equal(e.agent, 'CarbonMonitor/0.1');
  assert.match(e.visitor, /^[0-9a-f]{12}$/);
  assert.ok(!JSON.stringify(e).includes('127.0.0.1'));
});

test('usage log: an MCP reply sent as an event stream is read (the verdict is logged)', async () => {
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_wallet_approvals', arguments: { address: '0xabc' } } };
  const reply = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'RISK: unlimited approval to an unverified spender' }] } };
  const e = await logged((_req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.send(Buffer.from(`event: message\ndata: ${JSON.stringify(reply)}\n\n`));
  }, { path: '/mcp', body: call });
  assert.equal(e.route, 'check_wallet_approvals');
  assert.deepEqual(e.result, { verdict: 'RISK' });
});
