// Draw a scanner-style overlay onto a rendered spectral display (RGBA), for
// testing the automatic calibration on images with known scales: an orange
// baseline, a velocity scale (short and long ticks, the long ones labelled,
// "cm/s" at zero) and a timeline (0.1 s marks, taller every 0.5 s, tallest
// every 1 s). Labels use the Liberation Sans Bold glyphs in glyphs.js.

import { GLYPHS } from '../../web/js/io/glyphs.js';

const FONT = new Map(GLYPHS.filter((g, i) => GLYPHS.findIndex((q) => q[0] === g[0]) === i).map(([ch, w, h, px]) => [ch, { w, h, px }]));

function put(img, x, y, rgb, a = 1) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = 4 * (y * img.width + x);
  for (let c = 0; c < 3; c++) img.data[i + c] = Math.round((1 - a) * img.data[i + c] + a * rgb[c]);
}

function rect(img, x0, y0, w, h, rgb) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(img, x, y, rgb);
}

/** Text at (x, yMid), glyphs scaled to `size` px high; returns the width. */
export function text(img, str, x, yMid, size, rgb) {
  let cx = x;
  for (const ch of str) {
    if (ch === '-') {
      rect(img, cx, Math.round(yMid - size * 0.06), Math.round(size * 0.35), Math.max(2, Math.round(size * 0.12)), rgb);
      cx += Math.round(size * 0.45);
      continue;
    }
    const g = FONT.get(ch);
    if (!g) {
      cx += Math.round(size * 0.4);
      continue;
    }
    // Lower-case letters stand on the digits' baseline at x-height; the
    // slash is a little taller than a digit.
    const h = /[a-z]/.test(ch) ? Math.round(size * 0.73) : ch === '/' ? Math.round(size * 1.1) : size;
    const k = h / g.h;
    const w = Math.max(1, Math.round(g.w * k));
    const top = Math.round(yMid + size / 2 - h);
    // Area-average the glyph's pixels into each output pixel (anti-aliased).
    for (let y = 0; y < h; y++) {
      for (let x2 = 0; x2 < w; x2++) {
        let sum = 0;
        let n = 0;
        for (let gy = Math.floor(y / k); gy < Math.min(g.h, Math.ceil((y + 1) / k)); gy++) {
          for (let gx = Math.floor((x2 * g.w) / w); gx < Math.min(g.w, Math.ceil(((x2 + 1) * g.w) / w)); gx++) {
            sum += parseInt(g.px[gy * g.w + gx], 16) / 15;
            n++;
          }
        }
        const a = n ? Math.min(1, (1.3 * sum) / n) : 0;
        if (a > 0) put(img, cx + x2, top + y, rgb, a);
      }
    }
    cx += w + Math.max(1, Math.round(size * 0.12));
  }
  return cx - x;
}

/**
 * @param {{width:number,height:number,data:Uint8ClampedArray}} img
 * @param {{region:{x0:number,y0:number,x1:number,y1:number}, baselineY:number, velPerPx:number, secPerPx:number}} cal
 * @param {{stepCmS?:number, size?:number}} opts  label step (cm/s) and text height (px)
 */
export function drawScannerOverlay(img, cal, { stepCmS = 20, size = 15 } = {}) {
  const { region, baselineY, velPerPx, secPerPx } = cal;
  rect(img, region.x0, Math.round(baselineY) - 1, region.x1 - region.x0 + 1, 3, [200, 128, 58]);
  const sx = region.x1 + 12;
  const pxPerStep = stepCmS / 100 / Math.abs(velPerPx);
  for (let k = -20; k <= 20; k++) {
    const y = Math.round(baselineY - (k * pxPerStep) / 2);
    if (y < region.y0 - 2 || y > region.y1 + 2) continue;
    const long = k % 2 === 0;
    rect(img, sx, y - 1, long ? 14 : 7, 3, [242, 242, 242]);
    if (long) text(img, k === 0 ? 'cm/s' : String((k / 2) * stepCmS * Math.sign(velPerPx)), sx + 20, y, size, [242, 242, 242]);
  }
  const ty = region.y1 + 30;
  for (let k = 0; ; k++) {
    const x = Math.round(region.x0 + (k * 0.1) / secPerPx);
    if (x > region.x1) break;
    const h = k % 10 === 0 ? 12 : k % 5 === 0 ? 8 : 4;
    rect(img, x - 1, ty - h, 3, h, [242, 242, 242]);
  }
  return img;
}
