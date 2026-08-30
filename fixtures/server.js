// Local fixture site used to exercise score.js end-to-end without network access.
// The robots.txt below is a verbatim-shaped copy of everyonesocial.com's real file
// (fetched 2026-08-27) so the Content-Signal coherence logic is tested on real input.
import { createServer } from 'node:http';

const ROBOTS = `# BEGIN Cloudflare Managed content

User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
Allow: /

User-agent: Amazonbot
Disallow: /

User-agent: Applebot-Extended
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: CloudflareBrowserRenderingCrawler
Disallow: /

User-agent: Google-Extended
Disallow: /

User-agent: GPTBot
Disallow: /

User-agent: meta-externalagent
Disallow: /

# END Cloudflare Managed Content

User-agent: *
Allow: /
Disallow: /*.pdf$
Disallow: /private/

Sitemap: http://HOSTPORT/sitemap-index.xml
`;

const INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>http://HOSTPORT/sitemap-0.xml</loc></sitemap>
<sitemap><loc>http://HOSTPORT/sitemap-private.xml</loc></sitemap>
</sitemapindex>`;

const paths = [
  ['/blog/employee-advocacy-guide', '2026-08-10'],
  ['/blog/social-selling-stats', null],
  ['/blog/internal-comms-playbook', '2026-06-02'],
  ['/customers/acme-corp', null],
  ['/case-studies/globex', null],
  ['/resources/state-of-advocacy-2026', '2026-08-22'],
  ['/guides/getting-started', null],
  ['/news/series-c-announcement', '2026-03-01'],
  ['/webinars/advocacy-101', null],
  ['/life-at-example/engineering', null],
  ['/careers/senior-product-marketing-manager', null],
  ['/about/leadership', null],
  ['/pricing', null],
  ['/legal/privacy-policy', null],
  ['/de-de/blog/employee-advocacy-guide', null],
  ['/weird-section/thing-one', null],
  ['/weird-section/thing-two', null],
];
const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map(([p, lm]) => `<url><loc>http://HOSTPORT${p}</loc>${lm ? `<lastmod>${lm}</lastmod>` : ''}</url>`).join('\n')}
</urlset>`;

const HOME = `<!doctype html><html><head>
<title>Example — Employee Advocacy Platform</title>
<meta name="description" content="Fixture homepage.">
<meta property="og:title" content="Example"><meta property="og:description" content="d"><meta property="og:image" content="http://HOSTPORT/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="http://HOSTPORT/">
<link rel="alternate" type="application/rss+xml" title="Blog" href="/blog/feed.xml">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Example","sameAs":["https://x.com/example"]}</script>
</head><body>
<p>${'Real body copy that a plain fetch can see. '.repeat(40)}</p>
<a href="/careers/">Careers</a><a href="/life-at-example/">Life at Example</a>
<a href="https://boards.greenhouse.io/exampleco">Open roles</a>
</body></html>`;

const port = Number(process.argv[2] || 8811);
const hostport = `127.0.0.1:${port}`;
const sub = (s) => s.split('HOSTPORT').join(hostport);

createServer((req, res) => {
  const p = req.url.split('?')[0];
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
  if (p === '/robots.txt') return send(200, 'text/plain', sub(ROBOTS));
  if (p === '/sitemap-index.xml') return send(200, 'application/xml', sub(INDEX));
  if (p === '/sitemap-0.xml') return send(200, 'application/xml', sub(URLSET));
  if (p === '/sitemap-private.xml') return send(200, 'application/xml', sub(URLSET));
  if (p === '/llms.txt') return send(404, 'text/plain', 'not found');
  if (p === '/') return send(200, 'text/html', sub(HOME));
  return send(404, 'text/html', '<html><body>404</body></html>');
}).listen(port, '127.0.0.1', () => console.error(`fixture site on http://127.0.0.1:${port}`));
