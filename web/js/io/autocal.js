// Automatic calibration of a spectral Doppler screen image.
//
// Finds, without user input, the parts of a scanner display that a person
// would use to calibrate it by hand:
//   - the velocity scale: a column of evenly spaced tick marks, the longer
//     ticks labelled with numbers that are read with a small template
//     matcher (digits, minus sign, "cm/s");
//   - the zero-velocity baseline: a long horizontal line, checked against
//     the zero of the scale;
//   - the time scale: evenly spaced marks along a timeline (or dotted
//     vertical grid lines), with the convention used for their spacing;
//   - the spectral display region, kept clear of the ECG trace, the
//     timeline and on-screen text.
// Every reading is checked (scale labels must fall on one straight line,
// the baseline on the scale's zero) and reported, so the user can see what
// was taken for what. A published example image is also recognised by its
// thumbnail, which supplies its source, the heart rate printed on screen,
// and a reference calibration to compare with.

import { GLYPHS } from './glyphs.js';

// ---------- pixels ----------

function prepare(img) {
  const { width: W, height: H, data } = img;
  const n = W * H;
  const gray = new Float32Array(n);
  const chroma = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[4 * i];
    const g = data[4 * i + 1];
    const b = data[4 * i + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    chroma[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  // Overlay text and scale marks are bright and colourless.
  const white = new Uint8Array(n);
  for (let i = 0; i < n; i++) white[i] = gray[i] >= 100 && chroma[i] < 70 ? 1 : 0;
  return { W, H, data, gray, chroma, white };
}

/** 8-connected components of a mask. */
function components(mask, W, H, minPixels = 1) {
  const label = new Int32Array(W * H).fill(-1);
  const out = [];
  const stack = [];
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || label[i] >= 0) continue;
    const c = { id: out.length, x0: W, y0: H, x1: -1, y1: -1, n: 0, sy: 0 };
    label[i] = c.id;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop();
      const x = j % W;
      const y = (j - x) / W;
      c.n++;
      c.sy += y;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const k = yy * W + xx;
          if (mask[k] && label[k] < 0) {
            label[k] = c.id;
            stack.push(k);
          }
        }
      }
    }
    c.w = c.x1 - c.x0 + 1;
    c.h = c.y1 - c.y0 + 1;
    c.yc = c.sy / c.n;
    out.push(c);
  }
  return { label, comps: out.filter((c) => c.n >= minPixels), all: out };
}

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
  const res = xs.map((x, i) => ys[i] - (icpt + slope * x));
  const rms = Math.sqrt(res.reduce((s, r) => s + r * r, 0) / n);
  return { slope, icpt, rms, res };
}

const median = (a) => {
  const s = [...a].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Evenly spaced positions: the spacing and offset that put the most of `xs`
 * on a lattice, refined by least squares. Spacing is searched in [dMin, dMax].
 */
export function fitLattice(xs, { dMin, dMax, tol = 1.5, candidates = null, minFill = 0 }) {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length < 3) return null;
  const cand = new Set();
  if (candidates) for (const d of candidates) cand.add(d);
  else {
    for (let i = 1; i < s.length; i++) {
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        const d = s[i] - s[j];
        for (const k of [1, 2, 3]) if (d / k >= dMin && d / k <= dMax) cand.add(Math.round((d / k) * 4) / 4);
      }
    }
  }
  let best = null;
  for (const d of cand) {
    const t = Math.max(tol, 0.03 * d);
    for (const a of s) {
      const on = [];
      for (const x of s) {
        const k = Math.round((x - a) / d);
        if (Math.abs(x - (a + k * d)) <= t) on.push({ x, k });
      }
      // A sparse lattice (most sites empty) is a coincidence, not a grid.
      if (minFill && on.length < minFill * (Math.max(...on.map((q) => q.k)) - Math.min(...on.map((q) => q.k)) + 1)) continue;
      // Prefer more members, then the larger spacing (a lattice of 2d is
      // also matched by d with half the points missing).
      if (!best || on.length > best.on.length || (on.length === best.on.length && d > best.d)) best = { d, a, on };
    }
  }
  if (!best || best.on.length < 3) return null;
  // One point per lattice site (the closest), then refit by least squares.
  const members = (a, d) => {
    const t = Math.max(tol, 0.03 * d);
    const byK = new Map();
    for (const x of s) {
      const k = Math.round((x - a) / d);
      const r = Math.abs(x - (a + k * d));
      if (r <= t && (!byK.has(k) || r < byK.get(k).r)) byK.set(k, { x, k, r });
    }
    const pts = [...byK.values()].sort((p, q) => p.k - q.k);
    const k0 = pts.length ? pts[0].k : 0;
    return pts.map((q) => ({ x: q.x, k: q.k - k0 }));
  };
  let on = members(best.a, best.d);
  let fit = null;
  for (let iter = 0; iter < 3; iter++) {
    if (on.length < 3) return null;
    fit = linearFit(on.map((q) => q.k), on.map((q) => q.x));
    if (!(fit.slope > 0)) return null;
    on = members(fit.icpt, fit.slope);
  }
  if (on.length < 3) return null;
  fit = linearFit(on.map((q) => q.k), on.map((q) => q.x));
  return { spacing: fit.slope, origin: fit.icpt, members: on, rms: fit.rms, count: on.length, span: on[on.length - 1].k };
}

// ---------- glyphs ----------

const GW = 12;
const GH = 16;

/** Area-resample a w×h coverage map to GW×GH. */
function resample(src, w, h) {
  const out = new Float32Array(GW * GH);
  const fx = w / GW;
  const fy = h / GH;
  for (let gy = 0; gy < GH; gy++) {
    const ya = gy * fy;
    const yb = ya + fy;
    for (let gx = 0; gx < GW; gx++) {
      const xa = gx * fx;
      const xb = xa + fx;
      let s = 0;
      for (let y = Math.floor(ya); y < Math.min(h, Math.ceil(yb - 1e-9)); y++) {
        const wy = Math.min(yb, y + 1) - Math.max(ya, y);
        if (wy <= 0) continue;
        for (let x = Math.floor(xa); x < Math.min(w, Math.ceil(xb - 1e-9)); x++) {
          const wx = Math.min(xb, x + 1) - Math.max(xa, x);
          if (wx <= 0) continue;
          s += wx * wy * src[y * w + x];
        }
      }
      out[gy * GW + gx] = s / (fx * fy);
    }
  }
  // Zero mean, unit norm, for correlation.
  let m = 0;
  for (const v of out) m += v;
  m /= out.length;
  let nn = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] -= m;
    nn += out[i] * out[i];
  }
  nn = Math.sqrt(nn) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= nn;
  return out;
}

let TEMPLATES = null;
function templates() {
  if (TEMPLATES) return TEMPLATES;
  TEMPLATES = GLYPHS.map(([ch, w, h, px]) => {
    const src = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) src[i] = parseInt(px[i], 16) >= 8 ? 1 : 0;
    return { ch, aspect: w / h, vec: resample(src, w, h) };
  });
  return TEMPLATES;
}

/** Best matching character for one component, with its score. */
function classifyGlyph(px, lab, c) {
  const w = c.w;
  const h = c.h;
  const src = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) src[y * w + x] = lab[(c.y0 + y) * px.W + c.x0 + x] === c.id ? 1 : 0;
  const vec = resample(src, w, h);
  const aspect = w / h;
  let best = null;
  let second = null;
  for (const t of templates()) {
    let corr = 0;
    for (let i = 0; i < vec.length; i++) corr += vec[i] * t.vec[i];
    const score = corr - 0.35 * Math.abs(Math.log(aspect / t.aspect));
    if (!best || score > best.score) {
      if (best && best.ch !== t.ch) second = best;
      best = { ch: t.ch, score };
    } else if (t.ch !== best.ch && (!second || score > second.score)) second = { ch: t.ch, score };
  }
  return { ch: best.ch, score: best.score, margin: best.score - (second?.score ?? 0) };
}

/** Part of a component between two columns, with its own vertical extent. */
function subGlyph(lab, W, c, xa, xb) {
  let y0 = Infinity;
  let y1 = -1;
  let n = 0;
  for (let y = c.y0; y <= c.y1; y++) {
    for (let x = xa; x <= xb; x++) {
      if (lab[y * W + x] !== c.id) continue;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      n++;
    }
  }
  return { id: c.id, x0: xa, x1: xb, y0, y1, w: xb - xa + 1, h: y1 - y0 + 1, n };
}

/**
 * Characters that touch each other form one component: split off a leading
 * minus sign, and cut two touching digits at their thinnest column.
 */
function splitGlyph(lab, W, c, hRef, depth = 0) {
  if (depth > 2 || c.h < 0.8 * hRef) return [c];
  const ext = [];
  for (let x = c.x0; x <= c.x1; x++) {
    let a = -1;
    let b = -1;
    let n = 0;
    for (let y = c.y0; y <= c.y1; y++) {
      if (lab[y * W + x] !== c.id) continue;
      if (a < 0) a = y;
      b = y;
      n++;
    }
    ext.push({ a, b, n, e: a < 0 ? 0 : b - a + 1 });
  }
  // A minus sign: leading columns of constant, small height at mid-height.
  const e0 = ext[0].e;
  let L = 0;
  while (L < ext.length && ext[L].e > 0 && ext[L].e <= Math.min(0.45 * c.h, e0 + 2) && ext[L].a >= c.y0 + 0.2 * c.h && ext[L].b <= c.y1 - 0.15 * c.h) L++;
  if (L >= 0.25 * c.h && c.w - L >= 0.3 * c.h) {
    return [subGlyph(lab, W, c, c.x0, c.x0 + L - 1), ...splitGlyph(lab, W, subGlyph(lab, W, c, c.x0 + L, c.x1), hRef, depth + 1)];
  }
  // Two digits: wider than any single digit.
  if (c.w > 0.95 * c.h) {
    const lo = Math.round(0.3 * c.w);
    const hi = Math.round(0.7 * c.w);
    let cut = -1;
    for (let i = lo; i <= hi; i++) if (cut < 0 || ext[i].n < ext[cut].n) cut = i;
    if (cut > 0) {
      const left = subGlyph(lab, W, c, c.x0, c.x0 + cut - 1);
      const right = subGlyph(lab, W, c, c.x0 + cut, c.x1);
      if (left.n > 0 && right.n > 0) return [...splitGlyph(lab, W, left, hRef, depth + 1), ...splitGlyph(lab, W, right, hRef, depth + 1)];
    }
  }
  return [c];
}

/**
 * A narrow, full-height character whose lower part is one vertical stroke
 * is a "1", whatever the font (with or without a flag or a foot).
 */
function isOne(lab, W, g, hMax) {
  if (g.h < 0.75 * hMax || g.w > 0.62 * g.h) return false;
  const centre = (y) => {
    let s = 0;
    let n = 0;
    for (let x = g.x0; x <= g.x1; x++) {
      if (lab[y * W + x] === g.id) {
        s += x;
        n++;
      }
    }
    return n ? s / n : NaN;
  };
  const rows = (a, b) => {
    const cs = [];
    for (let y = Math.round(g.y0 + a * g.h); y < Math.round(g.y0 + b * g.h); y++) cs.push(centre(y));
    const ok = cs.filter(Number.isFinite);
    return ok.length ? ok.reduce((p, q) => p + q, 0) / ok.length : NaN;
  };
  // Longest unbroken run of ink in a band of rows: a "7" has a full-width
  // bar at the top, a "4" a full-width crossbar below the middle; a "1"
  // has neither (its flag leaves a gap beside the stem).
  const widest = (a, b) => {
    let wMax = 0;
    for (let y = Math.round(g.y0 + a * g.h); y < Math.max(Math.round(g.y0 + a * g.h) + 1, Math.round(g.y0 + b * g.h)); y++) {
      let run = 0;
      for (let x = g.x0; x <= g.x1; x++) {
        run = lab[y * W + x] === g.id ? run + 1 : 0;
        wMax = Math.max(wMax, run);
      }
    }
    return wMax;
  };
  const mid = rows(0.45, 0.7);
  const low = rows(0.7, 0.92);
  return widest(0, 0.12) <= 0.7 * g.w && widest(0.35, 0.85) < 0.8 * g.w && Math.abs(low - mid) < 0.15 * g.w;
}

/** Read a row of glyph components (left to right) as text. */
function readWord(px, lab, glyphs) {
  const hMax = Math.max(...glyphs.map((g) => g.h));
  const top = Math.min(...glyphs.map((g) => g.y0));
  const bottom = Math.max(...glyphs.map((g) => g.y1));
  const chars = glyphs.map((g) => {
    const mid = (g.y0 + g.y1) / 2;
    if (g.h <= 0.4 * hMax && g.w >= 1.3 * g.h && mid > top + 0.25 * (bottom - top) && mid < bottom - 0.2 * (bottom - top)) return { ch: '-', score: 1, margin: 1 };
    if (g.h <= 0.35 * hMax && g.w <= 1.6 * g.h && g.y1 >= bottom - 1) return { ch: '.', score: 1, margin: 1 };
    if (isOne(lab, px.W, g, hMax)) return { ch: '1', score: 1, margin: 1 };
    return classifyGlyph(px, lab, g);
  });
  return {
    text: chars.map((c) => c.ch).join(''),
    score: Math.min(...chars.map((c) => c.score)),
    margin: Math.min(...chars.map((c) => c.margin)),
    height: hMax,
    box: { x0: Math.min(...glyphs.map((g) => g.x0)), y0: top, x1: Math.max(...glyphs.map((g) => g.x1)), y1: bottom },
  };
}

// ---------- velocity scale ----------

/**
 * Tick marks: short, thin horizontal bars, aligned on one edge, evenly
 * spaced down the image. Pixels that belong to taller shapes (spectrum,
 * digits) are not bars, so a tick touching the spectrum is still found.
 */
function findTicks(px) {
  const { W, H, white } = px;
  const maxT = Math.max(6, Math.round(H / 40));
  // Vertical run length through each white pixel.
  const vr = new Uint16Array(W * H);
  for (let x = 0; x < W; x++) {
    let y = 0;
    while (y < H) {
      if (!white[y * W + x]) {
        y++;
        continue;
      }
      let y2 = y;
      while (y2 + 1 < H && white[(y2 + 1) * W + x]) y2++;
      const L = y2 - y + 1;
      for (let k = y; k <= y2; k++) vr[k * W + x] = L;
      y = y2 + 1;
    }
  }
  const bar = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) bar[i] = white[i] && vr[i] <= maxT ? 1 : 0;
  // Bar components must be wider than tall.
  const { comps, label: barLabel } = components(bar, W, H, 3);
  const bars = comps.filter((c) => c.w >= 3 && c.h <= maxT && c.w <= Math.max(40, W * 0.04));
  const flat = bars.filter((c) => c.w >= 1.3 * c.h);
  // Group by a shared left or right edge, then look for a regular lattice.
  let best = null;
  for (const edge of ['x0', 'x1']) {
    const seen = new Set();
    for (const b of flat) {
      const key = `${edge}${b[edge]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const group = flat.filter((q) => Math.abs(q[edge] - b[edge]) <= 2);
      if (group.length < 4) continue;
      const lat = fitLattice(group.map((q) => q.yc), { dMin: Math.max(6, H / 60), dMax: H / 2.5, tol: 1.5 });
      if (!lat || lat.count < 4) continue;
      const span = lat.span * lat.spacing;
      const score = lat.count + span / H;
      if (!best || score > best.score) best = { score, edge, at: median(group.map((q) => q[edge])), lattice: lat };
    }
  }
  if (!best) return null;
  // Every bar that crosses the scale column and sits on the lattice is a
  // tick (this recovers ticks that touch the spectrum or the baseline).
  const lat = best.lattice;
  const col = best.edge === 'x0' ? best.at + 2 : best.at - 2;
  const bySite = new Map();
  const crossing = [];
  for (const c0 of comps) {
    if (c0.x0 > col + 3 || c0.x1 < col - 3 || c0.h > maxT) continue;
    // A tick merged with the spectrum or the baseline: keep only its part
    // on the scale side of the aligned edge.
    let c = c0;
    if (c0.w > Math.max(40, W * 0.04)) {
      const xa = best.edge === 'x0' ? Math.round(best.at) : c0.x0;
      const xb = best.edge === 'x0' ? c0.x1 : Math.round(best.at);
      let n = 0;
      let sy = 0;
      let y0 = Infinity;
      let y1 = -1;
      let lo = Infinity;
      let hi = -1;
      for (let y = c0.y0; y <= c0.y1; y++) {
        for (let x = xa; x <= xb; x++) {
          if (barLabel[y * W + x] !== c0.id) continue;
          n++;
          sy += y;
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
          lo = Math.min(lo, x);
          hi = Math.max(hi, x);
        }
      }
      if (!n || hi - lo + 1 > Math.max(40, W * 0.04)) continue;
      c = { ...c0, x0: lo, x1: hi, y0, y1, w: hi - lo + 1, h: y1 - y0 + 1, yc: sy / n, n };
    }
    crossing.push(c);
  }
  // Refit the spacing on every bar in the column: the first lattice may
  // have come from the short ticks alone, with the long ones half-way.
  const refit = fitLattice(crossing.map((c) => c.yc), { dMin: Math.max(6, H / 60), dMax: H / 2.5, tol: 1.5, minFill: 0.6 }) ?? lat;
  for (const c of crossing) {
    const k = Math.round((c.yc - refit.origin) / refit.spacing);
    const r = Math.abs(c.yc - (refit.origin + k * refit.spacing));
    if (r > Math.max(1.5, 0.05 * refit.spacing)) continue;
    if (!bySite.has(k) || r < bySite.get(k).r) bySite.set(k, { c, r });
  }
  best.lattice = refit.count >= lat.count ? refit : lat;
  best.ticks = [...bySite.values()].map((q) => q.c).sort((p, q) => p.yc - q.yc);
  if (best.ticks.length < 4) return null;
  // Long (labelled) and short ticks differ in how far they reach from the
  // aligned edge (a tick merged with the baseline is wider, not longer).
  const ticks = best.ticks.map((c) => ({ y: c.yc, x0: c.x0, x1: c.x1, w: c.w, h: c.h, len: best.edge === 'x0' ? c.x1 - best.at + 1 : best.at - c.x0 + 1 }));
  const ls = ticks.map((t) => t.len).sort((a, b) => a - b);
  let gap = 0;
  let cut = Infinity;
  for (let i = 1; i < ls.length; i++) {
    if (ls[i] - ls[i - 1] > gap) {
      gap = ls[i] - ls[i - 1];
      cut = (ls[i] + ls[i - 1]) / 2;
    }
  }
  const lower = ls.filter((w) => w < cut);
  const upper = ls.filter((w) => w > cut);
  const twoKinds = lower.length > 0 && upper.length > 0 && gap >= 2 && median(upper) >= 1.4 * median(lower);
  for (const t of ticks) t.long = !twoKinds || t.len > cut;
  const x0 = best.edge === 'x0' ? best.at : median(ticks.map((t) => t.x0));
  const x1 = best.edge === 'x1' ? best.at : median(ticks.filter((t) => t.long).map((t) => t.x1));
  // Labels sit on the side away from the display.
  const side = x0 > W / 2 ? 'right' : 'left';
  return { ticks, spacing: best.lattice.spacing, x0, x1, side, maxT };
}

/** Read the label next to each long tick. */
function readScale(px, cc, scale) {
  const { ticks, spacing, side } = scale;
  const words = [];
  for (const t of ticks.filter((q) => q.long)) {
    const band = 0.5 * spacing;
    const startX = side === 'right' ? t.x1 + 1 : t.x0 - 1;
    const near = cc.comps.filter((c) => {
      if (Math.abs(c.yc - t.y) > band || c.h > 1.6 * spacing || c.h < 2) return false;
      return side === 'right' ? c.x0 > t.x1 && c.x0 < t.x1 + 4 * spacing : c.x1 < t.x0 && c.x1 > t.x0 - 4 * spacing;
    });
    near.sort((a, b) => (side === 'right' ? a.x0 - b.x0 : b.x1 - a.x1));
    const glyphs = [];
    let edge = startX;
    for (const c of near) {
      const hRef = Math.max(c.h, ...glyphs.map((g) => g.h));
      const gap = side === 'right' ? c.x0 - edge : edge - c.x1;
      if (gap > (glyphs.length ? 0.9 : 1.6) * hRef + 2) break;
      glyphs.push(c);
      edge = side === 'right' ? c.x1 : c.x0;
    }
    if (side === 'left') glyphs.reverse();
    // Specks above or below the characters are not part of the label.
    if (glyphs.length) {
      const hMax = Math.max(...glyphs.map((g) => g.h));
      const main = glyphs.filter((g) => g.h >= 0.6 * hMax);
      const top = Math.min(...main.map((g) => g.y0));
      const bottom = Math.max(...main.map((g) => g.y1));
      for (let i = glyphs.length - 1; i >= 0; i--) if (glyphs[i].y1 < top || glyphs[i].y0 > bottom) glyphs.splice(i, 1);
    }
    if (!glyphs.length) {
      words.push({ tick: t, text: '', ok: false });
      continue;
    }
    const hRef = Math.max(...glyphs.map((g) => g.h));
    const parts = glyphs.flatMap((g) => splitGlyph(cc.label, px.W, g, hRef));
    const w = readWord(px, cc.label, parts);
    words.push({ tick: t, ...w, glyphs: parts });
  }
  return words;
}

const NUMBER = /^-?\d+(\.\d+)?$/;

/** Turn the read labels into a velocity calibration, checking consistency. */
function velocityFromLabels(words, spacing) {
  const heights = words.filter((w) => w.text).map((w) => w.height);
  const hTyp = heights.length ? median(heights) : 0;
  let unit = null;
  const points = [];
  const rejected = [];
  for (const w of words) {
    if (!w.text) continue;
    const truncated = w.height < 0.8 * hTyp;
    // The unit printed at the zero tick ("cm/s" or "m/s"); the slash often
    // touches its neighbours, so only the first and last letters are relied on.
    const unitWord = w.text.length >= 3 && w.text.length <= 5 && w.text.endsWith('s') && !NUMBER.test(w.text) && /^[cm]/.test(w.text);
    if (unitWord) {
      unit = w.text.startsWith('c') ? 'cm/s' : 'm/s';
      points.push({ y: w.tick.y, value: 0, word: w, unitLabel: true });
      continue;
    }
    if (!truncated && NUMBER.test(w.text) && w.margin > 0.02) points.push({ y: w.tick.y, value: Number(w.text), word: w });
    else rejected.push({ word: w, reason: truncated ? 'partly hidden' : NUMBER.test(w.text) ? 'uncertain reading' : 'not a number' });
  }
  if (points.length < 3) return { ok: false, unit, points, rejected, reason: `only ${points.length} scale label${points.length === 1 ? '' : 's'} could be read` };
  // value → y must be one straight line; drop at most one misread label.
  const tol = Math.max(1.2, 0.04 * spacing);
  const fitPts = (pts) => linearFit(pts.map((p) => p.value), pts.map((p) => p.y));
  let use = points;
  let fit = fitPts(use);
  if (fit.rms > tol && points.length >= 4) {
    let bestDrop = null;
    for (let i = 0; i < points.length; i++) {
      const sub = points.filter((_, j) => j !== i);
      const f = fitPts(sub);
      if (!bestDrop || f.rms < bestDrop.fit.rms) bestDrop = { i, fit: f, sub };
    }
    if (bestDrop.fit.rms <= tol) {
      rejected.push({ word: points[bestDrop.i].word, reason: `read as ${points[bestDrop.i].word.text}, off the line through the other labels` });
      use = bestDrop.sub;
      fit = bestDrop.fit;
    }
  }
  if (fit.rms > tol || !Number.isFinite(fit.slope) || fit.slope === 0) {
    return { ok: false, unit, points, rejected, reason: 'the scale labels do not fall on a straight line' };
  }
  const values = use.map((p) => p.value);
  const integers = values.every((v) => Number.isInteger(v));
  let inferred = false;
  if (!unit) {
    // No unit printed: whole-number labels 10 or more apart are cm/s.
    const step = Math.min(...values.slice(1).map((v, i) => Math.abs(v - values[i])).filter((d) => d > 0));
    if (integers && step >= 5) {
      unit = 'cm/s';
      inferred = true;
    } else return { ok: false, unit, points, rejected, reason: 'the scale has no readable unit' };
  }
  const toCm = unit === 'm/s' ? 100 : 1;
  // y = icpt + slope · v  (v in the label unit)
  const pxPerCmS = fit.slope / toCm;
  return {
    ok: true,
    unit,
    unitInferred: inferred,
    points: use,
    rejected,
    zeroY: fit.icpt,
    pxPerCmS, // signed: negative when velocity increases upwards
    rms: fit.rms,
  };
}

// ---------- baseline ----------

function findBaseline(px, xMax) {
  const { W, H, gray, chroma } = px;
  const rows = [];
  for (let y = 0; y < H; y++) {
    // Longest run of coloured line pixels with a steady colour.
    let best = 0;
    let bestA = 0;
    let run = 0;
    let a = 0;
    for (let x = 0; x <= xMax; x++) {
      const i = y * W + x;
      if (chroma[i] >= 50 && gray[i] >= 50) {
        if (run === 0) a = x;
        run++;
        if (run > best) {
          best = run;
          bestA = a;
        }
      } else run = 0;
    }
    rows.push({ y, len: best, x0: bestA, x1: bestA + best - 1 });
  }
  const minLen = 0.45 * (xMax + 1);
  const lines = rows.filter((r) => r.len >= minLen);
  if (!lines.length) return null;
  // Group adjacent rows into one line; keep the longest group.
  const groups = [];
  for (const r of lines) {
    const g = groups[groups.length - 1];
    if (g && r.y - g.y1 <= 1) {
      g.y1 = r.y;
      g.rows.push(r);
    } else groups.push({ y0: r.y, y1: r.y, rows: [r] });
  }
  groups.sort((p, q) => Math.max(...q.rows.map((r) => r.len)) - Math.max(...p.rows.map((r) => r.len)));
  const g = groups[0];
  const longest = g.rows.reduce((p, q) => (q.len > p.len ? q : p));
  const i = Math.round((g.y0 + g.y1) / 2) * W + Math.round((longest.x0 + longest.x1) / 2);
  const rgb = [px.data[4 * i], px.data[4 * i + 1], px.data[4 * i + 2]];
  // Full extent of the line, across short interruptions (an erase bar, or
  // bright spectrum drawn over it).
  const on = new Uint8Array(xMax + 1);
  for (let y = g.y0; y <= g.y1; y++) for (let x = 0; x <= xMax; x++) if (chroma[y * W + x] >= 50 && gray[y * W + x] >= 50) on[x] = 1;
  let x0 = longest.x0;
  let x1 = longest.x1;
  const reach = Math.max(12, Math.round(0.03 * W));
  for (let x = x0 - 1, gap = 0; x >= 0 && gap <= reach; x--) {
    if (on[x]) {
      x0 = x;
      gap = 0;
    } else gap++;
  }
  for (let x = x1 + 1, gap = 0; x <= xMax && gap <= reach; x++) {
    if (on[x]) {
      x1 = x;
      gap = 0;
    } else gap++;
  }
  return { y: (g.y0 + g.y1) / 2, y0: g.y0, y1: g.y1, x0, x1, rgb, others: groups.length - 1 };
}

// ---------- time scale ----------

/**
 * Timeline marks: in some row, many narrow bright marks on a regular
 * lattice. The mark heights show the hierarchy (minor, major).
 */
function findTimeline(px, { xMax, yFrom, yTo }) {
  const { W, white } = px;
  const maxW = Math.max(6, Math.round(W / 250));
  let best = null;
  for (let y = yFrom; y <= yTo; y++) {
    const xs = [];
    for (let x = 0; x <= xMax; ) {
      if (!white[y * W + x]) {
        x++;
        continue;
      }
      let x2 = x;
      while (x2 + 1 <= xMax && white[y * W + x2 + 1]) x2++;
      if (x2 - x + 1 <= maxW) xs.push((x + x2) / 2);
      x = x2 + 1;
    }
    if (xs.length < 8 || xs.length > 400) continue;
    // Candidate spacings: the most common gaps to the next few marks.
    const hist = new Map();
    for (let i = 0; i < xs.length; i++) {
      for (let j = i + 1; j < Math.min(xs.length, i + 4); j++) {
        const d = Math.round(xs[j] - xs[i]);
        if (d >= 8 && d <= W / 6) for (const e of [d - 1, d, d + 1]) hist.set(e, (hist.get(e) ?? 0) + (e === d ? 2 : 1));
      }
    }
    const top = [...hist.entries()].sort((p, q) => q[1] - p[1]).slice(0, 5).map((e) => e[0]);
    if (!top.length) continue;
    // Refine each candidate to the mean of the gaps near it: an integer
    // spacing drifts off the marks over a long timeline.
    for (const e of [...top]) {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < xs.length; i++) {
        for (let j = i + 1; j < Math.min(xs.length, i + 4); j++) {
          const d = xs[j] - xs[i];
          if (Math.abs(d - e) <= 1.5) {
            sum += d;
            n++;
          }
        }
      }
      if (n) top.push(sum / n);
    }
    const lat = fitLattice(xs, { dMin: 8, dMax: W / 6, tol: 2, candidates: top });
    if (!lat || lat.count < 8) continue;
    const frac = lat.count / xs.length;
    const cover = (lat.span * lat.spacing) / (xMax + 1);
    if (frac < 0.35 || cover < 0.4 || lat.count < 10 || lat.count < 0.75 * (lat.span + 1)) continue;
    if (!best || lat.count > best.lattice.count || (lat.count === best.lattice.count && lat.rms < best.lattice.rms)) best = { y, lattice: lat };
  }
  if (!best) return null;
  // Mark heights above the row (marks hang from, or stand on, one line).
  const { H } = px;
  const cap = Math.ceil(best.lattice.spacing);
  const lit = (x, y) => white[y * W + x] || white[y * W + x - 1] || white[y * W + x + 1];
  const marks = best.lattice.members.map((m) => {
    const x = Math.round(m.x);
    let ya = best.y;
    let yb = best.y;
    while (ya - 1 >= 0 && best.y - ya < cap && lit(x, ya - 1)) ya--;
    while (yb + 1 < H && yb - best.y < cap && lit(x, yb + 1)) yb++;
    const valid = best.y - ya < cap && yb - best.y < cap;
    return { x: m.x, k: m.k, y0: ya, y1: yb, up: best.y - ya, valid };
  });
  // Tallest marks: the smallest period P (in marks) that puts every tallest
  // mark, and no shorter one, at k ≡ φ (mod P).
  const ok = marks.filter((m) => m.valid);
  let majorEvery = null;
  if (ok.length >= 6) {
    const upMax = Math.max(...ok.map((m) => m.up));
    const tall = ok.filter((m) => m.up >= upMax - 1);
    const short = ok.filter((m) => m.up < upMax - 2);
    if (tall.length >= 2 && tall.length <= ok.length / 3 && upMax >= 3) {
      for (let P = 2; P <= 20 && majorEvery === null; P++) {
        const phi = ((tall[0].k % P) + P) % P;
        if (tall.every((m) => m.k % P === phi) && !short.some((m) => m.k % P === phi)) majorEvery = P;
      }
    }
  }
  return {
    kind: 'timeline',
    y: best.y,
    spacing: best.lattice.spacing,
    origin: best.lattice.origin,
    rms: best.lattice.rms,
    marks,
    majorEvery,
    top: Math.min(...ok.map((m) => m.y0), best.y),
    bottom: Math.max(...ok.map((m) => m.y1), best.y),
  };
}

/**
 * Dotted vertical grid lines: columns of small dots at a regular vertical
 * spacing, repeated at a regular horizontal spacing. Found by brightness
 * alone, since compression can wash out the dots' colour.
 */
function findGridLines(px, { x0, x1, y0, y1 }) {
  const { W, gray } = px;
  const thr = 55;
  const lit = (x, y) => gray[y * W + x] >= thr;
  const cols = [];
  for (let x = Math.max(3, x0); x <= Math.min(W - 4, x1); x++) {
    const ys = [];
    for (let y = y0 + 2; y <= y1 - 2; ) {
      if (!lit(x, y)) {
        y++;
        continue;
      }
      let y2 = y;
      while (y2 + 1 <= y1 && lit(x, y2 + 1)) y2++;
      // Short, dark above and below, and dark on at least one side.
      const isDot = y2 - y <= 3 && !lit(x, y - 2) && !lit(x, Math.min(y1, y2 + 2)) && (!lit(x - 3, (y + y2) >> 1) || !lit(x + 3, (y + y2) >> 1));
      if (isDot) ys.push((y + y2) / 2);
      y = y2 + 1;
    }
    if (ys.length < 5) continue;
    const lat = fitLattice(ys, { dMin: 6, dMax: (y1 - y0) / 4, tol: 1.5 });
    if (!lat || lat.count < 5 || lat.count < 0.5 * (lat.span + 1)) continue;
    cols.push({ x, spacing: lat.spacing, count: lat.count, ys });
  }
  // Adjacent columns are one line.
  const lines = [];
  for (const c of cols) {
    const g = lines[lines.length - 1];
    if (g && c.x - g.xb <= 2) {
      g.xb = c.x;
      g.sw += c.count;
      g.sx += c.x * c.count;
      g.sp.push(c.spacing);
    } else lines.push({ xa: c.x, xb: c.x, sw: c.count, sx: c.x * c.count, sp: [c.spacing] });
  }
  const cand = lines.filter((g) => g.xb - g.xa <= 5).map((g) => ({ x: g.sx / g.sw, dot: median(g.sp) }));
  if (cand.length < 3) return null;
  // The same dot pitch on every line.
  const pitch = median(cand.map((c) => c.dot));
  const same = cand.filter((c) => Math.abs(c.dot - pitch) <= 0.1 * pitch);
  if (same.length < 3) return null;
  const lat = fitLattice(same.map((c) => c.x), { dMin: 40, dMax: (x1 - x0) / 2, tol: 4, minFill: 0.6 });
  if (!lat || lat.count < 3) return null;
  // Colour of the dots: grey dots (colour lost to compression) would be
  // traced as spectrum, so their columns are left out of the envelope.
  let cs = 0;
  let cn = 0;
  for (const m of lat.members) {
    for (const c of cols) {
      if (Math.abs(c.x - m.x) > 1) continue;
      for (const y of c.ys) {
        cs += px.chroma[Math.round(y) * W + c.x];
        cn++;
      }
    }
  }
  const dotChroma = cn ? cs / cn : 0;
  return { kind: 'lines', spacing: lat.spacing, origin: lat.origin, rms: lat.rms, dotPitch: pitch, dotChroma, lines: lat.members.map((m) => ({ x: m.x, k: m.k })) };
}

// ---------- overlays and region ----------

/** Grow a mask by r pixels in every direction. */
function dilate(raw, W, H, r) {
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!raw[y * W + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < W) mask[yy * W + xx] = 1;
        }
      }
    }
  }
  return mask;
}

/**
 * The ECG trace: a long, wavy, thin coloured curve, often broken into
 * pieces. Compression can leave it only faintly tinted, so a low colour
 * threshold is used; the shape (a quarter of the image wide or more, a few
 * pixels of ink per column, clear of the baseline) does the rest.
 */
function findEcg(px, baseline) {
  const { W, H, chroma, gray } = px;
  const raw = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) raw[i] = chroma[i] >= 18 && gray[i] >= 60 ? 1 : 0;
  const pad = baseline ? 3 + Math.ceil((baseline.y1 - baseline.y0) / 2) : 0;
  if (baseline) for (let y = Math.max(0, Math.floor(baseline.y - pad)); y <= Math.min(H - 1, Math.ceil(baseline.y + pad)); y++) raw.fill(0, y * W, (y + 1) * W);
  const r = 2;
  const { comps, label } = components(dilate(raw, W, H, r), W, H, 20);
  // Pieces: thin (a few pixels of ink per column) and clear of the baseline.
  const pieces = [];
  for (const c of comps) {
    if (c.w < 0.03 * W || c.h < 8) continue;
    if (baseline && c.y0 - r <= baseline.y + pad + 1 && c.y1 + r >= baseline.y - pad - 1) continue;
    let ink = 0;
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (raw[y * W + x] && label[y * W + x] === c.id) ink++;
    if (ink > 8 * c.w) continue;
    pieces.push({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1 });
  }
  // Chain pieces that continue one another in the same band of rows.
  pieces.sort((a, b) => a.x0 - b.x0);
  const chains = [];
  for (const q of pieces) {
    const c = chains.find((k) => q.x0 - k.x1 <= Math.max(30, 0.05 * W) && Math.min(k.y1, q.y1) - Math.max(k.y0, q.y0) >= 0.5 * Math.min(k.y1 - k.y0, q.y1 - q.y0));
    if (c) {
      c.x1 = Math.max(c.x1, q.x1);
      c.y0 = Math.min(c.y0, q.y0);
      c.y1 = Math.max(c.y1, q.y1);
    } else chains.push({ ...q });
  }
  const best = chains.filter((c) => c.x1 - c.x0 + 1 >= 0.25 * W).reduce((p, q) => (!p || q.x1 - q.x0 > p.x1 - p.x0 ? q : p), null);
  return best && { x0: best.x0 + r, y0: best.y0 + r, x1: best.x1 - r, y1: best.y1 - r };
}

/**
 * Thin horizontal rules (box borders, separators): a long run of lit grey
 * pixels in one row with dark rows just above and below.
 */
function findRules(px, { x0, x1, skip }) {
  const { W, H, gray, chroma } = px;
  const minLen = Math.max(40, 0.08 * (x1 - x0 + 1));
  const litAt = (x, y) => gray[y * W + x] >= 40 && chroma[y * W + x] < 50;
  const rules = [];
  for (let y = 2; y < H - 2; y++) {
    if (skip && y >= skip.y0 - 2 && y <= skip.y1 + 2) continue;
    let run = 0;
    let a = 0;
    let best = null;
    for (let x = x0; x <= x1 + 1; x++) {
      if (x <= x1 && litAt(x, y)) {
        if (run === 0) a = x;
        run++;
      } else {
        if (run >= minLen && (!best || run > best.b - best.a + 1)) best = { a, b: x - 1 };
        run = 0;
      }
    }
    if (!best) continue;
    let near = 0;
    for (let x = best.a; x <= best.b; x++) if (litAt(x, y - 2) || litAt(x, y + 2)) near++;
    if (near < 0.3 * (best.b - best.a + 1)) rules.push({ x0: best.a, x1: best.b, y0: y, y1: y });
  }
  return rules;
}

/** Bright border rows or columns at the edges of the image (a frame). */
function findFrame(px, { x0, x1, y0, y1 }) {
  const { W, gray } = px;
  const rowLit = (y) => {
    let n = 0;
    for (let x = x0; x <= x1; x++) if (gray[y * W + x] >= 100) n++;
    return n / (x1 - x0 + 1);
  };
  const colLit = (x) => {
    let n = 0;
    for (let y = y0; y <= y1; y++) if (gray[y * W + x] >= 100) n++;
    return n / (y1 - y0 + 1);
  };
  // From each edge: skip a dark margin, then step over bright border lines
  // (plus one pixel for their soft edge). Without a border, keep the edge.
  const inward = (from, to, step, litFrac) => {
    const limit = Math.round(0.1 * Math.abs(to - from));
    let p = from;
    while (Math.abs(p - from) < limit && litFrac(p) < 0.02) p += step;
    if (litFrac(p) < 0.9) return from;
    while (p !== to && litFrac(p) >= 0.9) p += step;
    return p + step;
  };
  return {
    top: inward(y0, y1, 1, rowLit),
    bottom: inward(y1, y0, -1, rowLit),
    left: inward(x0, x1, 1, colLit),
    right: inward(x1, x0, -1, colLit),
  };
}

/** Lines of on-screen text: rows of crisp glyph-sized components. */
function findText(px, cc, { hText, xMax }) {
  const { W, gray } = px;
  const glyphs = cc.comps.filter((c) => {
    if (c.x0 > xMax) return false;
    if (c.h < 0.6 * hText || c.h > 1.5 * hText || c.w > 1.6 * c.h || c.n < 0.15 * c.w * c.h) return false;
    // Crisp: bright inside.
    let s = 0;
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (cc.label[y * W + x] === c.id) s += gray[y * W + x];
    return s / c.n >= 170;
  });
  glyphs.sort((a, b) => a.x0 - b.x0);
  const used = new Set();
  const lines = [];
  for (const g of glyphs) {
    if (used.has(g.id)) continue;
    const line = [g];
    let last = g;
    for (const q of glyphs) {
      if (used.has(q.id) || q === g || q.x0 <= last.x0) continue;
      if (q.x0 - last.x1 > 1.2 * hText) continue;
      if (Math.abs(q.y1 - last.y1) > 0.3 * hText && Math.abs(q.y0 - last.y0) > 0.3 * hText) continue;
      line.push(q);
      last = q;
    }
    if (line.length >= 3) {
      for (const q of line) used.add(q.id);
      lines.push({ x0: line[0].x0, x1: line[line.length - 1].x1, y0: Math.min(...line.map((q) => q.y0)), y1: Math.max(...line.map((q) => q.y1)), glyphs: line });
    }
  }
  return lines;
}

// ---------- known displays ----------

const TW = 48;
const TH = 16;

/** Grey-level thumbnail used to recognise a known example image. */
export function fingerprint(img) {
  const { width: W, height: H, data } = img;
  const out = new Float32Array(TW * TH);
  const fx = W / TW;
  const fy = H / TH;
  for (let ty = 0; ty < TH; ty++) {
    for (let tx = 0; tx < TW; tx++) {
      let s = 0;
      let n = 0;
      const xa = Math.floor(tx * fx);
      const xb = Math.max(xa + 1, Math.floor((tx + 1) * fx));
      const ya = Math.floor(ty * fy);
      const yb = Math.max(ya + 1, Math.floor((ty + 1) * fy));
      for (let y = ya; y < yb; y += 1) {
        for (let x = xa; x < xb; x += 1) {
          const i = 4 * (y * W + x);
          s += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          n++;
        }
      }
      out[ty * TW + tx] = s / n;
    }
  }
  return Array.from(out, (v) => Math.round(v));
}

function correlation(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb || 1);
}

const decoded = new WeakMap();
function entryFingerprint(entry) {
  if (typeof entry.fingerprint !== 'string') return entry.fingerprint;
  if (!decoded.has(entry)) {
    const hex = entry.fingerprint;
    const out = new Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
    decoded.set(entry, out);
  }
  return decoded.get(entry);
}

/**
 * The known display this image is a copy of (resized or re-saved), if any:
 * same proportions, and a thumbnail correlation of at least 0.97.
 */
export function matchKnownDisplay(img, library) {
  const fp = fingerprint(img);
  const aspect = img.width / img.height;
  let best = null;
  for (const entry of library) {
    if (Math.abs(Math.log(aspect / (entry.width / entry.height))) > 0.04) continue;
    const r = correlation(fp, entryFingerprint(entry));
    if (!best || r > best.r) best = { entry, r };
  }
  if (!best || best.r < 0.97) return null;
  const { fingerprint: _omit, ...entry } = best.entry;
  return { ...entry, similarity: best.r, scale: img.width / best.entry.width };
}

// ---------- everything together ----------

/**
 * Calibrate a spectral Doppler image automatically.
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}} img RGBA
 * @param {{library?:object[]}} opts library: known example displays
 * @returns {object} { ok, calibration, found, missing[], checks[], match }
 *   calibration: { region, baselineY, velPerPx, secPerPx, tOffset } when ok.
 *   found: what was identified, in image pixels, for display.
 */
export function autoCalibrate(img, { library = [] } = {}) {
  const px = prepare(img);
  const { W, H } = px;
  const checks = [];
  const missing = [];
  const found = {};
  const match = library.length ? matchKnownDisplay(img, library) : null;

  // Velocity scale.
  const scale = findTicks(px);
  const cc = components(px.white, W, H, 2);
  let vel = null;
  if (scale) {
    found.scale = scale;
    const words = readScale(px, cc, scale);
    vel = velocityFromLabels(words, scale.spacing);
    found.labels = { words, ...vel };
    if (!vel.ok) checks.push({ level: 'warn', message: `Velocity scale found, but ${vel.reason}.` });
  } else checks.push({ level: 'warn', message: 'No velocity scale (a column of evenly spaced tick marks) was found.' });

  // Display extent to the scale.
  const xMax = scale ? (scale.side === 'right' ? Math.round(scale.x0) - 2 : W - 1) : W - 1;
  const xMin = scale && scale.side === 'left' ? Math.round(scale.x1) + 2 : 0;

  // Baseline.
  const line = findBaseline(px, xMax);
  if (line) found.baselineLine = line;
  let baselineY = null;
  if (vel?.ok) {
    if (line && Math.abs(line.y - vel.zeroY) <= Math.max(2, 0.06 * Math.abs(vel.pxPerCmS) * 10)) {
      baselineY = line.y;
      found.baseline = { y: line.y, from: 'line', zeroY: vel.zeroY };
    } else {
      baselineY = vel.zeroY;
      found.baseline = { y: vel.zeroY, from: 'scale', zeroY: vel.zeroY };
      if (line) checks.push({ level: 'warn', message: `A horizontal line at row ${line.y.toFixed(0)} is not at the scale's zero (row ${vel.zeroY.toFixed(1)}); the scale's zero is used.` });
    }
  } else if (line) {
    baselineY = line.y;
    found.baseline = { y: line.y, from: 'line' };
  }

  // Overlays.
  const ecg = findEcg(px, line);
  if (ecg) found.ecg = ecg;
  const hText = vel?.points?.length ? median(vel.points.map((p) => p.word.height)) : Math.max(8, Math.round(H / 30));
  const text = findText(px, cc, { hText, xMax });
  found.text = text;

  // Region: the scale's extent (one tick spacing beyond the outermost
  // ticks, which may be hidden), clear of overlays.
  let y0 = 0;
  let y1 = H - 1;
  if (scale) {
    y0 = Math.max(0, Math.round(scale.ticks[0].y - scale.spacing));
    y1 = Math.min(H - 1, Math.round(scale.ticks[scale.ticks.length - 1].y + scale.spacing));
  }
  const why = [];
  const ref = baselineY ?? (y0 + y1) / 2;
  const clearOf = (box, name, pad = 3) => {
    if (box.x1 < xMin || box.x0 > xMax) return;
    if (box.y0 > ref && box.y0 - pad < y1) {
      y1 = box.y0 - pad;
      why.push(`stops above the ${name}`);
    } else if (box.y1 < ref && box.y1 + pad > y0) {
      y0 = box.y1 + pad;
      why.push(`starts below the ${name}`);
    }
  };
  if (ecg) clearOf(ecg, 'ECG trace');
  for (const t of text) clearOf(t, 'on-screen text');
  const rules = findRules(px, { x0: xMin, x1: xMax, skip: line });
  found.rules = rules;
  for (const r of rules) clearOf(r, 'horizontal rule');
  const frame = findFrame(px, { x0: xMin, x1: xMax, y0: 0, y1: H - 1 });
  if (frame.top > y0) {
    y0 = frame.top;
    why.push('starts below the image border');
  }
  if (frame.bottom < y1) {
    y1 = frame.bottom;
    why.push('stops above the image border');
  }

  // Time scale: a timeline outside the display (inside it, a regular
  // spectrum could pass for one), else dotted grid lines across it.
  // The display may extend a little past the outermost ticks; a timeline
  // can start right after them.
  const below = scale ? Math.min(y1, Math.ceil(scale.ticks[scale.ticks.length - 1].y + 3)) : y1;
  const above = scale ? Math.max(y0, Math.floor(scale.ticks[0].y - 3)) : y0;
  let time = findTimeline(px, { xMax, yFrom: Math.min(H - 1, below + 1), yTo: H - 1 }) ?? findTimeline(px, { xMax, yFrom: 0, yTo: Math.max(0, above - 1) });
  if (time) clearOf({ x0: 0, x1: xMax, y0: time.top, y1: time.bottom }, 'timeline');

  let x0 = Math.max(xMin, frame.left);
  let x1 = Math.min(xMax - 1, frame.right);
  if (line) {
    x0 = Math.max(x0, line.x0);
    x1 = Math.min(x1, line.x1);
  }
  const region = { x0, y0, x1, y1 };
  found.region = { ...region, why: [...new Set(why)] };
  if (!time) time = findGridLines(px, { x0, x1, y0, y1 });
  let secPerPx = null;
  if (time) {
    found.time = time;
    if (time.kind === 'timeline') {
      // Convention: the tallest marks are 1 s apart; with no hierarchy,
      // marks are taken as 0.1 s apart.
      const step = time.majorEvery ? 1 / time.majorEvery : 0.1;
      time.step = step;
      time.assumption = time.majorEvery
        ? `the tallest marks (every ${time.majorEvery}th) are 1 s apart, so marks are ${+(step * 1000).toFixed(0)} ms apart`
        : 'marks are 0.1 s apart (no taller marks to confirm it)';
      secPerPx = step / time.spacing;
    } else {
      time.step = 1;
      time.assumption = 'dotted grid lines are 1 s apart';
      secPerPx = 1 / time.spacing;
    }
  }

  // Known display: cross-check, or fill what could not be read.
  if (match) {
    found.match = match;
    const s = match.scale;
    const refVel = match.calibration.velPerPx / s;
    const refSec = match.calibration.secPerPx / s;
    if (vel?.ok) {
      const autoVel = -1 / vel.pxPerCmS / 100;
      const dv = autoVel / refVel - 1;
      if (Math.abs(dv) > 0.02) checks.push({ level: 'warn', message: `Velocity scale read as ${(Math.abs(autoVel) * 100).toFixed(3)} cm/s per pixel; the reference calibration of this example gives ${(Math.abs(refVel) * 100).toFixed(3)}.` });
    }
    if (secPerPx) {
      const dt = secPerPx / refSec - 1;
      if (Math.abs(dt) > 0.02) checks.push({ level: 'warn', message: `Time scale read as ${(secPerPx * 1000).toFixed(3)} ms per pixel; the reference calibration of this example gives ${(refSec * 1000).toFixed(3)}.` });
    }
  }

  let velPerPx = vel?.ok ? -1 / vel.pxPerCmS / 100 : null;
  let source = 'scale';
  if (velPerPx === null && match) {
    velPerPx = match.calibration.velPerPx / match.scale;
    if (baselineY === null) baselineY = match.calibration.baselineY * match.scale;
    source = 'reference';
    checks.push({ level: 'info', message: 'Velocity scale taken from the reference calibration of this example.' });
  }
  if (secPerPx === null && match) {
    secPerPx = match.calibration.secPerPx / match.scale;
    checks.push({ level: 'info', message: 'Time scale taken from the reference calibration of this example.' });
  }
  if (velPerPx === null || baselineY === null) missing.push('velocity');
  if (secPerPx === null) missing.push('time');
  if (y1 - y0 < 20 || x1 - x0 < 20) missing.push('region');

  // Grey grid dots inside the display are not spectrum.
  const ignoreColumns = time?.kind === 'lines' && time.dotChroma < 30 ? time.lines.map((l) => [Math.floor(l.x) - 2, Math.ceil(l.x) + 2]) : [];
  if (ignoreColumns.length) checks.push({ level: 'info', message: `The dotted grid lines have lost their colour; ${ignoreColumns.length} columns of dots are bridged in the envelope.` });

  const ok = missing.length === 0;
  return {
    ok,
    missing,
    checks,
    found,
    match,
    source,
    calibration: ok ? { region, baselineY, velPerPx, secPerPx, tOffset: 0, ...(ignoreColumns.length ? { ignoreColumns } : {}) } : null,
    partial: { region, baselineY, velPerPx, secPerPx },
    size: { width: W, height: H },
  };
}
