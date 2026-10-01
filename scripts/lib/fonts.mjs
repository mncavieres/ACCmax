// IBM Plex faces used by the workbench, served from the page itself (no
// third-party font requests). Files come from the @fontsource packages
// (SIL Open Font License 1.1).
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);

export const FONT_FILES = [
  { family: 'IBM Plex Sans', pkg: 'ibm-plex-sans', weight: 400, style: 'normal' },
  { family: 'IBM Plex Sans', pkg: 'ibm-plex-sans', weight: 400, style: 'italic' },
  { family: 'IBM Plex Sans', pkg: 'ibm-plex-sans', weight: 500, style: 'normal' },
  { family: 'IBM Plex Sans', pkg: 'ibm-plex-sans', weight: 600, style: 'normal' },
  { family: 'IBM Plex Sans Condensed', pkg: 'ibm-plex-sans-condensed', weight: 500, style: 'normal' },
  { family: 'IBM Plex Sans Condensed', pkg: 'ibm-plex-sans-condensed', weight: 600, style: 'normal' },
  { family: 'IBM Plex Mono', pkg: 'ibm-plex-mono', weight: 400, style: 'normal' },
  { family: 'IBM Plex Mono', pkg: 'ibm-plex-mono', weight: 500, style: 'normal' },
].map((f) => ({ ...f, file: `${f.pkg}-latin-${f.weight}-${f.style}.woff2` }));

export const fontPath = (f) => new URL(`node_modules/@fontsource/${f.pkg}/files/${f.file}`, root);

/** @param {(f: object) => string} src URL for each face */
export function fontFaceCss(src) {
  return FONT_FILES.map(
    (f) => `@font-face { font-family: "${f.family}"; font-style: ${f.style}; font-weight: ${f.weight}; font-display: swap; src: url("${src(f)}") format("woff2"); }`
  ).join('\n');
}

/** CSS with every face embedded as a data URI (for single-file builds). */
export function inlineFontCss() {
  return fontFaceCss((f) => `data:font/woff2;base64,${readFileSync(fontPath(f)).toString('base64')}`);
}
