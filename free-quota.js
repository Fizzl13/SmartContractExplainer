// Free checks for people on the site: a few per visitor per day, and a cap
// for everyone together, so the free version can't run up the Claude bill.
// In memory (one instance); a restart resets the counts, which is fine here.
'use strict';

function createQuota({ perVisitor = 3, perDay = 150, windowMs = 24 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
  const visitors = new Map(); // key -> { count, resetAt }
  let all = { count: 0, resetAt: now() + windowMs };
  const entry = (key) => {
    const t = now();
    let e = visitors.get(key);
    if (!e || t > e.resetAt) { e = { count: 0, resetAt: t + windowMs }; visitors.set(key, e); }
    if (t > all.resetAt) all = { count: 0, resetAt: t + windowMs };
    if (visitors.size > 50000) visitors.delete(visitors.keys().next().value);
    return e;
  };
  return {
    left(key) {
      const e = entry(key);
      return Math.max(0, Math.min(perVisitor - e.count, perDay - all.count));
    },
    take(key) {
      const e = entry(key);
      if (e.count >= perVisitor) return { ok: false, reason: 'visitor', left: 0 };
      if (all.count >= perDay) return { ok: false, reason: 'day', left: 0 };
      e.count++; all.count++;
      return { ok: true, left: Math.max(0, Math.min(perVisitor - e.count, perDay - all.count)) };
    },
    // Give a check back when it failed on our side (no answer was given).
    refund(key) {
      const e = visitors.get(key);
      if (e && e.count > 0) e.count--;
      if (all.count > 0) all.count--;
    },
  };
}

module.exports = { createQuota };
