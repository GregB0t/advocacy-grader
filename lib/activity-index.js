// Activity-index client + company resolver.
//
// WHAT THIS IS FOR. The activity index is licensed third-party data — a
// commercial index of public professional-network activity, on EveryoneSocial's
// account. It is deliberately not named anywhere in this repo or on the site. It is NOT publicly observable evidence in the spec §7 sense: the
// visitor cannot go and verify an employee-posting count themselves. Every
// consumer must label it as such, and nothing here may enter the public grade
// until it has been calibrated across the corpus — same rule as the incumbent
// index. Aggregates only on anything public; no named people, no profile URLs.
//
// THE PROBLEM THIS FILE ACTUALLY SOLVES (probe, 2026-09-16, out/activity-index/):
//   - enrich?website=gong.io returned "Gong Israel", a subsidiary with
//     employees_count 0 and zero indexed employees. The real Gong record lists
//     its website as vercel.app, so a website lookup can never find it.
//   - enrich?website=aligntechnology.com -> 404. The index knows the company
//     as aligntech.com. Same company, different alias.
//   - Search endpoints answer a wrong query shape with 200 and ZERO results.
//     A silent zero is a fabricated "none" — the §7 trap in reverse.
// So: resolve by website, VERIFY with a free count, fall back to the LinkedIn
// shorthand the company's own homepage declares, and refuse to guess.
//
// CREDIT MODEL (provider docs, verified 2026-09-16): search is free and returns
// ids + an x-total-results header; collect/enrich cost credits per 200.
//
// The API base URL is NOT in this file. It comes from ACTIVITY_INDEX_BASE_URL
// (see .env.example) so the provider is not named in a public repo; without it,
// or without the key, the client reports 'disabled' and every consumer degrades
// to website-only evidence and says so.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registrableDomain } from './domain.js';

export const DEFAULT_CACHE_DIR = 'out/activity-index-cache';
export const COST = { company_multi_source: 20, employee_multi_source: 20, company_post: 1, employee_post: 1, historical_headcount: 10 };
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // a company record is slow-moving
export const UNRESOLVED_TTL_MS = 7 * 24 * 60 * 60 * 1000; // retrying an unresolved domain costs 20-40 credits

const clean = (s) => String(s || '').trim().toLowerCase();

// LinkedIn company shorthands the page itself links to, most-linked first.
// /company/ only — /showcase/ and /school/ pages are not the employer record.
export function extractLinkedInShorthands(html) {
  const counts = new Map();
  const re = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/([A-Za-z0-9][A-Za-z0-9._%-]*?)(?:[/?#"'\s<]|$)/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    let sh = decodeURIComponent(m[1]).toLowerCase().replace(/\.$/, '');
    if (!sh || sh === 'about' || sh === 'login' || sh === 'signup') continue;
    counts.set(sh, (counts.get(sh) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([sh]) => sh);
}

// Does this record look like the company at `domain`? Identity is judged on the
// website and headcount consistency, never on the name — a subsidiary carries
// the parent's name. Coverage (how many employees the index holds) is reported
// separately: it says how much the counts are worth, not who the record is.
export function assessCandidate(record, { domain, finalHost = null, employeesIndexed = null, method = 'enrich_by_website' } = {}) {
  const checks = {};
  const want = new Set([registrableDomain(domain), registrableDomain(finalHost)].filter(Boolean));
  const site = registrableDomain(record?.website || record?.website_domain || '');
  checks.website_matches = Boolean(site && want.has(site));
  checks.record_website = record?.website ?? null;
  checks.employees_count = record?.employees_count ?? null;
  checks.size_range = record?.size_range ?? null;
  checks.has_headcount = Number(record?.employees_count) > 0 || Boolean(record?.size_range);
  // "employees_count 0 but size_range 501-1000" was Gong Israel's signature.
  checks.headcount_consistent = !(Number(record?.employees_count) === 0 && record?.size_range);
  checks.employees_indexed = employeesIndexed;
  checks.declared_by_homepage = method.startsWith('homepage_linkedin');
  // A record nobody in the index works at cannot be verified as the company —
  // "Kitchen Store" (9 employees) claimed williams-sonoma.com and passed the
  // website test. Zero indexed employees is a rejection, not a coverage note.
  checks.verifiable = employeesIndexed === null || employeesIndexed > 0;

  let confidence;
  if (!record || !record.id) confidence = 'none';
  else if (!checks.verifiable) confidence = 'low';
  else if (checks.website_matches && checks.has_headcount && checks.headcount_consistent) confidence = 'high';
  else if (checks.declared_by_homepage && checks.has_headcount && checks.headcount_consistent) confidence = 'medium'; // alias domain; the company's own link
  else confidence = 'low';
  const coverage = employeesIndexed === null ? 'unknown' : employeesIndexed === 0 ? 'none' : employeesIndexed < 20 ? 'thin' : 'ok';
  return { confidence, coverage, checks };
}

export class ActivityIndex {
  constructor({ apiKey, baseUrl, maxCreditsPerRun = 60, cacheDir = DEFAULT_CACHE_DIR, ttlMs = CACHE_TTL_MS, fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
    this.apiKey = apiKey || null;
    this.baseUrl = baseUrl ? String(baseUrl).replace(/\/+$/, '') : null;
    this.maxCreditsPerRun = maxCreditsPerRun;
    this.cacheDir = cacheDir;
    this.ttlMs = ttlMs;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.creditsUsed = 0;
    this.calls = [];
    if (cacheDir) mkdirSync(cacheDir, { recursive: true });
  }

  get enabled() { return Boolean(this.apiKey && this.baseUrl); }
  get creditsRemaining() { return Math.max(0, this.maxCreditsPerRun - this.creditsUsed); }

  async _call(method, path, { body = null, cost = 0, note = null } = {}) {
    if (!this.enabled) return { status: 'disabled', headers: {}, json: null };
    if (cost > this.creditsRemaining) {
      const entry = { method, path, note, status: 'ceiling', cost: 0, ms: 0 };
      this.calls.push(entry);
      return { status: 'ceiling', headers: {}, json: null };
    }
    const started = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(this.baseUrl + path, {
        method, signal: ctl.signal,
        headers: { apikey: this.apiKey, accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* keep null */ }
      const headers = {}; res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      const charged = res.status === 200 ? cost : 0;
      this.creditsUsed += charged;
      this.calls.push({ method, path, note, status: res.status, cost: charged, ms: Date.now() - started });
      return { status: res.status, headers, json, text };
    } catch (e) {
      this.calls.push({ method, path, note, status: 0, cost: 0, ms: Date.now() - started, error: e?.name === 'AbortError' ? 'timeout' : String(e?.message || e) });
      return { status: 0, headers: {}, json: null, error: String(e?.message || e) };
    } finally { clearTimeout(timer); }
  }

  // ---- raw endpoints ----
  enrichByWebsite(domain) {
    return this._call('GET', `/company_multi_source/enrich?website=${encodeURIComponent(domain)}`, { cost: COST.company_multi_source, note: `enrich ${domain}` });
  }
  collectByShorthand(shorthand) {
    return this._call('GET', `/company_multi_source/collect/${encodeURIComponent(shorthand)}`, { cost: COST.company_multi_source, note: `collect ${shorthand}` });
  }
  collectPost(entity, id) {
    return this._call('GET', `/${entity}/collect/${encodeURIComponent(id)}`, { cost: COST[entity] ?? 1, note: `${entity} ${id}` });
  }

  // Free. Returns { total, ids, status }. total is null unless the API said 200
  // AND sent the header — a missing header is "not observed", never zero.
  async search(entity, query, { perPage = 1, note = null } = {}) {
    const r = await this._call('POST', `/${entity}/search/es_dsl?items_per_page=${perPage}`, { body: { query }, cost: 0, note: note || `search ${entity}` });
    const raw = r.headers?.['x-total-results'];
    const total = r.status === 200 && raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
    return { status: r.status, total, ids: Array.isArray(r.json) ? r.json : [] };
  }
  async count(entity, query, opts) { return (await this.search(entity, query, opts)).total; }

  // ---- cache ----
  _cachePath(domain) { return this.cacheDir ? join(this.cacheDir, registrableDomain(domain).replace(/[^a-z0-9.-]/g, '_') + '.json') : null; }
  cacheGet(domain) {
    const p = this._cachePath(domain);
    if (!p || !existsSync(p)) return null;
    try {
      const v = JSON.parse(readFileSync(p, 'utf8'));
      const ttl = v.status === 'resolved' ? this.ttlMs : UNRESOLVED_TTL_MS;
      if (Date.now() - Date.parse(v.resolved_at || 0) > ttl) return null;
      return v;
    } catch { return null; }
  }
  cachePut(domain, value) { const p = this._cachePath(domain); if (p) writeFileSync(p, JSON.stringify(value, null, 2)); }

  // ---- the resolver ----
  // Returns { status: 'resolved'|'unresolved'|'disabled'|'ceiling', confidence,
  //           method, company_id, record, candidates[], credits_used, notes[] }
  // Order: (1) cache; (2) enrich by website, verified by a FREE employee count
  // on the returned id; (3) the LinkedIn /company/ shorthand the homepage
  // itself links (the company's own declaration); (4) unresolved, with every
  // candidate recorded so a human can see what was tried.
  async resolveCompany({ domain, finalHost = null, html = null, useCache = true } = {}) {
    const key = registrableDomain(domain);
    if (!key) return { status: 'unresolved', reason: 'not a domain', candidates: [], credits_used: 0, notes: [] };
    if (!this.enabled) return { status: 'disabled', reason: 'no ACTIVITY_INDEX_API_KEY / ACTIVITY_INDEX_BASE_URL', candidates: [], credits_used: 0, notes: [] };
    if (useCache) { const hit = this.cacheGet(key); if (hit) return { ...hit, from_cache: true, credits_used: 0 }; }

    const before = this.creditsUsed;
    const notes = [];
    const candidates = [];
    const shorthands = extractLinkedInShorthands(html).slice(0, 2);
    const tried = new Set();

    const consider = async (method, fetchRecord) => {
      const r = await fetchRecord();
      if (r.status === 'ceiling') { notes.push(`${method}: credit ceiling (${this.maxCreditsPerRun}/run) reached before this call`); return { ceiling: true }; }
      if (r.status !== 200 || !r.json || Array.isArray(r.json) || !r.json.id) {
        candidates.push({ method, status: r.status, verdict: 'no record', detail: r.json?.detail ?? null });
        return null;
      }
      const record = r.json;
      if (tried.has(record.id)) { candidates.push({ method, id: record.id, verdict: 'duplicate of an earlier candidate' }); return null; }
      tried.add(record.id);
      const employeesIndexed = await this.count('employee_multi_source', { term: { active_experience_company_id: record.id } }, { note: `verify ${record.id}` });
      const a = assessCandidate(record, { domain: key, finalHost, employeesIndexed, method });
      const cand = { method, id: record.id, name: record.company_name ?? null, website: record.website ?? null,
        employees_count: record.employees_count ?? null, size_range: record.size_range ?? null,
        employees_indexed: employeesIndexed, confidence: a.confidence, coverage: a.coverage, checks: a.checks, verdict: a.confidence === 'high' || a.confidence === 'medium' ? 'accepted' : 'rejected' };
      candidates.push(cand);
      return cand.verdict === 'accepted' ? { cand, record } : null;
    };

    let pick = null;
    // (2) website
    pick = await consider('enrich_by_website', () => this.enrichByWebsite(key));
    // (3) homepage-declared shorthand(s) — only spend more when (2) did not convince
    for (const sh of shorthands) {
      if (pick) break; // accepted, or the ceiling — either way stop spending
      pick = await consider(`homepage_linkedin:${sh}`, () => this.collectByShorthand(sh));
    }
    if (!shorthands.length) notes.push(html ? 'homepage links no linkedin.com/company/ page' : 'no homepage html supplied, so no shorthand fallback');

    const credits_used = this.creditsUsed - before;
    let result;
    if (pick?.ceiling && !pick.cand) result = { status: 'ceiling', domain: key, candidates, credits_used, notes };
    else if (pick?.cand) {
      result = { status: 'resolved', domain: key, confidence: pick.cand.confidence, coverage: pick.cand.coverage, method: pick.cand.method, company_id: pick.cand.id,
        company_name: pick.cand.name, record: pick.record, candidates, credits_used, notes, resolved_at: new Date().toISOString() };
    } else {
      const best = candidates.find((c) => c.id) || null;
      result = { status: 'unresolved', domain: key, reason: best ? `best candidate ${best.name} (id ${best.id}) failed verification: ${describeRejection(best)}` : 'no record for this website and no usable homepage LinkedIn link',
        candidates, credits_used, notes, resolved_at: new Date().toISOString() };
    }
    if (useCache && (result.status === 'resolved' || result.status === 'unresolved')) this.cachePut(key, result);
    return result;
  }

  // ---- the seven aggregate counts, all free. null = not observed, never 0. ----
  async companyCounts(companyId, { days = 90, now = Date.now() } = {}) {
    const since = new Date(now - days * 864e5).toISOString().slice(0, 10);
    const by = { term: { active_experience_company_id: companyId } };
    const co = { term: { company_id: companyId } };
    const q = (e, must, note) => this.count(e, { bool: { must } }, { note });
    const out = {
      window_days: days, since,
      employees_indexed: await q('employee_multi_source', [by], 'employees indexed'),
      employees_posted_in_window: await q('employee_multi_source', [by, { range: { posting_recency: { gte: since } } }], 'employees posted'),
      employees_posting_12plus_per_year: await q('employee_multi_source', [by, { range: { post_frequency_yearly: { gte: 12 } } }], 'employees 12+/yr'),
      decision_makers_posted_in_window: await q('employee_multi_source', [by, { term: { is_decision_maker: 1 } }, { range: { posting_recency: { gte: since } } }], 'decision makers posted'),
      company_posts_all_time: await q('company_post', [co], 'company posts all'),
      company_posts_in_window: await q('company_post', [co, { range: { date_published: { gte: since } } }], 'company posts window'),
      // NESTED is required. The flat term form answers 0 for every company (probe 2026-09-16).
      reshares_of_company_posts_in_window: await q('employee_post', [{ nested: { path: 'reshared_post', query: { term: { 'reshared_post.company_id': companyId } } } }, { range: { date_published: { gte: since } } }], 'reshares window'),
    };
    const n = out.employees_indexed, p = out.employees_posted_in_window;
    out.active_poster_rate_pct = n && p !== null ? Math.round((p / n) * 1000) / 10 : null;
    out.note = 'Counts are records in a licensed third-party index, a lower bound with uneven coverage — small companies are under-covered. Never present as actual totals; a 0 means "none in the index".';
    return out;
  }

  // Positive control: a query that must be non-zero on a well-covered company.
  // If it ever returns 0 or null, a query shape or the index changed — stop
  // trusting every count until this passes again.
  async selfTest({ companyId = 752371 /* hubspot */ } = {}) {
    const nested = await this.count('employee_post', { bool: { must: [{ nested: { path: 'reshared_post', query: { term: { 'reshared_post.company_id': companyId } } } }] } }, { note: 'selftest nested' });
    const employees = await this.count('employee_multi_source', { term: { active_experience_company_id: companyId } }, { note: 'selftest employees' });
    const posts = await this.count('company_post', { term: { company_id: companyId } }, { note: 'selftest posts' });
    const ok = [nested, employees, posts].every((v) => Number.isFinite(v) && v > 0);
    return { ok, control_company_id: companyId, nested_reshares: nested, employees_indexed: employees, company_posts: posts };
  }
}

function describeRejection(c) {
  const k = c.checks || {};
  const why = [];
  if (!k.website_matches) why.push(`record website ${k.record_website || '(none)'} is not this domain`);
  if (!k.has_headcount) why.push('no headcount on the record');
  if (!k.headcount_consistent) why.push(`employees_count ${k.employees_count} contradicts size_range ${k.size_range}`);
  if (k.verifiable === false) why.push('zero employees in the index work there, so the record cannot be verified');
  if (!k.website_matches && !k.declared_by_homepage) why.push('and the homepage does not link this LinkedIn page');
  return why.join('; ') || 'low confidence';
}
