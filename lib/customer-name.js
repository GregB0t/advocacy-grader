// Second-pass cleaning for company names scraped off vendor sites.
//
// Everything here exists because a real logo wall was fed through it. The
// categories, in the order they must be handled:
//   1. file artefacts     Vattenfall_logo2.svg, 2560px-XBOX_logo_2012.svg,
//                         walter-tools-logo-png_seeklogo-371837, twoday-logo-300x86
//   2. boilerplate tails  "Barry Callebaut customer story", "Wisag Employee App"
//   3. sentence fragments "How A Multinational Bank Enables Employee Advocacy",
//                         "Sociuu Helped Afas", "Twoday Leveraged"
//   4. platform logos     salesforce-logo, Slack-logo, sharepoint-logo -- these
//                         are integrations shown on vendor sites, not customers
//   5. vendor names       competitors listed on comparison pages
//   6. people             testimonial bylines, not companies
//
// ORDER MATTERS: artefacts are stripped FIRST, so "salesforce-logo" becomes
// "salesforce" and is then caught by the platform list. Filtering before
// stripping would let every one of those through.

const PLATFORMS = new Set([
  'salesforce','sharepoint','microsoft','microsoft teams','teams','slack','google','gmail','google workspace',
  'workday','okta','zoom','outlook','office 365','microsoft 365','sap successfactors','servicenow platform',
  'instagram','youtube','facebook','linkedin','twitter','x','tiktok','pinterest','threads','whatsapp','snapchat',
  'g2','capterra','trustpilot','trustradius','gartner','forrester','getapp','softwareadvice',
  'apple','android','app store','google play','aws','azure','sso','saml','okta verify','screencloud',
  'copilot','microsoft copilot','sap','oracle netsuite','dropbox','box','onedrive','jira','confluence',
]);

const NOT_A_COMPANY = new Set([
  'logo','logos','client','clients','customer','customers','partner','partners','brand','brands',
  'star','stars','5 stars','4 stars','rating','review','reviews','quote','avatar','photo','image','icon',
  'home','about','about us','pricing','blog','contact','contact us','careers','login','sign in','sign up',
  'menu','search','close','next','previous','arrow','read more','learn more','case study','case studies',
  'customer story','customer stories','success story','success stories','testimonial','testimonials',
  'employee advocacy','employee communication','social media','internal communications','intranet',
  'privacy policy','terms','cookie','cookies','demo','book a demo','free trial','get started','download',
  'faq','vip','header','footer','banner','hero','background','placeholder','thumbnail','video','webinar',
  'ebook','guide','report','whitepaper','blog post','news','press','events','event','resources','product',
  'solutions','platform','company','team','people','culture','story','stories','overview','features',
]);

// Words that mean the string is a sentence about a customer, not the customer.
const SENTENCE_START = /^(how|why|what|when|where|the story|creating|building|making|meet|introducing|inside|discover|see how|watch|read|learn|case|customer|a |an )\b/i;
// Must be a SEPARATE trailing word: "\b...on$" alone matched "E.ON" and threw
// away a real company.
const DANGLING_END = /\s(with|through|and|to|for|by|at|in|of|on|from|using|helped|enables?|enabled|boosted|leveraged|drove|drives|improves?|improved|increases?|increased|builds?|built|turns?|turned|gets?|got|wins?|won)$/i;
const HAS_VERB = /\b(helped|enables?|enabled|boosted|leveraged|drove|drives|improves?|improved|increases?|increased|builds?|built|turns?|turned|achieves?|achieved|reduces?|reduced|scales?|scaled|launches?|launched|delivers?|delivered|creates?|created|uses?|used|chose|chooses|partners?|partnered)\b/i;

// Testimonial bylines. Deliberately narrow -- "Barry Callebaut" and
// "Baker McKenzie" are companies that look like people, so only unambiguous
// person markers count.
const PERSON = /(\b[A-Z]\.\s)|(\s[A-Z]\.?$)|(\b(van|von|der|den|del|della|bin|ibn)\s)/;

const FILE_EXT = /\.(svg|png|jpe?g|webp|gif|avif|ico|pdf)$/i;

export function cleanCustomerName(raw) {
  if (raw == null) return null;
  let n = String(raw);

  // --- 1. file artefacts
  n = n.replace(/&amp;/g, '&').replace(/&#0?39;|&rsquo;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
  n = n.replace(FILE_EXT, '');
  n = n.replace(/^\*+\.?/, '');                       // "*.Svg"
  n = n.replace(/\b\d{2,5}px[-_ ]?/gi, '');           // "2560px-XBOX..."
  n = n.replace(/[-_ ]\d{2,5}x\d{2,5}\b/gi, '');      // "twoday-logo-300x86"
  n = n.replace(/[-_ ]seeklogo[-_ ]?\d*/gi, '');
  n = n.replace(/[-_ ]?\b\d{6,}\b/g, '');             // "header-logo.1654708767"
  n = n.replace(/[_]+/g, ' ').replace(/(?<=[a-z0-9])-(?=[a-z0-9])/gi, ' ');
  n = n.replace(/\b(logo|logos|logotype|wordmark|icon|image|img|photo|picture|header|footer|white|black|colour|color|rgb|cmyk|transparent|final|copy|scaled|full|small|large|new|old|v\d+|logo\d+|png|svg|jpe?g|webp)\b/gi, ' ');
  n = n.replace(/\blogo\d+\b/gi, ' ');
  // Logo-carousel filenames: "ticker-illumina.png", "ticker_legal-general".
  n = n.replace(/^\s*(ticker|carousel|slider|marquee|strip|grid|row|item|slide)[-_ ]+/i, '');
  // Image-variant digits: "tesco-5.png", "ameriprise-financial-2", "elastic-small-1".
  // ONLY when a separator precedes them. Stripping a digit welded to letters
  // turned "DSMN8" into "DSMN", which then slipped past the vendor-name filter
  // and produced a fake customer domain claimed by six different vendors.
  n = n.replace(/[-_ ]+\d{1,2}$/, '');
  n = n.replace(/\s(19|20)\d{2}$/, '');            // trailing year: "XBOX logo 2012"
  n = n.replace(/\s+/g, ' ').trim().replace(/^[-–—|,.]+|[-–—|,.]+$/g, '').trim();
  if (!n) return null;

  // --- 2. boilerplate tails
  n = n.replace(/\s*[-–|:]?\s*(customer ?story|customer ?stories|case ?study|case ?studies|success ?story|testimonial|employee app|employee communication app|employee communication|communication app|mitarbeiter[- ]?app|intranet|app)\s*$/i, '').trim();
  n = n.replace(/^(case study|customer story|success story|how)\s*[:\-–]?\s*/i, '').trim();
  if (!n || n.length < 2 || n.length > 60) return null;

  // --- 3. sentence fragments
  if (HAS_VERB.test(n)) return null;
  if (DANGLING_END.test(n)) return null;
  if (SENTENCE_START.test(n) && n.split(/\s+/).length > 2) return null;
  if (n.split(/\s+/).length > 6) return null;
  if (!/[a-zA-Z]/.test(n)) return null;

  // --- 4 & 5 handled by the caller (needs the vendor list); 6 here
  if (PERSON.test(n)) return null;

  const low = n.toLowerCase();
  if (NOT_A_COMPANY.has(low)) return null;
  if (PLATFORMS.has(low)) return null;
  // "Google Gmail", "Microsoft Teams Intranet" -- a name LEADING with a platform
  // is that platform's branding, not a customer.
  if (PLATFORMS.has(low.split(' ')[0]) && low.split(' ').length <= 3) return null;
  if (/^\d+(\.\d+)?\s*(stars?|%)?$/.test(low)) return null;

  // Title-case a slug-derived all-lower name; leave real casing alone.
  if (n === low && /^[a-z0-9 &'.-]+$/.test(n)) n = n.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return n;
}

export const normalizeCompany = (s) => String(s || '').toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/\b(inc|llc|ltd|limited|gmbh|ag|sa|nv|bv|plc|corp|corporation|co|company|group|holding|holdings|international|global|the)\b/g, '')
  .replace(/[^a-z0-9]/g, '');

// Domain candidates to try for a company name, best guess first.
export function domainCandidates(name) {
  const base = String(name).toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[’'`.]/g, '')
    .replace(/[^a-z0-9 -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return [];
  const squashed = base.replace(/[ -]/g, '');
  const hyphen = base.replace(/\s+/g, '-');
  const noSuffix = base.replace(/\b(inc|llc|ltd|limited|gmbh|ag|nv|bv|plc|corp|corporation|group|holdings?)\b/g, '').replace(/\s+/g, ' ').trim().replace(/[ -]/g, '');
  // Interleave BY TLD, not by stem. Grouping by stem and slicing meant the
  // hyphenated variant was never reached -- "Messe Stuttgart" needs
  // messe-stuttgart.de, and 12 squashed variants used the whole budget first.
  const stems = [...new Set([squashed, noSuffix, hyphen].filter((x) => x && x.length >= 3 && x.length <= 40))];
  const out = [];
  for (const tld of ['.com', '.de', '.fr', '.nl', '.co.uk', '.io', '.be', '.se', '.es', '.it', '.co', '.net', '.dk', '.ch', '.at', '.fi', '.no', '.ie', '.com.au', '.ca']) {
    for (const stem of stems) { const c = stem + tld; if (!out.includes(c)) out.push(c); }
  }
  return out.slice(0, Number(process.env.MAX_DOMAIN_CANDIDATES || 30));
}

function _unusedLegacy(squashed, noSuffix, hyphen) {
  const out = [];
  for (const stem of [squashed, noSuffix, hyphen]) {
    if (!stem || stem.length < 3 || stem.length > 40) continue;
    // .com first. The scraped set is Europe-heavy (Haiilo, Staffbase, Sociabble
    // and Speakap sell mostly in DACH/France/Benelux), so country TLDs matter:
    // Deka is deka.de, not deka.com.
    for (const tld of ['.com', '.de', '.fr', '.nl', '.co.uk', '.io', '.be', '.se', '.es', '.it', '.co', '.net']) {
      const c = stem + tld;
      if (!out.includes(c)) out.push(c);
    }
  }
  return out.slice(0, 14);
}
