// Synthetic spectral-Doppler envelopes with known ground truth.
//
// Each beat is a sum of simple pulse shapes measured from the beat onset:
// a gamma-variate systolic wave, an optional early-diastolic reverse-flow
// dip and late forward wave (triphasic), and an optional diastolic run-off
// term (monophasic). Beats overlap and add, so diastolic flow is continuous
// across beats. RR intervals and amplitudes vary with respiration and at
// random, and the trace is degraded with additive noise, envelope spikes,
// pixel-like time sampling and velocity quantisation.

import { rng } from './stats.js';
import { findLandmarks } from './landmarks.js';

// Shapes chosen so that the noise-free ACCmax and AT sit near the poster's
// illustrative values (triphasic ≈ 7.8 m/s² and 93 ms, monophasic ≈ 1.0 m/s²
// and 144 ms); see syntheticTruth() for the exact values.
export const PRESETS = {
  triphasic: {
    label: 'Triphasic (normal inflow)',
    psv: 0.55,
    tauR: 0.12,
    nRise: 3.5,
    reverse: 0.22,
    revDelay: 0.28,
    revWidth: 0.045,
    late: 0.07,
    lateDelay: 0.44,
    lateWidth: 0.05,
    diastolic: 0,
    diaRise: 0.08,
    diaDecay: 0.7,
  },
  biphasic: {
    label: 'Biphasic (mildly damped)',
    psv: 0.32,
    tauR: 0.13,
    nRise: 3.5,
    reverse: 0.05,
    revDelay: 0.27,
    revWidth: 0.045,
    late: 0.0,
    lateDelay: 0.4,
    lateWidth: 0.06,
    diastolic: 0.03,
    diaRise: 0.12,
    diaDecay: 0.6,
  },
  monophasic: {
    label: 'Monophasic (tardus-parvus)',
    psv: 0.09,
    tauR: 0.15,
    nRise: 2.6,
    reverse: 0,
    revDelay: 0.25,
    revWidth: 0.04,
    late: 0,
    lateDelay: 0.4,
    lateWidth: 0.06,
    diastolic: 0.04,
    diaRise: 0.1,
    diaDecay: 0.8,
  },
};

const gauss = (x, mu, s) => Math.exp(-0.5 * ((x - mu) / s) ** 2);

function beatShape(shape, x, amp) {
  if (x <= 0) return 0;
  const g = (x / shape.tauR) ** shape.nRise * Math.exp(shape.nRise * (1 - x / shape.tauR));
  let v = amp * g;
  v -= shape.reverse * (amp / shape.psv) * gauss(x, shape.revDelay, shape.revWidth);
  v += shape.late * (amp / shape.psv) * gauss(x, shape.lateDelay, shape.lateWidth);
  v += shape.diastolic * (amp / shape.psv) * (1 - Math.exp(-x / shape.diaRise)) * Math.exp(-x / shape.diaDecay);
  return v;
}

function signalAt(shape, onsets, amps, t) {
  let v = 0;
  for (let k = onsets.length - 1; k >= 0; k--) {
    const x = t - onsets[k];
    if (x <= 0) continue;
    if (x > 4) break;
    v += beatShape(shape, x, amps[k]);
  }
  return v;
}

/**
 * Generate a noisy synthetic envelope.
 * @returns {{t: Float64Array, v: Float64Array, clean: Float64Array, onsets: number[], amps: number[], shape: object, hr: number}}
 */
export function synthesize({
  preset = 'triphasic',
  shape: shapeOverride = null,
  hr = 65,
  duration = 6,
  dt = 0.004,
  noise = 0.02,
  spikes = 0.01,
  quant = 0.003,
  rrSd = 0.03,
  rrResp = 0.04,
  ampSd = 0.04,
  ampResp = 0.05,
  respPeriod = 4.2,
  seed = 1,
} = {}) {
  const shape = shapeOverride ?? PRESETS[preset];
  const r = rng(seed);
  const rr0 = 60 / hr;
  const phase = r() * 2 * Math.PI;
  const onsets = [];
  const amps = [];
  let tk = -3 * rr0 + r() * rr0;
  while (tk < duration + rr0) {
    onsets.push(tk);
    const resp = Math.sin((2 * Math.PI * tk) / respPeriod + phase);
    amps.push(shape.psv * Math.max(0.3, 1 + ampResp * resp + ampSd * r.normal()));
    const rr = rr0 * (1 + rrResp * resp + rrSd * r.normal());
    tk += Math.min(Math.max(rr, 0.5 * rr0), 1.6 * rr0);
  }
  const n = Math.floor(duration / dt);
  const t = new Float64Array(n);
  const v = new Float64Array(n);
  const clean = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = i * dt;
    clean[i] = signalAt(shape, onsets, amps, t[i]);
    let y = clean[i] + noise * r.normal();
    if (r() < spikes) y += (0.08 + 0.25 * r()) * shape.psv;
    v[i] = quant > 0 ? Math.round(y / quant) * quant : y;
  }
  return { t, v, clean, onsets, amps, shape, hr };
}

/** Noise-free envelope at arbitrary times (used to draw synthetic spectrograms). */
export function cleanSignal(sim, t) {
  return signalAt(sim.shape, sim.onsets, sim.amps, t);
}

/**
 * Ground-truth landmarks of the noise-free, strictly periodic waveform at the
 * preset's mean amplitude, measured with the same definitions as the pipeline.
 */
export function syntheticTruth({ preset = 'triphasic', shape: shapeOverride = null, hr = 65 } = {}, lmOptions = {}) {
  const shape = shapeOverride ?? PRESETS[preset];
  const rr = 60 / hr;
  const onsets = [];
  const amps = [];
  for (let k = -6; k <= 2; k++) {
    onsets.push(k * rr);
    amps.push(shape.psv);
  }
  const dx = 0.0001;
  const x0 = -0.4 * rr;
  const n = Math.round(rr / dx);
  const value = new Float64Array(n);
  for (let i = 0; i < n; i++) value[i] = signalAt(shape, onsets, amps, x0 + i * dx);
  const d1 = new Float64Array(n).fill(NaN);
  const d2 = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n - 1; i++) {
    d1[i] = (value[i + 1] - value[i - 1]) / (2 * dx);
    d2[i] = (value[i + 1] - 2 * value[i] + value[i - 1]) / (dx * dx);
  }
  const tpl = { x0, dx, n, value, d1, d2 };
  const lm = findLandmarks(tpl, { period: rr, searchFrom: -0.1 * rr, searchTo: 0.3 * rr, ...lmOptions });
  return { template: tpl, landmarks: lm, accmax: lm.accmax, at: lm.at, psv: lm.psv };
}

/**
 * Render a grey-scale spectral Doppler display (RGBA) from a synthetic
 * envelope, for exercising the image → envelope path.
 * @returns {{width:number,height:number,data:Uint8ClampedArray,calibration:object}}
 */
export function renderSpectrogram(sim, {
  width = 900,
  height = 360,
  region = { x0: 40, y0: 20, x1: 860, y1: 330 },
  baselineY = 250,
  velPerPx = 0.004,
  secPerPx = 0.0045,
  tOffset = 0,
  wallFilter = 0.025,
  seed = 3,
  marks = true,
} = {}) {
  const r = rng(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  const put = (x, y, g, a = 255) => {
    const i = (y * width + x) * 4;
    data[i] = g;
    data[i + 1] = g;
    data[i + 2] = g;
    data[i + 3] = a;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, 8 + Math.floor(6 * r()));
  for (let x = region.x0; x <= region.x1; x++) {
    const t = tOffset + (x - region.x0) * secPerPx;
    const ve = cleanSignal(sim, t);
    for (let y = region.y0; y <= region.y1; y++) {
      const vel = (baselineY - y) * velPerPx;
      let g = 10 + 22 * r() * r();
      const inside = ve > 0 ? vel > 0 && vel <= ve : vel < 0 && vel >= ve;
      if (inside && Math.abs(vel) > wallFilter) {
        const frac = Math.abs(vel / ve);
        const edge = Math.min(1, (Math.abs(ve) - Math.abs(vel)) / (3 * velPerPx));
        const u = r();
        g = 40 + 200 * (0.35 + 0.65 * u) * (0.45 + 0.55 * frac) * (0.35 + 0.65 * edge);
      }
      put(x, y, Math.min(255, Math.round(g)));
    }
  }
  if (!marks) return { width, height, data, calibration: { region, baselineY, velPerPx, secPerPx, tOffset } };
  // Baseline and velocity ticks every 0.2 m/s on the right edge.
  for (let x = region.x0; x <= region.x1; x += 2) put(x, baselineY, 150);
  for (let k = -5; k <= 10; k++) {
    const y = Math.round(baselineY - (k * 0.2) / velPerPx);
    if (y < region.y0 || y > region.y1) continue;
    for (let x = region.x1 + 3; x < region.x1 + 12 && x < width; x++) put(x, y, 200);
  }
  // Time marks every 0.2 s along the bottom.
  for (let k = 0; ; k++) {
    const x = Math.round(region.x0 + (k * 0.2) / secPerPx);
    if (x > region.x1) break;
    const len = k % 5 === 0 ? 8 : 4;
    for (let y = region.y1 + 3; y < region.y1 + 3 + len && y < height; y++) put(x, y, 200);
  }
  return { width, height, data, calibration: { region, baselineY, velPerPx, secPerPx, tOffset } };
}

/**
 * True values for the beats actually measured from a simulation. ACCmax
 * scales with each beat's amplitude, so a short window of strong or weak
 * beats has its own true mean; AT does not depend on amplitude.
 * @param {ReturnType<typeof synthesize>} sim
 * @param {number[]} upstrokeTimes upstroke times of the stacked beats (s)
 */
export function truthForBeats(sim, { preset = 'triphasic', shape = null, hr = 65 } = {}, upstrokeTimes = [], lmOptions = {}) {
  const truth = syntheticTruth({ preset, shape, hr }, lmOptions);
  const ratios = upstrokeTimes
    .map((tu) => {
      let k = -1;
      for (let i = 0; i < sim.onsets.length; i++) if (sim.onsets[i] <= tu + 1e-9) k = i;
      return k >= 0 ? sim.amps[k] / sim.shape.psv : NaN;
    })
    .filter(Number.isFinite);
  const scale = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 1;
  return { ...truth, accmax: truth.accmax * scale, scale };
}
