// fizzl-cors.js
//
// Lets the live demos on fizzl.eu ("Tools for AI agents") call this service's
// free routes from the browser. Only the fizzl.eu origins, and only on the
// routes it is mounted on; paid routes stay same-origin (agents don't need
// CORS). Kept identical in ichimoku-signal, x402-doctor, presign-guard and
// SmartContractExplainer.
const ORIGINS = new Set(["https://fizzl.eu", "https://www.fizzl.eu"]);

function fizzlCors(req, res, next) {
  res.vary("Origin");
  const origin = req.get("origin");
  if (!origin || !ORIGINS.has(origin)) return next();
  res.set({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "600",
  });
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
}

module.exports = { fizzlCors, FIZZL_ORIGINS: ORIGINS };
