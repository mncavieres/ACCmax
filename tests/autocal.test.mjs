// Automatic image calibration (web/js/io/autocal.js): the published example
// crops, altered copies of them (resized, noisy, padded, cropped), synthetic
// displays with known scales, and the whole path an uploaded image takes in
// the workbench (calibrate, trace, fit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodePng } from '../scripts/lib/png.mjs';
import { drawScannerOverlay } from '../scripts/lib/scanner-overlay.mjs';
import { autoCalibrate, matchKnownDisplay, fitLattice } from '../web/js/io/autocal.js';
import { KNOWN_DISPLAYS } from '../web/js/io/known-displays.js';
import { extractEnvelope } from '../web/js/io/envelope.js';
import { analyze, DEFAULT_PARAMS } from '../web/js/core/pipeline.js';
import { synthesize, renderSpectrogram } from '../web/js/core/synthetic.js';

const root = new URL('../', import.meta.url);
const reference = JSON.parse(readFileSync(new URL('figures/calibration.json', root), 'utf8')).panels;
const load = (file) => decodePng(readFileSync(new URL(file, root)));
const rel = (a, b) => Math.abs(a / b - 1);

// Area-average resize of an RGBA image.
function resize(img, k) {
  const W = Math.round(img.width * k);
  const H = Math.round(img.height * k);
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const xa = x / k;
      const xb = (x + 1) / k;
      const ya = y / k;
      const yb = (y + 1) / k;
      const acc = [0, 0, 0];
      let n = 0;
      for (let sy = Math.floor(ya); sy < Math.min(img.height, Math.ceil(yb)); sy++) {
        const wy = Math.min(yb, sy + 1) - Math.max(ya, sy);
        for (let sx = Math.floor(xa); sx < Math.min(img.width, Math.ceil(xb)); sx++) {
          const w = wy * (Math.min(xb, sx + 1) - Math.max(xa, sx));
          const i = 4 * (sy * img.width + sx);
          for (let c = 0; c < 3; c++) acc[c] += w * img.data[i + c];
          n += w;
        }
      }
      const o = 4 * (y * W + x);
      for (let c = 0; c < 3; c++) out[o + c] = acc[c] / n;
      out[o + 3] = 255;
    }
  }
  return { width: W, height: H, data: out };
}

function pad(img, p) {
  const W = img.width + 2 * p;
  const H = img.height + 2 * p;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  for (let y = 0; y < img.height; y++) out.set(img.data.subarray(4 * y * img.width, 4 * (y + 1) * img.width), 4 * ((y + p) * W + p));
  return { width: W, height: H, data: out };
}

function crop(img, dx, dy) {
  const W = img.width - dx;
  const H = img.height - dy;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) out.set(img.data.subarray(4 * ((y + dy) * img.width + dx), 4 * ((y + dy) * img.width + img.width)), 4 * y * W);
  return { width: W, height: H, data: out };
}

// Compression-like noise: small grey and colour errors on every pixel.
function noisy(img, seed = 1) {
  let s = seed >>> 0;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 2;
  const out = new Uint8ClampedArray(img.data);
  for (let i = 0; i < out.length; i += 4) {
    const g = 5 * r();
    for (let c = 0; c < 3; c++) out[i + c] = out[i + c] + g + 4 * r();
  }
  return { width: img.width, height: img.height, data: out };
}

function checkCalibration(auto, p, k = 1, label = p.file) {
  assert.ok(auto.ok, `${label}: calibration incomplete (${auto.missing.join(', ')})`);
  const c = auto.calibration;
  assert.ok(rel(Math.abs(c.velPerPx) * k, Math.abs(p.velPerPx)) < 0.006, `${label}: velocity ${c.velPerPx} vs ${p.velPerPx / k}`);
  assert.equal(Math.sign(c.velPerPx), Math.sign(p.velPerPx), `${label}: flow direction`);
  assert.ok(rel(c.secPerPx * k, p.secPerPx) < 0.004, `${label}: time ${c.secPerPx} vs ${p.secPerPx / k}`);
}

test('autocal: every published crop is calibrated from its overlay and recognised', () => {
  for (const p of reference) {
    const img = load(p.file);
    const auto = autoCalibrate(img, { library: KNOWN_DISPLAYS });
    checkCalibration(auto, p);
    assert.ok(Math.abs(auto.calibration.baselineY - p.baselineY) <= 1, `${p.file}: baseline ${auto.calibration.baselineY} vs ${p.baselineY}`);
    // The labels read are the labels printed (the zero is "cm/s").
    const read = auto.found.labels.points.map((q) => q.value);
    const printed = p.evidence.velocityTicks.map((t) => t.cm_s);
    for (const v of read) assert.ok(printed.includes(v), `${p.file}: read ${v}, printed ${printed}`);
    assert.ok(read.length >= 3, `${p.file}: only ${read.length} labels`);
    assert.equal(auto.found.labels.unit, 'cm/s');
    assert.equal(auto.match?.id, p.file.split('/').pop().replace('.png', ''), `${p.file}: not recognised`);
    // The region keeps the ECG trace out.
    if (auto.found.ecg) assert.ok(auto.calibration.region.y1 < auto.found.ecg.y0 || auto.calibration.region.y0 > auto.found.ecg.y1);
  }
});

test('autocal: resized, noisy, padded and cropped copies', () => {
  for (const p of reference) {
    const img = load(p.file);
    const resized = resize(img, 0.8);
    checkCalibration(autoCalibrate(resized, { library: KNOWN_DISPLAYS }), p, 0.8, `${p.file} at 80%`);
    assert.ok(matchKnownDisplay(resized, KNOWN_DISPLAYS), `${p.file} at 80%: not recognised`);
    checkCalibration(autoCalibrate(noisy(img), { library: KNOWN_DISPLAYS }), p, 1, `${p.file} with noise`);
    const padded = pad(img, 30);
    checkCalibration(autoCalibrate(padded, { library: KNOWN_DISPLAYS }), p, 1, `${p.file} padded`);
    assert.equal(matchKnownDisplay(padded, KNOWN_DISPLAYS), null, `${p.file} padded: a different image must not be recognised`);
    checkCalibration(autoCalibrate(crop(img, 15, 12), { library: KNOWN_DISPLAYS }), p, 1, `${p.file} cropped`);
  }
});

test('autocal: synthetic displays with known scales, upright and inverted', () => {
  const sim = synthesize({ preset: 'biphasic', hr: 64, duration: 5, noise: 0, seed: 34 });
  for (const [velPerPx, secPerPx, baselineY] of [
    [0.0025, 0.0045, 262],
    [0.004, 0.003, 262],
    [-0.0025, 0.0045, 80],
  ]) {
    const cal = { region: { x0: 46, y0: 24, x1: 866, y1: 318 }, baselineY, velPerPx, secPerPx };
    const img = drawScannerOverlay(renderSpectrogram(sim, { width: 960, height: 372, ...cal, seed: 35, marks: false }), cal);
    const auto = autoCalibrate(img);
    assert.ok(auto.ok, `synthetic ${velPerPx}: ${auto.missing}`);
    assert.ok(rel(auto.calibration.velPerPx, velPerPx) < 0.003, `synthetic velocity ${auto.calibration.velPerPx} vs ${velPerPx}`);
    assert.ok(rel(auto.calibration.secPerPx, secPerPx) < 0.003, `synthetic time ${auto.calibration.secPerPx} vs ${secPerPx}`);
    assert.ok(Math.abs(auto.calibration.baselineY - baselineY) <= 1);
    assert.equal(auto.found.time.majorEvery, 10);
  }
});

test('autocal: an uploaded crop goes from calibration to fit without input', () => {
  // ACCmax (m/s²) and AT (ms) from the automatic path (results/summary.json).
  const expected = {
    anterior_tibial_baseline: [6.15, 116],
    anterior_tibial_eecp_1: [31.32, 87],
    anterior_tibial_eecp_2: [34.45, 83],
    anterior_tibial_eecp_3: [53.07, 57],
    brachial_before_eecp: [22.07, 76],
    brachial_during_eecp: [24.18, 95],
  };
  for (const p of reference) {
    const id = p.file.split('/').pop().replace('.png', '');
    const img = load(p.file);
    const auto = autoCalibrate(img, { library: KNOWN_DISPLAYS });
    const env = extractEnvelope(img, auto.calibration);
    const r = analyze(env.t, env.v, { ...DEFAULT_PARAMS, bootstrap: 0 });
    assert.ok(r.ok, `${id}: ${r.error}`);
    const [acc, at] = expected[id];
    assert.ok(rel(r.landmarks.accmax, acc) < 0.02, `${id}: ACCmax ${r.landmarks.accmax} vs ${acc}`);
    assert.ok(Math.abs(r.landmarks.at * 1000 - at) < 3, `${id}: AT ${r.landmarks.at * 1000} vs ${at}`);
    if (auto.match.displayedHr) assert.ok(rel(r.hr, auto.match.displayedHr) < 0.1, `${id}: HR ${r.hr} vs screen ${auto.match.displayedHr}`);
  }
});

test('autocal: an image without a scale is reported, not guessed', () => {
  const W = 400;
  const H = 200;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const x = i % W;
    const v = (Math.floor(x / 40) % 2) * 180;
    data.set([v, v, v, 255], 4 * i);
  }
  const auto = autoCalibrate({ width: W, height: H, data });
  assert.equal(auto.ok, false);
  assert.ok(auto.missing.includes('velocity'));
  assert.equal(auto.calibration, null);
});

test('autocal: lattice fit finds the spacing despite gaps and stray points', () => {
  const xs = [10, 30, 50, 90, 110, 130, 150, 77, 170];
  const lat = fitLattice(xs, { dMin: 8, dMax: 100, tol: 1.5 });
  assert.ok(Math.abs(lat.spacing - 20) < 0.05);
  assert.equal(lat.count, 8);
});
