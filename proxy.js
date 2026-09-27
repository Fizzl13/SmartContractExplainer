// How many proxies to trust for req.ip. Requests reach the app through three
// (the caller, then two hops, the last a private Render address: measured on
// x402-doctor, 26 Sep). 'true' trusted every X-Forwarded-For entry, so req.ip
// was whatever the caller put first: anyone could dodge the demo and MCP rate
// limits with a made-up header. TRUST_PROXY_HOPS overrides the count (a whole
// number from 0 to 10).
function trustProxyHops(env = process.env) {
  const n = Number(env.TRUST_PROXY_HOPS);
  return Number.isInteger(n) && n >= 0 && n <= 10 && String(env.TRUST_PROXY_HOPS).trim() !== '' ? n : 3;
}

module.exports = { trustProxyHops };
