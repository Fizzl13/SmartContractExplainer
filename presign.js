// presign-guard as the source of PlainText's verdicts.
//
// With FIZZL_INTERNAL_KEY set (at least 32 characters, the same value on
// presign-guard, Render only), PlainText calls presign-guard's /v1/check and
// /v1/approvals with the header x-fizzl-internal instead of paying: the verdict
// and its reasons (the same checks, sanctions list, wallet age and signed
// receipt as there) come from presign-guard, and PlainText only writes the
// plain-language explanation. Without the key nothing here is used.
'use strict';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const VERDICT_OF = { green: 'SAFE', orange: 'CAUTION', red: 'RISK' };
const presignUrl = (env = process.env) => String(env.PRESIGN_GUARD_URL || 'https://presign-guard.fizzl.eu').replace(/\/$/, '');
const presignKey = (env = process.env) => String(env.FIZZL_INTERNAL_KEY || '').trim();
const presignEnabled = (env = process.env) => presignKey(env).length >= 32;

async function askPresign(method, route, { query, body } = {}, { env = process.env, fetchFn = globalThis.fetch } = {}) {
  const url = new URL(presignUrl(env) + route);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
  const res = await fetchFn(url, {
    method,
    headers: { 'x-fizzl-internal': presignKey(env), accept: 'application/json', 'user-agent': 'plaintext/1.0', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000)
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !VERDICT_OF[json.verdict]) {
    throw Object.assign(new Error(`presign-guard ${route}: HTTP ${res.status}${json && json.message ? ` (${json.message})` : ''}`), { statusCode: res.status === 400 ? 400 : 502 });
  }
  return json;
}

// What presign-guard's POST /v1/check can judge: a typed-data signature, a
// transaction with calldata, or an approval with real addresses. Anything else
// (free text, shortened addresses, no chain) returns null: Claude explains it alone.
function presignCheckInput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const chainOf = (...v) => { const n = Number(v.find((x) => x !== undefined && x !== null && x !== '')); return Number.isInteger(n) && n > 0 ? n : null; };
  const origin = typeof data.origin === 'string' ? { origin: data.origin } : {};
  const td = data.typedData || (data.domain && data.message && data.primaryType ? data : null);
  if (td && typeof td === 'object') {
    const chainId = chainOf(data.chainId, td.domain && td.domain.chainId);
    return chainId ? { type: 'signature', chainId, typedData: td, ...origin } : null;
  }
  if (ADDRESS_RE.test(data.to || '') && typeof data.data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(data.data)) {
    const chainId = chainOf(data.chainId);
    return chainId ? { type: 'transaction', chainId, to: data.to, data: data.data, ...(data.value !== undefined ? { value: String(data.value) } : {}), ...origin } : null;
  }
  if (ADDRESS_RE.test(data.token || '') && ADDRESS_RE.test(data.spender || '')) {
    const chainId = chainOf(data.chainId);
    const amount = data.amount ?? data.value;
    return chainId && amount !== undefined ? { type: 'approval', chainId, token: data.token, spender: data.spender, amount: String(amount), ...origin } : null;
  }
  return null;
}

const trimReasons = (reasons) => (Array.isArray(reasons) ? reasons.slice(0, 20).map((r) => ({ code: r.code, severity: r.severity, ...(r.details ? { details: r.details } : {}) })) : []);

module.exports = { VERDICT_OF, presignEnabled, askPresign, presignCheckInput, trimReasons };
