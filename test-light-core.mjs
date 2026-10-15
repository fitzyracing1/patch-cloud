// Behavior changes from moving patch-cloud's light reads onto @fitzyracing1/light-core (MIGRATION.md 1, 5, 6, 7).
process.env.LIGHTS_REFRESH = '0';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { darkStreakOf, fetchOneLight } = await import('./server.mjs');

const res = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const run = (id, conclusion, at, extra = {}) => ({ id, status: 'completed', conclusion, name: 'CI', html_url: `u/${id}`, created_at: at, updated_at: at, ...extra });
const withFetch = async (impl, fn) => {
  const saved = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = saved; }
};

test('lit light has no dark fields', () => {
  assert.deepEqual(darkStreakOf([run(1, 'success', '2026-10-10T00:00:00Z')]), {});
});

test('change 7: lastPassingAt is now lastLitAt; change 1: cancelled counts as dark in the streak', () => {
  const s = darkStreakOf([
    run(3, 'failure', '2026-10-12T00:00:00Z'),
    run(2, 'cancelled', '2026-10-11T00:00:00Z'),
    run(1, 'success', '2026-10-10T00:00:00Z'),
  ]);
  assert.deepEqual(s, { darkRuns: 2, darkSince: '2026-10-11T00:00:00Z', darkSinceCapped: false, lastLitAt: '2026-10-10T00:00:00Z' });
  assert.equal('lastPassingAt' in s, false);
});

test('change 5: runs are ordered by run_started_at, so a lit re-run ends the streak', () => {
  // run 1 was created first but re-run (lit) after run 2 failed
  const s = darkStreakOf([
    run(2, 'failure', '2026-10-11T00:00:00Z'),
    run(1, 'success', '2026-10-10T00:00:00Z', { run_started_at: '2026-10-12T00:00:00Z' }),
  ]);
  assert.deepEqual(s, {});
});

test('fetchOneLight: only success is lit; skipped is dark', async () => {
  for (const [c, lit] of [['success', true], ['failure', false], ['skipped', false], ['cancelled', false]]) {
    const l = await withFetch(async () => res(200, { workflow_runs: [run(9, c, '2026-10-12T00:00:00Z')] }), () => fetchOneLight('o/a'));
    assert.equal(l.lit, lit, c);
  }
});

test('fetchOneLight: no completed run is an error, not dark', async () => {
  await withFetch(async () => res(200, { workflow_runs: [] }), () => assert.rejects(fetchOneLight('o/a'), /no completed runs/));
});

test('change 6: a secondary rate limit (retry-after) is retried instead of failing', async () => {
  let n = 0;
  const l = await withFetch(
    async () => (n++ === 0 ? res(429, { message: 'slow down' }, { 'retry-after': '0' }) : res(200, { workflow_runs: [run(9, 'success', '2026-10-12T00:00:00Z')] })),
    () => fetchOneLight('o/b'),
  );
  assert.equal(l.lit, true);
  assert.equal(n, 2);
});

// keep last: it blocks the shared client until the (far) reset
test('change 6: a far reset blocks further GitHub calls until then', async () => {
  const far = String(Math.floor(Date.now() / 1000) + 3600);
  let calls = 0;
  await withFetch(async () => { calls++; return res(403, { message: 'rate limit' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': far }); }, async () => {
    await assert.rejects(fetchOneLight('o/c'), (e) => e.budget === true);
    await assert.rejects(fetchOneLight('o/d'), (e) => e.budget === true);
  });
  assert.equal(calls, 1);
});
