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
import { registrableDomain } from './domain.js';

const INDEX_PATH = process.env.INCUMBENT_INDEX
  || path.resolve(new URL('..', import.meta.url).pathname, 'data/incumbent-index.json');

let _index = null;
export function loadIndex(file = INDEX_PATH) {
  if (_index) return _index;
  try { _index = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { _index = { domains: {}, rows: [], counts: {}, missing: true }; }
  return _index;
}

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

export function lookupIncumbent(domainOrUrl) {
  const idx = loadIndex();
  const domain = registrableDomain(domainOrUrl);
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
export function customersOf(vendorKey) {
  const idx = loadIndex();
  return (idx.rows || []).filter((r) => r.vendor_key === vendorKey);
}
