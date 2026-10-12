// Focused repro for jimp#1402: bundlers resolving the "browser" condition must get real exports.
// usage (from a project dir with jimp + esbuild installed): node jimp-browser.mjs
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(join(process.cwd(), 'x.js'));
const esbuild = require('esbuild');
const pkg = JSON.parse(readFileSync(require.resolve('jimp/package.json'), 'utf8'));
console.log('jimp', pkg.version, pkg._patchCloud ? `(patch-cloud build: ${pkg._patchCloud.fork})` : '(upstream)');
const dir = mkdtempSync(join(tmpdir(), 'jimp-browser-'));
const entry = join(dir, 'entry.mjs');
writeFileSync(entry, `import { Jimp, ResizeStrategy } from "jimp";
export const types = { Jimp: typeof Jimp, ResizeStrategy: typeof ResizeStrategy };
export async function run() {
  const img = new Jimp({ width: 4, height: 4, color: 0xff0000ff });
  img.resize({ w: 2, h: 2, mode: ResizeStrategy.BILINEAR });
  const png = await img.getBuffer("image/png");
  return { w: img.bitmap.width, pngBytes: png.length, sig: Array.from(png.slice(1, 4)).map(c => String.fromCharCode(c)).join("") };
}`);
const out = join(dir, 'bundle.mjs');
let r;
try {
  r = await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'esm', outfile: out, absWorkingDir: process.cwd(), nodePaths: [join(process.cwd(), 'node_modules')], logLevel: 'silent' });
} catch (e) {
  console.log('FAIL esbuild (platform=browser):', (e.errors || []).map((x) => x.text).join('; ') || e.message);
  process.exit(1);
}
console.log(`esbuild (platform=browser) bundle: ${readFileSync(out).length} bytes`);
const m = await import(out);
let ok = m.types.Jimp === 'function' && m.types.ResizeStrategy === 'object';
console.log(ok ? 'PASS' : 'FAIL', 'browser-condition exports:', JSON.stringify(m.types));
if (ok) {
  try {
    const res = await m.run();
    const pass = res.w === 2 && res.sig === 'PNG' && res.pngBytes > 50;
    ok = ok && pass;
    console.log(pass ? 'PASS' : 'FAIL', 'browser bundle creates/resizes/encodes an image:', JSON.stringify(res));
  } catch (e) { ok = false; console.log('FAIL run threw:', e.message); }
}
process.exit(ok ? 0 : 1);
