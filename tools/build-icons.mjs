// Regenerates every raster icon from site/favicon.svg — the one master drawing.
//
// WHY THIS EXISTS: the icon set was hand-built the first time, so changing a single
// colour meant redrawing four files from memory. Everything here derives from
// favicon.svg, so the vector and the rasters can never disagree again.
//
// OPTICAL SIZING IS DELIBERATE, NOT A BUG. The two ghost bubbles are a 1.7-unit
// stroke in a 37-unit box: at 16px that lands on about two thirds of a pixel and
// disappears. The 16 and 32px rasters are therefore drawn at 2.8 and 2.1 so the same
// drawing survives a tab strip. Anything 48px and up uses the vector's own 1.7.
//
// The ICO container is assembled by hand on purpose: PIL's `sizes=` +
// `append_images` silently writes only ONE size, which is how a 3-size icon
// quietly became a 1-size icon last time.
//
// Usage:  npm i --no-save @resvg/resvg-js  &&  node tools/build-icons.mjs
// The dependency is intentionally NOT in package.json — this repo ships with zero
// runtime dependencies and this script runs about once a year.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let Resvg;
try { ({ Resvg } = await import('@resvg/resvg-js')); }
catch {
  console.error('build-icons needs a rasterizer that is not a dependency of this repo.');
  console.error('Run:  npm i --no-save @resvg/resvg-js  &&  node tools/build-icons.mjs');
  process.exit(1);
}

const SITE = 'site';
const master = readFileSync(join(SITE, 'favicon.svg'), 'utf8');
const inner = master.match(/<g transform[\s\S]*<\/g>/)[0];

// The master is authoritative for colour; only the stroke WIDTH is retuned per size.
const atStroke = (svg, w) => svg.replace(/stroke-width="[\d.]+"/g, `stroke-width="${w}"`);
const png = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
const square = (size) => png(atStroke(master, size <= 16 ? 2.8 : size <= 32 ? 2.1 : 1.7), size);

writeFileSync(join(SITE, 'favicon-16.png'), square(16));
writeFileSync(join(SITE, 'favicon-32.png'), square(32));

// Apple touch icon: white ground (chosen over the indigo knockout), with the mark at
// 55.5% of the canvas — the inset iOS masking expects. Built as a wrapper SVG rather
// than by compositing, so there is exactly one renderer in this file.
const INK_UNITS = 36.76;            // the cascade's own bbox inside the 48-unit box
const TOUCH = 180, INK_PX = 100;    // matches the icon this replaces
const scale = INK_PX / INK_UNITS, box = 48 * scale, off = (TOUCH - box) / 2;
const touchSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${TOUCH}" height="${TOUCH}" viewBox="0 0 ${TOUCH} ${TOUCH}" fill="none">
<rect width="${TOUCH}" height="${TOUCH}" fill="#ffffff"/>
<g transform="translate(${off.toFixed(2)},${off.toFixed(2)}) scale(${scale.toFixed(4)})">${inner}</g>
</svg>`;
writeFileSync(join(SITE, 'apple-touch-icon.png'), png(atStroke(touchSvg, 1.7), TOUCH));

// ICO: a 6-byte header, one 16-byte directory entry per image, then the PNG payloads.
// PNG-in-ICO is understood everywhere this site's visitors will be.
const sizes = [16, 32, 48];
const images = sizes.map(square);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const dir = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s; e[2] = 0; e[3] = 0;
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(images[i].length, 8); e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  return e;
});
writeFileSync(join(SITE, 'favicon.ico'), Buffer.concat([header, ...dir, ...images]));

console.log(`icons rebuilt from ${SITE}/favicon.svg: favicon-16.png favicon-32.png apple-touch-icon.png favicon.ico (${sizes.join('+')})`);
