// Exercises the live-lookup page's FAILURE paths in a real browser.
//
// WHY THIS EXISTS: on 2026-08-31 the lookup page shipped a bug that made EVERY
// lookup end in "Something went wrong on the server side" — #rundomain was a child
// of #runsub, and the submit handler rewrote #runsub with textContent one line
// later, deleting it. The next $('rundomain') threw, and the throw landed in the
// fetch's .catch, so a DOM bug wore the costume of a network failure. Reading the
// code did not find it; driving the page did, in one run.
//
// Every scenario here mocks the API, so no site is ever fetched and no run is
// started. It asserts the two properties the page must never lose:
//   1. the submit button always ends up enabled — no dead end
//   2. every failure says something true about what was observed
//
// Usage:  npm i --no-save playwright   (once)
//         node server.js &             (or point at the live site)
//         node tools/test-lookup-ui.mjs [url]
// Env:    PW_CHROMIUM=/path/to/chrome   to use an already-installed Chromium.
const url = process.argv[2] || `http://127.0.0.1:${process.env.PORT || 8787}/es-demo`;

let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  console.error('test-lookup-ui needs Playwright, which is not a dependency of this repo.');
  console.error('Run:  npm i --no-save playwright  (then `npx playwright install chromium`, or set PW_CHROMIUM)');
  process.exit(1);
}

const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const RUNNING = json({ state: 'running', domain: 'example.com', fast: { findings: [] } });
const READY = json({ state: 'ready', domain: 'example.com', cached: true, fast: { findings: [] } });

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const results = [];

async function scenario(name, wire, waitMs, expect) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const seen = { lookups: 0, jobs: 0, navigated: null };
  page.on('framenavigated', (f) => { if (f === page.mainFrame() && !f.url().startsWith(url)) seen.navigated = f.url(); });
  await wire(page, seen);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.fill('#domain', 'example.com');
  await page.click('#go');
  await page.waitForTimeout(waitMs);
  let dom = {};
  try {
    dom = await page.evaluate(() => ({
      disabled: document.getElementById('go').disabled,
      status: document.getElementById('status').textContent,
      runningHidden: document.getElementById('running').classList.contains('hide'),
    }));
  } catch { dom = { navigatedAway: true }; }
  const obs = { ...seen, ...dom };
  results.push({ name, obs, pass: expect(obs) });
  await page.close();
}

// The submit lands while the instance is being replaced: the connection just dies.
await scenario('lookup connection dropped', async (p, s) => {
  await p.route('**/api/lookup', (r) => { s.lookups++; r.abort('connectionrefused'); });
}, 6000, (o) => o.lookups === 2 && !o.disabled && /No answer came back/.test(o.status) && o.runningHidden);

// The same, but the automatic retry lands on the healthy instance. Must recover silently.
await scenario('dropped once, retry succeeds', async (p, s) => {
  await p.route('**/api/lookup', (r) => { s.lookups++; s.lookups === 1 ? r.abort('connectionrefused') : r.fulfill(RUNNING); });
  await p.route('**/api/job*', (r) => { s.jobs++; r.fulfill(json({ state: 'running', elapsed_s: 3 })); });
}, 6000, (o) => o.lookups === 2 && !o.disabled && !o.runningHidden);

// A proxy error page where JSON was expected — r.json() throws.
await scenario('non-JSON error page', async (p, s) => {
  await p.route('**/api/lookup', (r) => { s.lookups++; r.fulfill({ status: 502, contentType: 'text/html', body: '<html>502</html>' }); });
}, 6000, (o) => o.lookups === 2 && !o.disabled && /No answer came back/.test(o.status));

// The server restarted mid-run, so its in-memory job map is empty and /api/job says
// 'none' forever. This used to poll silently until the tab was closed.
await scenario('server forgot the job', async (p, s) => {
  await p.route('**/api/lookup', (r) => { s.lookups++; r.fulfill(RUNNING); });
  await p.route('**/api/job*', (r) => { s.jobs++; r.fulfill(json({ state: 'none' })); });
}, 9000, (o) => !o.disabled && /Lost contact/.test(o.status) && o.runningHidden);

// Polling connections die outright. Used to be swallowed by an empty .catch.
await scenario('polling connection dies', async (p, s) => {
  await p.route('**/api/lookup', (r) => { s.lookups++; r.fulfill(RUNNING); });
  await p.route('**/api/job*', (r) => { s.jobs++; r.abort('connectionrefused'); });
}, 19000, (o) => !o.disabled && /Lost contact/.test(o.status) && o.runningHidden);

// And the happy path still leaves for the teaser.
await scenario('ready -> teaser', async (p, s) => {
  await p.route('**/api/lookup', (r) => { s.lookups++; r.fulfill(READY); });
  await p.route('**/teaser/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: 'teaser' }));
}, 3000, (o) => /\/teaser\/example\.com$/.test(o.navigated || ''));

await browser.close();

for (const r of results) {
  console.log(`${r.pass ? 'ok  ' : 'NOT OK'} - ${r.name}`);
  console.log(`         ${JSON.stringify(r.obs)}`);
}
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
