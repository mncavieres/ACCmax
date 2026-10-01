// End-to-end analysis of a Doppler velocity envelope v(t):
//
//   1. window       keep the operator-selected stretch of trace
//   2. period       multi-harmonic Lomb–Scargle periodogram over the
//                   physiological heart-rate range
//   3. track beats  locate every systolic upstroke, predicting each from the
//                   previous one (so heart-rate drift does not accumulate),
//                   and reject harmonic/sub-harmonic period choices
//   4. align        refine each beat's timing by cross-correlating its upstroke
//                   against a leave-one-out template of the other beats
//                   (Woody 1967). The per-beat offsets from a strict
//                   periodic ephemeris form an O−C diagram, as for a
//                   pulsating star.
//   5. stack        fold all accepted beats onto a common time axis in
//                   milliseconds from the upstroke (not in phase units: the
//                   systolic upstroke does not stretch with the RR interval)
//                   and smooth the stack with robust local quadratic
//                   regression
//   6. measure      ACCmax, valley, onset, peak and AT on the stacked template
//   7. uncertainty  per-beat measurements and a beat-level bootstrap

import { lombScargle } from './lombscargle.js';
import { localPoly, sortPairs } from './smooth.js';
import { findLandmarks } from './landmarks.js';
import { median, mad, percentile, mean, std, rng, interpGrid } from './stats.js';

export const DEFAULT_PARAMS = {
  hrMin: 30,
  hrMax: 200,
  nterms: 3,
  hrOverride: null,
  spanMs: 20,
  bandwidthMs: 5,
  // Smooth slow upstrokes more: the template bandwidth is at least this
  // fraction of the first-pass acceleration time (0 disables).
  bandwidthPerAT: 0.15,
  onsetMethod: 'tangent',
  minCorr: 0.85,
  maxShiftMs: 60,
  alignIters: 6,
  bootstrap: 200,
  excludedTimes: [],
  seed: 7,
};

const GRID_DX = 0.0005; // 0.5 ms template grid
const CORE_BEFORE = 0.25; // fraction of the period before the upstroke used for alignment
const CORE_AFTER = 0.35; // fraction after

function fail(message, extra = {}) {
  return { ok: false, error: message, ...extra };
}

function argmaxOnGrid(g, from, to) {
  const a = Math.max(0, Math.ceil((from - g.x0) / g.dx));
  const b = Math.min(g.n - 1, Math.floor((to - g.x0) / g.dx));
  let best = -1;
  for (let i = a; i <= b; i++) if (Number.isFinite(g.d1[i]) && (best < 0 || g.d1[i] > g.d1[best])) best = i;
  return best < 0 ? null : { t: g.x0 + best * g.dx, s: g.d1[best], atEdge: best - a < 2 || b - best < 2 };
}

// Find upstrokes by stepping one period at a time from the strongest one.
function trackBeats(g, P, tStart, tEnd) {
  const anchor = argmaxOnGrid(g, tStart + 0.05 * P, tEnd - 0.05 * P);
  if (!anchor) return [];
  const fids = [anchor];
  for (const dir of [1, -1]) {
    let f = anchor.t;
    for (;;) {
      const pred = f + dir * P;
      const lo = Math.max(pred - 0.3 * P, tStart);
      const hi = Math.min(pred + 0.3 * P, tEnd);
      if (hi - lo < 0.1 * P) break;
      const hit = argmaxOnGrid(g, lo, hi);
      if (!hit) break;
      fids.push(hit);
      f = hit.t;
    }
  }
  fids.sort((a, b) => a.t - b.t);
  return fids;
}

function interiorBeats(fids, P, tStart, tEnd) {
  return fids.filter((f) => f.t - CORE_BEFORE * P >= tStart && f.t + CORE_AFTER * P <= tEnd && !f.atEdge);
}

function choosePeriod(g, Pls, tStart, tEnd, pMin, pMax) {
  const candidates = [Pls / 2, Pls, Pls * 2].filter((p) => p >= pMin * 0.95 && p <= pMax * 1.05);
  for (const P of candidates) {
    const fids = trackBeats(g, P, tStart, tEnd);
    const inner = interiorBeats(fids, P, tStart, tEnd);
    if (inner.length < 2) continue;
    const smax = Math.max(...inner.map((f) => f.s));
    const strong = inner.filter((f) => f.s >= 0.5 * smax).length / inner.length;
    if (strong >= 0.8) return P;
  }
  return Pls;
}

function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

function stackSamples(beats, which, lo = -Infinity, hi = Infinity) {
  const x = [];
  const y = [];
  const id = [];
  for (const b of beats) {
    if (!which(b)) continue;
    for (let i = 0; i < b.t.length; i++) {
      const tau = b.t[i] - b.fiducial;
      if (tau >= lo && tau <= hi) {
        x.push(tau);
        y.push(b.v[i]);
        id.push(b.index);
      }
    }
  }
  return sortPairs(x, y, id);
}

function templateFrom(stack, lo, hi, bandwidth, robustIters = 0, dx = GRID_DX) {
  const n = Math.max(2, Math.round((hi - lo) / dx) + 1);
  return localPoly(stack.x, stack.y, { x0: lo, dx, n, bandwidth, degree: 2, robustIters });
}

function shiftLandmarks(lm, d) {
  if (!lm || !lm.ok) return lm;
  const s = (p) => ({ ...p, t: p.t - d });
  return {
    ...lm,
    acc: { ...lm.acc, t1: lm.acc.t1 - d, t2: lm.acc.t2 - d, tc: lm.acc.tc - d },
    valley: s(lm.valley),
    onset: s(lm.onset),
    peak: s(lm.peak),
  };
}

// Student-t quantile for the two levels used here (0.84 and 0.975).
const T_TABLE = {
  0.84: [1.819, 1.312, 1.189, 1.134, 1.104, 1.084, 1.071, 1.061, 1.054, 1.048],
  0.975: [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228],
};
const Z = { 0.84: 0.9945, 0.975: 1.96 };
function studentT(df, q) {
  if (!Number.isFinite(df)) return Z[q];
  if (df <= 10) return T_TABLE[q][Math.max(1, df) - 1];
  const z = Z[q];
  return z * (1 + (z * z + 1) / (4 * df));
}

function summarize(values) {
  const a = values.filter(Number.isFinite);
  if (!a.length) return null;
  return { mean: mean(a), sd: a.length > 1 ? std(a) : 0, min: Math.min(...a), max: Math.max(...a), n: a.length };
}

/**
 * Analyse a velocity envelope.
 * @param {ArrayLike<number>} tIn time, s
 * @param {ArrayLike<number>} vIn velocity, m/s
 * @param {Partial<typeof DEFAULT_PARAMS> & {window?: [number, number] | null}} params
 */
export function analyze(tIn, vIn, params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const qc = [];
  const h = p.bandwidthMs / 1000;
  const maxShift = p.maxShiftMs / 1000;

  // 1. Window and clean.
  const win = p.window && p.window[1] > p.window[0] ? p.window : null;
  const keepT = [];
  const keepV = [];
  for (let i = 0; i < tIn.length; i++) {
    const t = tIn[i];
    const v = vIn[i];
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    if (win && (t < win[0] || t > win[1])) continue;
    keepT.push(t);
    keepV.push(v);
  }
  const sorted = sortPairs(keepT, keepV);
  const t = sorted.x;
  const v = sorted.y;
  const N = t.length;
  if (N < 20) return fail('Too few samples in the selected window. Select a longer stretch of trace.');
  const tStart = t[0];
  const tEnd = t[N - 1];
  const diffs = [];
  for (let i = 1; i < N; i++) if (t[i] > t[i - 1]) diffs.push(t[i] - t[i - 1]);
  const dt = median(diffs);
  const pMin = 60 / p.hrMax;
  const pMax = 60 / p.hrMin;
  if (tEnd - tStart < 1.5 * pMin) return fail('The window is shorter than two heartbeats. Select a longer stretch of trace.');

  // 2. Periodogram.
  const fmax = Math.min(1 / pMin, 0.45 / dt);
  const ls = lombScargle(t, v, { fmin: 1 / pMax, fmax, nterms: p.nterms, oversample: 10 });
  const Pls = 1 / ls.best.freq;

  // 3. Beat tracking on a lightly smoothed trace.
  const gRaw = localPoly(t, v, {
    x0: tStart,
    dx: Math.min(dt / 2, 0.001),
    n: Math.ceil((tEnd - tStart) / Math.min(dt / 2, 0.001)) + 1,
    // Heavier smoothing than the final template: this pass only has to find
    // each upstroke, and noise spikes in the derivative must not win.
    bandwidth: Math.min(Math.max(0.03 * Pls, 2 * dt, 0.008), 0.04),
    degree: 2,
  });
  let P;
  if (p.hrOverride) {
    P = 60 / p.hrOverride;
  } else {
    P = choosePeriod(gRaw, Pls, tStart, tEnd, pMin, pMax);
    if (Math.abs(P - Pls) / Pls > 0.2) {
      qc.push({
        level: 'info',
        message: `The periodogram peak (${(60 / Pls).toFixed(0)} bpm) was a harmonic of the beat rate; using ${(60 / P).toFixed(0)} bpm from the tracked upstrokes.`,
      });
    }
  }
  const fids = trackBeats(gRaw, P, tStart, tEnd);
  if (fids.length < 1) return fail('No systolic upstrokes found in the window.');

  // Segment samples into beats.
  const beats = fids.map((f, k) => {
    const prev = fids[k - 1];
    const next = fids[k + 1];
    const start = prev ? f.t - 0.4 * (f.t - prev.t) : f.t - 0.4 * P;
    const end = next ? f.t + 0.6 * (next.t - f.t) : f.t + 0.6 * P;
    return { index: k, fiducial: f.t, fiducial0: f.t, strength: f.s, start, end, t: [], v: [] };
  });
  for (let i = 0, k = 0; i < N; i++) {
    while (k < beats.length - 1 && t[i] >= beats[k].end) k++;
    if (t[i] >= beats[k].start && t[i] < beats[k].end) {
      beats[k].t.push(t[i]);
      beats[k].v.push(v[i]);
    }
  }
  const coreLo = -CORE_BEFORE * P;
  const coreHi = CORE_AFTER * P;
  const maxGap = Math.max(4 * dt, 0.02);
  const excluded = (b) => p.excludedTimes.some((x) => Math.abs(x - b.fiducial0) < 0.3 * P);
  for (const b of beats) {
    const core = b.t.filter((x) => x - b.fiducial >= coreLo && x - b.fiducial <= coreHi);
    let gap = 0;
    for (let i = 1; i < core.length; i++) gap = Math.max(gap, core[i] - core[i - 1]);
    const covered =
      core.length > 5 &&
      core[0] - b.fiducial <= coreLo + 2 * dt + 1e-9 &&
      core[core.length - 1] - b.fiducial >= coreHi - 2 * dt - 1e-9 &&
      gap <= maxGap;
    b.covered = covered;
    b.userExcluded = excluded(b);
    b.reason = !covered ? 'incomplete' : b.userExcluded ? 'excluded by user' : null;
  }
  const eligible = beats.filter((b) => b.covered && !b.userExcluded);
  if (eligible.length === 0) {
    return fail('No complete heartbeat in the window. Widen the window so each upstroke and peak is fully inside it.', {
      periodogram: { freq: ls.freq, power: ls.power, best: ls.best.freq },
    });
  }

  // 4. Leave-one-out template alignment (Woody's method).
  const span = [coreLo - maxShift, coreHi + maxShift];
  let active = new Set(eligible.map((b) => b.index));
  for (const b of eligible) b.corr = NaN;
  if (eligible.length >= 2) {
    for (let iter = 0; iter < p.alignIters; iter++) {
      const useLoo = eligible.length <= 30;
      const full = useLoo ? null : templateFrom(stackSamples(beats, (b) => active.has(b.index), ...span), ...span, Math.max(h, (1.5 * dt) / Math.sqrt(active.size)));
      const shifts = new Map();
      for (const b of eligible) {
        const others = (o) => active.has(o.index) && o.index !== b.index;
        const pool = beats.filter(others).length >= 1 ? others : (o) => o.index !== b.index && o.covered && !o.userExcluded;
        const nOthers = beats.filter(pool).length;
        const tpl = full ?? templateFrom(stackSamples(beats, pool, ...span), ...span, Math.max(h, (1.5 * dt) / Math.sqrt(nOthers)));
        const xs = [];
        const ys = [];
        for (let i = 0; i < b.t.length; i++) {
          const tau = b.t[i] - b.fiducial;
          if (tau >= coreLo && tau <= coreHi) {
            xs.push(tau);
            ys.push(b.v[i]);
          }
        }
        const steps = Math.round(maxShift / GRID_DX);
        const scores = new Float64Array(2 * steps + 1).fill(-2);
        const model = new Float64Array(xs.length);
        for (let s = -steps; s <= steps; s++) {
          const sh = s * GRID_DX;
          let okAll = true;
          for (let i = 0; i < xs.length; i++) {
            model[i] = interpGrid(tpl.x0, tpl.dx, tpl.value, xs[i] - sh);
            if (!Number.isFinite(model[i])) {
              okAll = false;
              break;
            }
          }
          if (okAll) scores[s + steps] = pearson(ys, model);
        }
        let bi = 0;
        for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bi]) bi = i;
        let sh = (bi - steps) * GRID_DX;
        if (bi > 0 && bi < scores.length - 1 && scores[bi - 1] > -2 && scores[bi + 1] > -2) {
          const den = scores[bi - 1] - 2 * scores[bi] + scores[bi + 1];
          if (den < 0) sh += (0.5 * (scores[bi - 1] - scores[bi + 1]) / den) * GRID_DX;
        }
        b.atShiftLimit = bi === 0 || bi === scores.length - 1;
        b.corr = scores[bi];
        shifts.set(b.index, sh);
      }
      const meanShift = mean([...shifts.values()]);
      let maxDev = 0;
      for (const b of eligible) {
        const d = shifts.get(b.index) - meanShift;
        b.fiducial += d;
        maxDev = Math.max(maxDev, Math.abs(d));
      }
      active = new Set(eligible.filter((b) => b.corr >= p.minCorr && !b.atShiftLimit).map((b) => b.index));
      if (active.size < 2) active = new Set(eligible.map((b) => b.index));
      if (maxDev < 0.0002) break;
    }
  }
  for (const b of eligible) {
    if (!active.has(b.index)) b.reason = b.atShiftLimit ? 'alignment failed' : 'low similarity';
  }
  const included = beats.filter((b) => active.has(b.index) && b.covered && !b.userExcluded);
  for (const b of beats) b.included = included.includes(b);

  // 5. Stack and smooth.
  const stackAll = stackSamples(beats, (b) => b.included);
  const lo = Math.max(stackAll.x[0], -0.6 * P);
  const hi = Math.min(stackAll.x[stackAll.x.length - 1], 0.9 * P);
  let hStack = Math.max(h, (1.5 * dt) / Math.sqrt(included.length));
  let template0 = templateFrom(stackAll, lo, hi, hStack, 2);

  // 6. Landmarks; then re-reference so τ = 0 is the centre of the ACCmax chord.
  const lmOpts = { spanMs: p.spanMs, onsetMethod: p.onsetMethod, period: P, searchFrom: -0.15 * P, searchTo: 0.15 * P };
  let lm0 = findLandmarks(template0, lmOpts);
  if (!lm0.ok) return fail(lm0.reason);
  const hAdaptive = p.bandwidthPerAT * lm0.at;
  if (hAdaptive > 1.1 * hStack) {
    hStack = hAdaptive;
    template0 = templateFrom(stackAll, lo, hi, hStack, 2);
    lm0 = findLandmarks(template0, lmOpts);
    if (!lm0.ok) return fail(lm0.reason);
  }
  const ref = lm0.acc.tc;
  for (const b of beats) b.fiducial += ref;
  const template = { ...template0, x0: template0.x0 - ref };
  const landmarks = shiftLandmarks(lm0, ref);
  const lmOptsRef = { ...lmOpts, searchFrom: -0.1 * P, searchTo: 0.1 * P };

  // Strict linear ephemeris (least squares over the accepted upstrokes) for
  // the O−C diagram and for the plain fixed-period phase fold.
  const fidsIn = included.length ? included : eligible;
  const phase0 = fidsIn[0].fiducial;
  const cyc = fidsIn.map((b) => Math.round((b.fiducial - phase0) / P));
  let Peph = P;
  let epoch = mean(fidsIn.map((b, i) => b.fiducial - cyc[i] * P));
  if (new Set(cyc).size >= 2) {
    const mc = mean(cyc);
    const mf = mean(fidsIn.map((b) => b.fiducial));
    let sxy = 0;
    let sxx = 0;
    fidsIn.forEach((b, i) => {
      sxy += (cyc[i] - mc) * (b.fiducial - mf);
      sxx += (cyc[i] - mc) ** 2;
    });
    Peph = sxy / sxx;
    epoch = mf - Peph * mc;
  }
  for (const b of beats) {
    const c = Math.round((b.fiducial - epoch) / Peph);
    b.cycle = c;
    b.predicted = epoch + c * Peph;
    b.oc = b.fiducial - b.predicted;
  }
  for (let k = 0; k < beats.length; k++) beats[k].rr = k > 0 ? beats[k].fiducial - beats[k - 1].fiducial : NaN;

  // Sample-level views for plotting.
  const aligned = stackSamples(beats, (b) => b.covered, -0.6 * P, 0.9 * P);
  const naive = { x: [], y: [] };
  for (let i = 0; i < N; i++) {
    let ph = (t[i] - epoch) / Peph;
    ph -= Math.floor(ph + 0.4);
    naive.x.push(ph * Peph);
    naive.y.push(v[i]);
  }
  const naiveSorted = sortPairs(naive.x, naive.y);
  const naiveTemplate = templateFrom(naiveSorted, -0.4 * Peph, 0.6 * Peph, hStack, 2);
  const naiveLm = findLandmarks(naiveTemplate, lmOptsRef);

  // 7a. Per-beat measurements, the analogue of one manual measurement per beat.
  for (const b of beats) {
    if (!b.covered) continue;
    const s = sortPairs(
      b.t.map((x) => x - b.fiducial),
      b.v
    );
    const tpl = templateFrom(s, Math.max(s.x[0], -0.5 * P), Math.min(s.x[s.x.length - 1], 0.8 * P), Math.max(hStack, 1.5 * dt));
    const lm = findLandmarks(tpl, lmOptsRef);
    b.measure = lm.ok ? { accmax: lm.accmax, at: lm.at, psv: lm.psv } : null;
  }

  // 7b. Bootstrap over beats.
  let ci = null;
  if (included.length >= 3 && p.bootstrap > 0) {
    const r = rng(p.seed);
    const acc = [];
    const at = [];
    const bLo = -0.35 * P;
    const bHi = 0.5 * P;
    const pre = included.map((b) => stackSamples([b], () => true, bLo, bHi));
    for (let it = 0; it < p.bootstrap; it++) {
      const xs = [];
      const ys = [];
      for (let k = 0; k < included.length; k++) {
        const s = pre[Math.floor(r() * included.length)];
        for (let i = 0; i < s.x.length; i++) {
          xs.push(s.x[i]);
          ys.push(s.y[i]);
        }
      }
      const tpl = templateFrom(sortPairs(xs, ys), bLo, bHi, hStack, 0);
      const lm = findLandmarks(tpl, lmOptsRef);
      if (lm.ok) {
        acc.push(lm.accmax);
        at.push(lm.at);
      }
    }
    // Percentile intervals around the point estimate, widened for the small
    // number of beats (Student-t and n/(n−1) corrections); plain bootstrap
    // percentiles under-cover with 3–10 beats.
    const nb = included.length;
    const widen = (q) => (studentT(nb - 1, q) / studentT(Infinity, q)) * Math.sqrt(nb / (nb - 1));
    const band = (a, est) => {
      const mid = percentile(a, 50);
      const w68 = widen(0.84);
      const w95 = widen(0.975);
      return {
        lo68: est - w68 * (mid - percentile(a, 16)),
        hi68: est + w68 * (percentile(a, 84) - mid),
        lo95: est - w95 * (mid - percentile(a, 2.5)),
        hi95: est + w95 * (percentile(a, 97.5) - mid),
        n: a.length,
      };
    };
    ci = { accmax: band(acc, landmarks.accmax), at: band(at, landmarks.at) };
  }

  // Quality checks.
  // RR intervals between consecutive complete beats only: an edge beat's
  // upstroke time is unreliable.
  const rrs = beats.filter((b, k) => k > 0 && b.covered && beats[k - 1].covered).map((b) => b.rr);
  const rrCv = rrs.length >= 2 ? std(rrs) / mean(rrs) : NaN;
  const residuals = [];
  for (let i = 0; i < aligned.x.length; i++) {
    const tau = aligned.x[i];
    if (tau < landmarks.valley.t - 0.05 || tau > landmarks.peak.t + 0.05) continue;
    if (!included.some((b) => b.index === aligned.extra[i])) continue;
    const m = interpGrid(template.x0, template.dx, template.value, tau);
    if (Number.isFinite(m)) residuals.push(aligned.y[i] - m);
  }
  const noise = 1.4826 * mad(residuals, 0);
  const rise = landmarks.psv - landmarks.edv;
  if (included.length < 3) {
    qc.push({ level: 'warn', message: `Only ${included.length} beat${included.length === 1 ? '' : 's'} stacked. Uncertainty cannot be estimated; record more cardiac cycles if possible.` });
  }
  if (rrCv > 0.1) {
    qc.push({ level: 'warn', message: `Irregular rhythm: RR intervals vary by ${(rrCv * 100).toFixed(0)}%. Upstrokes are still aligned beat by beat, but check the individual beats (atrial fibrillation or ectopy?).` });
  }
  if (ls.best.power < 0.2) qc.push({ level: 'warn', message: 'Weak periodicity in the window. Check that the window contains clean, repeating waveforms.' });
  if (rise > 0 && noise / rise > 0.12) {
    qc.push({ level: 'warn', message: `Noisy envelope: beat-to-template scatter is ${((noise / rise) * 100).toFixed(0)}% of the systolic rise.` });
  }
  const dropped = beats.filter((b) => b.covered && !b.included);
  if (dropped.length) {
    qc.push({ level: 'info', message: `${dropped.length} complete beat${dropped.length === 1 ? '' : 's'} left out of the stack (${dropped.map((b) => `#${b.index + 1} ${b.reason}`).join(', ')}).` });
  }
  if (landmarks.at < 0.02 || landmarks.at > 0.4) {
    qc.push({ level: 'warn', message: `Acceleration time of ${(landmarks.at * 1000).toFixed(0)} ms is outside the usual 20–400 ms range. Check the onset and peak points.` });
  }
  if (p.qcExtra) qc.push(...p.qcExtra);

  return {
    ok: true,
    params: p,
    window: [tStart, tEnd],
    dt,
    period: Peph,
    hr: 60 / Peph,
    periodogram: { freq: ls.freq, power: ls.power, best: ls.best.freq, bestPower: ls.best.power, chosen: 1 / P },
    lsModel: ls.best,
    epoch,
    beats: beats.map((b) => ({
      index: b.index,
      fiducial: b.fiducial,
      detected: b.fiducial0,
      predicted: b.predicted,
      oc: b.oc,
      rr: b.rr,
      corr: b.corr,
      covered: b.covered,
      included: b.included,
      userExcluded: b.userExcluded,
      reason: b.included ? null : b.reason,
      start: b.start,
      end: b.end,
      measure: b.measure ?? null,
    })),
    stack: { tau: aligned.x, v: aligned.y, beat: aligned.extra },
    naive: { tau: naiveSorted.x, v: naiveSorted.y, template: naiveTemplate, landmarks: naiveLm },
    template,
    landmarks,
    landmarkOptions: lmOptsRef,
    bandwidth: hStack,
    noise,
    perBeat: {
      accmax: summarize(included.map((b) => b.measure?.accmax)),
      at: summarize(included.map((b) => b.measure?.at)),
    },
    ci,
    nBeats: included.length,
    rrCv,
    qc,
  };
}
