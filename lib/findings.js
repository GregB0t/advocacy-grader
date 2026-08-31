// The findings layer. This is the product.
//
// The coverage gate means three in four visitors get no letter grade — so the
// report has to stand on its own. A finding is a concrete, cited, fixable
// observation: what was seen, where it was seen (URLs), what to change, and how
// much it matters. Everything here is deterministic code over the evidence
// bundle; nothing is guessed. Spec §7: never fabricate a signal, cite the
// evidence, degrade gracefully, say plainly what could not be seen.
//
// Works on PARTIAL evidence by design: a fast-tier probe (robots + llms +
// homepage) yields fast-tier findings; a grade-withheld domain still yields
// everything observable. A missing source is itself a finding (severity
// 'limitation'), never silence.
//
// Narrative phrasing is deliberately separable: each finding carries
// deterministic `statement` and `fix` strings, and lib/narrate.js may later
// add a `narrative` field via a model call. The detection below never depends
// on that call — the tool works today with no API key.

const MAX_CITED_URLS = 8;

// severity: critical > issue > opportunity > info; 'positive' and 'limitation'
// are grouped separately by renderers.
// priority = impact * (6 - effort): high-impact, easy-to-fix findings first.
// impact 1-5 (5 = visible on every share / to every machine reader),
// effort 1-5 (1 = a template attribute; 5 = an editorial program).
function mk(f) {
  const impact = f.impact ?? 3;
  const effort = f.effort ?? 3;
  return { impact, effort, priority: impact * (6 - effort), tier: 'full', ...f };
}

const citeUrls = (urls) => ({
  urls: urls.slice(0, MAX_CITED_URLS),
  urls_truncated: Math.max(0, urls.length - MAX_CITED_URLS),
});

// og:image pathologies. All three classes exist in the calibration corpus:
// wholefoodsmarket.com ships ".../undefined", citb.co.uk ships a literal
// placeholder image on every sampled page, kumon.co.uk ships relative paths
// (invalid per the OG spec — consumers are not required to resolve them).
const BROKEN_IMG_RE = /\/(undefined|null)([?#]|$)/i;
const PLACEHOLDER_IMG_RE = /placeholder[^/]*\.(png|jpe?g|webp|gif|svg)/i;

function classifyOgImage(url) {
  if (!url) return null;
  if (BROKEN_IMG_RE.test(url)) return 'broken';
  if (PLACEHOLDER_IMG_RE.test(url)) return 'placeholder';
  if (!/^https?:\/\//i.test(url)) return 'relative';
  return 'ok';
}

// ---------------------------------------------------------------- fast tier
// Everything below needs only robots.txt + llms.txt + homepage — the sub-2s
// probe the live page renders first.
function fastFindings(ev) {
  const out = [];
  const robots = ev.robots;
  const posture = robots?.ai_posture;

  if (robots && !robots.present) {
    out.push(mk({
      id: 'robots_unreadable', severity: 'limitation', tier: 'fast', impact: 3, effort: 1,
      title: 'Your robots.txt could not be read',
      statement: `The robots.txt endpoint did not return a usable file${robots.reason ? ` (${robots.reason})` : ''}. Crawler and AI-agent policy for this domain is unknown — unknown is not the same as open, and I have not scored it as open.`,
      evidence: { source: 'robots.txt fetch', status: robots.status ?? null },
      fix: 'Serve a plain-text robots.txt at the domain root. Even an empty or allow-all file makes your crawl policy explicit instead of undefined.',
    }));
  }

  if (posture) {
    const blocked = posture.blocked_agents || [];
    const contradictions = posture.contradictions || [];
    if (contradictions.length) {
      const c = contradictions[0];
      out.push(mk({
        id: 'content_signal_contradiction', severity: 'issue', tier: 'fast', impact: 4, effort: 1,
        title: 'Your Content-Signal grants what your robots.txt forbids',
        statement: `robots.txt declares a Content-Signal that grants a use requiring the site to be read, while disallowing AI user-agents of exactly the kind that grant depends on: ${(c.blocked_agents || []).join(', ') || blocked.join(', ')}. A machine reading your policy gets two opposite answers.`,
        evidence: { source: 'robots.txt', content_signals: (posture.content_signals || []).map((s) => s.raw), blocked_agents: blocked },
        fix: 'Decide which statement is the policy and make the other match: either remove the disallow lines for the agent kinds the signal grants, or narrow the Content-Signal to the uses you actually permit.',
      }));
    }
    if (blocked.length) {
      out.push(mk({
        id: 'ai_agents_blocked', severity: 'opportunity', tier: 'fast', impact: 3, effort: 1,
        title: `${blocked.length} AI user-agent${blocked.length > 1 ? 's are' : ' is'} blocked at your site root`,
        statement: `robots.txt disallows ${blocked.length} of ${posture.agents?.length ?? 'the'} tracked AI user-agents at the root: ${blocked.join(', ')}.${posture.matches_cloudflare_default_blocklist ? ' The list exactly matches Cloudflare’s one-click "block AI bots" default, which often means a toggle was flipped rather than a policy decided.' : ''} This is a tradeoff, not a mistake: blocking protects content from training use, and costs visibility in AI search and assistants that cite sources. robots.txt is advisory, so this describes your declared policy, not enforcement.`,
        evidence: { source: 'robots.txt', blocked_agents: blocked, matches_cloudflare_default: Boolean(posture.matches_cloudflare_default_blocklist) },
        fix: 'Confirm the block is a decision rather than a default. If AI answer engines matter to how buyers and candidates find you, consider allowing search- and user-fetch-kind agents while keeping training bots blocked — the two can be set independently.',
      }));
    } else if ((posture.agents || []).length) {
      out.push(mk({
        id: 'ai_agents_open', severity: 'positive', tier: 'fast', impact: 2, effort: 5,
        title: 'All tracked AI user-agents may read your site',
        statement: `robots.txt permits all ${posture.agents.length} tracked AI user-agents at the site root, so AI search engines and assistants that honor robots.txt can read and cite you.`,
        evidence: { source: 'robots.txt', agents_tracked: posture.agents.length },
        fix: null,
      }));
    }
  }

  if (ev.llms_txt?.checked) {
    out.push(mk({
      id: 'llms_txt', severity: 'info', tier: 'fast', impact: 1, effort: 1,
      title: ev.llms_txt.present ? 'llms.txt is present' : 'No llms.txt',
      statement: ev.llms_txt.present
        ? 'An llms.txt file is served. Reported for completeness: Google has said it does not support llms.txt, no major AI vendor has confirmed consuming it, and large-scale studies found no correlation with AI citations. I record it and weight it at zero.'
        : 'No llms.txt file is served. This costs nothing today — the evidence that llms.txt affects anything is weak — so I do not count it against you.',
      evidence: { source: 'llms.txt fetch', present: Boolean(ev.llms_txt.present) },
      fix: null,
    }));
  }

  const hp = ev.homepage;
  if (hp) {
    const og = hp.open_graph || {};
    const missing = [];
    if (!og.title) missing.push('og:title');
    if (!og.description) missing.push('og:description');
    if (!og.image) missing.push('og:image');
    const imgClass = classifyOgImage(og.image);
    if (imgClass && imgClass !== 'ok') {
      out.push(mk({
        id: 'homepage_og_image_broken', severity: 'critical', tier: 'fast', impact: 5, effort: 1,
        title: imgClass === 'relative' ? 'Your homepage og:image is a relative URL' : `Your homepage og:image is a ${imgClass === 'broken' ? 'broken' : 'placeholder'} URL`,
        statement: imgClass === 'relative'
          ? `The homepage declares og:image as "${og.image}". The Open Graph spec requires a full URL; platforms are not required to resolve a relative path, so shares of your homepage can render without an image.`
          : `The homepage declares og:image as "${og.image}"${imgClass === 'broken' ? ' — a URL ending in a literal template variable, which is not an image' : ' — a placeholder asset, not real page art'}. Every share of your homepage renders with ${imgClass === 'broken' ? 'no image' : 'a stock placeholder'}.`,
        evidence: { source: 'homepage HTML', og_image: og.image },
        fix: 'Fix the template variable feeding og:image and make it an absolute URL to a real 1200×630 image. This is one template attribute; every future share inherits the fix.',
      }));
    } else if (missing.length) {
      out.push(mk({
        id: 'homepage_og_incomplete', severity: 'issue', tier: 'fast', impact: 4, effort: 1,
        title: `Your homepage share card is missing ${missing.join(', ')}`,
        statement: `The homepage lacks ${missing.join(', ')}. When anyone — including your own employees — shares your homepage link, the preview card renders incomplete${missing.includes('og:image') ? ' (no image means most platforms show a bare grey box)' : ''}.`,
        evidence: { source: 'homepage HTML', missing, present: Object.fromEntries(['title', 'description', 'image'].map((k) => [`og:${k}`, Boolean(og[k])])) },
        fix: `Add the missing tag${missing.length > 1 ? 's' : ''} to the homepage template: ${missing.join(', ')}. Minutes of work, visible on every share afterward.`,
      }));
    } else if (og.title && og.image) {
      out.push(mk({
        id: 'homepage_og_ok', severity: 'positive', tier: 'fast', impact: 2, effort: 5,
        title: 'Your homepage share card is complete',
        statement: 'The homepage carries og:title, og:description and og:image, so a shared homepage link renders a full preview card.',
        evidence: { source: 'homepage HTML' },
        fix: null,
      }));
    }

    if ((hp.json_ld_types || []).length === 0) {
      out.push(mk({
        id: 'homepage_no_schema', severity: 'opportunity', tier: 'fast', impact: 3, effort: 2,
        title: 'No structured data on your homepage',
        statement: 'The homepage carries no JSON-LD schema.org markup. Machine readers — search engines and AI assistants alike — get no structured statement of who you are (Organization, name, logo, sameAs profiles).',
        evidence: { source: 'homepage HTML', json_ld_blocks: hp.json_ld_blocks ?? 0 },
        fix: 'Add an Organization JSON-LD block to the homepage: name, url, logo, and sameAs links to your official social profiles.',
      }));
    }

    if (hp.likely_js_rendered) {
      out.push(mk({
        id: 'homepage_js_rendered', severity: 'issue', tier: 'fast', impact: 3, effort: 4,
        title: 'Your homepage is nearly invisible without JavaScript',
        statement: `A plain fetch of the homepage yields almost no readable text (${hp.rendered_text_chars ?? 0} characters). Crawlers and AI agents that do not execute JavaScript — which is many of them — see an empty page where your company should be.`,
        evidence: { source: 'homepage HTML', rendered_text_chars: hp.rendered_text_chars ?? 0 },
        fix: 'Server-render or pre-render the homepage shell so the core message, navigation and meta tags exist in the initial HTML.',
      }));
    }
  } else if (ev.meta?.resolved_origin === null || ev.meta?.resolved_origin === undefined) {
    if (!ev.blocked_at_root && ev.meta) {
      out.push(mk({
        id: 'homepage_unreachable', severity: 'limitation', tier: 'fast', impact: 4, effort: 2,
        title: 'Your homepage could not be retrieved',
        statement: 'No candidate origin returned a successful response to a polite, honestly-identified request — directly or through a rendering proxy. Everything a homepage would show (share tags, structured data, careers links) is unobserved, not judged.',
        evidence: { source: 'origin probes', attempts: (ev.meta.origin_attempts || []).map((a) => ({ origin: a.origin, status: a.status ?? null, error: a.error ?? null })) },
        fix: 'Check whether your bot protection returns errors to honest crawlers that identify themselves. If tools reading your site is unwanted, that is a valid choice — but many machine readers now decide what to say about you based on what they can read.',
      }));
    }
  }

  return out;
}

// ---------------------------------------------------------------- full tier
function contentFindings(ev, coverage) {
  const out = [];
  const cc = ev.classification?.canonical_content;
  const coverageOk = !coverage?.insufficient;

  if (ev.sitemaps && ev.sitemaps.urls_collected === 0) {
    out.push(mk({
      id: 'no_sitemap_urls', severity: 'limitation', impact: 4, effort: 2,
      title: 'No sitemap returned any URLs',
      statement: `Sitemaps were checked at ${(ev.sitemaps.seeds_tried || []).length} location(s) (declared in robots.txt or at the conventional paths) and collected zero URLs. Your content inventory is invisible to this tool — and to anything else that discovers content this way. This means "not found where sitemaps usually live", not "no content".`,
      evidence: { source: 'sitemap fetches', seeds_tried: (ev.sitemaps.seeds_tried || []).slice(0, MAX_CITED_URLS) },
      fix: 'Publish an XML sitemap of your canonical content and declare it with a Sitemap: line in robots.txt.',
    }));
    return out;
  }
  if (!cc) return out;

  // Coverage limitation — phrased as OUR reading gap, with the unread paths
  // cited so the company can see the content itself was found.
  if (coverage?.insufficient) {
    const prefixes = ev.classification?.unclassified?.top_path_prefixes || {};
    const top = Object.entries(prefixes).slice(0, 6).map(([p, n]) => `${p} (${n})`);
    out.push(mk({
      id: 'classification_coverage', severity: 'limitation', impact: 5, effort: 1,
      title: 'The reader could not classify most of your site',
      statement: `Of the ${coverage.total_urls.toLocaleString('en-US')} URLs in your sitemap, ${coverage.unclassified_urls.toLocaleString('en-US')} (${coverage.unclassified_share_pct}%) could not be sorted into content sections by the path-based classifier${top.length ? ` — the unread majority sits under paths like ${top.join(', ')}` : ''}. That is a limit of this tool's reading, not evidence you lack content, so no letter grade is issued and the volume-based scores below are floors, not measurements.`,
      evidence: { source: 'sitemap URL classification', total_urls: coverage.total_urls, unclassified_urls: coverage.unclassified_urls, unclassified_share_pct: coverage.unclassified_share_pct, top_unclassified_prefixes: prefixes },
      fix: null,
    }));
  }

  if (coverageOk) {
    const pool = coverage?.shareable_pool ?? cc.shareable_url_count ?? 0;
    if (pool < 30) {
      out.push(mk({
        id: 'content_below_floor', severity: 'issue', impact: 4, effort: 5,
        title: `Only ${pool} shareable page${pool === 1 ? '' : 's'} on the whole site`,
        statement: `After collapsing localized duplicates and filtering non-content pages, ${pool} page${pool === 1 ? '' : 's'} of shareable content remain${pool === 1 ? 's' : ''} (of ${cc.canonical_urls?.toLocaleString('en-US')} canonical URLs). An advocacy program needs a supply of things worth sharing; below roughly 30 pages there is not enough material to run one, regardless of quality.`,
        evidence: { source: 'sitemap URL classification', shareable_pool: pool, canonical_urls: cc.canonical_urls },
        fix: 'Before any tooling, build the supply: a blog or insights section, case studies, or press — content a person would attach their name to.',
      }));
    }
    const sectionsPresent = Object.entries(cc.sections || {}).filter(([k, v]) => v > 0 && !['unclassified', 'legal', 'product', 'home', 'careers', 'partner_integration', 'catalog_listing', 'locations', 'cms_cruft'].includes(k));
    if (pool >= 30 && sectionsPresent.length <= 2) {
      out.push(mk({
        id: 'content_monoculture', severity: 'opportunity', impact: 3, effort: 4,
        title: `Your shareable content lives in only ${sectionsPresent.length} section${sectionsPresent.length === 1 ? '' : 's'}`,
        statement: `All shareable content sits in: ${sectionsPresent.map(([k]) => k).join(', ') || 'none'}. Variety matters for advocacy — different employees share different things (news, case studies, culture stories, events).`,
        evidence: { source: 'sitemap URL classification', sections: Object.fromEntries(sectionsPresent) },
        fix: 'Add at least one more content type employees would plausibly share — customer stories and culture posts are the usual gaps.',
      }));
    }
  }

  const rec = ev.sitemaps?.recency;
  if (rec) {
    if (!rec.recency_measurable) {
      out.push(mk({
        id: 'recency_unobservable', severity: 'limitation', impact: 2, effort: 2,
        title: 'Content freshness is not observable here',
        statement: rec.lastmod_looks_machine_generated
          ? `Your sitemap publishes lastmod dates, but they look machine-generated rather than edit history (${(rec.credibility_reasons || []).join('; ') || 'implausible date distribution'}), so I cannot read them as freshness and have not guessed.`
          : 'Your sitemap carries no lastmod dates, so I cannot see how fresh your content is and have not guessed.',
        evidence: { source: 'sitemap lastmod analysis', urls_with_lastmod: rec.urls_with_lastmod ?? 0, looks_machine_generated: Boolean(rec.lastmod_looks_machine_generated) },
        fix: 'Emit real last-modified dates in the sitemap. Credible freshness data helps every machine reader — search, AI, and tools like this one — represent you accurately.',
      }));
    } else if (rec.urls_with_lastmod > 0) {
      const freshPct = Math.round((rec.updated_last_365d / rec.urls_with_lastmod) * 100);
      if (freshPct < 25) {
        out.push(mk({
          id: 'content_stale', severity: 'issue', impact: 3, effort: 4,
          title: `Only ${freshPct}% of your dated content was touched in the last year`,
          statement: `${rec.updated_last_365d.toLocaleString('en-US')} of ${rec.urls_with_lastmod.toLocaleString('en-US')} URLs with credible lastmod dates were updated in the last 365 days. A supply this static gives employees little new to share.`,
          evidence: { source: 'sitemap lastmod analysis', updated_last_365d: rec.updated_last_365d, urls_with_lastmod: rec.urls_with_lastmod, newest: rec.newest },
          fix: 'A regular publishing cadence — even monthly — matters more for advocacy than volume.',
        }));
      }
    }
  }

  const loc = ev.classification?.localization;
  if (loc && loc.distinct_locales >= 3) {
    out.push(mk({
      id: 'localization_spread', severity: 'positive', impact: 2, effort: 5,
      title: `Content is localized across ${loc.distinct_locales} locales`,
      statement: `${loc.localized_urls.toLocaleString('en-US')} URLs are localized variants across ${loc.distinct_locales} locales. I count each piece of content once (localization is maturity, not volume), but a multi-language surface is real evidence of marketing investment — and gives non-English-speaking employees something to share.`,
      evidence: { source: 'sitemap URL classification', distinct_locales: loc.distinct_locales, localized_urls: loc.localized_urls },
      fix: null,
    }));
  }
  return out;
}

function pageSampleFindings(ev, coverage) {
  const out = [];
  const sh = ev.shareability;
  if (!sh) return out;
  const n = sh.pages_retrieved || 0;
  const attempted = sh.pages_attempted || 0;

  if (attempted > 0 && n === 0) {
    out.push(mk({
      id: 'pages_unretrievable', severity: 'limitation', impact: 4, effort: 2,
      title: 'None of your sampled content pages could be read',
      statement: `${attempted} content page(s) were sampled from your sitemap and none returned readable HTML. Everything a content page would show — share tags, authors, schema — is unobserved for this site.`,
      evidence: { source: 'content page sample', ...citeUrls((sh.pages_unretrieved || []).map((p) => p.url)), reasons: [...new Set((sh.pages_unretrieved || []).map((p) => p.reason))].slice(0, 4) },
      fix: 'If your bot protection is returning errors to honestly-identified readers, the previews and citations other machines build about you are failing the same way.',
    }));
    return out;
  }
  if (!n || !sh.aggregates) return out;

  const a = sh.aggregates;
  const pages = sh.pages || [];
  const sample = (fn) => citeUrls(pages.filter(fn).map((p) => p.url));
  const caveat = coverage?.insufficient ? ' (sampled from the slice of the site that could be read)' : '';

  // Broken / placeholder / relative og:image — the highest-value class.
  const broken = pages.filter((p) => ['broken', 'placeholder'].includes(classifyOgImage(p.open_graph?.image)));
  if (broken.length) {
    const kinds = [...new Set(broken.map((p) => classifyOgImage(p.open_graph.image)))];
    out.push(mk({
      id: 'broken_og_images', severity: 'critical', impact: 5, effort: 1,
      title: `${broken.length} of ${n} sampled pages ship a ${kinds.includes('broken') ? 'broken' : 'placeholder'} share image`,
      statement: `${broken.length} of ${n} sampled content pages declare an og:image URL that is ${kinds.includes('broken') ? 'literally broken (it ends in an unrendered template variable like "undefined")' : 'a stock placeholder, not page art'}. Example: ${broken[0].url} points its share image at ${broken[0].open_graph.image}. Every share of these pages renders wrong, and the pages otherwise pass a "has an image tag" check — this only shows up when someone follows the URL.`,
      evidence: { source: 'content page sample', ...citeUrls(broken.map((p) => `${p.url} → ${p.open_graph.image}`)) },
      fix: 'Fix the template variable feeding og:image in the affected page template. One fix covers every page using it.',
    }));
  }
  const relative = pages.filter((p) => classifyOgImage(p.open_graph?.image) === 'relative');
  if (relative.length) {
    out.push(mk({
      id: 'relative_og_images', severity: 'issue', impact: 4, effort: 1,
      title: `${relative.length} of ${n} sampled pages use a relative og:image URL`,
      statement: `${relative.length} of ${n} sampled pages declare og:image as a relative path (e.g. ${relative[0].url} declares "${relative[0].open_graph.image}"). The Open Graph spec requires a full URL — platforms are not obliged to resolve relative paths, so these shares can render without an image depending on where they are shared.`,
      evidence: { source: 'content page sample', ...citeUrls(relative.map((p) => `${p.url} → ${p.open_graph.image}`)) },
      fix: 'Prefix the og:image path with your canonical origin in the template.',
    }));
  }

  const pctChecks = [
    ['og_image', 'a share image (og:image)', 5, 1, 'Without an og:image, most platforms render a shared link as a bare grey box.', 'Add a default share image to the content template, and per-post images where you have art.'],
    ['og_description', 'a share description (og:description)', 2, 1, 'The preview card shows the title with no supporting line.', 'Emit the post excerpt as og:description in the template.'],
    ['share_affordance', 'a visible share control', 3, 2, 'Nothing on the page invites a reader — or an employee — to share it.', 'Add share links or buttons to the content template. Plain links to the platform share endpoints work without any tracking script.'],
    ['article_schema', 'Article structured data', 3, 2, 'Machine readers cannot tell these pages are articles, or when they were published, or by whom.', 'Emit Article (or BlogPosting) JSON-LD with headline, datePublished and author in the content template.'],
  ];
  for (const [key, label, impact, effort, why, fix] of pctChecks) {
    const agg = a[key];
    if (!agg) continue;
    if (agg.pct === 0) {
      out.push(mk({
        id: `no_${key}`, severity: impact >= 5 ? 'critical' : 'issue', impact, effort,
        title: `0 of ${n} sampled pages carry ${label}`,
        statement: `None of the ${n} content pages sampled${caveat} carry ${label}. ${why}`,
        evidence: { source: 'content page sample', n: agg.n, of: n, pct: agg.pct, ...sample((p) => true) },
        fix,
      }));
    } else if (agg.pct < 60) {
      const missing = {
        og_image: (p) => !p.has_og_image, og_description: (p) => !p.has_og_description,
        share_affordance: (p) => !p.has_share_affordance, article_schema: (p) => !p.has_article_schema,
      }[key];
      out.push(mk({
        id: `low_${key}`, severity: 'issue', impact: Math.max(2, impact - 1), effort,
        title: `Only ${agg.n} of ${n} sampled pages carry ${label}`,
        statement: `${agg.n} of ${n} sampled content pages (${agg.pct}%)${caveat} carry ${label}; the rest do not. ${why}`,
        evidence: { source: 'content page sample', n: agg.n, of: n, pct: agg.pct, missing_examples: sample(missing).urls, missing_truncated: sample(missing).urls_truncated },
        fix,
      }));
    }
  }

  const auth = a.named_author;
  if (auth) {
    if (auth.pct === 0) {
      out.push(mk({
        id: 'no_named_authors', severity: 'issue', impact: 4, effort: 3,
        title: `0 of ${n} sampled pages name a human author`,
        statement: `None of the ${n} sampled content pages${caveat} carry a named human author — no byline, no author schema, no rel=author. Content nobody signs is content nobody feels ownership of; advocacy runs on employees being visible in the work.`,
        evidence: { source: 'content page sample', n: 0, of: n },
        fix: 'Add author bylines to content pages — a name, ideally with a link or an author block in the Article schema. Start with new posts; backfilling can wait.',
      }));
    } else if (auth.pct >= 60) {
      out.push(mk({
        id: 'named_authors_present', severity: 'positive', impact: 3, effort: 5,
        title: `${auth.n} of ${n} sampled pages name their author`,
        statement: `${auth.pct}% of sampled content pages carry a named human author — employees are already visible in the work, which is the raw material of advocacy.`,
        evidence: { source: 'content page sample', n: auth.n, of: n, pct: auth.pct },
        fix: null,
      }));
    }
  }

  if (a.share_affordance && a.share_affordance.pct >= 80) {
    out.push(mk({
      id: 'share_affordance_present', severity: 'positive', impact: 2, effort: 5,
      title: 'Share controls are on nearly every sampled page',
      statement: `${a.share_affordance.n} of ${n} sampled pages (${a.share_affordance.pct}%) carry a visible share control.`,
      evidence: { source: 'content page sample', n: a.share_affordance.n, of: n },
      fix: null,
    }));
  }

  if (n < attempted) {
    out.push(mk({
      id: 'partial_sample', severity: 'limitation', impact: 2, effort: 3,
      title: `${attempted - n} of ${attempted} sampled pages could not be read`,
      statement: `${n} of ${attempted} sampled pages returned readable HTML; the percentages above describe only those. The unread pages are listed here rather than guessed at.`,
      evidence: { source: 'content page sample', ...citeUrls((sh.pages_unretrieved || []).map((p) => p.url)) },
      fix: null,
    }));
  }
  return out;
}

function cultureCareersFindings(ev, coverage) {
  const out = [];
  const cc = ev.classification?.canonical_content;
  const coverageOk = !coverage?.insufficient;

  if (cc && coverageOk) {
    const culture = cc.sections?.culture || 0;
    if (culture === 0) {
      out.push(mk({
        id: 'no_culture_pages', severity: 'opportunity', impact: 4, effort: 4,
        title: 'No culture or life-at pages anywhere in your sitemap',
        statement: `Of ${cc.canonical_urls?.toLocaleString('en-US')} canonical URLs, zero classify as culture content — no life-at pages, employee stories, or team spotlights. This is the most common gap this tool finds, and the most directly advocacy-shaped one: it is the content employees share proudest and first.`,
        evidence: { source: 'sitemap URL classification', culture_urls: 0, canonical_urls: cc.canonical_urls },
        fix: 'Start small: one employee-story post a month, indexed in the sitemap. The section can grow from there.',
      }));
    }
  }

  // Careers reachability is a public rubric component already. Hiring-pressure
  // data, req counts and ATS job pulls stay private (spec §4) and are never
  // rendered into findings.
  const checked = ev.lead_signals?.careers_pages_checked || [];
  if (checked.length) {
    const ok = checked.filter((c) => c.ok);
    if (!ok.length) {
      out.push(mk({
        id: 'careers_unreachable', severity: 'issue', impact: 3, effort: 2,
        title: 'Your careers page could not be retrieved',
        statement: `${checked.length} careers location(s) were tried (${checked.map((c) => c.url).filter(Boolean).slice(0, 3).join(', ')}) and none returned a readable page. Candidates researching you through tools and AI assistants hit the same wall.`,
        evidence: { source: 'careers page probes', attempts: checked.map((c) => ({ url: c.url, status: c.status ?? null, skipped: c.skipped ?? null })) },
        fix: 'Serve a crawlable careers page at /careers and link it from the homepage.',
      }));
    } else {
      const invisible = ok.filter((c) => c.escalated && c.found_in_direct_html === false);
      if (invisible.length) {
        out.push(mk({
          id: 'careers_js_only', severity: 'opportunity', impact: 3, effort: 3,
          title: 'Your job listings are invisible without JavaScript',
          statement: `Your careers page (${invisible[0].url}) returns HTML, but the job listings are injected client-side — a plain reader sees a page with no roles on it. Machine readers that do not execute JavaScript (many crawlers and AI assistants) cannot see that you are hiring.`,
          evidence: { source: 'careers page probes', urls: invisible.map((c) => c.url) },
          fix: 'Server-render at least the role titles and locations, or publish jobs in structured data (schema.org JobPosting).',
        }));
      }
    }
  }
  return out;
}

function blockedFindings(ev) {
  if (!ev.blocked_at_root) return [];
  return [mk({
    id: 'blocked_at_root', severity: 'limitation', tier: 'fast', impact: 5, effort: 1,
    title: 'Your robots.txt blocks this crawler — so this report covers robots.txt only',
    statement: 'Your robots.txt disallows this crawler at the site root. I honor that: nothing beyond robots.txt itself was fetched, and no grade is issued, because a grade earned by being unreadable would be an invented verdict. Worth knowing: a broad disallow like this also governs how other honest crawlers and AI agents treat you. That may be exactly the policy you want — it protects content and reduces scraping load — or it may be broader than intended.',
    evidence: { source: 'robots.txt', raw_excerpt: (ev.robots?.raw || '').split(/\r?\n/).slice(0, 12) },
    fix: 'If the broad block is deliberate, no action. If not, scope the disallow rules to the specific bots or paths you mean to restrict.',
  })];
}

const SEVERITY_ORDER = { critical: 0, issue: 1, opportunity: 2, info: 3 };

// ---------------------------------------------------------------- entry point
// buildFindings(evidence, scoring?) -> { actions, positives, limitations, all }
// Works on full evidence, fast-probe partial evidence, and blocked domains.
export function buildFindings(ev, scoring = null) {
  const coverage = scoring?.classification_coverage ?? null;
  const all = [
    ...blockedFindings(ev),
    ...fastFindings(ev),
    ...contentFindings(ev, coverage),
    ...pageSampleFindings(ev, coverage),
    ...cultureCareersFindings(ev, coverage),
  ];

  const actions = all
    .filter((f) => ['critical', 'issue', 'opportunity'].includes(f.severity))
    .sort((x, y) => y.priority - x.priority || SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity] || x.effort - y.effort);
  const positives = all.filter((f) => f.severity === 'positive').sort((x, y) => y.impact - x.impact);
  const limitations = all.filter((f) => f.severity === 'limitation').sort((x, y) => y.impact - x.impact);
  const info = all.filter((f) => f.severity === 'info');

  return { actions, positives, limitations, info, all, counts: { actions: actions.length, positives: positives.length, limitations: limitations.length } };
}

// Fast-tier subset: what a phase-1 probe can honestly show while the full run
// continues. Only findings whose inputs the fast probe actually fetched.
export function fastTier(findingsResult) {
  const pick = (arr) => arr.filter((f) => f.tier === 'fast');
  return { actions: pick(findingsResult.actions), positives: pick(findingsResult.positives), limitations: pick(findingsResult.limitations), info: pick(findingsResult.info) };
}
