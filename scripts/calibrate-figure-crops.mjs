// Derive a provisional pixel → velocity and pixel → time calibration for the
// published figure crops (anterior tibial and brachial, Zhang et al. 2021)
// from the scanner overlay printed in each panel, and write
// figures/calibration.json.
//
// Velocity: the long tick marks on the right-hand scale, matched top to bottom
// to the printed labels (read from the image), fitted with a straight line.
// The orange baseline must fall on the 0 cm/s tick.
// Time (tibial): the evenly spaced marks along the ECG baseline, fitted as a
// lattice; "one mark per 0.1 s" is cross-checked against the heart rate
// printed on the display (scripts/fit-cases.mjs reports both).
// Time (brachial): the dotted vertical lines, taken as 1 s apart.
//
// This calibration is NOT independently verified (see figures/README.md).
// Results that use it are provisional and are not clinical ACCmax values.

import { readFileSync, writeFileSync } from 'node:fs';
import { decodePng } from './lib/png.mjs';

const root = new URL('../', import.meta.url);

// Values read by eye from each panel: the labels of the long velocity ticks
// (top to bottom), a pixel column that crosses every tick mark, the displayed
// heart rate, and a display region that keeps clear of overlay text and the
// ECG trace.
const TIBIAL = 'Zhang et al., Frontiers in Cardiovascular Medicine 8:795697 (2021), Figure 2, CC BY 4.0. See figures/README.md.';
const BRACHIAL = 'Zhang et al., Frontiers in Cardiovascular Medicine 8:721140 (2021), Figure 2, CC BY 4.0. See figures/README.md.';
const PANELS = [
  { file: 'anterior_tibial_baseline.png', label: 'Anterior tibial artery, baseline', ticks: [60, 40, 20, 0, -20], tickX: 1411, displayedHr: 58, source: TIBIAL, subtitle: 'Healthy young man, at rest (figure panel)', region: { x0: 0, y0: 5, x1: 1392, y1: 300 } },
  { file: 'anterior_tibial_eecp_1.png', label: 'Anterior tibial artery, EECP-1', ticks: [40, 0, -40], tickX: 1398, displayedHr: 63, source: TIBIAL, subtitle: 'Same subject during counterpulsation, setting EECP-1 (figure panel)', region: { x0: 0, y0: 30, x1: 1384, y1: 355 } },
  { file: 'anterior_tibial_eecp_2.png', label: 'Anterior tibial artery, EECP-2', ticks: [60, 0, -60], tickX: 1400, displayedHr: 61, source: TIBIAL, subtitle: 'Same subject during counterpulsation, setting EECP-2 (figure panel)', region: { x0: 0, y0: 32, x1: 1386, y1: 340 } },
  { file: 'anterior_tibial_eecp_3.png', label: 'Anterior tibial artery, EECP-3', ticks: [120, 60, 0, -60], tickX: 1400, displayedHr: 63, source: TIBIAL, subtitle: 'Same subject during counterpulsation, setting EECP-3 (figure panel)', region: { x0: 0, y0: 22, x1: 1386, y1: 400 } },
  { file: 'brachial_before_eecp.png', label: 'Brachial artery, before EECP', ticks: [-40, 0, 40, 80, 120, 160], tickX: 853, displayedHr: null, timeMarks: 'lines', source: BRACHIAL, subtitle: 'Inverted pulsed-wave display, coronary disease study (figure panel)', region: { x0: 30, y0: 8, x1: 832, y1: 212 } },
  { file: 'brachial_during_eecp.png', label: 'Brachial artery, during EECP', ticks: [-40, 0, 40, 80, 120, 160], tickX: 863, displayedHr: null, timeMarks: 'lines', source: BRACHIAL, subtitle: 'Same panel set during counterpulsation, inverted display (figure panel)', region: { x0: 30, y0: 26, x1: 840, y1: 228 } },
];

function linearFit(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const slope = sxy / sxx;
  const icpt = my - slope * mx;
  const rms = Math.sqrt(xs.reduce((s, x, i) => s + (ys[i] - (icpt + slope * x)) ** 2, 0) / n);
  return { slope, icpt, rms };
}

function calibrate(panel) {
  const img = decodePng(readFileSync(new URL(`figures/crops/${panel.file}`, root)));
  const at = (x, y) => {
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  const white = (x, y) => {
    const [r, g, b] = at(x, y);
    return r > 170 && g > 170 && b > 170;
  };
  const orange = (x, y) => {
    const [r, , b] = at(x, y);
    return r > 150 && b < 110 && r - b > 80;
  };

  // Orange baseline row(s).
  const baseRows = [];
  for (let y = 0; y < img.height; y++) {
    let n = 0;
    for (let x = 0; x < 1380; x++) if (orange(x, y)) n++;
    if (n > 0.6 * 1380) baseRows.push(y);
  }
  const baselineY = (baseRows[0] + baseRows[baseRows.length - 1]) / 2;

  // Tick marks crossing the given column, with how far right each extends.
  const ticks = [];
  for (let y = 0, x = panel.tickX; y < img.height; ) {
    if (!white(x, y)) {
      y++;
      continue;
    }
    let y2 = y;
    while (y2 + 1 < img.height && white(x, y2 + 1)) y2++;
    const yc = Math.round((y + y2) / 2);
    let xa = x;
    while (xa > 1370 && white(xa - 1, yc)) xa--;
    let xb = x;
    while (xb < img.width - 1 && white(xb + 1, yc)) xb++;
    if (y2 - y < 7 && xb - xa < 40) ticks.push({ y: (y + y2) / 2, right: xb });
    y = y2 + 1;
  }
  const best = { ticks };
  // Long (labelled) ticks reach further right than the unlabelled minor ticks.
  const inScale = best.ticks.filter((t) => t.y > panel.region.y0 - 25 && t.y < panel.region.y1 + 45);
  const maxRight = Math.max(...inScale.map((t) => t.right));
  const long = inScale.filter((t) => t.right >= maxRight - 2);
  if (long.length !== panel.ticks.length) {
    throw new Error(`${panel.file}: found ${long.length} long ticks (${long.map((t) => t.y).join(', ')}), expected ${panel.ticks.length}`);
  }
  const vfit = linearFit(panel.ticks, long.map((t) => t.y)); // y = icpt + slope · v
  const zeroY = vfit.icpt;
  if (Math.abs(zeroY - baselineY) > 2) throw new Error(`${panel.file}: 0 cm/s tick at y=${zeroY.toFixed(1)} but baseline at ${baselineY}`);

  if (panel.timeMarks === 'lines') return finish(panel, img, baselineY, vfit, long, lineMarks(img, baselineY, panel));

  // Timeline marks: in each row below the display, find short white marks and
  // the evenly spaced lattice that most of them sit on; keep the best row.
  const latticeFit = (xs) => {
    const diffs = [];
    for (let i = 1; i < xs.length; i++) {
      const d = xs[i] - xs[i - 1];
      if (d > 25 && d < 60) diffs.push(d);
    }
    if (diffs.length < 4) return null;
    diffs.sort((a, b) => a - b);
    let spacing = diffs[diffs.length >> 1];
    const members = (x0, sp) =>
      xs.map((x) => ({ x, k: Math.round((x - x0) / sp) })).filter((q) => Math.abs(q.x - (x0 + q.k * sp)) < 2.5);
    let x0 = xs[0];
    let on = [];
    for (const a of xs) {
      const m = members(a, spacing);
      if (m.length > on.length) {
        on = m;
        x0 = a;
      }
    }
    for (let iter = 0; iter < 3; iter++) {
      const f = linearFit(on.map((q) => q.k), on.map((q) => q.x));
      spacing = f.slope;
      x0 = f.icpt;
      on = members(x0, spacing);
    }
    return { spacing, x0, on, fit: linearFit(on.map((q) => q.k), on.map((q) => q.x)) };
  };
  let row = null;
  for (let y = Math.round(baselineY) + 60; y < img.height; y++) {
    const xs = [];
    for (let x = 0; x < 1395; ) {
      if (!white(x, y)) {
        x++;
        continue;
      }
      let x2 = x;
      while (x2 + 1 < 1395 && white(x2 + 1, y)) x2++;
      if (x2 - x <= 3) xs.push((x + x2) / 2);
      x = x2 + 1;
    }
    const lf = latticeFit(xs);
    if (lf && (!row || lf.on.length > row.lf.on.length)) row = { y, lf };
  }
  if (!row || row.lf.on.length < 10) throw new Error(`${panel.file}: no regular timeline marks found`);
  const spacing = row.lf.spacing;
  const tfit = row.lf.fit;
  const onLattice = row.lf.on;

  return finish(panel, img, baselineY, vfit, long, {
    secPerPx: 0.1 / spacing,
    evidence: {
      timelineRowY: row.y,
      timeMarks: onLattice.length,
      pxPer100ms: +spacing.toFixed(3),
      timeFitRms_px: +tfit.rms.toFixed(2),
      assumption: 'Timeline marks are 0.1 s apart (taller marks every 0.2 s, tallest every 1 s); the scanner also prints a 66 mm/s sweep.',
    },
  });
}

// Dotted vertical time lines (brachial panels): orange dots in columns.
function lineMarks(img, baselineY, panel) {
  const at = (x, y) => {
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  const counts = new Float64Array(panel.region.x1 + 1);
  const yEnd = Math.min(img.height - 1, panel.region.y1 + 45);
  for (let x = 0; x <= panel.region.x1; x++) {
    for (let y = panel.region.y0; y <= yEnd; y++) {
      if (Math.abs(y - baselineY) <= 3) continue;
      const [r, g, b] = at(x, y);
      if (r > 120 && r - b > 50 && g > 60) counts[x]++;
    }
  }
  const groups = [];
  for (let x = 0; x < counts.length; x++) {
    if (counts[x] < 3) continue;
    const last = groups[groups.length - 1];
    if (last && x - last.x1 <= 2) {
      last.x1 = x;
      last.sw += counts[x];
      last.sx += x * counts[x];
    } else groups.push({ x1: x, sw: counts[x], sx: x * counts[x] });
  }
  const xs = groups.map((g) => g.sx / g.sw);
  // Spacing: try each gap (and its halves and thirds) as the lattice step and
  // keep the step that puts the most detected lines on the lattice.
  const candidates = [];
  for (let i = 1; i < xs.length; i++) for (const k of [1, 2, 3]) if ((xs[i] - xs[i - 1]) / k > 100) candidates.push((xs[i] - xs[i - 1]) / k);
  let on = [];
  for (const step of candidates) {
    for (const a of xs) {
      const m = xs.map((x) => ({ x, k: Math.round((x - a) / step) })).filter((q) => Math.abs(q.x - (a + q.k * step)) < 4);
      if (m.length > on.length) on = m;
    }
  }
  const fit = linearFit(on.map((q) => q.k), on.map((q) => q.x));
  if (on.length < 3) throw new Error(`${panel.file}: too few dotted time lines`);
  return {
    secPerPx: 1 / fit.slope,
    evidence: {
      timeLines_x: on.map((q) => +q.x.toFixed(1)),
      pxPerSecond: +fit.slope.toFixed(2),
      timeFitRms_px: +fit.rms.toFixed(2),
      assumption: 'Dotted vertical lines are 1 s apart. No heart rate is legible on the panel to cross-check this; the alternative (0.5 s) would imply about 140 bpm at rest. Least certain of the calibrations.',
    },
  };
}

function finish(panel, img, baselineY, vfit, long, time) {
  const velPerPx = -1 / vfit.slope / 100; // m/s per pixel, positive upwards
  return {
    file: `figures/crops/${panel.file}`,
    label: panel.label,
    subtitle: panel.subtitle,
    source: panel.source,
    width: img.width,
    height: img.height,
    region: panel.region,
    baselineY,
    velPerPx,
    secPerPx: time.secPerPx,
    tOffset: 0,
    flowUp: velPerPx > 0,
    displayedHr_bpm: panel.displayedHr,
    evidence: {
      velocityTicks: long.map((t, i) => ({ y: t.y, cm_s: panel.ticks[i] })),
      velocityFitRms_px: +vfit.rms.toFixed(2),
      pxPerCmS: +Math.abs(vfit.slope).toFixed(4),
      ...time.evidence,
    },
  };
}

const out = {
  status: 'provisional',
  note: 'Derived from the scanner overlay printed in each published panel; not independently verified. Velocities assume the displayed scale is already angle-corrected. Do not report results from this calibration as clinical ACCmax values.',
  sources: [TIBIAL, BRACHIAL],
  generatedBy: 'scripts/calibrate-figure-crops.mjs',
  panels: PANELS.map(calibrate),
};
writeFileSync(new URL('figures/calibration.json', root), `${JSON.stringify(out, null, 2)}\n`);
for (const p of out.panels) {
  const time = p.evidence.pxPer100ms ? `${p.evidence.pxPer100ms} px per 0.1 s from ${p.evidence.timeMarks} marks` : `${p.evidence.pxPerSecond} px per s from ${p.evidence.timeLines_x.length} dotted lines`;
  console.log(`${p.file}: baseline y=${p.baselineY}, ${p.evidence.pxPerCmS} px per cm/s (rms ${p.evidence.velocityFitRms_px} px), ${time} (rms ${p.evidence.timeFitRms_px} px), forward ${p.flowUp ? 'up' : 'down'}`);
}
