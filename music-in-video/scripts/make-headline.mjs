// Renders the stand-in headline PNG (public/music/brand-assets/logo/
// music-in-this-video.png): "Music in this video" in Patrick Hand, brand red,
// hatched fill and outline, after Spencer's hand-drawn "Music Copyright
// Tester". Replace the PNG with Spencer's art when it exists; this script is
// only for regenerating the stand-in. Local only: Chrome via Playwright, the
// font from public/music/fonts.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = new URL('../public/music/', import.meta.url);
const font = (await readFile(new URL('fonts/patrick-hand-latin.woff2', root))).toString('base64');
const out = new URL('brand-assets/logo/music-in-this-video.png', root).pathname;

const W = 1967;
const H = 252;
const html = `<!doctype html><style>
@font-face { font-family: PH; src: url(data:font/woff2;base64,${font}); }
html, body { margin: 0; background: transparent; }
</style>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <pattern id="hatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(-50)">
      <rect width="9" height="9" fill="#F26A4B"/>
      <line x1="0" y1="0" x2="0" y2="9" stroke="#E0442A" stroke-width="5"/>
    </pattern>
  </defs>
  <text x="50%" y="224" text-anchor="middle" font-family="PH" font-size="268" textLength="${W - 24}" lengthAdjust="spacingAndGlyphs"
        fill="url(#hatch)" stroke="#E55A3C" stroke-width="9" stroke-linejoin="round" paint-order="stroke">Music in this video</text>
</svg>`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/google/chrome/chrome' });
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
await page.locator('svg').screenshot({ path: out, omitBackground: true });
await browser.close();
console.log('wrote', out);
