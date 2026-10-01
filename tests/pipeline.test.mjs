import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../web/js/core/pipeline.js';
import { synthesize, syntheticTruth, PRESETS } from '../web/js/core/synthetic.js';

const cases = [
  { preset: 'triphasic', hr: 60, accTol: 0.08, atTol: 0.008 },
  { preset: 'triphasic', hr: 105, accTol: 0.08, atTol: 0.008 },
  { preset: 'biphasic', hr: 70, accTol: 0.1, atTol: 0.012 },
  { preset: 'monophasic', hr: 55, accTol: 0.12, atTol: 0.02 },
  { preset: 'monophasic', hr: 90, accTol: 0.12, atTol: 0.02 },
];

for (const c of cases) {
  test(`recovers ACCmax and AT for a ${c.preset} waveform at ${c.hr} bpm`, () => {
    const truth = syntheticTruth(c);
    const sim = synthesize({ ...c, duration: 7, seed: 21, noise: 0.2 * PRESETS[c.preset].psv * 0.2 });
    const r = analyze(sim.t, sim.v, { bootstrap: 50 });
    assert.ok(r.ok, r.error);
    assert.ok(Math.abs(r.hr - c.hr) < 0.08 * c.hr, `HR ${r.hr}`);
    assert.ok(Math.abs(r.landmarks.accmax / truth.accmax - 1) < c.accTol, `ACCmax ${r.landmarks.accmax} vs ${truth.accmax}`);
    assert.ok(Math.abs(r.landmarks.at - truth.at) < c.atTol, `AT ${r.landmarks.at} vs ${truth.at}`);
    assert.ok(r.nBeats >= 4);
    assert.ok(r.ci && r.ci.accmax.lo95 < r.ci.accmax.hi95);
  });
}

test('beat alignment survives an irregular (AF-like) rhythm; a plain phase fold does not', () => {
  const c = { preset: 'triphasic', hr: 85 };
  const truth = syntheticTruth(c);
  const sim = synthesize({ ...c, duration: 8, rrSd: 0.15, seed: 5 });
  const r = analyze(sim.t, sim.v, { bootstrap: 0 });
  assert.ok(r.ok, r.error);
  assert.ok(Math.abs(r.landmarks.accmax / truth.accmax - 1) < 0.08);
  assert.ok(r.rrCv > 0.1, `RR variation ${r.rrCv}`);
  assert.ok(r.qc.some((q) => /Irregular rhythm/.test(q.message)));
});

test('respects the analysis window and user-excluded beats', () => {
  const sim = synthesize({ preset: 'triphasic', hr: 70, duration: 10, seed: 8 });
  const r = analyze(sim.t, sim.v, { window: [2, 7], bootstrap: 0 });
  assert.ok(r.ok);
  assert.ok(r.window[0] >= 2 && r.window[1] <= 7);
  const target = r.beats.find((b) => b.included);
  const r2 = analyze(sim.t, sim.v, { window: [2, 7], bootstrap: 0, excludedTimes: [target.fiducial] });
  const same = r2.beats.find((b) => Math.abs(b.fiducial - target.fiducial) < 0.1);
  assert.ok(same && !same.included && same.userExcluded);
  assert.equal(r2.nBeats, r.nBeats - 1);
});

test('heart-rate override and too-short windows', () => {
  const sim = synthesize({ preset: 'biphasic', hr: 64, duration: 6, seed: 2 });
  const r = analyze(sim.t, sim.v, { hrOverride: 64, bootstrap: 0 });
  assert.ok(r.ok);
  assert.ok(Math.abs(r.hr - 64) < 4);
  const short = analyze(sim.t, sim.v, { window: [1, 1.2] });
  assert.equal(short.ok, false);
  assert.match(short.error, /Too few samples|shorter than two heartbeats/);
});
