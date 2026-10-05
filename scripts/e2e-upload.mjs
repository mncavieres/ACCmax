// End-to-end check in a real browser: open each published example image as
// a user would (file upload), press "Run automatic fit", and check that the
// image was calibrated automatically, recognised, and fitted to the values in
// results/summary.json. Also runs the synthetic screenshot example against
// its known truth.
//
//   npm run test:e2e        (builds _site/ first)
//
// Needs Playwright's Chromium (npx playwright install chromium) or Google
// Chrome; on GitHub Actions the preinstalled Chrome is used.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const site = join(root, '_site');
const summary = JSON.parse(readFileSync(join(root, 'results/summary.json'), 'utf8'));
const crops = summary.cases.filter((c) => c.group === 'real' && existsSync(join(root, `figures/crops/${c.id}.png`)));

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.csv': 'text/csv', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const server = createServer((req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  let file = join(site, p);
  if (!file.startsWith(site)) return res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const url = `http://127.0.0.1:${server.address().port}/`;

let browser;
try {
  browser = await chromium.launch();
} catch {
  browser = await chromium.launch({ channel: 'chrome' });
}
const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  return ok;
};
const number = (text) => Number(text.replace(/[^\d.-]/g, ''));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('.metric.hero', { timeout: 30000 });

for (const c of crops) {
  const file = join(root, `figures/crops/${c.id}.png`);
  await page.setInputFiles('#file-input', file);
  await page.waitForFunction(
    (name) => document.querySelector('#source-line').textContent.includes(name) && !/Calibrating/.test(document.querySelector('#calib-status').textContent),
    `${c.id}.png`,
    { timeout: 30000 }
  );
  const status = (await page.textContent('#calib-status')).trim();
  const found = (await page.textContent('#calib-found')).replace(/\s+/g, ' ');
  check(status.startsWith('Calibrated automatically'), `${c.id}: not calibrated automatically (“${status}”)`);
  check(found.includes('Recognised'), `${c.id}: not recognised as a published example`);
  await page.click('#run-btn');
  await page.waitForFunction(() => document.querySelector('.metric.hero') && !document.querySelector('.flow.busy'), null, { timeout: 30000 });
  const acc = number(await page.textContent('.metric.hero .value b'));
  check(Math.abs(acc / c.accmax_m_s2 - 1) < 0.02, `${c.id}: ACCmax ${acc} m/s², expected ${c.accmax_m_s2.toFixed(2)}`);
  console.log(`${c.id.padEnd(26)} ${status.replace('Calibrated automatically from the image: ', '').padEnd(34)} ACCmax ${acc.toFixed(2)} m/s² (expected ${c.accmax_m_s2.toFixed(2)})`);
}

// The synthetic screenshot: calibrated automatically, close to its truth.
await page.selectOption('#example-select', 'screenshot');
await page.click('#example-btn');
await page.waitForFunction(() => /Example screenshot/.test(document.querySelector('#source-line').textContent) && !/Calibrating/.test(document.querySelector('#calib-status').textContent), null, { timeout: 30000 });
const shotStatus = (await page.textContent('#calib-status')).trim();
check(shotStatus.startsWith('Calibrated automatically'), `screenshot example: not calibrated automatically (“${shotStatus}”)`);
await page.click('#run-btn');
await page.waitForSelector('.metric.hero .truth', { timeout: 30000 });
const shotAcc = number(await page.textContent('.metric.hero .value b'));
const shotTruth = number(await page.textContent('.metric.hero .truth'));
check(Math.abs(shotAcc / shotTruth - 1) < 0.05, `screenshot example: ACCmax ${shotAcc} vs truth ${shotTruth}`);
console.log(`${'screenshot example'.padEnd(26)} ${shotStatus.replace('Calibrated automatically from the image: ', '').padEnd(34)} ACCmax ${shotAcc.toFixed(2)} m/s² (truth ${shotTruth.toFixed(2)})`);

check(errors.length === 0, `page errors: ${errors.join(' | ')}`);
await browser.close();
server.close();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`\nAll ${crops.length + 1} images calibrated automatically and fitted.`);
