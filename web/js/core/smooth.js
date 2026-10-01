// Local polynomial regression (a LOWESS-style smoother) for scattered,
// irregularly spaced samples such as a phase-folded stack of beats.
//
// For every point g of a uniform output grid, a polynomial in (x − g) is
// fitted to the samples with Gaussian weights of width `bandwidth`. The fit
// gives the smoothed value and its first and second derivatives at g in one
// step, the same idea as a Savitzky–Golay filter but valid for uneven
// sampling. Optional bisquare robustness iterations down-weight outliers
// (speckle spikes in the Doppler envelope, a mis-tracked column).

import { median } from './stats.js';

function fitGrid(x, y, w, grid, h, degree) {
  const { x0, dx, n } = grid;
  const value = new Float64Array(n).fill(NaN);
  const d1 = new Float64Array(n).fill(NaN);
  const d2 = new Float64Array(n).fill(NaN);
  const reach = 3 * h;
  let lo = 0;
  let hi = 0;
  const N = x.length;
  for (let j = 0; j < n; j++) {
    const g = x0 + j * dx;
    while (lo < N && x[lo] < g - reach) lo++;
    if (hi < lo) hi = lo;
    while (hi < N && x[hi] <= g + reach) hi++;
    if (hi - lo < degree + 2) continue;
    if (x[lo] > g || x[hi - 1] < g) continue; // no extrapolation
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0, sw2 = 0;
    for (let i = lo; i < hi; i++) {
      const u = (x[i] - g) / h;
      const k = Math.exp(-0.5 * u * u) * w[i];
      if (k === 0) continue;
      const u2 = u * u;
      s0 += k;
      s1 += k * u;
      s2 += k * u2;
      s3 += k * u2 * u;
      s4 += k * u2 * u2;
      t0 += k * y[i];
      t1 += k * u * y[i];
      t2 += k * u2 * y[i];
      sw2 += k * k;
    }
    if (s0 <= 0 || (s0 * s0) / sw2 < degree + 1.5) continue;
    if (degree >= 2) {
      // Solve the 3×3 normal equations by Cramer's rule.
      const a = [
        [s0, s1, s2],
        [s1, s2, s3],
        [s2, s3, s4],
      ];
      const det =
        a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
        a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
        a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
      if (Math.abs(det) < 1e-12 * s0 * s0 * s0) continue;
      const b0 =
        (t0 * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
          a[0][1] * (t1 * a[2][2] - a[1][2] * t2) +
          a[0][2] * (t1 * a[2][1] - a[1][1] * t2)) /
        det;
      const b1 =
        (a[0][0] * (t1 * a[2][2] - a[1][2] * t2) -
          t0 * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
          a[0][2] * (a[1][0] * t2 - t1 * a[2][0])) /
        det;
      const b2 =
        (a[0][0] * (a[1][1] * t2 - t1 * a[2][1]) -
          a[0][1] * (a[1][0] * t2 - t1 * a[2][0]) +
          t0 * (a[1][0] * a[2][1] - a[1][1] * a[2][0])) /
        det;
      value[j] = b0;
      d1[j] = b1 / h;
      d2[j] = (2 * b2) / (h * h);
    } else {
      const det = s0 * s2 - s1 * s1;
      if (Math.abs(det) < 1e-12 * s0 * s0) continue;
      value[j] = (t0 * s2 - s1 * t1) / det;
      d1[j] = (s0 * t1 - s1 * t0) / det / h;
      d2[j] = 0;
    }
  }
  return { value, d1, d2 };
}

/**
 * Smooth scattered samples onto a uniform grid.
 * @param {ArrayLike<number>} x sample positions, ascending
 * @param {ArrayLike<number>} y sample values
 * @param {{x0:number,dx:number,n:number,bandwidth:number,degree?:number,robustIters?:number}} o
 * @returns {{x0:number,dx:number,n:number,value:Float64Array,d1:Float64Array,d2:Float64Array}}
 */
export function localPoly(x, y, { x0, dx, n, bandwidth, degree = 2, robustIters = 0 }) {
  const grid = { x0, dx, n };
  const w = new Float64Array(x.length).fill(1);
  let fit = fitGrid(x, y, w, grid, bandwidth, degree);
  for (let it = 0; it < robustIters; it++) {
    const res = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const pos = (x[i] - x0) / dx;
      const k = Math.min(Math.max(Math.floor(pos), 0), n - 2);
      const f = pos - k;
      res[i] = y[i] - (fit.value[k] * (1 - f) + fit.value[k + 1] * f);
    }
    // Floor the robust scale so near-noise-free data (smooth exported traces)
    // do not down-weight every point that is not fitted exactly.
    let ymax = 0;
    for (let i = 0; i < y.length; i++) if (Math.abs(y[i]) > ymax) ymax = Math.abs(y[i]);
    const s = Math.max(median(Array.from(res, Math.abs).filter(Number.isFinite)), 0.005 * ymax);
    if (!(s > 0)) break;
    for (let i = 0; i < x.length; i++) {
      const u = res[i] / (6 * s);
      w[i] = Number.isFinite(u) && Math.abs(u) < 1 ? (1 - u * u) ** 2 : Number.isFinite(u) ? 0 : 1;
    }
    fit = fitGrid(x, y, w, grid, bandwidth, degree);
  }
  return { x0, dx, n, ...fit };
}

/** Running median with an odd window, used to knock out single-column spikes. */
export function medianFilter(y, k = 3) {
  if (k < 3) return Float64Array.from(y);
  const h = k >> 1;
  const out = new Float64Array(y.length);
  const buf = [];
  for (let i = 0; i < y.length; i++) {
    buf.length = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(y.length - 1, i + h); j++) buf.push(y[j]);
    buf.sort((a, b) => a - b);
    out[i] = buf[buf.length >> 1];
  }
  return out;
}

/** Sort paired arrays by x. */
export function sortPairs(x, y, extra) {
  const idx = Array.from(x, (_, i) => i).sort((a, b) => x[a] - x[b]);
  return {
    x: Float64Array.from(idx, (i) => x[i]),
    y: Float64Array.from(idx, (i) => y[i]),
    extra: extra ? Int32Array.from(idx, (i) => extra[i]) : undefined,
  };
}
