// Small numeric helpers shared by the analysis modules.

export function median(values) {
  const a = Array.from(values).filter(Number.isFinite).sort((x, y) => x - y);
  if (a.length === 0) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

export function mad(values, center = median(values)) {
  return median(Array.from(values, (v) => Math.abs(v - center)));
}

export function mean(values) {
  let s = 0;
  let n = 0;
  for (const v of values) {
    if (Number.isFinite(v)) {
      s += v;
      n += 1;
    }
  }
  return n ? s / n : NaN;
}

export function std(values) {
  const m = mean(values);
  let s = 0;
  let n = 0;
  for (const v of values) {
    if (Number.isFinite(v)) {
      s += (v - m) ** 2;
      n += 1;
    }
  }
  return n > 1 ? Math.sqrt(s / (n - 1)) : NaN;
}

// Linear-interpolated percentile, p in [0, 100].
export function percentile(values, p) {
  const a = Array.from(values).filter(Number.isFinite).sort((x, y) => x - y);
  if (a.length === 0) return NaN;
  const pos = (p / 100) * (a.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

// Value of a uniformly gridded curve at x (linear interpolation, NaN outside).
export function interpGrid(x0, dx, values, x) {
  const pos = (x - x0) / dx;
  if (!(pos >= 0) || pos > values.length - 1) return NaN;
  const i = Math.min(Math.floor(pos), values.length - 2);
  const f = pos - i;
  return values[i] * (1 - f) + values[i + 1] * f;
}

// Linear interpolation on an increasing (possibly non-uniform) abscissa.
export function interpSorted(xs, ys, x) {
  const n = xs.length;
  if (n === 0 || x < xs[0] || x > xs[n - 1]) return NaN;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  if (hi === lo) return ys[lo];
  const f = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] * (1 - f) + ys[hi] * f;
}

// Deterministic PRNG (mulberry32) so bootstrap and synthetic data are reproducible.
export function rng(seed = 1) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.normal = () => {
    let u = 0;
    while (u === 0) u = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  return next;
}

// Solve the symmetric positive-definite system A x = b in place (Gaussian
// elimination with partial pivoting). A is an array of row arrays. Returns
// null when the system is singular.
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    if (p !== c) [M[p], M[c]] = [M[c], M[p]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x.every(Number.isFinite) ? x : null;
}
