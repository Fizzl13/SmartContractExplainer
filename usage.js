// What each PlainText call was about, for the usage log (usage-log.js):
// the dashboard at x402-doctor.fizzl.eu/admin/usage. Null = not logged.
const { mcpToolCall } = require('./usage-log');

// Calls from this site's own page vs. agents and scripts.
const via = (req) => (req.get && req.get('sec-fetch-site') === 'same-origin' ? 'web' : 'api');

function describePlainTextCall(req, _res, body) {
  // Who reads the EIP-8004 registration (e.g. agent registries such as Metaplex).
  if (req.method === 'GET' && req.path === '/.well-known/agent-registration.json') return { route: 'agent registration', via: 'discovery', input: {}, result: { status: _res.statusCode } };
  const b = body || {};
  const input = req.body || {};
  if (req.method === 'POST' && req.path === '/api/check-wallet') {
    return { route: 'check-wallet', via: via(req), input: { address: input.address, chain: input.chain, kind: input.kind }, result: { verdict: b.verdict, error: b.error } };
  }
  if (req.method === 'POST' && req.path === '/api/explain') {
    return { route: 'explain', via: via(req), input: { data: input.data }, result: { verdict: b.verdict, error: b.error } };
  }
  if (req.method === 'POST' && req.path === '/api/free/check-wallet') {
    return { route: 'free check-wallet', via: 'web', input: { address: input.address, chain: input.chain, kind: input.kind }, result: { verdict: b.verdict, error: b.error } };
  }
  if (req.method === 'POST' && req.path === '/api/free/explain') {
    return { route: 'free explain', via: 'web', input: { data: input.data }, result: { verdict: b.verdict, error: b.error } };
  }
  if (req.method === 'POST' && req.path === '/api/demo-explain') {
    return { route: 'demo', via: 'web', input: { function: input.data && input.data.function }, result: { verdict: b.verdict, error: b.error } };
  }
  if (req.method === 'POST' && req.path === '/mcp') {
    const call = mcpToolCall(req.body);
    if (!call) return null; // initialize, tools/list
    if (call.tool === 'feedback') return null; // feedback.js logs it itself, with the full message
    const reply = (Array.isArray(b) ? b : [b]).find((r) => r && r.result) || {};
    const text = reply.result && reply.result.content && reply.result.content[0] && reply.result.content[0].text;
    const verdict = /^(SAFE|CAUTION|RISK):/.exec(String(text || ''));
    return { route: call.tool, via: 'mcp', input: call.args, result: verdict ? { verdict: verdict[1] } : { text: text || b.error } };
  }
  return null;
}

module.exports = { describePlainTextCall };
