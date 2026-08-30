// SSRF guard. This is a PUBLIC endpoint that fetches arbitrary user-supplied
// hosts, so a hostname that resolves to a private, loopback, link-local or
// otherwise-reserved address must never be connected to — including when a
// public hostname resolves to a private address (DNS rebinding) or a public
// site 30x-redirects to one. The real boundary is the connect-time `lookup`
// (safeLookup) wired into node:http/https in http.js: it validates the exact
// IP the socket is about to use, on every request and every redirect hop, so
// there is no resolve-then-connect TOCTOU. hostPreCheck() is a cheap,
// user-facing early rejection for literal internal inputs; it is defense in
// depth, not the boundary.
import dns from 'node:dns';
import net from 'node:net';

// Local-dev/fixtures opt-out ONLY. The public server never sets this; it exists
// so `node score.js http://127.0.0.1:PORT` against fixtures/server.js still works.
const allowPrivate = () => process.env.GRADER_ALLOW_PRIVATE === '1';

// Returns true if an IP literal is one we must never connect to.
export function ipIsBlocked(ip) {
  if (allowPrivate()) return false;
  if (typeof ip !== 'string') return true;
  let addr = ip;
  const fam = net.isIP(addr);
  if (fam === 4) return ipv4Blocked(addr);
  if (fam === 6) return ipv6Blocked(addr.toLowerCase());
  return true; // not a valid IP literal -> refuse to treat as connectable
}

function ipv4Blocked(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true;               // 0.0.0.0/8 "this host"
  if (a === 10) return true;              // private
  if (a === 127) return true;             // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;  // private
  if (a === 192 && b === 0 && p[2] === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && p[2] === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && p[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && p[2] === 113) return true;  // TEST-NET-3
  if (a >= 224) return true;              // multicast + reserved + 255.255.255.255
  return false;
}

function ipv6Blocked(ip) {
  if (ip === '::' || ip === '::1') return true;      // unspecified, loopback
  if (ip.startsWith('::ffff:')) {                     // IPv4-mapped
    const v4 = ip.slice(ip.lastIndexOf(':') + 1);
    if (net.isIP(v4) === 4) return ipv4Blocked(v4);
    return true;
  }
  if (ip.startsWith('fe80') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return true; // link-local fe80::/10
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // unique-local fc00::/7
  if (ip.startsWith('ff')) return true; // multicast
  if (ip.startsWith('::') && net.isIP(ip.slice(2)) === 4) return ipv4Blocked(ip.slice(2)); // ::a.b.c.d
  if (ip.startsWith('2001:db8')) return true; // documentation
  return false;
}

// Connect-time DNS validator, drop-in for the http/https `lookup` option.
// Resolves the hostname, refuses every private/reserved answer, and pins the
// socket to a validated public address so the IP checked is the IP used.
export function safeLookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'function' ? {} : (options || {});
  // A literal IP hostname never hits DNS; validate it directly.
  if (net.isIP(hostname)) {
    if (ipIsBlocked(hostname)) return cb(ssrfError(hostname, hostname));
    const family = net.isIP(hostname);
    return opts.all ? cb(null, [{ address: hostname, family }]) : cb(null, hostname, family);
  }
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = Array.isArray(addresses) ? addresses : [addresses];
    const safe = list.filter((a) => !ipIsBlocked(a.address));
    if (!safe.length) return cb(ssrfError(hostname, list.map((a) => a.address).join(', ')));
    if (opts.all) return cb(null, safe);
    return cb(null, safe[0].address, safe[0].family);
  });
}

function ssrfError(hostname, resolved) {
  const e = new Error(`refusing to connect to ${hostname} — it resolves to a private or reserved address (${resolved})`);
  e.code = 'ESSRFBLOCKED';
  return e;
}

// Cheap, user-facing early check on the RAW input, before any fetch. Catches
// literal internal addresses and non-public host shapes so the user gets a
// clear message instead of a generic timeout. Not the security boundary
// (safeLookup is) — a public hostname that resolves internally passes this and
// is caught at connect time.
export function hostPreCheck(host) {
  if (allowPrivate()) return { blocked: false };
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!h) return { blocked: true, reason: 'empty host' };
  if (h.length > 253) return { blocked: true, reason: 'that is too long to be a real domain name' };
  const bare = h.replace(/^\[/, '').replace(/\]$/, '');
  if (net.isIP(bare)) {
    return ipIsBlocked(bare)
      ? { blocked: true, reason: 'that is a private or reserved IP address, not a public website' }
      : { blocked: true, reason: 'enter a domain name, not a raw IP address' };
  }
  // decimal/hex/octal integer "IP" forms (e.g. 2130706433, 0x7f000001)
  if (/^(0x[0-9a-f]+|\d+)$/i.test(h)) return { blocked: true, reason: 'enter a domain name, not a numeric address' };
  if (h === 'localhost' || h.endsWith('.localhost')) return { blocked: true, reason: 'localhost is not a public website' };
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return { blocked: true, reason: 'that is an internal-network name, not a public website' };
  if (!h.includes('.')) return { blocked: true, reason: 'that does not look like a public domain name' };
  return { blocked: false };
}
