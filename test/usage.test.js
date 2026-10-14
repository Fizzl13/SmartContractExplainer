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
  // feedback.js records its own tool calls, with the full message.
  const fb = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'feedback', arguments: { message: 'hi there' } } };
  assert.equal(describePlainTextCall(req('POST', '/mcp', fb), {}, {}), null);
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
  await fetch(`http://127.0.0.1:${server.address().port}${request.path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': request.agent || 'node', ...request.headers }, body: JSON.stringify(request.body || {}) });
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

test('usage log: a refused x402 payment is logged with the reason the 402 gives', async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
  const e = await logged((_req, res) => res.set('PAYMENT-REQUIRED', b64({ x402Version: 2, error: 'insufficient_funds', accepts: [] })).status(402).json({}), { path: '/api/check-wallet', headers: { 'payment-signature': b64({ x402Version: 2 }) } });
  assert.deepEqual([e.status, e.payment_failed, e.reason], [402, true, 'insufficient_funds']);
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

test('usage log: writes are batched (one read and one write for several calls), and a day file over 1 MB keeps its lines', async () => {
  const { createUsageLog } = require('../usage-log');
  const path = 'events/plaintext/2026-10-14.jsonl';
  const old = `${'x'.repeat(1100 * 1024)}\n`;
  let file = old;
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push(`${method} ${new URL(url).pathname}`);
    // Like GitHub: the JSON form has no content for files over 1 MB, the raw form has the bytes.
    if (method === 'GET') return /raw/.test(opts.headers?.accept || '') ? new Response(file) : Response.json({ sha: 'x', content: '' });
    file = Buffer.from(JSON.parse(opts.body).content, 'base64').toString('utf8');
    return Response.json({}, { status: 200 });
  };
  const log = createUsageLog({ service: 'plaintext', env: { USAGE_LOG_TOKEN: 't' }, fetchFn, now: () => new Date('2026-10-14T10:00:00Z'), log: { warn() {}, error() {} } });
  log.record({ route: 'check-wallet', status: 402 });
  log.record({ route: 'explain', status: 200 });
  assert.equal(calls.length, 0, 'nothing written until the flush');
  await log.flush();
  assert.ok(file.startsWith(old), 'the old lines are still there');
  assert.equal(file.slice(old.length).trim().split('\n').length, 2);
  assert.deepEqual(calls, [`GET /repos/Fizzl13/usage-log/contents/${path}`, `PUT /repos/Fizzl13/usage-log/contents/${path}`]);
});

test('usage log: the next write to the same day file skips the read; a file changed elsewhere is read again', async () => {
  const crypto = require('node:crypto');
  const { createUsageLog } = require('../usage-log');
  const shaOf = (text) => { const b = Buffer.from(text); return crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'); };
  let file = null;
  const calls = [];
  // Like GitHub: a write must name the sha of the file it replaces.
  const fetchFn = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push(method);
    if (method === 'GET') return file === null ? new Response('{}', { status: 404 }) : new Response(file);
    const body = JSON.parse(opts.body);
    if (file !== null && body.sha !== shaOf(file)) return new Response('{}', { status: 409 });
    file = Buffer.from(body.content, 'base64').toString('utf8');
    return Response.json({}, { status: 201 });
  };
  const log = createUsageLog({ service: 'plaintext', env: { USAGE_LOG_TOKEN: 't' }, fetchFn, now: () => new Date('2026-10-14T10:00:00Z'), log: { warn() {}, error() {} } });
  log.record({ route: 'check-wallet', status: 402 });
  await log.flush();
  log.record({ route: 'explain', status: 200 });
  await log.flush();
  assert.deepEqual(calls, ['GET', 'PUT', 'PUT'], 'one read, then writes only');
  file += '{"t":"2026-10-14T10:00:01.000Z","service":"plaintext","route":"other"}\n'; // another writer appended
  log.record({ route: 'explain', status: 402 });
  await log.flush();
  assert.deepEqual(calls.slice(3), ['PUT', 'GET', 'PUT']);
  assert.deepEqual(file.trim().split('\n').map((l) => JSON.parse(l).route), ['check-wallet', 'explain', 'other', 'explain'], 'no line lost');
});
