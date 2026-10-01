// Fit every available case with the automated method and export what the
// checkplots need.
//
//   node scripts/fit-cases.mjs            # writes results/cases/*.json and results/summary.json
//   python3 scripts/plot_checkplots.py    # draws results/checkplots/*.png
//
// Real human cases (see CLAUDE.md, data/README.md, figures/README.md):
//   finger    data/finger/finger_envelope.csv: approximate screen digitisation
//             of a pulsed-wave recording (approximate calibration)
//   tibial    four anterior tibial crops from a published figure
//   brachial  two brachial crops from a published figure (inverted display)
//             Image crops are traced with the provisional calibration in
//             figures/calibration.json.
// Simulated cases: synthetic waveforms with known true ACCmax and AT.
//
// None of the real sources has expert ACCmax labels, and no m/s² value from
// them is a clinical measurement. Image results are also reported in display
// units (velocity pixels per time pixel), which need no calibration.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { analyze, DEFAULT_PARAMS } from '../web/js/core/pipeline.js';
import { parseDelimited, tableToTrace } from '../web/js/io/csv.js';
import { extractEnvelope } from '../web/js/io/envelope.js';
import { synthesize, renderSpectrogram, truthForBeats } from '../web/js/core/synthetic.js';
import { decodePng, encodePng } from './lib/png.mjs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root));
const params = { ...DEFAULT_PARAMS };
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);
const arr = (a, f = r4) => Array.from(a, f);

function exportResult(r) {
  if (!r.ok) return { ok: false, error: r.error, periodogram: r.periodogram ? { bpm: arr(r.periodogram.freq, (f) => r4(f * 60)), power: arr(r.periodogram.power) } : null };
  const lm = r.landmarks;
  return {
    ok: true,
    hr_bpm: r4(r.hr),
    rrVariation: r4(r.rrCv),
    window_s: r.window.map(r4),
    nBeats: r.nBeats,
    accmax_m_s2: r4(lm.accmax),
    at_ms: r4(lm.at * 1000),
    psv_cm_s: r4(lm.psv * 100),
    edv_cm_s: r4(lm.edv * 100),
    ci: r.ci
      ? {
          accmax68: [r4(r.ci.accmax.lo68), r4(r.ci.accmax.hi68)],
          accmax95: [r4(r.ci.accmax.lo95), r4(r.ci.accmax.hi95)],
          at68_ms: [r4(r.ci.at.lo68 * 1000), r4(r.ci.at.hi68 * 1000)],
          at95_ms: [r4(r.ci.at.lo95 * 1000), r4(r.ci.at.hi95 * 1000)],
        }
      : null,
    perBeat: r.perBeat,
    landmarks: {
      valley: { t: r4(lm.valley.t), v: r4(lm.valley.v) },
      onset: { t: r4(lm.onset.t), v: r4(lm.onset.v) },
      acc: { t1: r4(lm.acc.t1), v1: r4(lm.acc.v1), t2: r4(lm.acc.t2), v2: r4(lm.acc.v2) },
      peak: { t: r4(lm.peak.t), v: r4(lm.peak.v) },
    },
    beats: r.beats.map((b) => ({
      index: b.index,
      upstroke_s: r4(b.fiducial),
      included: b.included,
      covered: b.covered,
      reason: b.reason,
      rr_ms: r4(b.rr * 1000),
      oc_ms: r4(b.oc * 1000),
      similarity: r4(b.corr),
      accmax_m_s2: b.measure ? r4(b.measure.accmax) : null,
      at_ms: b.measure ? r4(b.measure.at * 1000) : null,
    })),
    stack: { tau_s: arr(r.stack.tau), v_m_s: arr(r.stack.v), beat: Array.from(r.stack.beat) },
    template: { x0: r4(r.template.x0), dx: r.template.dx, v_m_s: arr(r.template.value) },
    naiveFold: r.naive.landmarks.ok ? { accmax_m_s2: r4(r.naive.landmarks.accmax), at_ms: r4(r.naive.landmarks.at * 1000) } : null,
    periodogram: { bpm: arr(r.periodogram.freq, (f) => r4(f * 60)), power: arr(r.periodogram.power), chosen_bpm: r4(r.periodogram.chosen * 60), best_bpm: r4(r.periodogram.best * 60) },
    smoothing_ms: r4(r.bandwidth * 1000),
    qc: r.qc,
  };
}

// True values for a simulation, for the beats actually stacked: ACCmax scales
// with each beat's amplitude, so a short window of strong or weak beats has
// its own true mean. The true waveform is aligned on its steepest point.
function simTruth(sim, s, r) {
  const lmOptions = { spanMs: params.spanMs, onsetMethod: params.onsetMethod };
  const upstrokes = r.ok ? r.beats.filter((b) => b.included).map((b) => b.fiducial) : [];
  const truth = truthForBeats(sim, s, upstrokes, lmOptions);
  const tpl = truth.template;
  const step = 10; // 1 ms
  const tc = truth.landmarks.acc.tc;
  const values = [];
  for (let i = 0; i < tpl.n; i += step) values.push(r4(tpl.value[i] * truth.scale));
  return {
    truth: { accmax_m_s2: r4(truth.accmax), at_ms: r4(truth.at * 1000), amplitudeScale: r4(truth.scale) },
    truthTemplate: { x0: r4(tpl.x0 - tc), dx: tpl.dx * step, v_m_s: values },
  };
}

const cases = [];
function addCase(c) {
  cases.push(c);
  const r = c.result;
  const line = r.ok
    ? `HR ${r.hr_bpm.toFixed(1)} bpm, ${r.nBeats}/${r.beats.length} beats, ACCmax ${r.accmax_m_s2.toFixed(2)} m/s², AT ${r.at_ms.toFixed(0)} ms, PSV ${r.psv_cm_s.toFixed(1)} cm/s`
    : `FAILED: ${r.error}`;
  console.log(`${c.id.padEnd(28)} ${line}${c.truth ? ` | truth ${c.truth.accmax_m_s2.toFixed(2)} m/s², ${c.truth.at_ms.toFixed(0)} ms` : ''}${c.displayedHr_bpm ? ` | displayed HR ${c.displayedHr_bpm}` : ''}`);
  for (const q of r.qc ?? []) console.log(`    ${q.level}: ${q.message}`);
}

// --- Real: finger envelope CSV (time in s, velocity in mm/s) ---
{
  const table = parseDelimited(read('data/finger/finger_envelope.csv').toString());
  const trace = tableToTrace(table, { tCol: 0, vCol: 1, timeUnit: 's', velUnit: 'mm/s' });
  const r = analyze(trace.t, trace.v, params);
  addCase({
    id: 'finger',
    kind: 'csv',
    group: 'real',
    title: 'Finger: proper volar digital artery',
    subtitle: 'Healthy volunteer, pulsed-wave video, envelope digitised from the screen',
    source: 'Noel (2021), Mendeley Data, doi:10.17632/7g2p7t9tzt.1, CC BY 4.0',
    calibration: 'Approximate: printed 0 and −286 mm/s marks and 0.1 s ticks (data/finger/finger_metadata.json)',
    trace: { t_s: arr(trace.t), v_m_s: arr(trace.v) },
    result: exportResult(r),
  });
}

// --- Real: published figure crops traced with the provisional calibration ---
const cal = JSON.parse(read('figures/calibration.json'));
for (const p of cal.panels) {
  const img = decodePng(read(p.file));
  const env = extractEnvelope(img, p); // the calibration's sign says which side is forward
  const qcExtra = [];
  if (env.clippedFraction > 0.01) {
    qcExtra.push({ level: 'info', message: `Forward envelope reaches the edge of the traced region in ${(env.clippedFraction * 100).toFixed(0)}% of columns.` });
  }
  const r = analyze(env.t, env.v, { ...params, qcExtra });
  const res = exportResult(r);
  if (res.ok) {
    res.accmax_display_px_per_px = r4(r.landmarks.accmax / (Math.abs(p.velPerPx) / p.secPerPx));
    res.at_display_px = r4(r.landmarks.at / p.secPerPx);
    // The same recording measured on the forward edge only (reverse flow set to
    // zero), as calipers placed above the baseline would measure it.
    const fwd = analyze(env.t, env.vForward, { ...params, bootstrap: 0 });
    if (fwd.ok) res.forwardOnly = { accmax_m_s2: r4(fwd.landmarks.accmax), at_ms: r4(fwd.landmarks.at * 1000) };
  }
  addCase({
    id: p.file.split('/').pop().replace('.png', ''),
    kind: 'image',
    group: 'real',
    title: p.label,
    subtitle: p.subtitle ?? 'Published figure panel, scanner screen capture',
    source: p.source ?? cal.source,
    calibration: `Provisional, from the scanner overlay: ${p.evidence.pxPerCmS} px per cm/s, ${p.evidence.pxPer100ms ? `${p.evidence.pxPer100ms} px per 0.1 s (timeline marks)` : `${p.evidence.pxPerSecond} px per s (dotted lines taken as 1 s apart)`}. See figures/calibration.json`,
    displayedHr_bpm: p.displayedHr_bpm,
    image: { file: p.file, region: p.region, baselineY: p.baselineY, velPerPx: p.velPerPx, secPerPx: p.secPerPx, flowUp: p.flowUp !== false },
    trace: { t_s: arr(env.t), v_m_s: arr(env.v), vForward_m_s: arr(env.vForward), vReverse_m_s: arr(env.vReverse), edgeY: arr(env.edgeY, (y) => (Number.isFinite(y) ? Math.round(y * 10) / 10 : null)), edgeReverseY: arr(env.edgeReverseY, (y) => (Number.isFinite(y) ? Math.round(y * 10) / 10 : null)) },
    envelope: { threshold: env.threshold, clippedFraction: r4(env.clippedFraction) },
    result: res,
  });
}

// --- Simulated: synthetic waveforms with known truth ---
const sims = [
  { id: 'sim_triphasic', title: 'Simulated triphasic waveform', subtitle: 'Normal inflow, 66 bpm, 6 s, 2 cm/s envelope noise', preset: 'triphasic', hr: 66, duration: 6, noise: 0.02, seed: 31 },
  { id: 'sim_monophasic', title: 'Simulated monophasic waveform', subtitle: 'Tardus-parvus, 72 bpm, 8 s, 0.8 cm/s envelope noise', preset: 'monophasic', hr: 72, duration: 8, noise: 0.008, seed: 32 },
  { id: 'sim_irregular', title: 'Simulated triphasic, irregular rhythm', subtitle: 'RR intervals vary by about 15% (AF-like), 85 bpm, 8 s', preset: 'triphasic', hr: 85, duration: 8, noise: 0.02, rrSd: 0.15, seed: 33 },
];
for (const s of sims) {
  const sim = synthesize(s);
  const r = analyze(sim.t, sim.v, params);
  addCase({
    id: s.id,
    kind: 'csv',
    group: 'simulated',
    title: s.title,
    subtitle: s.subtitle,
    source: 'Synthetic (web/js/core/synthetic.js); true values known',
    calibration: 'Exact (synthetic)',
    ...simTruth(sim, s, r),
    trace: { t_s: arr(sim.t), v_m_s: arr(sim.v) },
    result: exportResult(r),
  });
}
// A simulated screen capture, measured through the image path.
{
  const s = { preset: 'biphasic', hr: 64, duration: 5, noise: 0, seed: 34 };
  const sim = synthesize(s);
  const calib = { region: { x0: 46, y0: 24, x1: 866, y1: 318 }, baselineY: 262, velPerPx: 0.0025, secPerPx: 0.0045 };
  const img = renderSpectrogram(sim, { width: 920, height: 352, ...calib, seed: 35 });
  mkdirSync(new URL('results/cases/', root), { recursive: true });
  writeFileSync(new URL('results/cases/sim_screen.png', root), encodePng(img));
  const env = extractEnvelope(img, calib);
  const r = analyze(env.t, env.v, params);
  addCase({
    id: 'sim_screen',
    kind: 'image',
    group: 'simulated',
    title: 'Simulated spectral display (image path)',
    subtitle: 'Biphasic, 64 bpm, rendered as a grey-scale spectrum and traced from the image',
    source: 'Synthetic (web/js/core/synthetic.js); true values known',
    calibration: 'Exact (synthetic display)',
    ...simTruth(sim, s, r),
    image: { file: 'results/cases/sim_screen.png', region: calib.region, baselineY: calib.baselineY, velPerPx: calib.velPerPx, secPerPx: calib.secPerPx, flowUp: true },
    trace: { t_s: arr(env.t), v_m_s: arr(env.v), vForward_m_s: arr(env.vForward), vReverse_m_s: arr(env.vReverse), edgeY: arr(env.edgeY, (y) => (Number.isFinite(y) ? Math.round(y * 10) / 10 : null)), edgeReverseY: arr(env.edgeReverseY, (y) => (Number.isFinite(y) ? Math.round(y * 10) / 10 : null)) },
    result: exportResult(r),
  });
}

mkdirSync(new URL('results/cases/', root), { recursive: true });
for (const c of cases) writeFileSync(new URL(`results/cases/${c.id}.json`, root), JSON.stringify({ settings: { spanMs: params.spanMs, onsetMethod: params.onsetMethod }, ...c }));
const summary = {
  generated: new Date().toISOString(),
  settings: { spanMs: params.spanMs, onsetMethod: params.onsetMethod, bandwidthMs: params.bandwidthMs, bandwidthPerAT: params.bandwidthPerAT, minCorr: params.minCorr },
  note: 'Real cases have no expert ACCmax labels; m/s² values from them are not clinical measurements. Image cases use a provisional calibration.',
  cases: cases.map((c) => {
    const r = c.result;
    return {
      id: c.id,
      group: c.group,
      title: c.title,
      calibration: c.calibration,
      ok: r.ok,
      error: r.error,
      hr_bpm: r.hr_bpm,
      displayedHr_bpm: c.displayedHr_bpm ?? null,
      beats: r.ok ? `${r.nBeats}/${r.beats.length}` : null,
      accmax_m_s2: r.accmax_m_s2,
      accmax68: r.ci?.accmax68 ?? null,
      at_ms: r.at_ms,
      at68_ms: r.ci?.at68_ms ?? null,
      psv_cm_s: r.psv_cm_s,
      accmax_display_px_per_px: r.accmax_display_px_per_px ?? null,
      truth: c.truth ?? null,
      qc: (r.qc ?? []).map((q) => `${q.level}: ${q.message}`),
    };
  }),
};
writeFileSync(new URL('results/summary.json', root), `${JSON.stringify(summary, null, 2)}\n`);
