#!/usr/bin/env node
// mirror-bot: local gatekeeper for npm downloads on this machine.
//   node mirror-bot/mirror-bot.mjs sign <request.json>   (requesting bot side: add nonce/createdAt/sig)
//   node mirror-bot/mirror-bot.mjs run                   (mirror bot: review queue, okay or refuse, then download)
// Env: MIRROR_BOT_SECRET (required, never printed), MIRROR_BOT_HOME, MIRROR_BOT_DOWNLOADS,
//      MIRROR_BOT_ALLOWLIST, MIRROR_BOT_REGISTRY, PATCH_CLOUD_STATUS, GITHUB_TOKEN (optional).
// Exit code is active-low: 0 = lit (every request okayed and downloaded), 1 = dark (anything else).
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { review, download, sign, verifySig, LIT, DARK, lightWord } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = {
  home: process.env.MIRROR_BOT_HOME || '/workspace/mirror-bot-state',
  downloadDir: process.env.MIRROR_BOT_DOWNLOADS || '/workspace/mirror-bot-downloads',
  allowlistFile: process.env.MIRROR_BOT_ALLOWLIST || path.join(here, 'allowlist.json'),
  registry: process.env.MIRROR_BOT_REGISTRY || 'https://registry.npmjs.org',
  statusUrl: process.env.PATCH_CLOUD_STATUS || 'https://patch-cloud-production.up.railway.app/status',
};
const secret = process.env.MIRROR_BOT_SECRET;

async function readJson(f, dflt) {
  try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return dflt; }
}
async function writeJson(f, v) {
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, JSON.stringify(v, null, 2) + '\n');
}

async function cmdSign(file) {
  if (!secret) { console.error('MIRROR_BOT_SECRET not set'); return DARK; }
  const r = await readJson(file, null);
  if (!r) { console.error(`cannot read ${file}`); return DARK; }
  r.id ??= `req-${Date.now()}-${randomBytes(3).toString('hex')}`;
  r.nonce ??= randomBytes(12).toString('hex');
  r.createdAt ??= new Date().toISOString();
  delete r.sig;
  r.sig = sign(r, secret);
  await writeJson(file, r);
  console.log(`signed ${file} (${r.package}@${r.version} from ${r.requester})`);
  return LIT;
}

async function cmdRun() {
  if (!secret) { console.error('MIRROR_BOT_SECRET not set; dark by default'); return DARK; }
  const dirs = {
    queue: path.join(cfg.home, 'queue'),
    done: path.join(cfg.home, 'done'),
    okays: path.join(cfg.home, 'okays'),
  };
  for (const d of Object.values(dirs)) await fs.mkdir(d, { recursive: true });
  const allow = await readJson(cfg.allowlistFile, { requesters: [] });
  const seenFile = path.join(cfg.home, 'seen-nonces.json');
  const usedFile = path.join(cfg.home, 'used-okays.json');
  const logFile = path.join(cfg.home, 'log.jsonl');
  const seenNonces = new Set(await readJson(seenFile, []));
  const usedOkays = new Set(await readJson(usedFile, []));
  const ctx = { ...cfg, secret, allowlist: new Set(allow.requesters), seenNonces, usedOkays, token: process.env.GITHUB_TOKEN };

  const files = (await fs.readdir(dirs.queue)).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) console.log('queue empty');
  let all = LIT;
  for (const f of files) {
    const src = path.join(dirs.queue, f);
    const req = await readJson(src, null);
    const r = await review(req, ctx);
    if (req?.nonce && verifySig(req, secret)) seenNonces.add(req.nonce); // burn any signed nonce, okay or refuse
    const entry = { at: new Date().toISOString(), file: f, ...r, okay: undefined, okayId: r.okay?.okayId };
    let dl = null;
    if (r.decision === 'okay') {
      // Okay record goes to disk first; the downloader reads it back and re-checks the signature.
      const okFile = path.join(dirs.okays, `${r.okay.okayId}.json`);
      await writeJson(okFile, r.okay);
      const okay = await readJson(okFile, null);
      try {
        dl = await download(okay, ctx);
      } catch (e) {
        dl = { ok: false, reason: `download error: ${String(e.message).split('\n')[0]}` };
      }
      entry.download = dl;
    }
    const bit = r.decision === 'okay' && dl?.ok ? LIT : DARK;
    entry.result = lightWord(bit);
    entry.resultBit = bit;
    if (bit !== LIT) all = DARK;
    await fs.appendFile(logFile, JSON.stringify(entry) + '\n');
    await fs.rename(src, path.join(dirs.done, f));
    const what = `${r.package}@${r.version} from ${r.requester}`;
    console.log(`[${lightWord(r.bit)} ${r.bit}] ${r.decision.toUpperCase()} ${what}: ${r.reason}`);
    if (dl) console.log(`    download ${dl.ok ? `lit 0: ${dl.file} (${dl.integrity.slice(0, 27)}...)` : `dark 1: ${dl.reason}`}`);
  }
  await writeJson(seenFile, [...seenNonces]);
  await writeJson(usedFile, [...usedOkays]);
  console.log(`overall: ${lightWord(all)} (${all})`);
  return all;
}

const [cmd, arg] = process.argv.slice(2);
const code = cmd === 'sign' ? await cmdSign(arg) : cmd === 'run' ? await cmdRun() : (console.error('usage: mirror-bot.mjs sign <request.json> | run'), DARK);
process.exitCode = code;
