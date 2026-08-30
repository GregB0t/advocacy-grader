import { readFileSync } from 'node:fs';

// ScrapingBee client, tuned for cost rather than convenience.
//
// TWO RULES THAT ARE NOT NEGOTIABLE:
//   1. Nothing reaches this module unless our own robots.txt matcher already
//      approved the URL. A proxy service is not a way around spec §7 rule 5.
//      Being blocked is data; routing around a block is not.
//   2. Every request reports what it cost. A public endpoint that spends
//      credits per visitor needs a per-run ceiling, not good intentions.
//
// Credit table (verified against ScrapingBee docs 2026-08-27):
//   plain 1 · render_js 5 · premium 10 (no JS) / 25 (JS) · stealth 75
//   render_js DEFAULTS TO TRUE at the API, which is a 5x bill for HTML we can
//   usually get for 1. We always send it explicitly.

const ENDPOINT = 'https://app.scrapingbee.com/api/v1/';

export const ESCALATION = {
  // Our plain fetch got a 200 but almost no text: we know we need a browser.
  // Going straight to render_js beats auto-mode, which would stop at the
  // 1-credit tier, succeed by HTTP standards, and hand back the same empty shell.
  THIN: 'thin_html',
  // Our plain fetch was refused (403/429/timeout). We do not know why, so let
  // auto-mode find the cheapest configuration that works — and pay 0 if none does.
  BLOCKED: 'fetch_blocked',
};

export class ScrapingBee {
  constructor({ apiKey, maxCreditsPerRun = 120, maxCostPerRequest = 25, timeoutMs = 25000, tag = null } = {}) {
    this.apiKey = apiKey || null;
    this.maxCreditsPerRun = maxCreditsPerRun;
    this.maxCostPerRequest = maxCostPerRequest;
    this.timeoutMs = timeoutMs;
    // ScrapingBee rejects anything but alphanumerics, hyphens and underscores here.
    this.tag = tag ? String(tag).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) : null;
    this.creditsUsed = 0;
    this.calls = [];
  }

  get enabled() { return Boolean(this.apiKey); }
  get creditsRemaining() { return Math.max(0, this.maxCreditsPerRun - this.creditsUsed); }

  _params(url, reason) {
    const p = new URLSearchParams();
    p.set('api_key', this.apiKey);
    p.set('url', url);
    // Body + headers + actual cost in one payload, so the fetch log can carry
    // the credits spent instead of us guessing from the parameters we sent.
    p.set('json_response', 'true');
    p.set('timeout', String(this.timeoutMs));
    if (this.tag) p.set('tag', this.tag);

    if (reason === ESCALATION.THIN) {
      // Return the target's real status code rather than ScrapingBee's wrapper
      // status; without it a 404 arrives as a 200. Auto-mode rejects this
      // parameter outright (HTTP 400), so it is set only on the render path.
      p.set('transparent_status_code', 'true');
      p.set('render_js', 'true');          // 5 credits
      p.set('block_resources', 'true');    // skip images/CSS: we only need <head>
      p.set('block_ads', 'true');
      p.set('wait_browser', 'load');       // meta tags are often injected after DOMContentLoaded
    } else {
      p.set('mode', 'auto');               // charges only for the tier that works, 0 if none do
      p.set('max_cost', String(this.maxCostPerRequest));
    }
    return p;
  }

  // Deliberately NOT used: extract_rules, ai_query, ai_extract_rules,
  // return_page_text, return_page_markdown. The report has to cite the tags it
  // actually saw, so we keep the raw HTML and parse it ourselves. Putting a
  // model or a server-side extractor between the page and the evidence would
  // make §7 rule 2 unverifiable — and return_page_source is wrong here too,
  // since it hands back the pre-JavaScript HTML we already have.
  async fetch(url, { reason = ESCALATION.BLOCKED, robotsAllowed } = {}) {
    if (robotsAllowed !== true) {
      throw new Error('ScrapingBee.fetch called without an explicit robots.txt allowance. Refusing: a proxy must not be used to fetch what robots.txt disallows.');
    }
    if (!this.enabled) {
      return { ok: false, skipped: 'no_api_key', credits: 0, body: null, status: null,
        note: 'ScrapingBee key not configured. Run `npm run setup`. This page was not retried.' };
    }
    const projected = reason === ESCALATION.THIN ? 5 : this.maxCostPerRequest;
    if (this.creditsUsed + projected > this.maxCreditsPerRun) {
      return { ok: false, skipped: 'credit_budget_exhausted', credits: 0, body: null, status: null,
        note: `Per-run credit ceiling reached (${this.creditsUsed}/${this.maxCreditsPerRun}). This page was not retried and must be reported as unchecked.` };
    }

    const started = Date.now();
    let record = { url, reason, credits: 0, ms: 0, status: null, ok: false, error: null };
    try {
      const res = await fetch(`${ENDPOINT}?${this._params(url, reason)}`, { signal: AbortSignal.timeout(this.timeoutMs + 10000) });
      const raw = await res.text();
      const headerCost = Number(res.headers.get('spb-auto-cost') ?? res.headers.get('spb-cost') ?? NaN);

      let payload = null;
      try { payload = JSON.parse(raw); } catch { /* non-JSON error body */ }

      const credits = Number.isFinite(headerCost) ? headerCost : Number(payload?.cost ?? 0) || 0;
      this.creditsUsed += credits;

      record = {
        url, reason, credits, ms: Date.now() - started,
        status: payload?.['initial-status-code'] ?? res.status,
        ok: res.ok,
        resolved_url: payload?.['resolved-url'] ?? null,
        error: res.ok ? null : `HTTP ${res.status}: ${raw.slice(0, 200)}`,
      };
      this.calls.push(record);

      if (!res.ok) return { ok: false, credits, status: record.status, body: null, error: record.error, note: null };
      const body = typeof payload?.body === 'string' ? payload.body : raw;
      return { ok: true, credits, status: record.status, body, resolvedUrl: record.resolved_url, error: null, note: null };
    } catch (err) {
      record.ms = Date.now() - started;
      record.error = String(err.message || err);
      this.calls.push(record);
      return { ok: false, credits: 0, status: null, body: null, error: record.error, note: null };
    }
  }

  report() {
    return {
      enabled: this.enabled,
      credits_used: this.creditsUsed,
      credits_ceiling: this.maxCreditsPerRun,
      calls: this.calls,
      note: this.enabled ? null : 'ScrapingBee not configured; JavaScript-rendered pages were reported as unchecked rather than retried.',
    };
  }
}

// Minimal .env reader so the script has no dependency just to read one key.
export function loadEnv(path) {
  try {
    const out = {};
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
  } catch { return {}; }
}
