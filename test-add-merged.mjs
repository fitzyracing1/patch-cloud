// Behavior changes from moving add-merged onto @fitzyracing1/light-core (MIGRATION.md change 1, 5, 8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lightOf, runFacts, detectLitRun, detectDarkRun, buildEntry, AddMergedError } from './add-merged.mjs';

const REPO = 'o/r';
const fakeGh = (routes) => async (path) => {
  for (const [re, val] of routes) if (re.test(path)) return typeof val === 'function' ? val(path) : val;
  throw new Error(`unexpected ${path}`);
};
const run = (id, conclusion, extra = {}) => ({ id, status: 'completed', conclusion, name: 'CI', html_url: `https://github.com/o/r/actions/runs/${id}`, head_branch: 'main', head_sha: `s${id}`, created_at: '2026-10-01T00:00:00Z', ...extra });
const job = (name, conclusion, status = 'completed') => ({ name, status, conclusion, html_url: `https://github.com/o/r/actions/runs/1/job/${name}` });

test('only success is lit; cancelled, skipped, neutral, stale, action_required are dark', () => {
  assert.equal(lightOf('completed', 'success'), 'lit');
  for (const c of ['failure', 'timed_out', 'startup_failure', 'cancelled', 'skipped', 'neutral', 'stale', 'action_required'])
    assert.equal(lightOf('completed', c), 'dark', c);
});

test('a run still in progress is waiting, not dark', () => {
  assert.equal(lightOf('in_progress', null), 'waiting');
  assert.equal(lightOf('queued', null), 'waiting');
});

test('a skipped job matched by --light is kept and makes the run dark', async () => {
  const gh = fakeGh([
    [/runs\/1\/jobs/, { jobs: [job('test-a', 'success'), job('test-b', 'skipped'), job('lint', 'success')] }],
    [/runs\/1$/, run(1, 'success')],
  ]);
  const f = await runFacts(gh, REPO, 1, 'test');
  assert.equal(f.state, 'dark');
  assert.deepEqual(f.jobs.map((j) => [j.name, j.light]), [['test-a', 'lit'], ['test-b', 'dark']]);
});

test('a cancelled whole run reads dark (was "none")', async () => {
  const gh = fakeGh([[/runs\/2\/jobs/, { jobs: [] }], [/runs\/2$/, run(2, 'cancelled')]]);
  assert.equal((await runFacts(gh, REPO, 2, '')).state, 'dark');
});

test('detectLitRun stops at a cancelled after-merge run (dark) instead of skipping it', async () => {
  const gh = fakeGh([
    [/actions\/runs\?/, { workflow_runs: [run(4, 'success', { created_at: '2026-10-03T00:00:00Z' }), run(3, 'cancelled', { created_at: '2026-10-02T00:00:00Z' })] }],
    [/runs\/(\d+)\/jobs/, { jobs: [] }],
    [/runs\/3$/, run(3, 'cancelled')],
    [/runs\/4$/, run(4, 'success')],
  ]);
  const f = await detectLitRun(gh, REPO, 'main', '2026-10-01T00:00:00Z', 'none', '');
  assert.equal(f.id, 3);
  assert.equal(f.state, 'dark');
});

test('detectLitRun orders by run_started_at (re-runs), not created_at', async () => {
  const gh = fakeGh([
    [/actions\/runs\?/, { workflow_runs: [
      run(5, 'success', { created_at: '2026-10-02T00:00:00Z', run_started_at: '2026-10-09T00:00:00Z' }),
      run(6, 'failure', { created_at: '2026-10-03T00:00:00Z', run_started_at: '2026-10-03T00:00:00Z' }),
    ] }],
    [/runs\/(\d+)\/jobs/, { jobs: [] }],
    [/runs\/5$/, run(5, 'success', { run_started_at: '2026-10-09T00:00:00Z' })],
    [/runs\/6$/, run(6, 'failure')],
  ]);
  const f = await detectLitRun(gh, REPO, 'main', '2026-10-01T00:00:00Z', 'none', '');
  assert.equal(f.id, 6);
  const lit = await runFacts(gh, REPO, 5, '');
  assert.equal(lit.createdAt, '2026-10-09T00:00:00Z');
});

test('detectDarkRun still cites a real failure, not a cancelled run', async () => {
  const gh = fakeGh([
    [/actions\/runs\?/, { workflow_runs: [run(8, 'cancelled'), run(7, 'failure')] }],
    [/runs\/(\d+)\/jobs/, { jobs: [] }],
    [/runs\/7$/, run(7, 'failure')],
    [/runs\/8$/, run(8, 'cancelled')],
  ]);
  assert.equal((await detectDarkRun(gh, REPO, 'main', '2026-10-05T00:00:00Z', '')).id, 7);
});

test('an unmerged PR is refused with an error, not exit', async () => {
  const gh = fakeGh([[/pulls\/9$/, { merged: false, state: 'open' }]]);
  await assert.rejects(buildEntry(gh, REPO, 9, {}), AddMergedError);
});
