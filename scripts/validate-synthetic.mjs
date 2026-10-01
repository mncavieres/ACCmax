// Monte Carlo check of the automated measurement against synthetic waveforms
// with known ground truth.
//
// For every scenario it compares four estimators of ACCmax and AT:
//   stacked   beat-aligned stack (the proposed method)
//   fold      plain fixed-period phase fold (no per-beat alignment)
//   1 beat    one randomly chosen beat, as in a single manual measurement
//   beat avg  mean of the single-beat measurements
// and prints the median error (bias) and the robust spread (1.4826 × MAD).
//
//   node scripts/validate-synthetic.mjs [--runs 40] [--coverage]

import { synthesize, syntheticTruth } from '../web/js/core/synthetic.js';
import { analyze, DEFAULT_PARAMS } from '../web/js/core/pipeline.js';
import { median, mad, rng } from '../web/js/core/stats.js';

const args = process.argv.slice(2);
const runs = Number(args[args.indexOf('--runs') + 1]) || 40;
const coverage = args.includes('--coverage');

const allScenarios = [
  { name: 'triphasic, regular, 4 s', preset: 'triphasic', hr: 70, duration: 4, noise: 0.02 },
  { name: 'triphasic, regular, 8 s', preset: 'triphasic', hr: 70, duration: 8, noise: 0.02 },
  { name: 'triphasic, noisy, 8 s', preset: 'triphasic', hr: 70, duration: 8, noise: 0.045 },
  { name: 'triphasic, AF-like RR, 8 s', preset: 'triphasic', hr: 85, duration: 8, noise: 0.02, rrSd: 0.15 },
  { name: 'biphasic, regular, 6 s', preset: 'biphasic', hr: 65, duration: 6, noise: 0.02 },
  { name: 'monophasic, regular, 6 s', preset: 'monophasic', hr: 65, duration: 6, noise: 0.005 },
  { name: 'monophasic, noisy, 8 s', preset: 'monophasic', hr: 65, duration: 8, noise: 0.01 },
  { name: 'monophasic, AF-like RR, 8 s', preset: 'monophasic', hr: 85, duration: 8, noise: 0.005, rrSd: 0.15 },
];

const only = args.find((a) => a.startsWith('--only='))?.slice(7);
const scenarios = only ? allScenarios.filter((s) => s.name.includes(only)) : allScenarios;

const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const stat = (errs) => {
  const e = errs.filter(Number.isFinite);
  return { bias: median(e), spread: 1.4826 * mad(e), n: e.length };
};

const params = { ...DEFAULT_PARAMS, bootstrap: coverage ? 200 : 0 };
for (const a of args) {
  const m = /^--(\w+)=(.+)$/.exec(a);
  if (m) params[m[1]] = Number.isNaN(Number(m[2])) ? m[2] : Number(m[2]);
}
console.log(`ACCmax error in % of truth; AT error in ms. ${runs} runs per scenario.`);
console.log(`span ${params.spanMs} ms, bandwidth ${params.bandwidthMs} ms (≥ ${params.bandwidthPerAT} × AT), onset ${params.onsetMethod}\n`);
const header = ['scenario', 'truth', 'stacked', 'fold', '1 beat', 'beat avg', 'fails'];
console.log(header.join(' | '));

for (const sc of scenarios) {
  const truth = syntheticTruth(sc, { spanMs: params.spanMs, onsetMethod: params.onsetMethod });
  const pick = rng(99);
  const e = { acc: { s: [], f: [], o: [], a: [] }, at: { s: [], f: [], o: [], a: [] } };
  let fails = 0;
  let covAcc = 0;
  let covAt = 0;
  let covN = 0;
  for (let k = 0; k < runs; k++) {
    const sim = synthesize({ ...sc, seed: 1000 + k });
    const r = analyze(sim.t, sim.v, params);
    if (!r.ok) {
      fails++;
      continue;
    }
    const rel = (x) => (100 * (x - truth.accmax)) / truth.accmax;
    const ms = (x) => 1000 * (x - truth.at);
    e.acc.s.push(rel(r.landmarks.accmax));
    e.at.s.push(ms(r.landmarks.at));
    if (r.naive.landmarks.ok) {
      e.acc.f.push(rel(r.naive.landmarks.accmax));
      e.at.f.push(ms(r.naive.landmarks.at));
    }
    const measured = r.beats.filter((b) => b.included && b.measure);
    if (measured.length) {
      const one = measured[Math.floor(pick() * measured.length)].measure;
      e.acc.o.push(rel(one.accmax));
      e.at.o.push(ms(one.at));
    }
    e.acc.a.push(rel(r.perBeat.accmax?.mean));
    e.at.a.push(ms(r.perBeat.at?.mean));
    if (coverage && r.ci) {
      covN++;
      if (truth.accmax >= r.ci.accmax.lo68 && truth.accmax <= r.ci.accmax.hi68) covAcc++;
      if (truth.at >= r.ci.at.lo68 && truth.at <= r.ci.at.hi68) covAt++;
    }
  }
  const cell = (errs, d) => {
    const s = stat(errs);
    return `${s.bias >= 0 ? '+' : ''}${fmt(s.bias, d)} ± ${fmt(s.spread, d)}`;
  };
  console.log(
    [
      sc.name,
      `ACCmax ${fmt(truth.accmax, 2)} m/s²`,
      cell(e.acc.s),
      cell(e.acc.f),
      cell(e.acc.o),
      cell(e.acc.a),
      fails,
    ].join(' | ')
  );
  console.log(
    ['', `AT ${fmt(truth.at * 1000, 0)} ms`, cell(e.at.s, 0), cell(e.at.f, 0), cell(e.at.o, 0), cell(e.at.a, 0), ''].join(' | ')
  );
  if (coverage) console.log(`   68% interval coverage: ACCmax ${fmt((100 * covAcc) / covN, 0)}%, AT ${fmt((100 * covAt) / covN, 0)}% (n=${covN})`);
}
