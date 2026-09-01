// Exercises the TEASER gate form in a real browser, with both Cloudflare and the
// API mocked. Companion to tools/test-lookup-ui.mjs, and it exists for the same
// reason: the lookup page shipped a bug that reading the code did not find, and
// driving the page found it in one run. This form now has a second moving part —
// a third-party widget that injects a hidden input — so it gets the same
// treatment.
//
// The Cloudflare mock reproduces exactly the contract the page depends on:
// api.js injects <input name="cf-turnstile-response"> into the enclosing form and
// exposes window.turnstile.reset(). Nothing here reaches Cloudflare, and no key
// of any kind is used.
//
// It asserts the properties the gate must never lose:
//   1. the submit button always ends up enabled — no dead end, ever
//   2. no request is sent that the page already knows will be refused
//   3. a spent challenge is always reset before the visitor can try again
//   4. every message says something true about what was observed
//
// Usage:  npm i --no-save playwright
//         node server.js &
//         node tools/test-teaser-ui.mjs [gated-url] [ungated-url]
// Env:    PW_CHROMIUM=/path/to/chrome
const gatedUrl = process.argv[2] || `http://127.0.0.1:${process.env.PORT || 8787}/teaser/everyonesocial.com`;
const plainUrl = process.argv[3] || '';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  console.error('test-teaser-ui needs Playwright, which is not a dependency of this repo.');
  console.error('Run:  npm i --no-save playwright  (then set PW_CHROMIUM, or npx playwright install chromium)');
  process.exit(1);
}

// The widget as the page actually experiences it: a script that appends the
// hidden input the submit handler reads, plus a reset() the handler calls.
const CF_SCRIPT = (injectToken) => ({
  status: 200, contentType: 'application/javascript',
  body: `window.__resets = 0;
    window.turnstile = { reset: function () { window.__resets++; var i = document.querySelector('[name="cf-turnstile-response"]'); if (i) i.value = ''; } };
    (function () {
      var host = document.querySelector('.cf-turnstile');
      if (!host) return;
      var i = document.createElement('input');
      i.type = 'hidden'; i.name = 'cf-turnstile-response';
      i.value = ${injectToken ? "'XXXX.DUMMY.TOKEN.XXXX'" : "''"};
      host.appendChild(i);
    })();`,
});

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const results = [];

async function scenario(name, { url = gatedUrl, cfToken = true, wire = () => {} }, expect) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const seen = { leads: 0, body: null, navigated: null };
  page.on('framenavigated', (f) => { if (f === page.mainFrame() && !f.url().startsWith(url)) seen.navigated = f.url(); });
  await page.route('**/turnstile/v0/api.js*', (r) => r.fulfill(CF_SCRIPT(cfToken)));
  await page.route('**/report/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: 'report' }));
  await wire(page, seen);
  await page.goto(url, { waitUntil: 'load' });
  await page.fill('#first', 'Ada');
  await page.fill('#last', 'Lovelace');
  await page.fill('#email', 'ada@example.com');
  await page.click('#gogate');
  await page.waitForTimeout(1200);
  let dom = {};
  try {
    dom = await page.evaluate(() => ({
      disabled: document.getElementById('gogate').disabled,
      note: document.getElementById('gatenote').textContent,
      resets: window.__resets,
    }));
  } catch { dom = { navigatedAway: true }; }
  const obs = { ...seen, ...dom };
  results.push({ name, obs, pass: expect(obs) });
  await page.close();
}

const okLead = { status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) };

// The visitor presses the button before the widget has resolved. The page must
// NOT send a request it already knows the server will refuse, and must say what
// is actually true.
await scenario('challenge unresolved: nothing is sent, and the message is true', {
  cfToken: false,
  wire: async (p, s) => { await p.route('**/api/lead', (r) => { s.leads++; r.fulfill(okLead); }); },
}, (o) => o.leads === 0 && o.disabled === false && /has not finished/.test(o.note || ''));

// The happy path: the token the widget produced actually reaches the server.
await scenario('token resolved: it is sent with the lead, and the report opens', {
  wire: async (p, s) => {
    await p.route('**/api/lead', (r) => { s.leads++; s.body = r.request().postDataJSON(); r.fulfill(okLead); });
  },
}, (o) => o.leads === 1 && o.body?.turnstile_token === 'XXXX.DUMMY.TOKEN.XXXX'
      && o.body?.email === 'ada@example.com' && /\/report\/everyonesocial\.com$/.test(o.navigated || ''));

// The server refuses the challenge. The visitor must get the server's own reason,
// a working button, and a FRESH challenge — a spent token cannot be resubmitted.
await scenario('server rejects: reason shown, button back, challenge reset', {
  wire: async (p, s) => {
    await p.route('**/api/lead', (r) => { s.leads++; r.fulfill({ status: 403, contentType: 'application/json',
      body: JSON.stringify({ error: 'Cloudflare did not accept the anti-bot check.', turnstile: 'rejected' }) }); });
  },
}, (o) => o.leads === 1 && o.disabled === false && o.resets === 1 && /did not accept/.test(o.note || ''));

// The request dies outright. Same three invariants, and no claim about a cause
// the client cannot observe.
await scenario('lead request dies: no dead end, no invented cause', {
  wire: async (p, s) => { await p.route('**/api/lead', (r) => { s.leads++; r.abort('connectionrefused'); }); },
}, (o) => o.leads >= 1 && o.disabled === false && o.resets === 1
      && /went wrong saving/.test(o.note || '') && !/server/i.test(o.note || ''));

// A non-JSON error page from an edge or proxy. r.json() throws inside .then, and
// that throw lands in the fetch's .catch — the exact shape of the 2026-08-31 bug.
// The page must still recover.
await scenario('non-JSON error page: the .catch still leaves a way forward', {
  wire: async (p, s) => {
    await p.route('**/api/lead', (r) => { s.leads++; r.fulfill({ status: 502, contentType: 'text/html', body: '<html>502</html>' }); });
  },
}, (o) => o.disabled === false && o.resets === 1);

// With no site key configured the page is ungated: no widget, no third-party
// script, and the form must still work exactly as it did before phase G.
if (plainUrl) {
  await scenario('ungated page still submits and still opens the report', {
    url: plainUrl,
    wire: async (p, s) => {
      await p.route('**/api/lead', (r) => { s.leads++; s.body = r.request().postDataJSON(); r.fulfill(okLead); });
    },
  }, (o) => o.leads === 1 && o.body?.turnstile_token === '' && /\/report\/everyonesocial\.com$/.test(o.navigated || ''));
}

await browser.close();

for (const r of results) {
  console.log(`${r.pass ? 'ok  ' : 'NOT OK'} - ${r.name}`);
  console.log(`         ${JSON.stringify(r.obs)}`);
}
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
