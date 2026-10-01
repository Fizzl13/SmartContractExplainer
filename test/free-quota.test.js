// Free checks: 3 per visitor per day, a cap for everyone, a refund on our failures.
const { test } = require('node:test');
const assert = require('node:assert');
const { createQuota } = require('../free-quota');

test('3 per visitor, then no more until the day is over', () => {
  let t = 0;
  const q = createQuota({ perVisitor: 3, perDay: 100, now: () => t });
  assert.equal(q.left('a'), 3);
  assert.deepEqual([q.take('a').ok, q.take('a').ok, q.take('a').ok, q.take('a').ok], [true, true, true, false]);
  assert.equal(q.take('a').reason, 'visitor');
  assert.equal(q.take('b').ok, true, 'another visitor still can');
  t += 24 * 60 * 60 * 1000 + 1;
  assert.equal(q.left('a'), 3);
});

test('the daily cap for everyone together', () => {
  const q = createQuota({ perVisitor: 3, perDay: 4 });
  ['a', 'a', 'b', 'c'].forEach((k) => assert.equal(q.take(k).ok, true));
  const r = q.take('d');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'day');
  assert.equal(q.left('d'), 0);
});

test('a failed check is given back', () => {
  const q = createQuota({ perVisitor: 1, perDay: 10 });
  assert.equal(q.take('a').ok, true);
  q.refund('a');
  assert.equal(q.take('a').ok, true);
});
