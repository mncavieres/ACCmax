// Multi-harmonic generalized Lomb–Scargle periodogram.
//
// At each trial frequency f the data are fitted by least squares with a
// constant plus a K-term Fourier series,
//     y(t) ≈ a0 + Σ_k [a_k cos(2πkft) + b_k sin(2πkft)],
// and the power is the fraction of variance explained, 1 − χ²(f)/χ²₀
// (Schwarzenberg-Czerny 1996; VanderPlas 2018). Using several harmonics
// matters for arterial Doppler: the systolic peak is sharp and far from
// sinusoidal, so a single-sinusoid periodogram often peaks at 2f.
// Uneven sampling and gaps (erase bars, rejected columns) need no special
// handling.

import { solve } from './stats.js';

function accumulate(t, y, w, nterms) {
  const m = 2 * nterms + 1;
  const ata = Array.from({ length: m }, () => new Float64Array(m));
  const aty = new Float64Array(m);
  const phi = new Float64Array(m);
  let yy = 0;
  for (let i = 0; i < t.length; i++) {
    const c1 = Math.cos(w * t[i]);
    const s1 = Math.sin(w * t[i]);
    phi[0] = 1;
    let c = c1;
    let s = s1;
    for (let k = 0; k < nterms; k++) {
      phi[1 + 2 * k] = c;
      phi[2 + 2 * k] = s;
      const cn = c * c1 - s * s1;
      s = s * c1 + c * s1;
      c = cn;
    }
    const yi = y[i];
    yy += yi * yi;
    for (let a = 0; a < m; a++) {
      const pa = phi[a];
      aty[a] += pa * yi;
      const row = ata[a];
      for (let b = a; b < m; b++) row[b] += pa * phi[b];
    }
  }
  for (let a = 0; a < m; a++) for (let b = 0; b < a; b++) ata[a][b] = ata[b][a];
  return { ata, aty, yy };
}

function fitAt(t, y, freq, nterms, chi0) {
  const { ata, aty, yy } = accumulate(t, y, 2 * Math.PI * freq, nterms);
  const beta = solve(ata.map((r) => Array.from(r)), Array.from(aty));
  if (!beta) return { power: 0, coeffs: null };
  let fit = 0;
  for (let a = 0; a < beta.length; a++) fit += beta[a] * aty[a];
  const chi2 = Math.max(yy - fit, 0);
  return { power: Math.max(0, 1 - chi2 / chi0), coeffs: beta };
}

/**
 * @param {ArrayLike<number>} tIn times (s)
 * @param {ArrayLike<number>} yIn values
 * @param {{fmin:number,fmax:number,nterms?:number,oversample?:number}} opts
 */
export function lombScargle(tIn, yIn, { fmin, fmax, nterms = 3, oversample = 10 } = {}) {
  const n = tIn.length;
  let tm = 0;
  let ym = 0;
  for (let i = 0; i < n; i++) {
    tm += tIn[i];
    ym += yIn[i];
  }
  tm /= n;
  ym /= n;
  const t = Float64Array.from(tIn, (v) => v - tm);
  const y = Float64Array.from(yIn, (v) => v - ym);
  let chi0 = 0;
  for (let i = 0; i < n; i++) chi0 += y[i] * y[i];
  const span = t[n - 1] - t[0];
  const df = 1 / (span * oversample);
  const nf = Math.max(2, Math.ceil((fmax - fmin) / df) + 1);
  const freq = new Float64Array(nf);
  const power = new Float64Array(nf);
  let best = 0;
  for (let j = 0; j < nf; j++) {
    freq[j] = fmin + j * df;
    power[j] = chi0 > 0 ? fitAt(t, y, freq[j], nterms, chi0).power : 0;
    if (power[j] > power[best]) best = j;
  }
  // Refine the peak on a fine local grid.
  let bf = freq[best];
  let bp = power[best];
  for (let s = -10; s <= 10; s++) {
    const f = freq[best] + (s * df) / 10;
    if (f < fmin || f > fmax) continue;
    const p = fitAt(t, y, f, nterms, chi0).power;
    if (p > bp) {
      bp = p;
      bf = f;
    }
  }
  const fit = fitAt(t, y, bf, nterms, chi0);
  return {
    freq,
    power,
    best: { freq: bf, power: fit.power, coeffs: fit.coeffs, tRef: tm, yRef: ym, nterms },
  };
}

/** Least-squares Fourier-series fit at a fixed frequency. */
export function harmonicFit(tIn, yIn, freq, nterms = 3) {
  const n = tIn.length;
  let tm = 0;
  let ym = 0;
  for (let i = 0; i < n; i++) {
    tm += tIn[i];
    ym += yIn[i];
  }
  tm /= n;
  ym /= n;
  const t = Float64Array.from(tIn, (v) => v - tm);
  const y = Float64Array.from(yIn, (v) => v - ym);
  let chi0 = 0;
  for (let i = 0; i < n; i++) chi0 += y[i] * y[i];
  const fit = fitAt(t, y, freq, nterms, chi0 || 1);
  return { freq, power: fit.power, coeffs: fit.coeffs, tRef: tm, yRef: ym, nterms };
}

/** Evaluate a harmonic model returned by lombScargle().best or harmonicFit(). */
export function harmonicModel(model, t) {
  const { coeffs, freq, tRef, yRef, nterms } = model;
  if (!coeffs) return yRef;
  const w = 2 * Math.PI * freq * (t - tRef);
  let v = yRef + coeffs[0];
  for (let k = 0; k < nterms; k++) {
    v += coeffs[1 + 2 * k] * Math.cos((k + 1) * w) + coeffs[2 + 2 * k] * Math.sin((k + 1) * w);
  }
  return v;
}
