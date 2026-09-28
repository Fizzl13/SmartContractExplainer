const { test, before, after } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const { fizzlCors } = require("../fizzl-cors");

let server, base;
before(async () => {
  const app = express();
  app.use("/free", fizzlCors);
  app.get("/free", (_req, res) => res.json({ ok: true }));
  app.get("/paid", (_req, res) => res.json({ ok: true }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test("fizzl.eu may read the free route", async () => {
  for (const origin of ["https://fizzl.eu", "https://www.fizzl.eu"]) {
    const res = await fetch(`${base}/free`, { headers: { origin } });
    assert.strictEqual(res.headers.get("access-control-allow-origin"), origin);
    assert.match(res.headers.get("vary"), /Origin/);
  }
});

test("preflight from fizzl.eu gets 204 with methods and content-type", async () => {
  const res = await fetch(`${base}/free`, { method: "OPTIONS", headers: { origin: "https://fizzl.eu", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.strictEqual(res.status, 204);
  assert.match(res.headers.get("access-control-allow-methods"), /POST/);
  assert.strictEqual(res.headers.get("access-control-allow-headers"), "content-type");
});

test("other origins and other routes get no CORS header", async () => {
  const evil = await fetch(`${base}/free`, { headers: { origin: "https://evil.example" } });
  assert.strictEqual(evil.headers.get("access-control-allow-origin"), null);
  const lookalike = await fetch(`${base}/free`, { headers: { origin: "https://fizzl.eu.evil.example" } });
  assert.strictEqual(lookalike.headers.get("access-control-allow-origin"), null);
  const paid = await fetch(`${base}/paid`, { headers: { origin: "https://fizzl.eu" } });
  assert.strictEqual(paid.headers.get("access-control-allow-origin"), null);
});
