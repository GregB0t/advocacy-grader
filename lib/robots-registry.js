// Per-host robots.txt. A sitemap can list URLs on other hosts (NVIDIA's lists
// www.nvidia.cn) and a careers page can hand off to a jobs.* subdomain. Each of
// those is a different host with its own robots.txt, and checking them against
// the primary host's rules is exactly the kind of quiet overreach spec §7 rule 5
// exists to prevent.
import { parseRobots, makeMatcher } from './robots.js';
import { UA_TOKEN } from './http.js';

const ALLOW_ALL = { allowed: () => true, crawlDelay: null, group: null };

export class RobotsRegistry {
  constructor(fetcher) {
    this.fetcher = fetcher;
    this.cache = new Map();   // origin -> matcher
    this.fetched = [];        // audit trail of every robots.txt consulted
  }

  seed(origin, parsed) {
    this.cache.set(origin, makeMatcher(parsed, UA_TOKEN));
    this.fetched.push({ origin, source: 'primary fetch' });
  }

  async matcherFor(url) {
    let origin;
    try { origin = new URL(url).origin; } catch { return ALLOW_ALL; }
    if (this.cache.has(origin)) return this.cache.get(origin);

    const res = await this.fetcher.get(origin + '/robots.txt', { note: 'robots.txt (secondary host)', accept: 'text/plain,*/*' });
    let matcher = ALLOW_ALL;
    let note = 'no usable robots.txt; treated as allow-all';
    if (res.ok && res.body && !/^\s*<(!doctype|html)/i.test(res.body)) {
      matcher = makeMatcher(parseRobots(res.body), UA_TOKEN);
      note = 'parsed';
    }
    this.cache.set(origin, matcher);
    this.fetched.push({ origin, status: res.status, note });
    return matcher;
  }

  async allowed(url) {
    const m = await this.matcherFor(url);
    return m.allowed(url);
  }

  report() {
    return { hosts_consulted: this.fetched, note: 'Every host touched has its own robots.txt checked before any request to it.' };
  }
}
