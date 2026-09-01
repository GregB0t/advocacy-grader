// Incumbent-vendor lookup. PRIVATE ONLY -- never rendered to the visitor.
//
// Answers: does this company already run an employee advocacy or employee
// communications platform, and how do we know?
//
// The evidence is a white-labeled mobile app published under the vendor's own
// Apple developer account. That is a real, checkable artefact, and every
// verdict below carries the artefact that produced it.
//
// THE ASYMMETRY THAT GOVERNS THIS MODULE
// A hit is strong evidence. A miss is NOT evidence of absence, and this module
// never says "no incumbent" -- only "nothing found in the index". Vendors
// without a white-label tier, web-only rollouts and Android-only deployments
// are all invisible here. Saying otherwise would be stating a finding the tool
// did not observe (spec §7 rule 3).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { registrableDomain } from './domain.js';

// Resolved at CALL time, never at import time. lib/scrapingbee.js's loadEnv()
// returns an object and does NOT populate process.env, so a value that lives
// only in .env is invisible to a module-level read -- the same trap phase G
// found in verifyTurnstile. Callers holding the merged env (server.js) pass the
// path in explicitly; everything else falls back to process.env, then to the
// repo default.
export function defaultIndexPath() {
  return process.env.INCUMBENT_INDEX
    || path.resolve(new URL('..', import.meta.url).pathname, 'data/incumbent-index.json');
}

// Suffixes are peeled right to left, so `index.json`, `index.json.gz` and
// `index.json.gz.b64` all load the same object. This is one index in three
// encodings, not three indexes.
//
// WHY .b64 EXISTS AND IS NOT PARANOIA. The plain index is ~5.2MB. Render caps
// the COMBINED size of a service's secret files at 1MB, and its secret-file UI
// is a paste-in Contents field for "plaintext files" -- raw gzip bytes do not
// survive a textarea. So the deployable form is gzip THEN base64:
//   full index  ~4.2MB json -> 382KB gz -> 509KB base64
//   slim index  ~1.7MB json -> 150KB gz -> 200KB base64   <- built by
//                                        tools/build-incumbent-secret.js
// Both fit. Neither is a different index; see that tool for what "slim" drops
// and why the server does not need it.
function readIndexFile(file) {
  let buf = fs.readFileSync(file);
  let name = file;
  if (name.endsWith('.b64')) {
    buf = Buffer.from(buf.toString('utf8').replace(/\s+/g, ''), 'base64');
    name = name.slice(0, -4);
  }
  if (name.endsWith('.gz')) {
    buf = zlib.gunzipSync(buf);
    name = name.slice(0, -3);
  }
  return JSON.parse(buf.toString('utf8'));
}

// Memoised PER PATH. A single module-level cache ignored the `file` argument
// after the first call, so a second index could never be loaded in one process
// -- untestable, and silently wrong for anything that switched paths.
let _index = null;
let _indexPath = null;
export function loadIndex(file = defaultIndexPath()) {
  if (_index && _indexPath === file) return _index;
  _indexPath = file;
  try {
    _index = readIndexFile(file);
    _index.missing = false;
  } catch (err) {
    _index = { domains: {}, rows: [], counts: {}, missing: true, load_error: err.code || err.message };
  }
  return _index;
}

// Test seam only. The per-path memo above is process-wide by design.
export function _resetIndexCache() { _index = null; _indexPath = null; }

// Confidence is a statement about the EVIDENCE, not about the relationship.
// "confirmed" means the vendor itself declared this domain; it does not mean
// the contract is still live.
const CONFIDENCE = {
  confirmed: { score: 90, label: 'Confirmed',
    means: 'The vendor named this company\'s own domain as the seller of the app, on an app published from the vendor\'s developer account. The vendor is asserting the relationship.' },
  probable: { score: 70, label: 'Probable',
    means: 'The vendor publishes an app whose bundle id names this company, and the company\'s live site independently corroborates the match. The vendor did not name the domain itself.' },
  possible: { score: 40, label: 'Possible',
    means: 'The vendor publishes an app whose bundle id names this company, and that name spells a live domain -- but nothing independently corroborates it, so the token may be the product\'s name rather than the company\'s. Verify before acting.' },
};

const TIER_MEANING = {
  advocacy: 'A direct competitor. This platform\'s job is getting employees to share company content externally, which is the same job EveryoneSocial does. Treat as a displacement conversation.',
  comms: 'An internal comms / intranet / frontline platform. Several of these bundle an advocacy or social-sharing module, but the app proves the platform only -- NOT that this company bought or uses that module. Often complementary rather than competing.',
  social: 'A social media management suite with an advocacy add-on. Proves social-media tooling and budget; does not prove an advocacy programme.',
};

// Freshness is reported, never scored. Greg deferred the churn-signal
// derivative; this exposes the raw dates so it can be built later without
// another index rebuild.
function ageNote(row, now = new Date()) {
  const last = row.evidence?.last_updated ? new Date(row.evidence.last_updated) : null;
  const first = row.evidence?.first_released ? new Date(row.evidence.first_released) : null;
  if (!last) return null;
  const months = Math.round((now - last) / (1000 * 60 * 60 * 24 * 30.44));
  return {
    first_released: first ? first.toISOString().slice(0, 10) : null,
    last_updated: last.toISOString().slice(0, 10),
    months_since_update: months,
    note: months >= 24
      ? `The customer app has not been updated in about ${months} months. That is consistent with a dormant or lapsed deployment, but an unmaintained app is not proof of churn.`
      : `The customer app was updated about ${months} month(s) ago, which is consistent with an active deployment.`,
  };
}

export function lookupIncumbent(domainOrUrl, { indexPath = null } = {}) {
  const idx = loadIndex(indexPath || defaultIndexPath());
  const domain = registrableDomain(domainOrUrl);

  // A MISSING INDEX AND A GENUINE MISS ARE NOT THE SAME FINDING, and until
  // 2026-09-01 this module reported them identically: both returned
  // status 'no_evidence_in_index' and the sentence "Nothing found for X in the
  // incumbent index". In production, where no index is loaded at all, that is a
  // claim that a search ran and came back empty. No search ran. Spec section 7
  // rule 3 -- never state a finding the tool did not observe. The only tell was
  // index_built_at being null, and the lead row does not carry that field.
  if (idx.missing) {
    return {
      visibility: 'PRIVATE -- never shown to the visitor.',
      domain,
      index_loaded: false,
      index_built_at: null,
      status: 'no_index_loaded',
      already_a_client: null,
      confidence_score: null,
      sales_motion: 'unknown',
      summary: `No incumbent index is loaded in this environment, so ${domain || 'this domain'} was never looked up. This is not a miss: no search was performed.`,
      caveat: 'The incumbent signal is UNAVAILABLE here, not empty. Point INCUMBENT_INDEX at a readable index (.json, .json.gz, or .json.gz.b64) to enable it. Until then this field says nothing whatsoever about whether this company runs an advocacy or comms platform.',
      stack: { advocacy: [], comms: [], social: [] },
      competing_claims: null,
      former_relationships: [],
      currently_published: null,
      matches: [],
    };
  }

  const rows = (domain && idx.domains?.[domain]) || [];

  const found = rows
    .filter((r) => !r.is_client_vendor)
    .map((r) => ({
      vendor: r.vendor_name,
      vendor_key: r.vendor_key,
      category: r.vendor_tier,
      category_means: TIER_MEANING[r.vendor_tier],
      confidence: r.confidence,
      low_specificity_name: Boolean(r.low_specificity_name),
      confidence_label: CONFIDENCE[r.confidence]?.label,
      confidence_score: CONFIDENCE[r.confidence]?.score ?? null,
      what_confidence_means: CONFIDENCE[r.confidence]?.means,
      how_we_know: r.confidence_basis,
      deployment: ageNote(r),
      evidence_kind: r.evidence.bundle_id ? 'white-labeled mobile app' : 'vendor-published customer claim',
      historical: Boolean(r.evidence.historical),
      evidence: r.evidence.bundle_id ? {
        source: r.evidence.source,
        app_name: r.evidence.app_name,
        bundle_id: r.evidence.bundle_id,
        published_by: `${r.evidence.developer_account}${r.evidence.developer_id ? ` (Apple developer id ${r.evidence.developer_id})` : ''}`,
        app_store_url: r.evidence.app_url,
        vendor_declared_seller_url: r.evidence.seller_url,
        description_excerpt: r.evidence.description_excerpt,
      } : {
        source: r.evidence.source,
        named_as: r.customer_name,
        claim: r.evidence.claim,
        page: r.evidence.app_url,
        // quoted_contact removed: the contact name/title fields were stripped from the
        // datasets (personal data of testimonial authors; owner decision 2026-08-30).
        retrieved_via: r.evidence.retrieved_via || null,
        archived_capture: r.evidence.archived_timestamp || null,
        no_longer_published: r.evidence.historical
          ? 'This case study is in the Wayback Machine but is no longer in the vendor\'s live sitemap. A page can be removed for many reasons; a removal is consistent with a lapsed relationship but does not establish one.'
          : null,
      },
    }))
    .sort((a, b) => (b.confidence_score - a.confidence_score) || a.vendor.localeCompare(b.vendor));

  // The client's own customers are worth knowing about, separately.
  const isExistingClient = rows.some((r) => r.is_client_vendor);

  const best = found[0] || null;
  const hasDirectCompetitor = found.some((f) => f.category === 'advocacy');
  const advocacyVendors = [...new Set(found.filter((f) => f.category === 'advocacy').map((f) => f.vendor))];
  const historical = found.filter((f) => f.historical);
  const current = found.filter((f) => !f.historical);

  return {
    visibility: 'PRIVATE — never shown to the visitor.',
    domain,
    index_loaded: true,
    index_built_at: idx.built_at || null,
    status: found.length ? 'evidence_found' : 'no_evidence_in_index',
    already_a_client: isExistingClient,
    confidence_score: best?.confidence_score ?? 0,
    sales_motion: hasDirectCompetitor ? 'displacement'
      : found.length ? 'adjacent_platform'
      : 'unknown',
    summary: found.length
      ? `${found.length} platform relationship(s) found for ${domain}: ${found.map((f) => `${f.vendor} (${f.confidence_label.toLowerCase()})`).join(', ')}.`
      : `Nothing found for ${domain} in the incumbent index. This is NOT evidence that the company has no advocacy or comms platform — see caveat.`,
    caveat: found.length
      ? 'Two different kinds of evidence sit behind these matches. A white-labeled app proves a relationship existed when the app was published. A vendor-published claim (logo wall, case study, testimonial) proves the VENDOR SAYS SO — vendors do not date their logo walls, and stale customers are rarely taken down. Neither proves the contract is current, and none of it should be repeated to the visitor.'
      : 'The index only sees vendors that publish white-labeled customer apps on the Apple App Store. A company running a web-only deployment, an Android-only deployment, or a vendor with no white-label tier is invisible here. Absence must be reported as "not found", never as "no incumbent".',
    // Vendors are never merged together. A company named by more than one is a
    // fact worth reading, not a duplicate to collapse.
    stack: {
      advocacy: [...new Set(found.filter((f) => f.category === 'advocacy').map((f) => f.vendor))],
      comms: [...new Set(found.filter((f) => f.category === 'comms').map((f) => f.vendor))],
      social: [...new Set(found.filter((f) => f.category === 'social').map((f) => f.vendor))],
    },
    competing_claims: advocacyVendors.length > 1 ? {
      vendors: advocacyVendors,
      reading: `${advocacyVendors.length} direct competitors each publish this company as a customer. That is either a switch (one claim is stale and was never taken down), a genuine multi-tool estate, or one vendor overstating a pilot. Check the dates on each claim before using either name in a conversation.`,
    } : null,
    former_relationships: historical.length ? historical.map((f) => ({
      vendor: f.vendor, evidence: f.evidence.page,
      note: 'The vendor published this customer and has since removed the page.',
    })) : [],
    currently_published: current.length,
    matches: found,
  };
}

// Everything the index knows about a vendor's customers, including the rows
// with no resolvable domain. Useful as an outbound target list rather than a
// per-run lookup.
export function customersOf(vendorKey, { indexPath = null } = {}) {
  const idx = loadIndex(indexPath || defaultIndexPath());
  return (idx.rows || []).filter((r) => r.vendor_key === vendorKey);
}
