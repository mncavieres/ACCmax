// Regression tests from running the method on the real cases in this
// repository and on synthetic cases built to reproduce what they revealed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze } from '../web/js/core/pipeline.js';
import { synthesize, syntheticTruth, renderSpectrogram, PRESETS } from '../web/js/core/synthetic.js';
import { extractEnvelope } from '../web/js/io/envelope.js';
import { parseDelimited, tableToTrace } from '../web/js/io/csv.js';
import { decodePng } from '../scripts/lib/png.mjs';

const root = new URL('../', import.meta.url);
const cal = JSON.parse(readFileSync(new URL('figures/calibration.json', root)));
const panel = (name) => cal.panels.find((p) => p.file.endsWith(name));
const fitPanel = (name) => {
  const p = panel(name);
  const env = extractEnvelope(decodePng(readFileSync(new URL(p.file, root))), p);
  return { p, env, r: analyze(env.t, env.v, { bootstrap: 0 }) };
};

test('real: anterior tibial baseline crop gives the displayed heart rate and three complete beats', () => {
  const { p, r } = fitPanel('anterior_tibial_baseline.png');
  assert.ok(r.ok, r.error);
  assert.ok(Math.abs(r.hr - p.displayedHr_bpm) < 3, `HR ${r.hr} vs scanner ${p.displayedHr_bpm}`);
  assert.ok(r.nBeats >= 3);
  assert.ok(r.landmarks.accmax > 3 && r.landmarks.accmax < 12, `ACCmax ${r.landmarks.accmax}`);
  assert.ok(r.landmarks.at > 0.08 && r.landmarks.at < 0.16, `AT ${r.landmarks.at}`);
});

test('real: counterpulsation crops keep the cardiac rate, not twice it', () => {
  for (const name of ['anterior_tibial_eecp_1.png', 'anterior_tibial_eecp_2.png', 'anterior_tibial_eecp_3.png']) {
    const { p, r } = fitPanel(name);
    assert.ok(r.ok, `${name}: ${r.error}`);
    assert.ok(Math.abs(r.hr - p.displayedHr_bpm) < 6, `${name}: HR ${r.hr} vs scanner ${p.displayedHr_bpm}`);
  }
});

test('real: inverted brachial display is measured on the forward (downward) side', () => {
  const { p, env, r } = fitPanel('brachial_before_eecp.png');
  assert.ok(p.velPerPx < 0 && p.flowUp === false);
  assert.ok(r.ok, r.error);
  assert.ok(r.landmarks.psv > 0.8, `PSV ${r.landmarks.psv} m/s`);
  assert.ok(Math.max(...env.vReverse) < 0.5, 'reverse side holds the small retrograde component');
});

test('real: finger digitisation is fitted at its own heart rate despite interleaved dropouts', () => {
  const table = parseDelimited(readFileSync(new URL('data/finger/finger_envelope.csv', root), 'utf8'));
  const tr = tableToTrace(table, { velUnit: 'mm/s' });
  const r = analyze(tr.t, tr.v, { bootstrap: 0 });
  assert.ok(r.ok, r.error);
  assert.ok(Math.abs(r.hr - 51.5) < 3, `HR ${r.hr}`);
  assert.ok(r.nBeats >= 7);
  assert.ok(r.qc.some((q) => /dropouts/.test(q.message)));
});

test('a second forward wave in every cycle does not double the heart rate', () => {
  const shape = { ...PRESETS.triphasic, late: 0.3, lateDelay: 0.42, lateWidth: 0.06 };
  const sim = synthesize({ shape, hr: 62, duration: 8, noise: 0.015, seed: 3 });
  const r = analyze(sim.t, sim.v, { bootstrap: 0 });
  assert.ok(r.ok, r.error);
  assert.ok(Math.abs(r.hr - 62) < 4, `HR ${r.hr}`);
});

test('one-sample dropouts on the upstroke are removed before fitting', () => {
  const c = { preset: 'triphasic', hr: 70 };
  const sim = synthesize({ ...c, duration: 8, noise: 0.01, seed: 4 });
  const dirty = Float64Array.from(sim.v);
  for (let i = 1; i < dirty.length - 1; i += 3) if (sim.clean[i] > 0.15) dirty[i] = 0.004;
  const truth = syntheticTruth(c);
  const r = analyze(sim.t, dirty, { bootstrap: 0 });
  assert.ok(r.ok, r.error);
  assert.ok(Math.abs(r.landmarks.accmax / truth.accmax - 1) < 0.08, `ACCmax ${r.landmarks.accmax} vs ${truth.accmax}`);
});

test('beats of different amplitude are averaged, not switched between (no false steepness)', () => {
  const sim = synthesize({ preset: 'biphasic', hr: 64, duration: 5, noise: 0, quant: 0, spikes: 0, seed: 34 });
  const r = analyze(sim.t, sim.v, { bootstrap: 0 });
  assert.ok(r.ok, r.error);
  const single = r.beats.filter((b) => b.included && b.measure).map((b) => b.measure.accmax);
  assert.ok(r.landmarks.accmax <= Math.max(...single) * 1.02, `stack ${r.landmarks.accmax} vs single beats ${single}`);
});

test('envelope: signed trace includes reverse flow, no-signal columns are zero flow', () => {
  const sim = synthesize({ preset: 'triphasic', hr: 66, duration: 4, noise: 0, seed: 12 });
  const img = renderSpectrogram(sim, {});
  const env = extractEnvelope(img, img.calibration);
  assert.ok(env.v.every(Number.isFinite), 'envelope has no gaps');
  assert.ok(env.vForward.every((x) => x >= 0) && env.vReverse.every((x) => x >= 0));
  assert.ok(Math.min(...env.v) < -0.05, 'reverse flow of the triphasic wave is negative in the trace');
  assert.ok(Math.max(...env.v) > 0.4, 'forward systolic flow is positive');
});

test('envelope: a flow reversal crosses zero without a jump', () => {
  // Spectrum that shifts from reverse to forward over a few columns, with
  // both directions present while it does.
  const width = 120;
  const height = 200;
  const baselineY = 100;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let x = 0; x < width; x++) {
    const f = Math.min(1, Math.max(0, (x - 40) / 40)); // 0 → 1 across columns 40..80
    const fwd = Math.round(60 * f);
    const rev = Math.round(60 * (1 - f));
    for (let y = 0; y < height; y++) {
      const on = (y < baselineY - 2 && y >= baselineY - fwd) || (y > baselineY + 2 && y <= baselineY + rev);
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = on ? 200 : 5;
      data[i + 3] = 255;
    }
  }
  const env = extractEnvelope({ width, height, data }, { region: { x0: 0, y0: 0, x1: width - 1, y1: height - 1 }, baselineY, velPerPx: 0.01, secPerPx: 0.002 }, { threshold: 100 });
  let maxStep = 0;
  for (let c = 1; c < width; c++) maxStep = Math.max(maxStep, Math.abs(env.v[c] - env.v[c - 1]));
  assert.ok(env.v[10] < -0.5 && env.v[110] > 0.5);
  assert.ok(maxStep < 0.1, `largest column-to-column step ${maxStep} m/s`);
});
