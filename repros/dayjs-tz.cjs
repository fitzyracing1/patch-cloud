// Focused repro for dayjs timezone perf (iamkun/dayjs#2019).
// usage: node dayjs-tz.cjs <path-to-installed-dayjs-package> [--compare <other-dayjs-path>]
const path = require('path');
function load(dir) {
  const r = (m) => require(path.join(path.resolve(dir), m));
  const dayjs = r('dayjs.min.js');
  dayjs.extend(r('plugin/utc.js'));
  dayjs.extend(r('plugin/timezone.js'));
  return dayjs;
}
function bench(dayjs, n) {
  const zones = ['America/New_York', 'Europe/London', 'Asia/Tokyo', 'Australia/Sydney'];
  const base = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 200; i++) dayjs(base + i * 3600e3).tz(zones[i % 4]); // warm-up
  const t0 = process.hrtime.bigint();
  let acc = 0;
  for (let i = 0; i < n; i++) acc += dayjs(base + i * 3600e3).tz(zones[i % 4]).hour();
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, acc };
}
function sample(dayjs) {
  const out = [];
  for (const z of ['America/New_York', 'Europe/London', 'Asia/Kolkata', 'Pacific/Chatham', 'UTC'])
    for (const t of [Date.UTC(2026, 2, 8, 6, 30), Date.UTC(2026, 10, 1, 5, 59, 59, 123), Date.UTC(2026, 9, 11, 1)])
      out.push(dayjs(t).tz(z).format('YYYY-MM-DDTHH:mm:ss.SSSZ'));
  return out;
}
const [dir, flag, other] = process.argv.slice(2);
const N = 20000;
const a = load(dir);
const ra = bench(a, N);
console.log(`dayjs ${require(path.join(path.resolve(dir), 'package.json')).version} (${dir}): ${N} x .tz() in ${ra.ms.toFixed(0)} ms (${((ra.ms * 1000) / N).toFixed(1)} µs/call)`);
const pkg = require(path.join(path.resolve(dir), 'package.json'));
let ok = true;
if (flag === '--compare' && other) {
  const b = load(other);
  const rb = bench(b, N);
  console.log(`compare (${other}): ${N} x .tz() in ${rb.ms.toFixed(0)} ms (${((rb.ms * 1000) / N).toFixed(1)} µs/call)  speedup x${(rb.ms / ra.ms).toFixed(1)}`);
  const same = JSON.stringify(sample(a)) === JSON.stringify(sample(b)) && ra.acc === rb.acc;
  console.log(`identical results vs compare: ${same}`);
  ok = ok && same && rb.ms / ra.ms > 2;
}
if (pkg._patchCloud) console.log('patch-cloud build:', pkg._patchCloud.fork, pkg._patchCloud.branch);
process.exit(ok ? 0 : 1);
