// Assemble the static website in _site/ (served by GitHub Pages and by
// `npm run serve`):
//   index.html, styles.css, js/   the workbench (web/)
//   fonts/                        self-hosted IBM Plex (no third-party requests)
//   cases/                        real published cases offered in the examples
//                                 menu, with their (approximate or provisional)
//                                 calibration and attribution
//   results/                      the automatic fits on every case: a page
//                                 rendered from results/README.md plus all
//                                 checkplots
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { FONT_FILES, fontPath, fontFaceCss } from './lib/fonts.mjs';

const root = new URL('../', import.meta.url);
// The page icon (an inline SVG) from the workbench page, reused on the results page.
const ICON = readFileSync(new URL('web/index.html', root), 'utf8').match(/<link rel="icon"[^>]*>/)?.[0] ?? '';
const site = new URL('_site/', root);
const at = (p) => new URL(p, root);

rmSync(site, { recursive: true, force: true });
mkdirSync(site, { recursive: true });
cpSync(at('web/'), site, { recursive: true });

// Fonts.
mkdirSync(new URL('fonts/', site), { recursive: true });
for (const f of FONT_FILES) copyFileSync(fontPath(f), new URL(`fonts/${f.file}`, site));
writeFileSync(new URL('fonts/fonts.css', site), `${fontFaceCss((f) => f.file)}\n`);
copyFileSync(at('node_modules/@fontsource/ibm-plex-sans/LICENSE'), new URL('fonts/OFL.txt', site));

// Real cases.
mkdirSync(new URL('cases/', site), { recursive: true });
const cal = JSON.parse(readFileSync(at('figures/calibration.json'), 'utf8'));
const cases = [];
copyFileSync(at('data/finger/finger_envelope.csv'), new URL('cases/finger_envelope.csv', site));
const siteFor = (file) => (file.includes('tibial') ? 'ata' : file.includes('brachial') ? 'brachial' : 'other');
for (const p of cal.panels) {
  const name = p.file.split('/').pop();
  copyFileSync(at(p.file), new URL(`cases/${name}`, site));
  const time = p.evidence.pxPer100ms ? 'time from the 0.1 s timeline marks' : 'time from dotted grid lines taken as 1 s apart (no heart rate visible to confirm it)';
  cases.push({
    id: name.replace('.png', ''),
    menuLabel: `${p.label} (image)`,
    label: `${p.label}: ${p.subtitle}`,
    kind: 'image',
    file: `cases/${name}`,
    site: siteFor(name),
    displayedHr: p.displayedHr_bpm,
    source: `Source: ${p.source.replace(' See figures/README.md.', '')}`,
    calibration: { region: p.region, baselineY: p.baselineY, velPerPx: p.velPerPx, secPerPx: p.secPerPx, tOffset: 0, source: 'figure' },
    calibrationNote: `Calibration read automatically from the scanner overlay in the published figure (velocity from the labelled cm/s ticks, ${time}); provisional, checked against the reference calibration in figures/calibration.json. Not a clinical ACCmax value; no expert reference exists for this case.`,
  });
}
cases.unshift({
  id: 'finger',
  menuLabel: 'Finger, proper volar digital artery (digitised trace)',
  label: 'Finger: proper volar digital artery of a healthy volunteer, envelope digitised from a pulsed-wave video',
  kind: 'csv',
  file: 'cases/finger_envelope.csv',
  columns: { t: 0, v: 1 },
  units: { time: 's', velocity: 'mm/s' },
  site: 'digital',
  source: 'Source: Noel (2021), Mendeley Data, doi:10.17632/7g2p7t9tzt.1, CC BY 4.0',
  calibrationNote: 'Approximate calibration from the printed 0 and −286 mm/s marks and 0.1 s ticks. The digitisation merges video frames that are offset by some milliseconds; a second, lagging band of samples is visible in the stack. Not a clinical ACCmax value.',
});
writeFileSync(new URL('cases/cases.json', site), `${JSON.stringify({ note: 'Real human cases from the repository (CLAUDE.md, data/README.md, figures/README.md). CC BY 4.0 sources.', cases }, null, 2)}\n`);

// Results page.
const results = new URL('results/', site);
mkdirSync(new URL('checkplots/', results), { recursive: true });
const plots = existsSync(at('results/checkplots/')) ? readdirSync(at('results/checkplots/')).filter((f) => f.endsWith('.png')) : [];
for (const f of plots) copyFileSync(at(`results/checkplots/${f}`), new URL(`checkplots/${f}`, results));
const md = existsSync(at('results/README.md')) ? readFileSync(at('results/README.md'), 'utf8') : '# Results\n\nNo results yet.';
writeFileSync(new URL('index.html', results), resultsPage(md, plots));

console.log(`_site/ built: ${cases.length} real cases, ${plots.length} checkplots`);

// Minimal Markdown → HTML for results/README.md (headings, paragraphs,
// lists, tables, images, links, inline code and bold, fenced code).
function inline(t) {
  return t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, href) => `<a href="${href.replace('../docs/PLAN.md', 'https://github.com/mncavieres/ACCmax/blob/main/docs/PLAN.md')}">${txt}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
function markdown(src) {
  const out = [];
  const lines = src.replace(/<!--.*?-->/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (l.startsWith('```')) {
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i].replace(/&/g, '&amp;').replace(/</g, '&lt;'));
      out.push(`<pre><code>${code.join('\n')}</code></pre>`);
    } else if (/^#{1,3} /.test(l)) {
      const n = l.match(/^#+/)[0].length;
      out.push(`<h${n}>${inline(l.slice(n + 1))}</h${n}>`);
    } else if (l.startsWith('|')) {
      const rows = [];
      for (; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i]);
      i--;
      const cells = (r) => r.slice(1, -1).split('|').map((c) => c.trim());
      const [h, , ...body] = rows;
      out.push(`<div class="table-wrap"><table class="beats"><thead><tr>${cells(h).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (l.startsWith('- ')) {
      const items = [];
      for (; i < lines.length && lines[i].startsWith('- '); i++) items.push(`<li>${inline(lines[i].slice(2))}</li>`);
      i--;
      out.push(`<ul>${items.join('')}</ul>`);
    } else {
      const para = [l];
      for (i++; i < lines.length && lines[i].trim() && !/^(#|\||- |```)/.test(lines[i]); i++) para.push(lines[i]);
      i--;
      out.push(`<p>${inline(para.join(' '))}</p>`);
    }
  }
  return out.join('\n');
}
function resultsPage(src, files) {
  const gallery = files
    .filter((f) => f !== 'overview.png')
    .map((f) => `<figure><a href="checkplots/${f}"><img src="checkplots/${f}" alt="Checkplot ${f.replace('.png', '')}" loading="lazy"></a><figcaption>${f.replace('.png', '').replaceAll('_', ' ')}</figcaption></figure>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>ACCmax Workbench results</title>
${ICON}
<link rel="stylesheet" href="../fonts/fonts.css">
<link rel="stylesheet" href="../styles.css">
<style>
  .doc { max-width: 1240px; margin: 0 auto; padding-block: 20px 40px; display: flex; flex-direction: column; gap: 14px; }
  .doc h1 { font-size: 1.6rem; }
  .doc h2 { margin-top: 18px; font-size: 1rem; }
  .doc p, .doc li { max-width: 85ch; color: var(--ink-2); }
  .doc img { max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 4px; background: #fff; }
  .doc pre { background: var(--surface-2); padding: 10px 12px; border-radius: 5px; overflow-x: auto; }
  .doc td, .doc th { font-family: var(--font-body); font-size: 0.82rem; white-space: normal; text-align: left; }
  .gallery { display: grid; gap: 22px; }
  .gallery figcaption { color: var(--muted); font-size: 0.85rem; margin-top: 4px; }
  .gallery figure { margin: 0; }
  .back { font-size: 0.9rem; }
</style>
</head>
<body>
<main class="doc">
<p class="back"><a href="../">← Open the ACCmax Workbench</a></p>
${markdown(src)}
<h2>All checkplots</h2>
<div class="gallery">
${gallery}
</div>
</main>
</body>
</html>
`;
}
