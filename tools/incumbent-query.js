#!/usr/bin/env node
// Query the incumbent index. Outbound prospecting, not part of the grading run.
//
//   node tools/incumbent-query.js kimley-horn.com     # one domain
//   node tools/incumbent-query.js --vendor sociabble  # a vendor's customers
//   node tools/incumbent-query.js --tier advocacy     # every direct-competitor customer
//   node tools/incumbent-query.js --stale 24          # apps not updated in 24+ months
//   node tools/incumbent-query.js --multi-vendor      # companies named by 2+ vendors
//   node tools/incumbent-query.js --competing         # named by 2+ DIRECT competitors
//   node tools/incumbent-query.js --former            # case studies the vendor has taken down
//
// --stale is the churn/displacement list. It is a REPORTED signal only: an
// unmaintained app is consistent with a lapsed deployment but is not proof of
// churn, and nothing here is folded into any score.

import { loadIndex } from '../lib/incumbent.js';
import { lookupIncumbent } from '../lib/incumbent.js';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const idx = loadIndex();

const monthsSince = (iso) => (iso ? Math.round((Date.now() - new Date(iso)) / (1000 * 60 * 60 * 24 * 30.44)) : null);
const line = (r) => `${String(r.confidence).padEnd(17)} ${String(r.domain || '(unresolved: ' + (r.customer_name || r.customer_token) + ')').padEnd(34)} ${r.vendor_name.padEnd(32)} ${r.evidence.app_name || r.customer_name || ''}${r.evidence?.historical ? '  [TAKEN DOWN]' : ''}`;

if (flag('--vendor')) {
  const rows = idx.rows.filter((r) => r.vendor_key === flag('--vendor'));
  console.log(`${rows.length} customer app(s) under ${flag('--vendor')}\n`);
  rows.forEach((r) => console.log(line(r)));
} else if (flag('--tier')) {
  const rows = idx.rows.filter((r) => r.vendor_tier === flag('--tier') && !r.is_client_vendor);
  const doms = new Set(rows.filter((r) => r.domain).map((r) => r.domain));
  console.log(`${rows.length} app(s), ${doms.size} matchable domain(s) in tier "${flag('--tier')}"\n`);
  rows.forEach((r) => console.log(line(r)));
} else if (flag('--stale')) {
  const min = Number(flag('--stale'));
  const rows = idx.rows
    .map((r) => ({ ...r, months: monthsSince(r.evidence?.last_updated) }))
    .filter((r) => r.months !== null && r.months >= min && !r.is_client_vendor)
    .sort((a, b) => b.months - a.months);
  console.log(`${rows.length} customer app(s) not updated in ${min}+ months.`);
  console.log('An unmaintained app is CONSISTENT WITH a lapsed deployment. It is not proof of churn.\n');
  rows.forEach((r) => console.log(`${String(r.months + 'mo').padStart(5)}  ${line(r)}`));
} else if (args.includes('--multi-vendor') || args.includes('--competing')) {
  const competingOnly = args.includes('--competing');
  const rowsFor = (dom) => idx.domains[dom].filter((r) => !r.is_client_vendor);
  const hits = Object.keys(idx.domains)
    .map((dom) => ({ dom, rows: rowsFor(dom) }))
    .map((h) => ({ ...h, vendors: [...new Set(h.rows.map((r) => r.vendor_key))],
                   advocacy: [...new Set(h.rows.filter((r) => r.vendor_tier === 'advocacy').map((r) => r.vendor_key))] }))
    .filter((h) => (competingOnly ? h.advocacy.length > 1 : h.vendors.length > 1))
    .sort((a, b) => b.vendors.length - a.vendors.length);
  console.log(competingOnly
    ? `${hits.length} compan(ies) named as a customer by 2+ DIRECT competitors.\nThat is a switch, a genuine multi-tool estate, or one vendor overstating a pilot -- check the dates on each claim.\n`
    : `${hits.length} compan(ies) named by more than one vendor. Nothing is merged: each vendor's claim is its own row.\n`);
  for (const h of hits) {
    console.log(`${h.dom}`);
    for (const r of h.rows) {
      const age = r.evidence?.last_updated ? ` (app updated ${String(r.evidence.last_updated).slice(0, 10)})` : '';
      const gone = r.evidence?.historical ? '  [TAKEN DOWN]' : '';
      console.log(`   ${r.confidence.padEnd(17)} ${r.vendor_tier.padEnd(9)} ${r.vendor_name.padEnd(32)} ${(r.evidence?.app_name || r.customer_name || '')}${age}${gone}`);
    }
  }
} else if (args.includes('--former')) {
  const rows = idx.rows.filter((r) => r.evidence?.historical && !r.is_client_vendor);
  console.log(`${rows.length} case study/studies the vendor published and has since REMOVED from its live site.`);
  console.log('A page can be taken down for many reasons. This is consistent with a lapsed relationship; it does not establish one.\n');
  for (const r of rows.sort((a, b) => String(a.vendor_key).localeCompare(String(b.vendor_key)))) {
    console.log(`${r.confidence.padEnd(17)} ${String(r.domain || '(unresolved)').padEnd(30)} ${r.vendor_name.padEnd(28)} ${r.customer_name}`);
  }
} else if (args[0]) {
  console.log(JSON.stringify(lookupIncumbent(args[0]), null, 2));
} else {
  const t = idx.counts?.by_confidence || {};
  console.log(`incumbent index built ${idx.built_at}`);
  console.log(`${idx.counts?.rows} rows, ${idx.counts?.distinct_domains} matchable domains`);
  console.log(`by confidence: ${JSON.stringify(t)}\n`);
  console.log('vendors:');
  for (const v of idx.vendors.filter((v) => v.customers)) console.log(`  ${v.key.padEnd(18)} ${v.tier.padEnd(9)} ${String(v.customers).padStart(4)} customer apps`);
  const bySource = {};
  for (const r of idx.rows) bySource[r.evidence.source] = (bySource[r.evidence.source] || 0) + 1;
  console.log('\nby evidence source:');
  for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
  console.log('\nviews: <domain> | --vendor K | --tier advocacy | --stale 24 | --multi-vendor | --competing | --former');
}
