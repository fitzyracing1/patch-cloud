// Focused repro for ms round-trip (vercel/ms#284, PR #299) and parse() ReDoS timing (#291).
const ms = require(require.resolve('ms', { paths: [process.cwd()] }));
const pkg = require(require.resolve('ms/package.json', { paths: [process.cwd()] }));
console.log('ms', pkg.version, pkg._patchCloud ? '(patch-cloud build: ' + pkg._patchCloud.fork + ')' : '(upstream)');
let ok = true;
for (const v of [1e30, -1e30, 1e-7, 2.5e-9]) {
  const out = ms(v), back = ms(out);
  const pass = !/e/.test(out) && back === v;
  ok = ok && pass;
  console.log(pass ? 'PASS' : 'FAIL', `ms(${v}) = ${JSON.stringify(out)} -> ms(...) = ${back}`);
}
const same = ms(500) === '500ms' && ms(60000) === '1m' && ms(234234234) === '3d' && ms(-3 * 60000, { long: true }) === '-3 minutes' && ms('1.5h') === 5400000;
ok = ok && same;
console.log(same ? 'PASS' : 'FAIL', 'ordinary output unchanged');
for (const [label, input] of [['"9"x1000+"z"', '9'.repeat(1000) + 'z'], ['"9"x99+"z" (max under 100-char cap)', '9'.repeat(99) + 'z'], ['"1."+"1"x97+"z"', '1.' + '1'.repeat(97) + 'z']]) {
  const N = 2000;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) ms(input);
  const per = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  const pass = per < 0.5;
  ok = ok && pass;
  console.log(pass ? 'PASS' : 'FAIL', `parse ${label}: ${(per * 1000).toFixed(1)} µs/call`);
}
process.exit(ok ? 0 : 1);
