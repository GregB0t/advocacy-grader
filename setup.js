#!/usr/bin/env node
// Interactive setup for local secrets. Writes .env (gitignored, chmod 600) and
// verifies the key against ScrapingBee before saving it.
//
//   node setup.js                 prompt for the key, hidden input
//   node setup.js --show          prompt but echo what you type
//   node setup.js --check         verify the key already in .env, change nothing
//   cat key.txt | node setup.js   read from a pipe
//
// The key is never printed back in full and never leaves this machine except in
// the verification request to ScrapingBee.

import { readFileSync, writeFileSync, existsSync, chmodSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const ENV_PATH = new URL('./.env', import.meta.url).pathname;
const KEY_NAME = 'SCRAPINGBEE_API_KEY';
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);

const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m` };
const mask = (k) => (k.length <= 10 ? '*'.repeat(k.length) : `${k.slice(0, 4)}${'*'.repeat(k.length - 8)}${k.slice(-4)}`);

function readEnv() {
  if (!existsSync(ENV_PATH)) return {};
  const out = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function writeEnv(updates) {
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split(/\r?\n/) : [];
  const seen = new Set();
  const lines = existing.map((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (m && Object.hasOwn(updates, m[1])) { seen.add(m[1]); return `${m[1]}=${updates[m[1]]}`; }
    return line;
  });
  for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) lines.push(`${k}=${v}`);
  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
  writeFileSync(ENV_PATH, body, { mode: 0o600 });
  chmodSync(ENV_PATH, 0o600);
}

function assertGitignored() {
  try {
    execSync('git check-ignore -q .env', { cwd: new URL('./', import.meta.url).pathname, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function promptHidden(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      let data = '';
      process.stdin.on('data', (d) => (data += d));
      process.stdin.on('end', () => resolve(data.trim()));
      return;
    }
    if (flag('--show')) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      return rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
    }
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '') {
        process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener('data', onData);
        process.stdout.write('\n'); return resolve(buf.trim());
      }
      if (ch === '') { process.stdout.write('\n'); process.exit(130); }
      if (ch === '' || ch === '\b') { if (buf.length) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); } return; }
      if (ch < ' ') return;
      buf += ch; process.stdout.write('*');
    };
    process.stdin.on('data', onData);
  });
}

// No documented usage endpoint, so try it and fall back to a real 1-credit probe.
async function verify(key) {
  try {
    const u = await fetch(`https://app.scrapingbee.com/api/v1/usage?api_key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(20000) });
    if (u.ok) {
      const j = await u.json().catch(() => null);
      if (j && typeof j === 'object') return { ok: true, method: 'usage endpoint', detail: j };
    }
    if (u.status === 401) return { ok: false, method: 'usage endpoint', detail: 'ScrapingBee rejected the key (401 Unauthorized).' };
  } catch { /* fall through to the probe */ }

  const probe = new URL('https://app.scrapingbee.com/api/v1/');
  probe.searchParams.set('api_key', key);
  probe.searchParams.set('url', 'https://example.com');
  probe.searchParams.set('render_js', 'false');       // 1 credit, not 5
  probe.searchParams.set('json_response', 'true');
  probe.searchParams.set('tag', 'advocacy-grader-setup');
  try {
    const r = await fetch(probe, { signal: AbortSignal.timeout(30000) });
    const text = await r.text();
    if (r.ok) return { ok: true, method: 'live probe (1 credit)', detail: { cost_header: r.headers.get('spb-cost') ?? r.headers.get('spb-auto-cost') ?? 'n/a' } };
    if (r.status === 401) return { ok: false, method: 'live probe', detail: 'ScrapingBee rejected the key (401 Unauthorized).' };
    return { ok: false, method: 'live probe', detail: `HTTP ${r.status}: ${text.slice(0, 200)}` };
  } catch (e) { return { ok: false, method: 'live probe', detail: `Could not reach ScrapingBee: ${e.message}` }; }
}

const env = readEnv();

if (flag('--check')) {
  const key = process.env[KEY_NAME] || env[KEY_NAME];
  if (!key) { console.log(c.y(`No ${KEY_NAME} found in .env. Run: node setup.js`)); process.exit(1); }
  console.log(`${c.b('Key')}      ${mask(key)}  ${c.dim('(from .env)')}`);
  const v = await verify(key);
  console.log(v.ok ? c.g(`Verified via ${v.method}`) : c.r(`Failed via ${v.method}`));
  console.log(c.dim(typeof v.detail === 'string' ? v.detail : JSON.stringify(v.detail)));
  process.exit(v.ok ? 0 : 1);
}

console.log(c.b('\nAdvocacy Grader — local secret setup\n'));

if (!assertGitignored()) {
  console.log(c.r('STOP: .env is not gitignored in this repo.'));
  console.log('Add a line reading  .env  to .gitignore before continuing. Refusing to write a secret to a tracked path.\n');
  process.exit(1);
}
console.log(c.g('✓') + ' .env is gitignored (verified with git check-ignore)');

if (env[KEY_NAME]) console.log(c.y('!') + ` ${KEY_NAME} is already set to ${mask(env[KEY_NAME])} — entering a new one replaces it`);

console.log(c.dim('\nGet your key at https://app.scrapingbee.com/account/manage — it is the "API Key" field.\n'));

const key = await promptHidden(`${KEY_NAME}: `);
if (!key) { console.log(c.r('\nNothing entered. No changes made.')); process.exit(1); }
if (key.length < 20) console.log(c.y(`\nThat key is only ${key.length} characters, which looks short. Verifying anyway.`));

console.log(c.dim('\nVerifying with ScrapingBee...'));
const v = await verify(key);
if (!v.ok) {
  console.log(c.r('\n✗ Verification failed: ') + (typeof v.detail === 'string' ? v.detail : JSON.stringify(v.detail)));
  console.log(c.dim('Nothing was written. Re-run when you have the right key.\n'));
  process.exit(1);
}
console.log(c.g('✓') + ` Verified via ${v.method}`);
if (v.detail && typeof v.detail === 'object') console.log(c.dim('  ' + JSON.stringify(v.detail)));

writeEnv({ [KEY_NAME]: key });
const mode = (statSync(ENV_PATH).mode & 0o777).toString(8);
console.log(c.g('✓') + ` Wrote ${KEY_NAME}=${mask(key)} to .env (mode ${mode})`);
console.log(c.dim('\nRe-check any time with:  node setup.js --check\n'));
