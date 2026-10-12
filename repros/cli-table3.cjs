// Focused repro for cli-table3 PR #359: rowSpan past the last row must not crash.
const Table = require(require.resolve('cli-table3', { paths: [process.cwd()] }));
const pkg = require(require.resolve('cli-table3/package.json', { paths: [process.cwd()] }));
console.log('cli-table3', pkg.version, pkg._patchCloud ? '(patch-cloud build: ' + pkg._patchCloud.fork + ')' : '(upstream)');
try {
  const t = new Table();
  t.push([{ content: 'aaaa bbbb', rowSpan: 2 }]);
  const out = t.toString();
  const t2 = new Table({ head: ['a', 'b'] });
  t2.push([{ content: 'x', rowSpan: 3 }, 'y'], ['z']);
  const out2 = t2.toString();
  const ok = out.includes('aaaa bbbb') && out2.includes('x') && out2.includes('z');
  console.log(out);
  console.log(ok ? 'PASS' : 'FAIL', 'rowSpan past last row renders');
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.log('FAIL toString() threw:', e.message);
  process.exit(1);
}
