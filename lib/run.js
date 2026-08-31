// The collection pipeline, extracted from score.js so the same run() serves
// the CLI, the static-site builder, and the live lookup server. score.js
// remains the CLI wrapper. Behavior is unchanged — this file is a move, plus
// the exported fastProbe() used by the live page's phase-1 response.
import { Fetcher, UA, UA_TOKEN, VERSION } from './http.js';
import { parseRobots, makeMatcher, aiPosture } from './robots.js';
import { collectSitemaps, lastmodStats, FALLBACK_PATHS } from './sitemap.js';
import { classifyUrls } from './classify.js';
import { extractHomepage } from './homepage.js';
import { extractPage } from './page.js';
import { sampleContentUrls } from './sample.js';
import { ScrapingBee, ESCALATION, loadEnv } from './scrapingbee.js';
import { detectAts, pullJobs, analyzeJobs, extractSelfHostedRoles, findJobSubdomainLinks } from './ats.js';
import { RobotsRegistry } from './robots-registry.js';
import { mapPool } from './pool.js';
import { scoreEvidence } from './rubric.js';
import { leadScore } from './lead-score.js';
import { SHAREABLE_SECTIONS } from './classify.js';
import { hostPreCheck } from './ssrf.js';

export const DEFAULT_OPTS = { out: null, maxSitemaps: 60, maxUrls: 60000, timeout: 15000, quiet: true, pretty: true,
  sample: 24, pages: true, ats: true, maxCredits: 150, concurrency: 5, score: true };

export function normalizeDomain(input) {
  let s = String(input || '').trim();
  const explicitScheme = /^https?:\/\//i.test(s);
  if (!explicitScheme) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  return { input, scheme: u.protocol.replace(':', ''), host: u.hostname.toLowerCase(), port: u.port || null, origin: u.origin, explicitScheme };
}

// Sites split between apex and www. Try the input, then the other one, and
// record which origin actually answered.
async function resolveOrigin(fetcher, norm) {
  const candidates = [norm.origin];
  if (!norm.port) {
    const alt = norm.host.startsWith('www.') ? norm.host.slice(4) : 'www.' + norm.host;
    candidates.push(`${norm.scheme}://${alt}`);
  }
  const attempts = [];
  for (const origin of candidates) {
    const res = await fetcher.get(origin + '/', { note: 'origin probe' });
    attempts.push({ origin, status: res.status, ok: res.ok, final_url: res.finalUrl, redirected: res.redirected, error: res.error });
    if (res.ok) {
      const finalOrigin = (() => { try { return new URL(res.finalUrl).origin; } catch { return origin; } })();
      return { origin: finalOrigin, homepage: res, attempts };
    }
  }
  return { origin: null, homepage: null, attempts };
}

export async function run(opts) {
  const startedAt = new Date();
  const t0 = Date.now();
  const warnings = [];
  const notObserved = [];

  const norm = normalizeDomain(opts.domain);
  if (!norm) throw new Error(`Could not parse "${opts.domain}" as a domain.`);
  const _pc = hostPreCheck(norm.host);
  if (_pc.blocked) throw new Error(`Cannot grade "${opts.domain}": ${_pc.reason}.`);

  const fetcher = new Fetcher({ timeoutMs: opts.timeout });
  const envFile = loadEnv(new URL('../.env', import.meta.url).pathname);
  const bee = new ScrapingBee({
    apiKey: process.env.SCRAPINGBEE_API_KEY || envFile.SCRAPINGBEE_API_KEY || null,
    maxCreditsPerRun: opts.maxCredits,
    timeoutMs: Math.max(opts.timeout, 20000),
    tag: `grader:${norm.host}`,
  });

  // 1. Resolve which origin actually serves the site.
  let resolved = await resolveOrigin(fetcher, norm);

  // Recovery path: a homepage that refuses a plain fetch (403 from a bot shield)
  // is common — haiilo.com and sociabble.com both do it — and robots.txt is
  // usually still readable. Read robots FIRST so the escalation stays inside
  // whatever the site actually permits, then retry the homepage through the proxy.
  if (!resolved.origin) {
    for (const attempt of resolved.attempts) {
      const cand = attempt.origin;
      const rb = await fetcher.get(cand + '/robots.txt', { note: 'robots.txt (recovery probe)', accept: 'text/plain,*/*' });
      if (!rb.ok || !rb.body || /^\s*<(!doctype|html)/i.test(rb.body)) continue;
      const m = makeMatcher(parseRobots(rb.body), UA_TOKEN);
      if (!m.allowed('/')) {
        warnings.push(`${cand} refused a direct request and its robots.txt disallows our user-agent at the root, so no retry was attempted.`);
        continue;
      }
      // One proxy attempt only. Auto-mode walks 1 -> 5 -> 10 -> 25 credit tiers
      // internally, which already takes real time; retrying the www/apex twin
      // doubles the worst case past any sane budget for a public endpoint.
      const b = await bee.fetch(cand + '/', { reason: ESCALATION.BLOCKED, robotsAllowed: true });
      if (!b.ok) {
        warnings.push(`${cand} refused a direct request (HTTP ${attempt.status}) and the proxy retry also failed: ${b.error || b.note || 'unknown error'}.`);
        notObserved.push(`Homepage: ${cand} blocks direct requests and could not be retrieved through the proxy either. Nothing downstream was collected for this domain.`);
        break;
      }
      if (b.ok && b.body) {
        resolved = {
          origin: cand,
          homepage: { ok: true, body: b.body, status: b.status, finalUrl: b.resolvedUrl || cand + '/' },
          attempts: [...resolved.attempts, { origin: cand, status: b.status, ok: true, via: 'scrapingbee', credits: b.credits }],
        };
        warnings.push(`${cand} refused a direct request (HTTP ${attempt.status}); robots.txt permitted our user-agent, so the homepage was retrieved through a rendering proxy at a cost of ${b.credits} credit(s).`);
        break;
      }
    }
  }

  if (!resolved.origin) {
    notObserved.push('Homepage: no candidate origin returned a successful response, directly or through a proxy. Nothing downstream could be collected.');
    return envelope({ startedAt, t0, norm, resolved, fetcher, warnings, notObserved, opts, bee });
  }
  const origin = resolved.origin;

  // 2. robots.txt — fetched first, and it governs everything after it.
  const robotsRes = await fetcher.get(origin + '/robots.txt', { note: 'robots.txt', accept: 'text/plain,*/*' });
  let robotsParsed = { groups: [], sitemaps: [], unknownDirectives: [] };
  let robotsBlock;
  if (robotsRes.ok && robotsRes.body && !/^\s*<(!doctype|html)/i.test(robotsRes.body)) {
    robotsParsed = parseRobots(robotsRes.body);
    robotsBlock = {
      present: true, status: robotsRes.status, bytes: robotsRes.bytes, url: robotsRes.finalUrl,
      raw: robotsRes.body,
      group_count: robotsParsed.groups.length,
      declared_sitemaps: robotsParsed.sitemaps,
      unknown_directives: robotsParsed.unknownDirectives,
      ai_posture: aiPosture(robotsParsed),
    };
  } else {
    const reason = robotsRes.ok ? 'endpoint returned HTML, not a robots.txt' : robotsRes.error || `HTTP ${robotsRes.status}`;
    robotsBlock = { present: false, status: robotsRes.status, reason, raw: null, declared_sitemaps: [], ai_posture: null };
    notObserved.push(`robots.txt: not retrievable (${reason}). AI-agent posture and crawl directives are unknown for this domain — not "open", unknown.`);
    warnings.push('No usable robots.txt. Proceeding with an empty rule set, which permits all paths.');
  }

  const matcher = makeMatcher(robotsParsed, UA_TOKEN);
  const robotsReg = new RobotsRegistry(fetcher);
  robotsReg.seed(origin, robotsParsed);
  if (matcher.crawlDelay) {
    fetcher.crawlDelayMs = Math.min(matcher.crawlDelay * 1000, 2000);
    warnings.push(`robots.txt declares Crawl-delay: ${matcher.crawlDelay}s. Throttling to ${fetcher.crawlDelayMs}ms between requests (capped at 2s).`);
  }
  if (!matcher.allowed('/')) {
    warnings.push('robots.txt disallows our user-agent at the site root. Only robots.txt itself was read; nothing else was fetched. Being blocked is a finding, not an error.');
    notObserved.push('Sitemaps, homepage content and URL inventory: our user-agent is disallowed at "/" and we did not fetch them.');
    return envelope({ startedAt, t0, norm, resolved, fetcher, warnings, notObserved, opts, origin, robots: robotsBlock, blockedAtRoot: true, bee });
  }

  // 3. llms.txt — detected and reported. Weight ~0 per REVISIONS R2.
  const llmsRes = matcher.allowed('/llms.txt')
    ? await fetcher.get(origin + '/llms.txt', { note: 'llms.txt', accept: 'text/plain,*/*' })
    : null;
  const llmsPresent = Boolean(llmsRes?.ok && llmsRes.body && !/^\s*<(!doctype|html)/i.test(llmsRes.body));
  const llmsBlock = {
    checked: Boolean(llmsRes),
    present: llmsPresent,
    status: llmsRes?.status ?? null,
    bytes: llmsPresent ? llmsRes.bytes : 0,
    first_lines: llmsPresent ? llmsRes.body.split(/\r?\n/).slice(0, 8) : null,
    evidence_caveat:
      'Presence is reported for completeness only. Google has stated it does not support llms.txt; no major AI vendor has confirmed consuming it; large-scale studies found no correlation with AI citations. This is recorded, not credited.',
  };

  // 4. Sitemaps — declared first, then conventional fallbacks.
  const seeds = robotsBlock.declared_sitemaps.length
    ? robotsBlock.declared_sitemaps
    : FALLBACK_PATHS.map((p) => origin + p);
  if (!robotsBlock.declared_sitemaps.length) {
    warnings.push('robots.txt declared no Sitemap: line. Falling back to conventional paths; a miss here means "not found at the usual locations", not "no content".');
  }
  const sm = await collectSitemaps({ fetcher, matcher, seeds, origin, maxSitemaps: opts.maxSitemaps, maxUrls: opts.maxUrls });
  warnings.push(...sm.notes);
  if (!sm.urls.length) {
    notObserved.push('URL inventory: no sitemap returned any URLs. Content volume could not be measured from sitemaps for this domain.');
  }

  // 5. Homepage evidence (already fetched during origin resolution).
  let homepage = resolved.homepage?.ok ? extractHomepage(resolved.homepage.body, origin) : null;
  if (!homepage) notObserved.push('Homepage HTML: not retrievable.');
  else if (homepage.likely_js_rendered) warnings.push('Homepage looks JavaScript-rendered; a plain fetch sees almost no text. A rendering fetch would be needed to judge its content.');

  // 5b. English-version discovery (K1 decision, 2026-08-31). When the homepage
  // declares a non-English language, exhaust the honest options for finding an
  // English version — hreflang alternates first, then conventional /en/ paths —
  // before accepting that the site must be read in its native language. Every
  // probe is robots-checked and recorded; nothing is inferred from a miss.
  let languageResolution = null;
  if (homepage) {
    const siteLang = homepage.lang || null;
    if (!siteLang || siteLang.startsWith('en')) {
      languageResolution = {
        site_language: siteLang || 'not declared',
        english_version_used: true,
        attempts: [],
        note: siteLang
          ? 'The homepage declares an English lang attribute; no discovery was needed.'
          : 'The homepage declares no lang attribute. It was read as-is; no language probes were made.',
      };
    } else {
      const candidates = [];
      for (const a of homepage.hreflang_alternates || []) {
        if (/^en(-|$)/.test(a.hreflang) || a.hreflang === 'x-default') candidates.push({ url: a.href, via: `hreflang ${a.hreflang}` });
      }
      for (const pth of ['/en/', '/en-us/', '/en-gb/']) candidates.push({ url: origin + pth, via: `conventional path ${pth}` });
      const attempts = [];
      const seenCand = new Set();
      let english = null;
      for (const c of candidates.slice(0, 8)) {
        const key = c.url.replace(/\/+$/, '');
        if (seenCand.has(key)) continue;
        seenCand.add(key);
        if (key === origin.replace(/\/+$/, '')) continue; // an alternate pointing back at the page we already have
        if (!(await robotsReg.allowed(c.url))) { attempts.push({ url: c.url, via: c.via, skipped: 'robots.txt for that host disallows this URL for our user-agent' }); continue; }
        const r = await fetcher.get(c.url, { note: 'english-version probe' });
        const rec = { url: c.url, via: c.via, status: r.status, ok: r.ok };
        attempts.push(rec);
        if (r.ok && r.body) {
          const ex = extractHomepage(r.body, r.finalUrl || c.url);
          if (!ex) { rec.rejected = 'no extractable HTML'; continue; }
          if (ex.lang && !ex.lang.startsWith('en')) { rec.rejected = `page declares lang="${ex.lang}", not English`; continue; }
          english = { url: r.finalUrl || c.url, extract: ex, via: c.via };
          break;
        }
      }
      if (english) {
        languageResolution = {
          site_language: siteLang,
          english_version_found: english.url,
          found_via: english.via,
          english_version_used: true,
          attempts,
          note: 'The homepage declares a non-English language, so English variants were probed (hreflang alternates first, then conventional /en/ paths). Homepage evidence describes the English version; the URL inventory still covers the whole site.',
        };
        homepage = { ...english.extract, native_language: siteLang, english_version_url: english.url };
        warnings.push(`Homepage declares lang="${siteLang}". An English version was found at ${english.url} (via ${english.via}) and is used for homepage evidence.`);
      } else {
        languageResolution = {
          site_language: siteLang,
          english_version_found: null,
          english_version_used: false,
          attempts,
          note: 'The homepage declares a non-English language and no English version was found via hreflang alternates or conventional /en/ paths. The site is read in its native language; the absence of an English version is recorded, not judged.',
        };
        warnings.push(`Homepage declares lang="${siteLang}" and no English version was found after ${attempts.length} recorded probe(s). Reading the site in its native language.`);
      }
    }
  }

  // 6. Classification (canonical view drives Content Supply — decision 2).
  const classification = sm.urls.length ? classifyUrls(sm.urls, { origin }) : null;
  const recency = lastmodStats(sm.urls);

  // 7. Shareability — deterministic sample of canonical content pages.
  let shareability = null;
  if (opts.pages && classification?.canonicalList?.length) {
    const picked = sampleContentUrls(classification.canonicalList, {
      domain: norm.host, size: opts.sample, sections: SHAREABLE_SECTIONS,
    });
    if (!picked.urls.length) {
      notObserved.push('Shareability: no content URLs in a shareable section were found in the sitemap, so no pages could be sampled.');
    } else {
      const pages = await mapPool(picked.urls, opts.concurrency, async ({ url, section }) => {
        // Cross-host check: NVIDIA's sitemap lists www.nvidia.cn pages, which are
        // governed by that host's robots.txt, not this one's.
        if (!(await robotsReg.allowed(url))) {
          return { url, section, retrieved: false, reason: 'robots.txt for that host disallows this URL for our user-agent; it was not fetched.', evidence: null, via: null, credits: 0 };
        }
        const direct = await fetcher.get(url, { note: 'content sample' });
        let html = direct.ok ? direct.body : null;
        let via = 'direct';
        let credits = 0;

        const thin = html && html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length < 800;
        if (!direct.ok || thin) {
          const reason = direct.ok ? ESCALATION.THIN : ESCALATION.BLOCKED;
          const r = await bee.fetch(url, { reason, robotsAllowed: true });
          credits = r.credits || 0;
          if (r.ok && r.body) { html = r.body; via = `scrapingbee:${reason}`; }
          else if (!html) {
            return { url, section, retrieved: false, via: null, credits,
              reason: r.skipped ? r.note : (r.error || direct.error || `HTTP ${direct.status}`), evidence: null };
          }
        }
        return { url, section, retrieved: true, via, credits, reason: null, evidence: extractPage(html, url) };
      });

      const got = pages.filter((p) => p.retrieved && p.evidence);
      const pct = (n) => (got.length ? Math.round((n / got.length) * 1000) / 10 : null);
      const count = (fn) => got.filter((p) => fn(p.evidence)).length;
      shareability = {
        sampling: picked,
        pages_attempted: pages.length,
        pages_retrieved: got.length,
        pages_unretrieved: pages.filter((p) => !p.retrieved).map((p) => ({ url: p.url, reason: p.reason })),
        aggregates: got.length ? {
          og_complete: { n: count((e) => e.og_complete), pct: pct(count((e) => e.og_complete)) },
          og_image: { n: count((e) => e.has_og_image), pct: pct(count((e) => e.has_og_image)) },
          og_title: { n: count((e) => e.has_og_title), pct: pct(count((e) => e.has_og_title)) },
          og_description: { n: count((e) => e.has_og_description), pct: pct(count((e) => e.has_og_description)) },
          twitter_card: { n: count((e) => e.has_twitter_card), pct: pct(count((e) => e.has_twitter_card)) },
          canonical: { n: count((e) => e.has_canonical), pct: pct(count((e) => e.has_canonical)) },
          article_schema: { n: count((e) => e.has_article_schema), pct: pct(count((e) => e.has_article_schema)) },
          named_author: { n: count((e) => e.author.named_human_author), pct: pct(count((e) => e.author.named_human_author)) },
          share_affordance: { n: count((e) => e.has_share_affordance), pct: pct(count((e) => e.has_share_affordance)) },
        } : null,
        pages: got.map((p) => ({ url: p.url, section: p.section, via: p.via, credits: p.credits, ...p.evidence })),
        confidence_note: got.length < pages.length
          ? `${got.length} of ${pages.length} sampled pages were retrieved. Percentages describe the retrieved subset only.`
          : null,
      };
      if (got.length === 0) notObserved.push('Shareability: none of the sampled content pages could be retrieved. This category cannot be scored for this domain.');
    }
  } else if (opts.pages) {
    notObserved.push('Shareability: no sitemap URLs available to sample from.');
  }

  // 8. PRIVATE lead signals (spec §4). Never mixed into the public grade.
  let leadSignals = null;
  if (opts.ats) {
    const hints = [...(homepage?.ats_hints || []).map((h) => ({ ...h, found_in: 'homepage' }))];
    // Normalise so /careers and /careers/ are not paid for twice.
    const norm2 = (u) => u.replace(/\/+$/, '') || u;
    const careersCandidates = [...new Set([
      ...(homepage?.career_links_found || []).slice(0, 2),
      origin + '/careers', origin + '/jobs',
    ].map(norm2))];
    const careersChecked = [];
    let careersHtml = null, careersUrl = null;
    for (const cu of [...new Set(careersCandidates)].slice(0, 3)) {
      if (hints.length) break;
      if (!matcher.allowed(cu)) { careersChecked.push({ url: cu, skipped: 'robots.txt disallows' }); continue; }
      const r = await fetcher.get(cu, { note: 'careers page' });
      let html = r.ok ? r.body : null;
      let via = 'direct';
      let found = html ? detectAts(html, cu) : [];

      // Escalation trigger is "did we get what we came for", not page size. Gong's
      // careers page is 369KB of text with the job board injected client-side, so
      // a thin-HTML test never fires on it. If a careers page yields neither an ATS
      // link nor a single role title, the listing is rendered in the browser and a
      // plain fetch will never see it.
      // One lone title match is more often a stray heading than a job board, so
      // require an ATS link or at least two plausible roles before we believe the
      // direct fetch actually saw the listing.
      const directRoles = html ? extractSelfHostedRoles(html, cu) : null;
      const gotSomething = found.length > 0 || (directRoles?.approximate_open_reqs ?? 0) >= 2;
      if (r.ok && !gotSomething) {
        const b = await bee.fetch(cu, { reason: ESCALATION.THIN, robotsAllowed: true });
        if (b.ok && b.body) { html = b.body; via = 'scrapingbee:render'; found = detectAts(html, cu); }
        else if (b.error || b.note) careersChecked.push({ url: cu, proxy_retry_failed: b.error || b.note });
      }
      careersChecked.push({ url: cu, status: r.status, ok: r.ok, via,
        escalated: via !== 'direct', found_in_direct_html: gotSomething });
      hints.push(...found);
      if (html && !careersHtml) { careersHtml = html; careersUrl = cu; }

      // One hop to a vanity jobs subdomain. NVIDIA's careers page links to
      // jobs.nvidia.com, which is where the ATS actually lives — §1's Workday
      // tenant is reachable from there, not from the careers page itself.
      if (!hints.length && html) {
        for (const sub of findJobSubdomainLinks(html, cu)) {
          if (!(await robotsReg.allowed(sub))) { careersChecked.push({ url: sub, skipped: 'robots.txt for that host disallows it' }); continue; }
          const sr = await fetcher.get(sub, { note: 'jobs subdomain' });
          let shtml = sr.ok ? sr.body : null;
          let svia = 'direct';
          let sfound = shtml ? detectAts(shtml, sub) : [];
          if (sr.ok && !sfound.length) {
            const b = await bee.fetch(sub, { reason: ESCALATION.THIN, robotsAllowed: true });
            if (b.ok && b.body) { shtml = b.body; svia = 'scrapingbee:render'; sfound = detectAts(shtml, sub); }
          }
          careersChecked.push({ url: sub, status: sr.status, ok: sr.ok, via: svia, hop: 'jobs subdomain' });
          hints.push(...sfound);
          if (shtml && !careersHtml) { careersHtml = shtml; careersUrl = sub; }
          if (hints.length) break;
        }
      }
    }

    const deduped = [];
    for (const h of hints) if (!deduped.some((d) => d.ats === h.ats && d.token === h.token)) deduped.push(h);

    let jobsResult = { jobs: null, usedAts: null, attempts: [] };
    if (deduped.length) jobsResult = await pullJobs(fetcher, deduped);

    leadSignals = {
      visibility: 'PRIVATE — never rendered in the public report. Hiring pressure is a need signal, not a quality signal (spec §4).',
      careers_pages_checked: careersChecked,
      ats_detected: deduped,
      ats_attempts: jobsResult.attempts,
      ats_used: jobsResult.usedAts,
      hiring: analyzeJobs(jobsResult.jobs),
      self_hosted_board: null,
    };
    // No ATS, or an ATS that returned nothing: fall back to the careers page itself.
    if (!jobsResult.jobs && careersHtml) {
      leadSignals.self_hosted_board = extractSelfHostedRoles(careersHtml, careersUrl);
    }
    if (!deduped.length) notObserved.push('ATS: no Greenhouse, Lever, Ashby, Workday, SmartRecruiters or Workable link was found on the homepage or careers pages. Hiring signals are unavailable for this domain.');
    else if (!jobsResult.jobs) notObserved.push(`ATS: ${deduped.map((d) => d.ats).join(', ')} detected but no job data could be retrieved. See lead_signals.ats_attempts.`);
  }

  return envelope({
    startedAt, t0, norm, resolved, fetcher, warnings, notObserved, opts, origin,
    robots: robotsBlock, llms: llmsBlock, sitemaps: sm, classification, recency, homepage,
    languageResolution, shareability, leadSignals, bee, robotsReg,
  });
}

function envelope(ctx) {
  const {
    startedAt, t0, norm, resolved, fetcher, warnings, notObserved, opts, origin = null,
    robots = null, llms = null, sitemaps = null, classification = null, recency = null,
    homepage = null, languageResolution = null, blockedAtRoot = false, shareability = null, leadSignals = null, bee = null, robotsReg = null,
  } = ctx;

  const out = {
    schema: 'advocacy-grader/evidence',
    phase: 3,
    disclaimer: 'Raw observation only. No scores, no model output, no inference. Every number below is derived from a request recorded in meta.fetch_log.',
    meta: {
      version: VERSION,
      user_agent: UA,
      input: opts.domain,
      normalized_host: norm?.host ?? null,
      resolved_origin: origin,
      origin_attempts: resolved?.attempts ?? [],
      started_at: startedAt.toISOString(),
      elapsed_ms: Date.now() - t0,
      requests_made: fetcher.log.length,
      bytes_downloaded: fetcher.log.reduce((n, e) => n + (e.bytes || 0), 0),
      fetch_log: fetcher.log,
      caps: { max_sitemaps: opts.maxSitemaps, max_urls: opts.maxUrls, timeout_ms: opts.timeout, sample_size: opts.sample, max_credits: opts.maxCredits },
      scrapingbee: bee ? bee.report() : null,
      robots_hosts: robotsReg ? robotsReg.report() : null,
    },
    robots,
    llms_txt: llms,
    sitemaps: sitemaps
      ? {
          seeds_tried: sitemaps.documents.map((d) => d.url),
          documents: sitemaps.documents,
          documents_fetched: sitemaps.documents.filter((d) => d.kind === 'urlset' || d.kind === 'index').length,
          urls_collected: sitemaps.urls.length,
          duplicate_urls_removed: sitemaps.duplicates ?? 0,
          recency,
        }
      : null,
    homepage,
    language_resolution: languageResolution,
    classification,
    shareability,
    lead_signals: leadSignals,
    blocked_at_root: blockedAtRoot,
    warnings,
    not_observed: notObserved,
  };



  if (opts.score) {
    out.scoring = scoreEvidence(out);
    out.lead_score = leadScore(out, out.scoring.overall_score, { domain: out.meta?.normalized_host || out.meta?.input || null });
  }
  return out;
}


// ---------------------------------------------------------------- fast probe
// Phase 1 of the live lookup: robots.txt + llms.txt + homepage only, direct
// fetches, no proxy escalation, no sitemaps. Measured across all 350
// calibration domains this tier runs at median 721ms, p90 1.9s, p99 15s.
// Returns a partial evidence bundle that lib/findings.js accepts as-is
// (fast-tier findings only). Never throws on unreachable sites — an
// unreachable source becomes a recorded absence, which findings.js turns
// into a limitation finding.
export async function fastProbe(domainInput, { timeoutMs = 6000 } = {}) {
  const startedAt = new Date();
  const t0 = Date.now();
  const norm = normalizeDomain(domainInput);
  if (!norm) return { error: `Could not parse "${domainInput}" as a domain.` };
  const _pc = hostPreCheck(norm.host);
  if (_pc.blocked) return { error: `Cannot grade "${domainInput}": ${_pc.reason}.` };
  const fetcher = new Fetcher({ timeoutMs });

  const resolved = await resolveOrigin(fetcher, norm);
  // robots.txt is often readable even when the homepage 403s a bot shield;
  // try it on every candidate origin until one answers.
  const origins = resolved.origin ? [resolved.origin] : resolved.attempts.map((a) => a.origin);
  let robotsBlock = { present: false, status: null, reason: 'not retrievable', raw: null, declared_sitemaps: [], ai_posture: null };
  let robotsParsed = { groups: [], sitemaps: [], unknownDirectives: [] };
  let robotsOrigin = null;
  for (const o of origins) {
    const r = await fetcher.get(o + '/robots.txt', { note: 'robots.txt (fast probe)', accept: 'text/plain,*/*' });
    if (r.ok && r.body && !/^\s*<(!doctype|html)/i.test(r.body)) {
      robotsParsed = parseRobots(r.body);
      robotsBlock = { present: true, status: r.status, bytes: r.bytes, url: r.finalUrl, raw: r.body,
        group_count: robotsParsed.groups.length, declared_sitemaps: robotsParsed.sitemaps,
        unknown_directives: robotsParsed.unknownDirectives, ai_posture: aiPosture(robotsParsed) };
      robotsOrigin = o;
      break;
    }
    robotsBlock.status = r.status ?? robotsBlock.status;
    robotsBlock.reason = r.error || (r.ok ? 'endpoint returned HTML, not a robots.txt' : `HTTP ${r.status}`);
  }

  const matcher = makeMatcher(robotsParsed, UA_TOKEN);
  const blockedAtRoot = robotsBlock.present && !matcher.allowed('/');

  let llmsBlock = { checked: false, present: false };
  let homepage = null;
  if (!blockedAtRoot && robotsOrigin) {
    if (matcher.allowed('/llms.txt')) {
      const lr = await fetcher.get(robotsOrigin + '/llms.txt', { note: 'llms.txt (fast probe)', accept: 'text/plain,*/*' });
      const present = Boolean(lr.ok && lr.body && !/^\s*<(!doctype|html)/i.test(lr.body));
      llmsBlock = { checked: true, present, status: lr.status ?? null };
    }
  }
  if (!blockedAtRoot && resolved.homepage?.ok) {
    homepage = extractHomepage(resolved.homepage.body, resolved.origin);
  }

  return {
    schema: 'advocacy-grader/evidence-fast',
    meta: {
      version: VERSION, user_agent: UA, input: domainInput, normalized_host: norm.host,
      resolved_origin: resolved.origin, origin_attempts: resolved.attempts,
      started_at: startedAt.toISOString(), elapsed_ms: Date.now() - t0,
      requests_made: fetcher.log.length, fetch_log: fetcher.log,
    },
    robots: robotsBlock,
    llms_txt: llmsBlock,
    homepage,
    blocked_at_root: blockedAtRoot,
  };
}

// Derived values (scores, lead score) are computed fresh from evidence by
// lib/rubric.js on every read. Persisting them creates a STALE copy that later
// readers mistake for the current grade — that trap produced three separate
// false claims during this build. Nothing is written to disk with them attached.
export function stripDerived(evidence) {
  const { scoring, lead_score, ...rest } = evidence || {};
  return {
    ...rest,
    derived_note:
      'Scores are NOT stored. Derive them at read time with scoreEvidence() from lib/rubric.js ' +
      '(see tools/rescore.js). Any grade you did not just compute is not a grade.',
  };
}
