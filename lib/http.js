// Fetch layer. Every request is logged. Nothing is fetched that robots.txt
// disallows for our user-agent (spec §7 rules 1, 2 and 5), and nothing is
// connected to that resolves to a private/reserved address (SSRF guard —
// this is a public endpoint that fetches arbitrary user-supplied hosts).
//
// Implemented on node:http/https rather than global fetch() specifically so
// the SSRF `lookup` runs at socket-connect time on EVERY request and EVERY
// redirect hop — closing the resolve-then-connect TOCTOU that input
// validation alone cannot (a public host can rebind to, or 30x-redirect to, a
// private address). The return shape is unchanged from the previous fetch()
// implementation: { ok, status, url, finalUrl, redirected, contentType,
// bytes, ms, buffer, body, error }.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { gunzipSync, inflateSync, inflateRawSync, brotliDecompressSync } from 'node:zlib';
import { safeLookup, ipIsBlocked } from './ssrf.js';

export const VERSION = '0.1.0-phase1';
export const UA_TOKEN = 'AdvocacyReadinessGrader';
export const UA = `${UA_TOKEN}/${VERSION} (+https://greg-o-matic.com/grader; respects robots.txt)`;

const MAX_REDIRECTS = 10;

// ------------------------------------------------------- global request gate
// OPT-IN, off by default: the live server must never serialize its requests.
//
// It exists because concurrency in this project is a CORRECTNESS problem, not a
// speed knob — past roughly 18 simultaneous outbound requests, healthy hosts
// start timing out and get recorded as "no site", which is a fabricated finding.
// A batch runner's real in-flight count is (domains in parallel) x (page fetches
// per domain), which is easy to get wrong by an order of magnitude, so the cap
// is enforced here at the socket, where the true number is, rather than at any
// one caller's loop. ScrapingBee requests do not pass through here and are not
// counted; they go to the proxy's infrastructure, not the target's.
let _gateLimit = 0;            // 0 = unlimited
let _gateActive = 0;
const _gateQueue = [];

export function setGlobalConcurrency(n) {
  _gateLimit = Number(n) > 0 ? Math.floor(Number(n)) : 0;
  _drainGate();
  return _gateLimit;
}
export function globalConcurrencyState() {
  return { limit: _gateLimit, active: _gateActive, queued: _gateQueue.length };
}
function _drainGate() {
  while (_gateQueue.length && (!_gateLimit || _gateActive < _gateLimit)) {
    _gateActive++;
    _gateQueue.shift()();
  }
}
function _acquireGate() {
  if (!_gateLimit) return null;                       // unlimited: no bookkeeping
  if (_gateActive < _gateLimit) { _gateActive++; return _releaseGate; }
  return new Promise((resolve) => _gateQueue.push(() => resolve(_releaseGate)));
}
function _releaseGate() {
  _gateActive = Math.max(0, _gateActive - 1);
  _drainGate();
}

// One raw request (no redirect following), guarded by safeLookup at connect
// time. Resolves to { status, headers, location, buffer, finalUrl }.
function rawRequest(url, { timeoutMs, accept, maxBytes, deadline }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error(`invalid URL: ${url}`)); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return reject(Object.assign(new Error(`refusing non-http(s) URL: ${u.protocol}//`), { code: 'EPROTOBLOCKED' }));
    }
    // node skips the custom `lookup` for literal-IP hosts, so a literal
    // private/reserved IP (including a redirect straight to one) must be
    // validated here — safeLookup only guards hostname->address resolution.
    const litHost = u.hostname.replace(/^\[/, '').replace(/\]$/, '');
    if (net.isIP(litHost) && ipIsBlocked(litHost)) {
      return reject(Object.assign(new Error(`refusing to connect to ${litHost} — private or reserved address`), { code: 'ESSRFBLOCKED' }));
    }
    const mod = u.protocol === 'https:' ? https : http;
    const remaining = Math.max(1, Math.min(timeoutMs, deadline - Date.now()));
    const req = mod.request(u, {
      method: 'GET',
      lookup: safeLookup,                  // <- the SSRF boundary, per connection
      headers: { 'user-agent': UA, accept, 'accept-encoding': 'gzip, deflate, br' },
      timeout: remaining,
    }, (res) => {
      const chunks = [];
      let len = 0;
      let aborted = false;
      const settle = () => resolve({
        status: res.statusCode,
        headers: res.headers,
        location: res.headers.location || null,
        buffer: decode(Buffer.concat(chunks), res.headers['content-encoding']),
        contentType: res.headers['content-type'] || null,
        truncated: aborted,
      });
      res.on('data', (c) => {
        len += c.length;
        if (len > maxBytes) {
          // Oversized (or never-ending) response body. destroy() emits neither
          // 'end' nor 'error', so the promise MUST be settled here — before
          // this fix, one >32MB response left run() awaiting forever with an
          // empty event loop, which is how the K2 prewarm died at 349/350
          // (Node exit 13, "unsettled top-level await") on ultradentproducts.com.
          aborted = true;
          res.destroy();
          settle();
          return;
        }
        chunks.push(c);
      });
      res.on('end', settle);
      res.on('error', reject);
      // A connection that closes without 'end' or 'error' (server drops
      // mid-body) must not strand the promise either. resolve/reject are
      // settle-once, so this is a harmless no-op on the normal path.
      res.on('close', () => reject(Object.assign(new Error('connection closed before the response completed'), { code: 'ECONNCLOSED' })));
    });
    req.on('timeout', () => { req.destroy(Object.assign(new Error(`timeout after ${remaining}ms`), { code: 'ETIMEDOUT' })); });
    req.on('error', reject);
    req.end();
  });
}

// Decode transport Content-Encoding only. A payload that is itself a gzip file
// (a .gz sitemap served without Content-Encoding) is left as raw bytes so the
// caller still sees the gzip magic — matching the previous fetch() behavior.
function decode(buf, encoding) {
  if (!encoding) return buf;
  try {
    const enc = String(encoding).toLowerCase();
    if (enc.includes('br')) return brotliDecompressSync(buf);
    if (enc.includes('gzip')) return gunzipSync(buf);
    if (enc.includes('deflate')) { try { return inflateSync(buf); } catch { return inflateRawSync(buf); } }
  } catch { /* fall through to raw bytes */ }
  return buf;
}

export class Fetcher {
  constructor({ timeoutMs = 15000, crawlDelayMs = 0, maxBytes = 32 * 1024 * 1024 } = {}) {
    this.timeoutMs = timeoutMs;
    this.crawlDelayMs = crawlDelayMs;
    this.maxBytes = maxBytes;
    this.log = [];
    this._lastAt = 0;
  }

  async _throttle() {
    if (!this.crawlDelayMs) return;
    const wait = this._lastAt + this.crawlDelayMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastAt = Date.now();
  }

  // Returns { ok, status, url, finalUrl, contentType, bytes, ms, body, error, redirected, buffer }
  async get(url, { note = null, accept = '*/*' } = {}) {
    const release = await _acquireGate();
    try {
      return await this._get(url, { note, accept });
    } finally {
      if (release) release();
    }
  }

  async _get(url, { note = null, accept = '*/*' } = {}) {
    await this._throttle();
    const started = Date.now();
    const deadline = started + this.timeoutMs;
    const entry = { url, note, status: null, ok: false, ms: 0, bytes: 0, error: null };
    let current = url;
    try {
      let hops = 0;
      // Manual redirect following so safeLookup re-validates each hop.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const r = await rawRequest(current, { timeoutMs: this.timeoutMs, accept, maxBytes: this.maxBytes, deadline });
        const isRedirect = r.status >= 300 && r.status < 400 && r.location;
        if (isRedirect && hops < MAX_REDIRECTS) {
          let next;
          try { next = new URL(r.location, current).toString(); } catch { break; }
          const proto = (() => { try { return new URL(next).protocol; } catch { return null; } })();
          if (proto !== 'http:' && proto !== 'https:') {
            entry.error = `refused redirect to non-http(s) target (${proto || 'unknown'})`;
            entry.ms = Date.now() - started;
            this.log.push(entry);
            return fail(url, current, entry);
          }
          current = next;
          hops++;
          continue;
        }
        const buf = r.buffer;
        const ok = r.status >= 200 && r.status < 300;
        entry.status = r.status;
        entry.ok = ok;
        entry.bytes = buf.length;
        entry.ms = Date.now() - started;
        entry.finalUrl = current;
        entry.redirected = current !== url;
        entry.contentType = r.contentType;
        this.log.push(entry);
        return {
          ok, status: r.status, url, finalUrl: current, redirected: current !== url,
          contentType: r.contentType, bytes: buf.length, ms: entry.ms, buffer: buf,
          body: buf.toString('utf8'), error: null,
        };
      }
      // Redirect loop broke without resolving.
      entry.error = 'redirect could not be resolved';
      entry.ms = Date.now() - started;
      this.log.push(entry);
      return fail(url, current, entry);
    } catch (err) {
      entry.ms = Date.now() - started;
      entry.error = err.code === 'ETIMEDOUT' ? `timeout after ${this.timeoutMs}ms`
        : err.code === 'ESSRFBLOCKED' ? String(err.message)
        : String(err.message || err);
      this.log.push(entry);
      return fail(url, current, entry);
    }
  }
}

function fail(url, finalUrl, entry) {
  return { ok: false, status: entry.status ?? null, url, finalUrl: finalUrl || url, redirected: false, contentType: null, bytes: 0, ms: entry.ms, buffer: null, body: null, error: entry.error };
}
