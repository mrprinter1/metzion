const { chromium } = require('playwright');
// pad = שוליים שקופים ביחס לגודל. בחנות: 16 מתוך 128.
const svg = (pad, arrow) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="100%" height="100%">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1fb45a"/><stop offset="1" stop-color="#0a7a3d"/></linearGradient></defs>
<g transform="translate(${pad} ${pad}) scale(${(128 - 2 * pad) / 128})">
<rect width="128" height="128" rx="30" fill="url(#g)"/>
<circle cx="56" cy="56" r="27" fill="none" stroke="#fff" stroke-width="12"/>
<path d="M76 76 L98 98" stroke="#fff" stroke-width="15" stroke-linecap="round"/>
${arrow ? '<path d="M66 45 L46 67" stroke="#fff" stroke-width="6.5" stroke-linecap="round"/><circle cx="47.5" cy="47" r="5.5" fill="#fff"/><circle cx="64.5" cy="65" r="5.5" fill="#fff"/>' : ''}
</g></svg>`;
// יוצר את האייקונים ב-icons/. הרצה: NODE_PATH=$(npm root -g) node scripts/icons.js
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  for (const [size, pad, arrow] of [[128, 16, true], [48, 4, true], [32, 0, true], [16, 0, false]]) {
    await p.setViewportSize({ width: size, height: size });
    await p.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg(pad, arrow)}`);
    await p.screenshot({ path: `${__dirname}/../icons/icon${size}.png`, omitBackground: true });
  }
  await b.close();
})();
