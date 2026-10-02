const test = require('node:test');
const assert = require('node:assert/strict');
const { onPublicHost } = require('../public-host');

const seen = (req) => `${req.protocol}://${req.headers.host}${req.originalUrl}`;
const run = (host, protocol = 'https') => new Promise((done) => {
  let url;
  const req = Object.create({ get protocol() { return protocol; } });
  Object.assign(req, { headers: { host }, originalUrl: '/api/check-wallet' });
  onPublicHost('https://plaintext.fizzl.eu', (r, _res, next) => { url = seen(r); next(); })(req, {}, () => done({ url, after: seen(req) }));
});

test('public host: the paywall sees plaintext.fizzl.eu for requests on the Render address, and only the paywall', async () => {
  assert.deepEqual(await run('smartcontractexplainer.onrender.com', 'http'), { url: 'https://plaintext.fizzl.eu/api/check-wallet', after: 'http://smartcontractexplainer.onrender.com/api/check-wallet' });
  assert.equal((await run('plaintext.fizzl.eu')).url, 'https://plaintext.fizzl.eu/api/check-wallet');
  assert.equal((await run('localhost:3000', 'http')).url, 'http://localhost:3000/api/check-wallet'); // local runs stay as they are
});
