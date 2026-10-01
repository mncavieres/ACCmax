// Landmark detection on a smoothed systolic waveform (the stacked template or
// a single beat). All times are in seconds, velocities in m/s.
//
// Landmarks mirror the manual caliper placement described for duplex
// ultrasound:
//   ACCmax  steepest chord of fixed span on the systolic upstroke
//           (two points on the envelope, slope = Δv/Δt in m/s²)
//   valley  end-diastolic minimum immediately before that upstroke. Found by
//           walking backwards from the steepest point, so the early-diastolic
//           reverse-flow trough of a triphasic waveform is never chosen.
//   onset   foot of the upstroke (method selectable, see ONSET_METHODS)
//   peak    first systolic velocity peak after the steepest point
//   AT      peak time − onset time (PAT when the site is a pedal artery)

import { interpGrid } from './stats.js';

export const ONSET_METHODS = {
  tangent: 'Tangent intersection: the ACCmax tangent meets the end-diastolic level',
  curvature: 'Maximum curvature: point of greatest upward bend at the foot',
  valley: 'Valley: lowest point just before the upstroke',
  threshold: '10% rise: first point 10% of the way from valley to peak',
};

const DEFAULTS = {
  spanMs: 20,
  onsetMethod: 'tangent',
  searchFrom: -Infinity,
  searchTo: Infinity,
  period: 1,
  persistMs: 12,
  dropFrac: 0.05,
  footSlopeFrac: 0.03,
};

export function valueAt(tpl, t) {
  return interpGrid(tpl.x0, tpl.dx, tpl.value, t);
}

export function findLandmarks(tpl, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const { x0, dx, n, value: v, d1, d2 } = tpl;
  const idx = (t) => Math.round((t - x0) / dx);
  const tOf = (i) => x0 + i * dx;
  const ok = (i) => i >= 0 && i < n && Number.isFinite(v[i]);
  const hs = Math.max(1, Math.round(o.spanMs / 1000 / 2 / dx));
  const persist = Math.max(2, Math.round(o.persistMs / 1000 / dx));
  const reach = Math.max(persist * 2, Math.round((0.45 * o.period) / dx));

  // 1. Steepest chord of the given span.
  const iFrom = Math.max(hs, idx(o.searchFrom));
  const iTo = Math.min(n - 1 - hs, idx(o.searchTo));
  let iAcc = -1;
  let slope = -Infinity;
  for (let i = iFrom; i <= iTo; i++) {
    if (!ok(i - hs) || !ok(i + hs)) continue;
    const s = (v[i + hs] - v[i - hs]) / (2 * hs * dx);
    if (s > slope) {
      slope = s;
      iAcc = i;
    }
  }
  if (iAcc < 0 || !(slope > 0)) return { ok: false, reason: 'No rising systolic upstroke found.' };
  const i1 = iAcc - hs;
  const i2 = iAcc + hs;

  // 2. Valley: walk back from the chord while the curve is still rising
  //    noticeably, then take the lowest point in a short window at the foot.
  const footSlope = o.footSlopeFrac * slope;
  const lower = Math.max(0, iAcc - reach);
  let k = i1;
  while (k - 1 >= lower && ok(k - 1) && (d1[k - 1] > footSlope || !Number.isFinite(d1[k - 1]))) k--;
  let iValley = k;
  for (let j = Math.max(lower, k - persist); j <= k; j++) if (ok(j) && v[j] < v[iValley]) iValley = j;

  // 3. Peak: the first maximum after the chord that the curve then falls away
  //    from by a clear margin (prominence), so noise ripples on a rounded
  //    monophasic top are not mistaken for the peak.
  const upper = Math.min(n - 1, iAcc + reach);
  let iPeak = i2;
  let found = false;
  for (let j = i2; j <= upper; j++) {
    if (!ok(j)) break;
    if (v[j] > v[iPeak]) iPeak = j;
    else if (v[iPeak] - v[j] > o.dropFrac * (v[iPeak] - v[iValley])) {
      found = true;
      break;
    }
  }
  if (!found) {
    for (let j = i2; j <= upper; j++) if (ok(j) && v[j] > v[iPeak]) iPeak = j;
  }

  const t1 = tOf(i1);
  const t2 = tOf(i2);
  const v1 = v[i1];
  const v2 = v[i2];
  // Parabolic refinement puts extrema between grid points.
  const refine = (i) => {
    if (i <= 0 || i >= n - 1 || !ok(i - 1) || !ok(i + 1)) return { t: tOf(i), v: v[i] };
    const den = v[i - 1] - 2 * v[i] + v[i + 1];
    if (den === 0) return { t: tOf(i), v: v[i] };
    const d = Math.max(-0.5, Math.min(0.5, (0.5 * (v[i - 1] - v[i + 1])) / den));
    return { t: tOf(i) + d * dx, v: v[i] - 0.25 * (v[i - 1] - v[i + 1]) * d };
  };
  const { t: tValley, v: vValley } = refine(iValley);
  const { t: tPeak, v: vPeak } = refine(iPeak);

  // 4. Onset.
  let tOn;
  switch (o.onsetMethod) {
    case 'curvature': {
      let best = iValley;
      let bestCurv = -Infinity;
      for (let j = iValley; j <= iAcc; j++) {
        if (Number.isFinite(d2[j]) && d2[j] > bestCurv) {
          bestCurv = d2[j];
          best = j;
        }
      }
      tOn = tOf(best);
      break;
    }
    case 'valley':
      tOn = tValley;
      break;
    case 'threshold': {
      const level = vValley + 0.1 * (vPeak - vValley);
      tOn = tValley;
      for (let j = iValley + 1; j <= iPeak; j++) {
        if (ok(j) && v[j] >= level) {
          const f = (level - v[j - 1]) / (v[j] - v[j - 1] || 1);
          tOn = tOf(j - 1) + f * dx;
          break;
        }
      }
      break;
    }
    case 'tangent':
    default: {
      tOn = t1 + (vValley - v1) / slope;
      tOn = Math.min(Math.max(tOn, tValley), t1);
    }
  }

  return {
    ok: true,
    accmax: slope,
    acc: { t1, v1, t2, v2, tc: tOf(iAcc) },
    valley: { t: tValley, v: vValley },
    onset: { t: tOn, v: valueAt(tpl, tOn), method: o.onsetMethod },
    peak: { t: tPeak, v: vPeak },
    at: tPeak - tOn,
    psv: vPeak,
    edv: vValley,
  };
}

/**
 * Recompute ACCmax and AT from caliper times placed on a template (manual
 * edits). Points sit on the template curve, so only their times are stored.
 */
export function measureFromPoints(tpl, { t1, t2, onset, peak }) {
  const v1 = valueAt(tpl, t1);
  const v2 = valueAt(tpl, t2);
  const accmax = t2 !== t1 ? (v2 - v1) / (t2 - t1) : NaN;
  return {
    accmax,
    acc: { t1, v1, t2, v2, tc: 0.5 * (t1 + t2) },
    onset: { t: onset, v: valueAt(tpl, onset) },
    peak: { t: peak, v: valueAt(tpl, peak) },
    at: peak - onset,
    psv: valueAt(tpl, peak),
  };
}
