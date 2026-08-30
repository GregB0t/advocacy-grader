// Deterministic sampling. Decision 3: the same domain must always yield the same
// pages and therefore the same Shareability score. A grade that moves between
// runs is a grade nobody can defend.

// FNV-1a, then xorshift32. Both are stable across platforms and Node versions,
// which Math.random() and any hash with a runtime-seeded salt are not.
function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h || 1;
}
function makeRng(seed) {
  let x = seed >>> 0;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x100000000; };
}

export function sampleContentUrls(canonicalList, { domain, size = 8, sections = null } = {}) {
  const pool = canonicalList
    .filter((c) => (sections ? sections.includes(c.section) : true))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)); // stable order first

  if (pool.length <= size) {
    return {
      urls: pool.map((c) => ({ url: c.url, section: c.section })),
      method: 'all',
      seed: null,
      pool_size: pool.length,
      allocation: null,
      note: `Only ${pool.length} candidate URL(s) available, so every one was checked rather than sampled.`,
    };
  }

  const seed = hashSeed(domain);

  // Stratify across sections. A uniform draw over the whole pool returns whatever
  // dominates it — NVIDIA's pool is event-heavy, so a uniform sample scored their
  // event pages and called it Shareability. Every section that exists gets at least
  // one slot; the rest are allocated by section size, largest remainder first.
  const bySection = new Map();
  for (const c of pool) {
    if (!bySection.has(c.section)) bySection.set(c.section, []);
    bySection.get(c.section).push(c);
  }
  const names = [...bySection.keys()].sort();               // deterministic section order
  const strata = names.map((n) => ({ name: n, items: bySection.get(n) }));

  const quotas = new Map();
  let remaining = size;

  // Floor of one per section, in size order so the biggest sections are served
  // first when there are more sections than slots.
  for (const st of [...strata].sort((a, b) => b.items.length - a.items.length || (a.name < b.name ? -1 : 1))) {
    if (remaining <= 0) break;
    quotas.set(st.name, 1);
    remaining--;
  }
  // Remainder proportional to section size.
  if (remaining > 0) {
    const eligible = strata.filter((st) => quotas.has(st.name));
    const total = eligible.reduce((n, st) => n + st.items.length, 0) || 1;
    const shares = eligible.map((st) => {
      const exact = (st.items.length / total) * remaining;
      return { name: st.name, floor: Math.floor(exact), frac: exact - Math.floor(exact), cap: st.items.length - quotas.get(st.name) };
    });
    for (const sh of shares) {
      const add = Math.min(sh.floor, sh.cap);
      quotas.set(sh.name, quotas.get(sh.name) + add);
      remaining -= add;
    }
    for (const sh of shares.sort((a, b) => b.frac - a.frac || (a.name < b.name ? -1 : 1))) {
      if (remaining <= 0) break;
      const st = strata.find((x) => x.name === sh.name);
      if (quotas.get(sh.name) >= st.items.length) continue;
      quotas.set(sh.name, quotas.get(sh.name) + 1);
      remaining--;
    }
    // Any slots still unfilled (small sections capped out) spill to the largest sections.
    for (const st of [...strata].sort((a, b) => b.items.length - a.items.length || (a.name < b.name ? -1 : 1))) {
      while (remaining > 0 && (quotas.get(st.name) ?? 0) < st.items.length) {
        quotas.set(st.name, (quotas.get(st.name) ?? 0) + 1);
        remaining--;
      }
      if (remaining <= 0) break;
    }
  }

  // Draw within each section with its own seeded shuffle, so adding a section
  // does not reshuffle the others.
  const picked = [];
  for (const st of strata) {
    const q = quotas.get(st.name) || 0;
    if (!q) continue;
    const rng = makeRng(hashSeed(domain + '::' + st.name));
    const idx = [...st.items.keys()];
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    for (const i of idx.slice(0, q).sort((a, b) => a - b)) picked.push({ url: st.items[i].url, section: st.name });
  }

  return {
    urls: picked,
    method: 'deterministic_stratified',
    seed,
    pool_size: pool.length,
    allocation: Object.fromEntries([...quotas.entries()].sort((a, b) => b[1] - a[1])),
    sections_available: names.length,
    note: 'Seeded by a hash of the domain and drawn proportionally across content sections, so re-running this domain returns the same pages and the same score, and no single section can dominate the sample.',
  };
}
