// Registrable-domain normalization. Deliberately a small hand-maintained
// suffix list rather than a PSL dependency: the input is a few hundred
// vendor-supplied sellerUrls, not arbitrary web input, and a wrong answer
// here shows up as an unmatched row, not a false positive.

const MULTI_PART_SUFFIXES = new Set([
  'co.uk','org.uk','ac.uk','gov.uk','me.uk','ltd.uk','plc.uk','net.uk',
  'com.au','net.au','org.au','edu.au','gov.au','com.br','com.mx','com.ar',
  'co.jp','ne.jp','or.jp','ac.jp','go.jp','co.kr','or.kr','co.nz','net.nz',
  'org.nz','govt.nz','co.za','org.za','com.sg','com.my','com.hk','com.tw',
  'com.cn','net.cn','org.cn','gov.cn','co.in','net.in','org.in','gen.in',
  'com.tr','com.pl','com.es','com.pt','com.co','com.pe','com.ve','com.ec',
  'com.uy','co.il','com.ua','com.vn','com.ph','co.th','com.sa','com.eg',
  'com.ng','com.gh','co.ke','com.pk','com.bd','com.ru','net.ru','org.ru',
]);

export function registrableDomain(input) {
  if (!input) return null;
  let host = String(input).trim();
  try {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) host = 'https://' + host;
    host = new URL(host).hostname;
  } catch { return null; }
  host = host.toLowerCase().replace(/\.$/, '');
  if (!host || !host.includes('.')) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  host = host.replace(/^www\d?\./, '');
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo)) {
    return parts.length >= 3 ? parts.slice(-3).join('.') : host;
  }
  return lastTwo;
}

// Hosts that are never a customer's own domain — app-store landing pages,
// generic hosting, or the vendor pointing at itself.
export const NON_CUSTOMER_HOSTS = new Set([
  'apple.com','apps.apple.com','itunes.apple.com','play.google.com','google.com',
  'facebook.com','linkedin.com','twitter.com','x.com','instagram.com','youtube.com',
  'wordpress.com','wixsite.com','squarespace.com','godaddy.com','github.io',
  'sites.google.com','notion.site','example.com','localhost',
]);
