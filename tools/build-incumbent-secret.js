#!/usr/bin/env node
// Build a paste-ready incumbent index for a Render SECRET FILE.
//
//   node tools/build-incumbent-secret.js            # slim  (~200KB, recommended)
//   node tools/build-incumbent-secret.js --full     # full  (~509KB)
//
// WHY THIS EXISTS. data/ is gitignored by decision -- the index is derived from
// vendor scraping and NOTHING from it is republished (see the data-ethics line
// in the audit findings). So it cannot ride along in the repo, and Render has no
// persistent disk. A secret file is the one private channel left.
//
// Two constraints shape the output, both checked rather than assumed:
//   1. Render caps the COMBINED size of a service's secret files at 1MB.
//   2. Render's secret-file UI is a paste-in "Contents" field for plaintext.
//      Raw gzip bytes do not survive a textarea. Hence gzip THEN base64.
//
// WHAT --slim DROPS, AND WHY THAT IS SAFE: the `rows` array (2,107 entries,
// ~2.6MB of the ~4.2MB). lib/incumbent.js reads `rows` only in customersOf(),
// which is called ONLY by tools/incumbent-query.js -- a local prospecting tool.
// The server's path is lookupIncumbent() -> idx.domains, which slim keeps whole.
// Verified by grep before this tool was written, not assumed.
//
// THE OUTPUT IS PRIVATE. It is written to data/, which is gitignored. Do not
// commit it, do not attach it to anything public, and do not paste it anywhere
// but the Render secret-file field.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { defaultIndexPath, loadIndex } from '../lib/incumbent.js';

const full = process.argv.includes('--full');
const src = defaultIndexPath();
const idx = loadIndex(src);

if (idx.missing) {
  console.error(`No index at ${src} (${idx.load_error || 'unreadable'}).`);
  console.error('Nothing was written. This tool will not invent an index.');
  process.exit(1);
}

const payload = full ? idx : {
  schema: idx.schema,
  built_at: idx.built_at,
  resolved_at: idx.resolved_at,
  method: idx.method,
  limitations: idx.limitations,
  vendors: idx.vendors,
  counts: idx.counts,
  domains: idx.domains,
};

const json = JSON.stringify(payload);
const gz = gzipSync(Buffer.from(json), { level: 9 });
const b64 = gz.toString('base64');

const name = full ? 'incumbent-index.json.gz.b64' : 'incumbent-index.slim.json.gz.b64';
const out = path.join(path.dirname(src), name);
writeFileSync(out, b64);

const KB = (n) => (n / 1024).toFixed(0) + 'KB';
const CAP = 1024 * 1024;
console.log(`source        ${src}`);
console.log(`built_at      ${idx.built_at}`);
console.log(`domains       ${Object.keys(payload.domains || {}).length}`);
console.log(`rows          ${full ? (idx.rows || []).length + ' (kept)' : 'DROPPED — customersOf() is a local tool, the server never reads rows'}`);
console.log(`json          ${KB(json.length)}`);
console.log(`gzipped       ${KB(gz.length)}`);
console.log(`base64        ${KB(b64.length)}`);
console.log(`under 1MB     ${b64.length < CAP ? 'yes' : 'NO — this will not fit in a Render secret file'}`);
console.log(`wrote         ${out}`);
console.log('');
console.log('Next, on Render (srv-daag7f1f2nfc73a7vo10 -> Environment -> Secret Files):');
console.log(`  Filename  ${name}`);
console.log('  Contents  paste this file verbatim');
console.log(`Then set  INCUMBENT_INDEX=/etc/secrets/${name}`);
console.log('');
console.log('Verify from the deploy log after the redeploy: a captured lead should record');
console.log("incumbent_status 'no_evidence_in_index' (a real search that missed) rather than");
console.log("'no_index_loaded' (no search at all). Those are different answers on purpose.");

if (b64.length >= CAP) process.exit(1);
