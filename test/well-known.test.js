// /.well-known/x402 (well-known.js): the paid resources as { url, method, name, description }, as the XRPL AI Hub
// reads them, and the endpoints list for existing readers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { wellKnown } = require('../well-known');

test('/.well-known/x402: each paid resource with a short name and a one-line description', () => {
  const doc = wellKnown('https://plaintext.fizzl.eu');
  assert.equal(doc.version, 1);
  assert.equal(doc.name, 'PlainText — wallet approval translator');
  assert.deepEqual(doc.resources.map((r) => [r.url, r.method]), [['https://plaintext.fizzl.eu/api/check-wallet', 'POST'], ['https://plaintext.fizzl.eu/api/explain', 'POST']]);
  assert.equal(new Set(doc.resources.map((r) => r.name)).size, doc.resources.length, 'names are unique');
  for (const r of doc.resources) {
    assert.ok(r.name.length > 0 && r.name.length <= 40, r.url);
    assert.ok(r.description.length >= 40 && r.description.length <= 200, r.url);
  }
  assert.deepEqual(doc.endpoints.map((e) => e.url), doc.resources.map((r) => r.url), 'the endpoints list stays');
  assert.match(doc.description, /XRP Ledger/);
});
