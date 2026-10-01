// Bundle the workbench into self-contained HTML files:
//   dist/accmax-workbench.html  complete document; open it straight from disk,
//                               works offline (fonts fall back to system faces)
//   dist/artifact.html          the same page without the html/head/body
//                               wrapper, for hosts that supply their own
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

const bundle = await build({
  entryPoints: [new URL('web/js/app.js', root).pathname],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  write: false,
  legalComments: 'none',
});
const js = bundle.outputFiles[0].text.replaceAll('</script', '<\\/script');
const css = read('web/styles.css');
let html = read('web/index.html');
html = html.replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${css}</style>`);
html = html.replace('<script type="module" src="js/app.js"></script>', () => `<script>\n${js}</script>`);
if (html.includes('src="js/app.js"') || html.includes('href="styles.css"')) throw new Error('inlining failed');

mkdirSync(new URL('dist/', root), { recursive: true });
writeFileSync(new URL('dist/accmax-workbench.html', root), html);

// Fragment: keep <title>, font links, style, body content and script.
const head = html.slice(html.indexOf('<head>') + 6, html.indexOf('</head>'));
const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
const keepHead = head
  .split('\n')
  .filter((l) => !/<meta charset|<meta name="viewport"/.test(l))
  .join('\n');
// Title first so hosts that scan the start of the file find it.
const title = keepHead.match(/<title>.*?<\/title>/)[0];
// Embedded viewers block page-initiated downloads; keep "Copy results" only.
const fragmentBody = body.replace(/(id="(?:json|csv)-btn" type="button" disabled)/g, '$1 hidden');
if (fragmentBody === body) throw new Error('download buttons not found');
writeFileSync(new URL('dist/artifact.html', root), `${title}\n${keepHead.replace(title, '')}\n${fragmentBody}`);
console.log(`dist/accmax-workbench.html ${(html.length / 1024).toFixed(0)} kB`);
