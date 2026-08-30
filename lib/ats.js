// ATS discovery and job-board APIs. Everything here feeds the PRIVATE lead score
// only (spec §4). Hiring volume is a need signal, not a quality signal — it must
// never reach the public grade.

export const COMPETITORS = [
  'EveryoneSocial', 'GaggleAMP', 'Sociabble', 'Hootsuite Amplify', 'Sprout Social',
  'Bambu', 'Dynamic Signal', 'Firstup', 'Haiilo', 'PostBeyond', 'Clearview Social',
  'Oktopost', 'Denim Social', 'Smarp', 'Ambassify', 'DSMN8', 'Influitive',
];

// The strongest trigger in the category: someone arrives with a mandate and no vendor.
export const BUYER_TITLES = [
  ['employer_brand',   /\b(employer|talent)[\s-]?brand/i],
  ['internal_comms',   /\b(internal|employee)[\s-]?comm(unication)?s?\b/i],
  ['corporate_comms',  /\b(corporate|company)[\s-]?comm(unication)?s?\b/i],
  ['social_media',     /\bsocial[\s-]?media\b/i],
  ['employee_advocacy',/\bemployee[\s-]?advocacy\b/i],
  ['comms_leadership', /\b(head|director|vp|vice president|chief)\b[^,|]{0,40}\bcommunications?\b/i],
];

const ATS_PATTERNS = [
  ['greenhouse',      /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/ig],
  ['lever',           /jobs\.lever\.co\/([a-z0-9_-]+)/ig],
  ['ashby',           /jobs\.ashbyhq\.com\/([a-z0-9_-]+)/ig],
  ['workday',         /([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/([a-z0-9_-]+)?/ig],
  ['smartrecruiters', /careers\.smartrecruiters\.com\/([a-z0-9_-]+)/ig],
  ['workable',        /apply\.workable\.com\/([a-z0-9_-]+)/ig],
  ['eightfold',       /([a-z0-9-]+)\.eightfold\.ai/ig],
  ['phenom',          /([a-z0-9-]+)\.phenompeople\.com/ig],
  ['icims',           /([a-z0-9-]+)\.icims\.com/ig],
  ['jobvite',         /jobs\.jobvite\.com\/([a-z0-9_-]+)/ig],
];

// Some vendors are reached through generic hostnames (app.eightfold.ai), so the
// subdomain is not a company token. Detect the vendor, drop the fake token.
const NOISE_TOKENS = new Set(['embed', 'job_board', 'www', 'jobs', 'careers', 'search', 'api', 'v1', 'boards',
  'app', 'static', 'cdn', 'assets', 'vs-errors', 'errors', 'help', 'docs', 'support', 'go', 'try', 'my']);

export function detectAts(html, sourceLabel) {
  const found = [];
  for (const [name, re] of ATS_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html))) {
      const token = (m[1] || '').toLowerCase();
      if (!token || NOISE_TOKENS.has(token)) continue;
      const entry = { ats: name, token, found_in: sourceLabel };
      if (name === 'workday') { entry.tenant = token; entry.datacenter = m[2]; entry.site = m[3] || null; }
      if (!found.some((f) => f.ats === entry.ats && f.token === entry.token)) found.push(entry);
    }
  }
  return found;
}

const stripTags = (s) => String(s ?? '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

async function j(fetcher, url, note) {
  const res = await fetcher.get(url, { note, accept: 'application/json,*/*' });
  if (!res.ok) return { ok: false, status: res.status, error: res.error || `HTTP ${res.status}`, data: null };
  try { return { ok: true, status: res.status, data: JSON.parse(res.body), error: null }; }
  catch (e) { return { ok: false, status: res.status, error: `response was not JSON: ${e.message}`, data: null }; }
}

// Each adapter returns the same normalized job shape so the lead score never has
// to know which ATS a company uses.
const ADAPTERS = {
  async greenhouse(fetcher, token) {
    const r = await j(fetcher, `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`, 'greenhouse jobs');
    if (!r.ok) return r;
    const jobs = (r.data?.jobs || []).map((x) => ({
      title: x.title || null,
      location: x.location?.name || null,
      department: (x.departments || []).map((d) => d.name).filter(Boolean).join(', ') || null,
      posted_at: x.first_published || x.updated_at || null,
      url: x.absolute_url || null,
      description_text: stripTags(x.content || ''),
    }));
    return { ok: true, status: r.status, jobs, error: null };
  },
  async lever(fetcher, token) {
    const r = await j(fetcher, `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`, 'lever postings');
    if (!r.ok) return r;
    const jobs = (Array.isArray(r.data) ? r.data : []).map((x) => ({
      title: x.text || null,
      location: x.categories?.location || null,
      department: [x.categories?.department, x.categories?.team].filter(Boolean).join(' / ') || null,
      posted_at: x.createdAt ? new Date(x.createdAt).toISOString() : null,
      url: x.hostedUrl || null,
      description_text: stripTags(x.descriptionPlain || x.description || '') + ' ' + (x.lists || []).map((l) => stripTags(l.text + ' ' + l.content)).join(' '),
    }));
    return { ok: true, status: r.status, jobs, error: null };
  },
  async ashby(fetcher, token) {
    const r = await j(fetcher, `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=false`, 'ashby jobs');
    if (!r.ok) return r;
    const jobs = (r.data?.jobs || []).map((x) => ({
      title: x.title || null,
      location: x.location || (x.isRemote ? 'Remote' : null),
      department: [x.department, x.team].filter(Boolean).join(' / ') || null,
      posted_at: x.publishedAt || null,
      url: x.jobUrl || null,
      description_text: stripTags(x.descriptionPlain || x.descriptionHtml || ''),
    }));
    return { ok: true, status: r.status, jobs, error: null };
  },
};

export async function pullJobs(fetcher, hints) {
  const attempts = [];
  let jobs = null, usedAts = null;

  for (const hint of hints) {
    const adapter = ADAPTERS[hint.ats];
    if (!adapter) {
      attempts.push({ ats: hint.ats, token: hint.token, ok: false, reason: hint.ats === 'workday'
        ? 'Workday requires the CXS discovery step. Deferred to Phase 6 — reported as detected but unqueried.'
        : `Detected but not queried: no adapter for ${hint.ats}. Reported as an observed ATS, not as zero hiring.` });
      continue;
    }
    const r = await adapter(fetcher, hint.token);
    attempts.push({ ats: hint.ats, token: hint.token, ok: r.ok, status: r.status, job_count: r.jobs?.length ?? 0, reason: r.error || null });
    if (r.ok && r.jobs?.length) { jobs = r.jobs; usedAts = hint; break; }
  }
  return { jobs, usedAts, attempts };
}

export function analyzeJobs(jobs) {
  if (!jobs) return null;
  const now = Date.now(), day = 86400000;
  const dated = jobs.map((x) => Date.parse(x.posted_at)).filter(Number.isFinite);

  const buyerRoles = [];
  for (const job of jobs) {
    const hits = BUYER_TITLES.filter(([, re]) => re.test(job.title || '')).map(([k]) => k);
    if (hits.length) buyerRoles.push({ title: job.title, triggers: hits, url: job.url, posted_at: job.posted_at });
  }

  const mentions = [];
  for (const name of COMPETITORS) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const hits = jobs.filter((x) => re.test(x.description_text || '') || re.test(x.title || ''));
    if (hits.length) mentions.push({ vendor: name, job_count: hits.length, example_jobs: hits.slice(0, 3).map((h) => ({ title: h.title, url: h.url })) });
  }

  const withText = jobs.filter((x) => (x.description_text || '').length > 200).length;

  return {
    open_reqs: jobs.length,
    reqs_with_full_description: withText,
    posted_last_30d: dated.filter((d) => now - d <= 30 * day).length,
    posted_last_90d: dated.filter((d) => now - d <= 90 * day).length,
    newest_post: dated.length ? new Date(Math.max(...dated)).toISOString().slice(0, 10) : null,
    posting_dates_available: dated.length,
    departments: Object.fromEntries(
      Object.entries(jobs.reduce((acc, x) => { const d = x.department || 'unspecified'; acc[d] = (acc[d] || 0) + 1; return acc; }, {}))
        .sort((a, b) => b[1] - a[1]).slice(0, 12)),
    locations: Object.fromEntries(
      Object.entries(jobs.reduce((acc, x) => { const l = x.location || 'unspecified'; acc[l] = (acc[l] || 0) + 1; return acc; }, {}))
        .sort((a, b) => b[1] - a[1]).slice(0, 12)),
    buyer_in_seat_roles: buyerRoles,
    buyer_in_seat_trigger: buyerRoles.length > 0,
    competitor_mentions: mentions,
    displacement_target: mentions.length > 0,
    caveat: withText < jobs.length
      ? `Competitor grep covered the ${withText} of ${jobs.length} reqs that returned usable description text. Absence of a mention is not evidence of absence.`
      : null,
  };
}

// ---------------------------------------------------------------------------
// Self-hosted careers pages. EveryoneSocial (and plenty of others) publish roles
// directly on their own site with no third-party ATS at all — the spec assumed
// Greenhouse/Lever/Ashby or Workday and that assumption does not hold. This
// fallback reads the page we already fetched. It is deliberately weaker than the
// APIs: no post dates, no full JD text, and titles are inferred from link and
// heading text, so it is labelled as such wherever it is reported.
// ---------------------------------------------------------------------------

const ROLE_WORDS = /\b(engineer|developer|manager|director|head|vp|vice president|chief|lead|architect|designer|analyst|specialist|coordinator|recruiter|scientist|consultant|strategist|marketer|controller|counsel|administrator|representative|executive|associate|partner|officer|intern)\b/i;
const NOT_A_ROLE = /\b(cookie|privacy|terms|policy|blog|resources?|pricing|contact|about us|log ?in|sign ?up|newsletter|subscribe|demo|webinar|customers?|press)\b/i;

const decodeEnt = (s) => String(s ?? '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

export function extractSelfHostedRoles(html, pageUrl) {
  if (!html) return null;
  const candidates = new Map();

  const consider = (raw, where) => {
    const t = decodeEnt(String(raw).replace(/<[^>]+>/g, ' '));
    if (!t || t.length < 4 || t.length > 90) return;
    if (!ROLE_WORDS.test(t)) return;
    if (NOT_A_ROLE.test(t)) return;
    if (/^(view|apply|see|browse|learn|read)\b/i.test(t)) return;
    // Job titles are noun phrases, not sentences. NVIDIA's careers hero
    // ("Follow Your Passion. Lead a Movement.") otherwise reads as an open role.
    if (/[.!?]\s/.test(t) || /[.!?]$/.test(t)) return;
    if (t.split(/\s+/).length > 8) return;
    const k = t.toLowerCase();
    if (!candidates.has(k)) candidates.set(k, { title: t, found_in: where });
  };

  // Only anchors that actually point at something job-shaped. Without this filter
  // a marketing page like /executive-activation/ reads as an open "Executive" role.
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]{0,120}?)<\/a>/gi)) {
    if (!/href=["'][^"']*(job|career|opening|position|vacanc|apply)/i.test(m[1])) continue;
    consider(m[2], 'link text');
  }
  for (const m of html.matchAll(/<h[2-4][^>]*>([\s\S]{0,120}?)<\/h[2-4]>/gi)) consider(m[1], 'heading');
  // Titles frequently sit in a plain div/span carrying a role/job class rather
  // than in a link or heading — EveryoneSocial uses <div class="jb-role-title">.
  for (const m of html.matchAll(/<[a-z]+[^>]*class=["'][^"']*\b(?:jb-)?(?:role|job|position|opening|vacancy)[-_]?(?:title|name)\b[^"']*["'][^>]*>([\s\S]{0,120}?)<\/[a-z]+>/gi)) consider(m[1], 'role-title element');
  // Link that points at a job detail page: take its slug when the visible text
  // is just "View role" or an arrow.
  for (const m of html.matchAll(/href=["'][^"']*\/(?:jobs?|careers?|openings?|positions?)\/([a-z0-9][a-z0-9-]{4,60})\/?["']/gi)) {
    const slug = m[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    consider(slug, 'job URL slug');
  }
  // Astro/Next-style sites often ship the board as embedded JSON.
  for (const m of html.matchAll(/"(?:title|jobTitle|name|role)"\s*:\s*"([^"]{4,90})"/g)) consider(m[1], 'embedded JSON');

  const titles = [...candidates.values()];
  if (!titles.length) return null;

  const buyerRoles = [];
  for (const t of titles) {
    const hits = BUYER_TITLES.filter(([, re]) => re.test(t.title)).map(([k]) => k);
    if (hits.length) buyerRoles.push({ title: t.title, triggers: hits, url: pageUrl, posted_at: null });
  }

  return {
    source: 'self-hosted careers page',
    source_url: pageUrl,
    role_titles: titles.slice(0, 60),
    approximate_open_reqs: titles.length,
    buyer_in_seat_roles: buyerRoles,
    buyer_in_seat_trigger: buyerRoles.length > 0,
    confidence: 'low',
    caveat: 'Titles were inferred from link and heading text on the careers page, not read from an ATS API. The count is approximate, posting dates are unavailable, and full job description text is unavailable — so competitor/displacement grep cannot run for this company.',
  };
}

// Enterprise careers pages routinely hand off to a vanity subdomain
// (jobs.nvidia.com, careers.acme.com) that fronts the real ATS. One hop is worth
// following; more than one is a crawler, which this is not.
export function findJobSubdomainLinks(html, baseUrl) {
  if (!html) return [];
  let baseHost = '';
  try { baseHost = new URL(baseUrl).hostname.replace(/^www\./, ''); } catch { return []; }
  const out = new Set();
  for (const m of html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) {
    try {
      const u = new URL(m[1]);
      const host = u.hostname.toLowerCase();
      if (!/^(jobs|careers|apply|talent|hiring|work)\./.test(host)) continue;
      if (!host.replace(/^[a-z]+\./, '').startsWith(baseHost.split('.')[0])) continue;
      out.add(u.origin + u.pathname.replace(/\/$/, ''));
    } catch {}
  }
  return [...out].slice(0, 3);
}
