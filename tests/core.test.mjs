import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lombScargle } from '../web/js/core/lombscargle.js';
import { localPoly } from '../web/js/core/smooth.js';
import { findLandmarks, measureFromPoints } from '../web/js/core/landmarks.js';
import { synthesize, syntheticTruth } from '../web/js/core/synthetic.js';

test('multi-harmonic Lomb–Scargle finds the beat rate of a pulsatile signal with gaps', () => {
  const sim = synthesize({ preset: 'triphasic', hr: 72, duration: 8, rrSd: 0, rrResp: 0, ampSd: 0, ampResp: 0, seed: 4 });
  // Punch two erase-bar gaps into the trace.
  const keep = Array.from(sim.t, (t) => !(t > 2.0 && t < 2.15) && !(t > 5.1 && t < 5.3));
  const t = sim.t.filter((_, i) => keep[i]);
  const v = sim.v.filter((_, i) => keep[i]);
  const ls = lombScargle(t, v, { fmin: 0.5, fmax: 3.3, nterms: 3 });
  assert.ok(Math.abs(60 * ls.best.freq - 72) < 1.5, `got ${60 * ls.best.freq} bpm`);
});

test('local quadratic regression reproduces a quadratic and its derivatives', () => {
  const x = Array.from({ length: 400 }, (_, i) => i * 0.0025 + 0.0007 * Math.sin(i));
  const y = x.map((u) => 0.2 + 3 * u - 4 * u * u);
  const g = localPoly(x, y, { x0: 0.1, dx: 0.01, n: 50, bandwidth: 0.01 });
  for (let j = 0; j < g.n; j++) {
    const u = g.x0 + j * g.dx;
    assert.ok(Math.abs(g.value[j] - (0.2 + 3 * u - 4 * u * u)) < 1e-9);
    assert.ok(Math.abs(g.d1[j] - (3 - 8 * u)) < 1e-6);
    assert.ok(Math.abs(g.d2[j] + 8) < 1e-3);
  }
});

function rampTemplate() {
  // Flat at 0.05 m/s, linear rise of 10 m/s² from 0 to 60 ms, then a
  // rounded peak and decay; plus an earlier reverse-flow trough at −0.3 s.
  const dx = 0.0005;
  const x0 = -0.5;
  const n = 1600;
  const value = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = x0 + i * dx;
    let v = 0.05 - 0.2 * Math.exp(-0.5 * ((t + 0.3) / 0.03) ** 2);
    if (t > 0 && t <= 0.06) v += 10 * t;
    else if (t > 0.06) v += 0.6 * Math.exp(-(((t - 0.06) / 0.08) ** 2)) ;
    value[i] = v;
  }
  const s = localPoly(Array.from({ length: n }, (_, i) => x0 + i * dx), value, { x0, dx, n, bandwidth: 0.002 });
  return s;
}

test('landmarks: ACCmax, peak and the end-diastolic valley (not the reverse-flow trough)', () => {
  const tpl = rampTemplate();
  const lm = findLandmarks(tpl, { spanMs: 20, period: 1, searchFrom: -0.1, searchTo: 0.1 });
  assert.ok(lm.ok);
  assert.ok(Math.abs(lm.accmax - 10) < 0.3, `ACCmax ${lm.accmax}`);
  assert.ok(lm.valley.t > -0.05 && lm.valley.t <= 0.005, `valley at ${lm.valley.t}`);
  assert.ok(Math.abs(lm.peak.t - 0.06) < 0.006, `peak at ${lm.peak.t}`);
  assert.ok(Math.abs(lm.onset.t - 0) < 0.006, `onset at ${lm.onset.t}`);
  assert.ok(Math.abs(lm.at - 0.06) < 0.01, `AT ${lm.at}`);
});

test('onset methods are ordered sensibly on a gradual foot', () => {
  const truth = syntheticTruth({ preset: 'monophasic', hr: 60 });
  const at = {};
  for (const m of ['valley', 'threshold', 'tangent', 'curvature']) {
    at[m] = findLandmarks(truth.template, { period: 1, onsetMethod: m, searchFrom: -0.1, searchTo: 0.3 }).at;
  }
  assert.ok(at.valley >= at.threshold && at.valley >= at.tangent, JSON.stringify(at));
  for (const v of Object.values(at)) assert.ok(v > 0.08 && v < 0.3);
});

test('manual caliper points recompute ACCmax and AT', () => {
  const tpl = rampTemplate();
  const m = measureFromPoints(tpl, { t1: 0.01, t2: 0.04, onset: 0, peak: 0.06 });
  assert.ok(Math.abs(m.accmax - 10) < 0.2);
  assert.ok(Math.abs(m.at - 0.06) < 1e-9);
});
