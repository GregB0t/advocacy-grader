// Ships the calibration evidence corpus WITH the deploy.
//
// out/ is gitignored, so a git-based deploy (Render) arrives with an empty
// cache and every first lookup is a cold 10-77s live run. seed/calib.tgz is
// the corpus (gzipped, ~3MB) and is extracted into out/calib at boot.
//
// The extractor is pure Node built-ins on purpose: this project has zero npm
// dependencies, and shelling out to `tar` would make boot depend on a binary
// the host image happens to provide. ustar is a simple format — 512-byte
// header blocks, 512-byte-aligned payloads — so reading it costs ~40 lines.
import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const BLOCK = 512;

// Yields { name, data } for every regular file in an uncompressed tar buffer.
export function* readTar(buf) {
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    // Two consecutive zero blocks terminate the archive.
    if (header.every((b) => b === 0)) return;
    const str = (start, len) => {
      const raw = header.subarray(start, start + len);
      const end = raw.indexOf(0);
      return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
    };
    const name = str(0, 100);
    const prefix = str(345, 155); // ustar long-name prefix
    const sizeField = str(124, 12).trim();
    const size = parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(header[156]) || '0';
    off += BLOCK;
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / BLOCK) * BLOCK;
    // '0' and '\0' are regular files; skip dirs ('5'), longlink metadata ('L','K'), etc.
    if (type === '0' || header[156] === 0) {
      yield { name: prefix ? prefix + '/' + name : name, data };
    }
  }
}

// Extracts seed/calib.tgz into destRoot. Never overwrites a file that already
// exists, so a locally-refreshed evidence file always wins over the shipped
// seed, and a partial extraction can simply be re-run.
export function ensureSeed({ tgz = 'seed/calib.tgz', destRoot = 'out', quiet = false } = {}) {
  if (!existsSync(tgz)) return { ok: false, reason: 'no seed archive', written: 0, skipped: 0 };
  let entries;
  try {
    entries = [...readTar(gunzipSync(readFileSync(tgz)))];
  } catch (err) {
    return { ok: false, reason: `unreadable seed archive: ${err.message}`, written: 0, skipped: 0 };
  }
  let written = 0, skipped = 0;
  for (const { name, data } of entries) {
    // Refuse anything that escapes destRoot. The archive is ours, but a path
    // check costs nothing and a tar-slip bug is not worth the risk.
    if (!name || name.includes('..') || name.startsWith('/')) continue;
    if (!name.endsWith('.json')) continue;
    const dest = join(destRoot, name);
    if (existsSync(dest)) { skipped++; continue; }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
    written++;
  }
  const dir = join(destRoot, 'calib');
  const total = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).length : 0;
  if (!quiet && written) console.log(`seed: extracted ${written} evidence files (${skipped} already present) -> ${dir}/ (${total} total)`);
  return { ok: true, written, skipped, total };
}
