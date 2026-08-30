// Per-IP sliding-window rate limit. In-memory — resets on restart, which is
// acceptable for a launch-week tool; the 7-day cache is the real cost
// control (a repeat domain never triggers a refetch).
export class RateLimiter {
  constructor({ windowMs = 60 * 60 * 1000, max = 10 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map(); // ip -> [timestamps]
  }

  check(ip) {
    const now = Date.now();
    const arr = (this.hits.get(ip) || []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(ip, arr);
      const retryMs = this.windowMs - (now - arr[0]);
      return { allowed: false, retry_after_s: Math.ceil(retryMs / 1000) };
    }
    arr.push(now);
    this.hits.set(ip, arr);
    if (this.hits.size > 10000) { // bounded memory
      for (const [k, v] of this.hits) if (!v.length || now - v[v.length - 1] > this.windowMs) this.hits.delete(k);
    }
    return { allowed: true };
  }
}
