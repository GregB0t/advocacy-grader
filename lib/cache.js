// 30-day per-domain evidence cache (spec §6), keyed on the normalized host.
// The cache stores EVIDENCE, never scores — scoring always re-applies the
// live rubric at read time, so a rubric fix propagates to cached domains
// instantly. The pre-generated calibration corpus (out/calib) seeds it:
// a repeat lookup of any of those 350 domains is instant.
//
// TTL is 30 days by deliberate choice (2026-08-30): caching AND expiration are
// meant to be visible as built features, and meaningful site change inside a
// month is unlikely. The previous 7-day TTL would have expired the whole seed
// corpus on 2026-09-04 and made pre-warming a large domain list pointless,
// because the TTL is evaluated at READ time against meta.started_at.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stripDerived } from './run.js';

export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// A live run that resolved no origin (DNS failure, unreachable, an un-recovered
// 403) is often a TRANSIENT outage, not a permanent verdict. Caching it for the
// full 30 days freezes a temporarily-down site as "unreadable" for a month and
// never re-fetches. Such failure envelopes written to the live cache get a short
// TTL so they self-heal; the curated corpus seeds are never expired this way.
export const FAIL_TTL_MS = 60 * 60 * 1000;
const isFailureEnvelope = (ev) => !ev?.meta?.resolved_origin && !ev?.blocked_at_root;

export function cacheKey(host) {
  return String(host || '').toLowerCase().replace(/^www\d?\./, '').replace(/[^a-z0-9.-]/g, '_');
}

export class EvidenceCache {
  constructor({ dir = 'out/cache', seedDirs = ['out/calib'], ttlMs = CACHE_TTL_MS } = {}) {
    this.dir = dir;
    this.seedDirs = seedDirs;
    this.ttlMs = ttlMs;
    mkdirSync(dir, { recursive: true });
  }

  _paths(host) {
    const key = cacheKey(host);
    return [join(this.dir, key + '.json'), ...this.seedDirs.map((d) => join(d, key + '.json'))];
  }

  // Returns { evidence, cached_at, source } or null if absent/stale.
  get(host) {
    for (const p of this._paths(host)) {
      if (!existsSync(p)) continue;
      try {
        const evidence = JSON.parse(readFileSync(p, 'utf8'));
        const at = Date.parse(evidence.meta?.started_at || 0) || 0;
        // Short TTL for failure envelopes in the WRITABLE cache only; seed dirs
        // (the curated 350-domain corpus) always use the full TTL.
        const fromSeed = !p.startsWith(this.dir);
        const ttl = (!fromSeed && isFailureEnvelope(evidence)) ? Math.min(this.ttlMs, FAIL_TTL_MS) : this.ttlMs;
        if (Date.now() - at > ttl) continue; // stale — fall through, maybe refetch
        return { evidence, cached_at: new Date(at).toISOString(), source: p };
      } catch { continue; }
    }
    return null;
  }

  put(host, evidence) {
    const p = join(this.dir, cacheKey(host) + '.json');
    writeFileSync(p, JSON.stringify(stripDerived(evidence)));
    return p;
  }
}
