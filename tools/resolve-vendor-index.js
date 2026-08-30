#!/usr/bin/env node
// Pass 2 over the raw vendor app index:
//   1. drop the vendors' own flagship apps (they have no customer behind them)
//   2. resolve a domain for rows whose vendor stamped its OWN url on every app
//   3. assign a confidence tier with the evidence that justifies it
//
// The resolution in step 2 is a GUESS (<token>.com) that is then VERIFIED
// against the live site, and only verified guesses are kept. An unverified
// guess is left unresolved rather than written down as a fact -- an index that
// silently invents domains would produce false "already a customer" verdicts,
// which is exactly the failure spec §7 rule 1 forbids.
//
// Resumable:one row per cache entry. Re-run until it prints ALL ROWS RESOLVED.

import fs from 'node:fs/promises';
import path from 'node:path';
import { VENDOR_BY_KEY } from '../lib/vendors.js';
import { registrableDomain } from '../lib/domain.js';
import { UA, UA_TOKEN } from '../lib/http.js';
import { parseRobots, makeMatcher } from '../lib/robots.js';
import { mapPool } from '../lib/pool.js';

const IN = path.resolve(process.cwd(), 'data/vendor-app-index.json');
const OUT = path.resolve(process.cwd(), 'data/incumbent-index.json');
const CACHE = path.resolve(process.cwd(), 'data/.resolve-cache.json');
const BUDGET_MS = Number(process.env.BUDGET_MS || 33000);
const t0 = Date.now();
const outOfTime = () => Date.now() - t0 > BUDGET_MS;
const log = (...a) => console.error(...a);

// Bundle segments that are packaging, not a customer name.
const NOISE = new Set(['cb', 'app', 'apps', 'ios', 'android', 'appstore', 'mobile', 'engage', 'prod', 'production', 'release', 'member', 'intune', 'client', 'v2', 'new', 'store']);
// Generic words that are a product name, not a company. Resolving these to
// "<word>.com" lands on an unrelated business (social.com -> salesforce.com),
// which would be a fabricated customer. Never resolve them by domain guess.
const GENERIC = new Set(['social', 'live', 'connect', 'connected', 'hub', 'news', 'team', 'teams', 'one', 'my', 'share', 'sharing', 'portal', 'intranet', 'community', 'work', 'workplace', 'people', 'inside', 'pulse', 'voice', 'plus', 'now', 'today', 'link', 'net', 'space', 'place', 'world', 'life', 'together', 'us', 'we', 'home', 'central', 'daily', 'insider', 'buzz', 'wave', 'spark', 'loop', 'nexus', 'compass', 'beacon', 'amplify', 'advocacy', 'ambassador', 'ambassadors', 'socialarmy', 'internal', 'comms',
  // Common nouns that companies use as PRODUCT names. "River by Hudson's Bay"
  // resolved river.com (a Bitcoin company) because the token appeared in that
  // site's title -- coincidence, not corroboration.
  'river', 'compass', 'canopy', 'source', 'atlas', 'summit', 'bridge', 'anchor',
  'prism', 'orbit', 'forge', 'harbor', 'harbour', 'horizon', 'mosaic', 'oasis',
  'pinnacle', 'quest', 'ripple', 'stream', 'vertex', 'vista', 'zenith', 'echo',
  'ember', 'flare', 'grove', 'haven', 'ignite', 'junction', 'lantern', 'meridian',
  'summit', 'catalyst', 'current', 'element', 'engage', 'fusion', 'genesis',
  'horizon', 'impact', 'insight', 'legacy', 'momentum', 'origin', 'pathway',
  'pioneer', 'radar', 'signal', 'spectrum', 'unity', 'vantage', 'venture', 'vision', 'beats', 'nature', 'network', 'mobile', 'digital', 'global', 'group', 'gruppe', 'family', 'academy', 'campus', 'base']);
// Tokens that ARE the vendor itself.
const SELF_TOKENS = new Set(['dsmn8', 'board', 'sociabble', 'ambassify', 'oktopost', 'gaggleamp', 'staffbase', 'simpplr', 'haiilo', 'coyo', 'unily', 'lumapps', 'workvivo', 'speakap', 'beekeeper', 'yoobic', 'talkspirit', 'sprinklr', 'firstup', 'socialchorus', 'everyonesocial', 'clearviewsocial', 'apostle', 'socxo', 'postbeyond', 'denimsocial', 'theemployeeapp', 'jostle', 'interact', 'hootsuite', 'smarpshare', 'voicestorm', 'messenger']);

const cleanToken = (tok) => {
  if (!tok) return null;
  const parts = String(tok).toLowerCase().split('.').filter((p) => p && !NOISE.has(p));
  return parts.length ? parts[parts.length - 1].replace(/[^a-z0-9-]/g, '') : null;
};
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const PARKED = /(domain\s+(is\s+)?for\s+sale|buy\s+this\s+domain|parked\s+(free\s+)?at|godaddy|sedo|namecheap\s+parking|under\s+construction)/i;
// Domain brokers and parking services. An unregistered <token>.com often
// redirects to one of these, which the "candidate is owned and redirected"
// rule would otherwise read as corroboration -- collapsing many unrelated
// companies onto one broker domain.
const PARKING_HOSTS = new Set(['hugedomains.com', 'sedo.com', 'sedoparking.com', 'dan.com', 'afternic.com', 'undeveloped.com', 'buydomains.com', 'domainmarket.com', 'squadhelp.com', 'atom.com', 'namecheap.com', 'godaddy.com', 'bodis.com', 'parkingcrew.com', 'above.com', 'uniregistry.com', 'domain.com', 'name.com', 'escrow.com', 'brandbucket.com', 'saw.com']);

async function fetchText(url, timeout = 8000) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
    return { ok: res.ok, status: res.status, finalUrl: res.url, text: await res.text() };
  } catch (e) { return { ok: false, status: null, error: e.message }; }
}

// Try <token>.com and record WHICH evidence fired. The caller turns that into a
// confidence tier.
//
// The trap this avoids: "the token appears in the resolved domain" is
// tautological -- the candidate was BUILT from the token, so it is always true
// when there is no redirect. It is not corroboration and is never scored as
// such. Real corroboration is the site naming the company independently, or
// the candidate redirecting to a domain the same company owns.
async function verifyCandidate(token, appName) {
  if (GENERIC.has(token)) {
    return { domain: null, signal: 'generic_word', why: `"${token}" is a generic product word, not a company name. Resolving it to ${token}.com would land on an unrelated business, so no domain was attempted.` };
  }
  const candidate = `${token}.com`;
  const rb = await fetchText(`https://${candidate}/robots.txt`, 8000);
  if (rb.ok && rb.text) {
    const m = makeMatcher(parseRobots(rb.text), UA_TOKEN);
    if (m && typeof m.allowed === 'function' && !m.allowed('/')) {
      return { domain: null, signal: 'robots_blocked', why: `robots.txt on ${candidate} disallows our user-agent at /; not fetched (spec §7 rule 5)` };
    }
  }

  const res = await fetchText(`https://${candidate}/`);
  if (!res.ok && res.status) {
    // A site that answers but refuses our user-agent is NOT evidence the domain
    // is wrong -- it is evidence the domain exists and blocks bots. Being
    // blocked is data (spec §7 rule 5).
    if ([401, 403, 405, 406, 429, 503].includes(res.status)) {
      return { domain: candidate, signal: 'exists_blocked', why: `https://${candidate}/ exists but returned HTTP ${res.status} to our user-agent, so nothing on the page could corroborate it. The only evidence is that the bundle-id token "${token}" spells a live registrable domain.` };
    }
    return { domain: null, signal: 'no_site', why: `https://${candidate}/ did not resolve (HTTP ${res.status})` };
  }
  if (!res.ok) return { domain: null, signal: 'no_site', why: `https://${candidate}/ did not resolve (${res.error})` };
  if ((res.text || '').length < 2000) return { domain: null, signal: 'no_site', why: `https://${candidate}/ returned a near-empty page (${(res.text || '').length} bytes)` };

  const title = ((res.text.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  const ogSite = ((res.text.match(/property=["']og:site_name["'][^>]*content=["']([^"']{0,120})["']/i) || [])[1] || '').trim();
  if (PARKED.test(title) || PARKED.test(res.text.slice(0, 3000))) {
    return { domain: null, signal: 'parked', why: `${candidate} looks like a parked or for-sale domain (title: "${title}")` };
  }

  const finalDomain = registrableDomain(res.finalUrl) || candidate;
  if (PARKING_HOSTS.has(finalDomain)) {
    return { domain: null, signal: 'parked', why: `${candidate} redirects to the domain broker ${finalDomain}, so the domain is unregistered or for sale -- not a company site.` };
  }
  const hay = norm(title + ' ' + ogSite);
  const appWords = norm(appName);

  // Independent corroboration: the live site names the company or the app.
  // Token length >= 6 for the title rule: a 4-5 character token collides with
  // ordinary words in ordinary page titles far too often to count as evidence.
  if (norm(token).length >= 6 && hay.includes(norm(token))) {
    return { domain: finalDomain, signal: 'title_match', title, why: `${candidate} resolves to ${finalDomain} and its own page title names "${token}" ("${title}") -- the site corroborates the app independently of how the candidate was constructed.` };
  }
  if (appWords.length >= 5 && hay.includes(appWords)) {
    return { domain: finalDomain, signal: 'title_match', title, why: `${candidate} resolves to ${finalDomain} and its page title contains the app name "${appName}" ("${title}").` };
  }
  // The candidate is a real domain the company redirects to its primary one.
  // Redirect rule needs a 6+ character token for the same reason the title rule
  // does: "beats".com redirects to an unrelated bestweb.com.
  if (finalDomain !== candidate && token.length >= 6) {
    return { domain: finalDomain, signal: 'redirect_owned', title, why: `${candidate} is owned and redirected to ${finalDomain} (title: "${title}"); holding and redirecting the token domain is itself evidence of the same owner.` };
  }
  return { domain: finalDomain, signal: 'exists_only', title, why: `${candidate} is a live site (title: "${title}") but nothing on it names "${token}" or "${appName}". The only evidence is that the token spells a live domain.` };
}

async function main() {
  const raw = JSON.parse(await fs.readFile(IN, 'utf8'));
  const preResolved = [];

  // Fold in the Google Play half. Play carries no customer domain, so its only
  // contribution is Android-only customers the App Store never saw. A Play row
  // whose vendor+token already came from iOS is dropped, not duplicated.
  const play = await fs.readFile(path.resolve(process.cwd(), 'data/play-app-index.json'), 'utf8')
    .then(JSON.parse).catch(() => ({ rows: [] }));
  const seen = new Set(raw.rows.map((r) => `${r.vendor_key}::${norm(cleanToken(r.customer_token))}`));
  let added = 0;
  for (const r of play.rows) {
    const k = `${r.vendor_key}::${norm(cleanToken(r.customer_token))}`;
    if (seen.has(k)) continue;
    seen.add(k); raw.rows.push(r); added++;
  }
  if (added) log(`folded in ${added} Android-only row(s) from Google Play`);

  // Fold in the vendor-published web evidence (logo walls, case studies,
  // testimonials, Wayback). These arrive already resolved and already carry a
  // confidence tier, so they bypass the token verifier below.
  //
  // NOTHING IS COLLAPSED ACROSS VENDORS. The dedupe key is vendor+company, so a
  // company named by two vendors keeps two rows. That is not duplication -- it
  // is a stack, a switch, or a stale claim, and which one it is matters.
  const web = await fs.readFile(path.resolve(process.cwd(), 'data/web-customer-resolved.json'), 'utf8')
    .then(JSON.parse).catch(() => ({ rows: [] }));
  let webAdded = 0;
  for (const r of web.rows) {
    const k = `${r.vendor_key}::${norm(r.customer_token || r.customer_name)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    preResolved.push(r); webAdded++;
  }
  if (webAdded) log(`folded in ${webAdded} row(s) from vendor-published web evidence`);
  const cache = await fs.readFile(CACHE, 'utf8').then(JSON.parse).catch(() => ({}));
  let pending = 0, resolvedNow = 0;

  const out = [];
  const todo = [];
  const emit = [];
  for (const row of raw.rows) {
    const vendor = VENDOR_BY_KEY[row.vendor_key];
    const token = cleanToken(row.customer_token);

    // 1. the vendor's own app, not a customer's
    const vKey = norm(vendor?.key), vName = norm(vendor?.name).slice(0, 12);
    const isSelf = !token || SELF_TOKENS.has(token)
      || (vKey.length >= 4 && norm(token).includes(vKey))
      || (vName.length >= 5 && norm(token).includes(vName));
    if (!row.domain && isSelf) continue;
    if (row.domain && registrableDomain(vendor?.domain) === row.domain) continue;

    if (row.domain) {
      emit.push({ ...row, customer_token: token, confidence: 'confirmed',
        confidence_basis: `The vendor declared ${row.domain} as the seller URL on a customer-specific app (${row.evidence.bundle_id}) published from its own developer account.` });
      continue;
    }

    const key = row.evidence.bundle_id;
    if (!(key in cache)) { todo.push({ key, token, row }); continue; }
    const v = cache[key];
    if (v.domain) {
      // Independent corroboration, or a token long enough that spelling a live
      // domain by coincidence is implausible -> probable. A short token with no
      // corroboration is only possible: "wcu" spelling wcu.com proves nothing.
      // Only independent corroboration earns "probable". Token length is NOT a
      // substitute: "thesource" (9 chars) resolved thesource.com for Coupa's
      // app, and "rockstarrs" (10) resolved rockstarrs.com for a Unily program.
      // Long tokens are just as often the product's name as the company's.
      const corroborated = v.signal === 'title_match' || v.signal === 'redirect_owned';
      const conf = corroborated ? 'probable' : 'possible';
      emit.push({ ...row, domain: v.domain,
        domain_source: `inferred from bundle-id token (${v.signal})`,
        customer_token: token, confidence: conf, resolution_signal: v.signal,
        confidence_basis: `${row.vendor_name} publishes ${key} from its own developer account, which names "${token}", but it listed its OWN url as the seller so the domain is not vendor-declared. ${v.why}${corroborated ? '' : ' Nothing on the live site names this company, so the token may be the PRODUCT name rather than the company name. Unconfirmed: do not assert this match.'}` });
    } else {
      emit.push({ ...row, domain: null, customer_token: token, confidence: 'named_unresolved', resolution_signal: v.signal,
        confidence_basis: `A customer-specific app (${key}) exists under ${row.vendor_name}'s developer account, naming "${token}", but no domain could be verified: ${v.why} Not matchable by domain.` });
    }
  }

  // Resolve the uncached rows concurrently. Every candidate is a different
  // host, so there is no single-site hammering here.
  if (todo.length) {
    const batch = todo.slice(0, Number(process.env.BATCH || 120));
    pending = todo.length - batch.length;
    log(`resolving ${batch.length} candidate domain(s), ${pending} left after this pass`);
    await mapPool(batch, Number(process.env.CONCURRENCY || 8), async (item) => {
      const v = await verifyCandidate(item.token, item.row.evidence.app_name);
      cache[item.key] = v; resolvedNow++;
      log(`  ${item.key} -> ${v.domain || 'UNRESOLVED'}  (${v.why})`);
      // Flush as we go: each shell invocation is short-lived and a batch that
      // is cut off mid-flight must not lose the work already done.
      if (resolvedNow % 10 === 0) await fs.writeFile(CACHE, JSON.stringify(cache, null, 2));
    });
    await fs.writeFile(CACHE, JSON.stringify(cache, null, 2));
    log(`\nresolved ${resolvedNow} this pass; re-run to fold them into the index.`);
  }

  for (const r of preResolved) {
    const nm = String(r.customer_name || '');
    // A single short word ("Scala", "Poet", "Disco") can title-match an
    // unrelated business. Flagged rather than silently trusted.
    r.low_specificity_name = nm.split(/\s+/).length === 1 && nm.replace(/[^A-Za-z0-9]/g, '').length <= 6;
    if (r.low_specificity_name && r.confidence === 'probable') {
      r.confidence_basis += ' NOTE: the published name is a single short word, which can match an unrelated company of the same name — verify before using it.';
    }
  }
  out.push(...emit, ...preResolved);
  const domains = {};
  for (const r of out) if (r.domain) (domains[r.domain] ||= []).push(r);

  const tally = out.reduce((a, r) => { a[r.confidence] = (a[r.confidence] || 0) + 1; return a; }, {});
  const final = { schema: 2, built_at: raw.built_at, resolved_at: new Date().toISOString(),
    method: raw.method,
    limitations: [...raw.limitations,
      'Google Play\'s static developer page lists at most 20 apps, so Play coverage is a partial top-up rather than a full customer list for any vendor.',
      'Play listings carry the VENDOR\'s website, never the customer\'s, so every Play-sourced row is domain-inferred at best.'],
    vendors: raw.vendors,
    counts: { rows: out.length, distinct_domains: Object.keys(domains).length, by_confidence: tally },
    domains, rows: out };
  await fs.writeFile(OUT, JSON.stringify(final, null, 2));

  log(`\nrows=${out.length} domains=${Object.keys(domains).length}`, JSON.stringify(tally));
  if (pending || todo.length) log(`${pending || 0} row(s) still to verify -- re-run to continue.`);
  else log('ALL ROWS RESOLVED.');
}
main().catch((e) => { console.error(e); process.exit(1); });
