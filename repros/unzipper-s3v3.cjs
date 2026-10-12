// Focused repro for unzipper#330 / PR #331: Open.s3_v3 must work after a plain
// production install (no devDependencies). Run from a project dir that has unzipper installed.
const path = require('path');
const Stream = require('stream');
const ZIP = Buffer.from('UEsDBBQAAAAIAEWsS11wbpx+EwAAABEAAAAJAAAAaGVsbG8udHh0y0jNyclXSCvKz1UoNo4vM+YCAFBLAQIUAxQAAAAIAEWsS11wbpx+EwAAABEAAAAJAAAAAAAAAAAAAACAAQAAAABoZWxsby50eHRQSwUGAAAAAAEAAQA3AAAAOgAAAAAA', 'base64');
let unzipper, pkg;
try {
  unzipper = require(require.resolve('unzipper', { paths: [process.cwd()] }));
  pkg = require(require.resolve('unzipper/package.json', { paths: [process.cwd()] }));
} catch (e) { console.error('unzipper not installed here:', e.message); process.exit(2); }
console.log('unzipper', pkg.version, pkg._patchCloud ? '(patch-cloud build: ' + pkg._patchCloud.fork + ')' : '(upstream)');
const client = {
  send: async (cmd) => {
    const n = cmd.constructor.name;
    if (n === 'HeadObjectCommand') return { ContentLength: ZIP.length };
    if (n === 'GetObjectCommand') {
      const m = cmd.input.Range.match(/^bytes=(\d+)-(\d*)$/);
      const s = new Stream.PassThrough();
      s.end(ZIP.slice(Number(m[1]), m[2] ? Number(m[2]) + 1 : undefined));
      return { Body: s };
    }
    throw new Error('unexpected command ' + n);
  },
};
(async () => {
  try {
    const dir = await unzipper.Open.s3_v3(client, { Bucket: 'b', Key: 'k.zip' });
    const text = (await dir.files[0].buffer()).toString();
    const ok = dir.files[0].path === 'hello.txt' && text === 'hello from s3_v3\n';
    console.log(ok ? 'PASS' : 'FAIL', 'Open.s3_v3 read', JSON.stringify(dir.files[0].path), JSON.stringify(text));
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.log('FAIL Open.s3_v3 threw:', e.code || '', e.message.split('\n')[0]);
    process.exit(1);
  }
})();
