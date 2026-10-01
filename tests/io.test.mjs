import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDelimited, guessUnits, tableToTrace } from '../web/js/io/csv.js';
import { parseDicom, ultrasoundRegions, spectralCalibration, decodeUncompressed, imageInfo } from '../web/js/io/dicom.js';
import { extractEnvelope } from '../web/js/io/envelope.js';
import { synthesize, syntheticTruth, renderSpectrogram, cleanSignal } from '../web/js/core/synthetic.js';
import { analyze } from '../web/js/core/pipeline.js';
import { spectralDicom } from '../scripts/lib/dicom-writer.mjs';

test('CSV: comma file with header, seconds and m/s', () => {
  const tbl = parseDelimited('time_s,velocity_m_s\n0,0.1\n0.005,0.2\n0.010,0.3\n');
  assert.deepEqual(tbl.columns, ['time_s', 'velocity_m_s']);
  assert.equal(tbl.rows.length, 3);
  const u = guessUnits(tbl);
  assert.equal(u.timeUnit, 's');
  assert.equal(u.velUnit, 'm/s');
});

test('CSV: semicolon file with decimal commas, ms and cm/s', () => {
  const tbl = parseDelimited('t;v\n0;10,5\n4;22,1\n8;35,0\n12;40,2\n');
  assert.equal(tbl.decimalComma, true);
  const u = guessUnits(tbl);
  assert.equal(u.timeUnit, 'ms');
  assert.equal(u.velUnit, 'cm/s');
  const tr = tableToTrace(tbl, u);
  assert.ok(Math.abs(tr.t[1] - 0.004) < 1e-12);
  assert.ok(Math.abs(tr.v[1] - 0.221) < 1e-12);
});

test('CSV: single column with a sample rate', () => {
  const tbl = parseDelimited('0.1\n0.2\n0.3\n');
  const tr = tableToTrace(tbl, { sampleRate: 200 });
  assert.ok(Math.abs(tr.t[2] - 0.01) < 1e-12);
});

test('DICOM spectral capture → calibration → envelope → ACCmax/AT', () => {
  const c = { preset: 'triphasic', hr: 66 };
  const sim = synthesize({ ...c, duration: 4.2, seed: 12 });
  const img = renderSpectrogram(sim, { secPerPx: 0.0045 });
  const cal = img.calibration;
  const file = spectralDicom(img, cal, { dopplerAngle: 58 });

  const dcm = parseDicom(file.buffer);
  assert.equal(imageInfo(dcm).columns, img.width);
  const regions = ultrasoundRegions(dcm);
  assert.equal(regions.length, 1);
  const calib = spectralCalibration(regions);
  assert.ok(calib);
  assert.ok(Math.abs(calib.baselineY - cal.baselineY) < 1e-9);
  assert.ok(Math.abs(calib.velPerPx - cal.velPerPx) < 1e-12);
  assert.equal(calib.dopplerAngle, 58);

  const frame = decodeUncompressed(dcm, 0);
  const env = extractEnvelope(frame, calib);
  // Envelope error against the noise-free envelope, in pixels.
  let err = 0;
  let n = 0;
  for (let i = 0; i < env.t.length; i++) {
    const truthV = cleanSignal(sim, env.t[i]);
    if (Math.abs(truthV) < 0.05) continue;
    // The signed envelope follows forward flow above and reverse flow below the baseline.
    err += ((env.v[i] - truthV) / cal.velPerPx) ** 2;
    n++;
  }
  const rmsPx = Math.sqrt(err / n);
  assert.ok(rmsPx < 3, `envelope RMS error ${rmsPx.toFixed(2)} px`);

  const truth = syntheticTruth(c);
  const r = analyze(env.t, env.v, { bootstrap: 0 });
  assert.ok(r.ok, r.error);
  assert.ok(Math.abs(r.landmarks.accmax / truth.accmax - 1) < 0.12, `ACCmax ${r.landmarks.accmax} vs ${truth.accmax}`);
  assert.ok(Math.abs(r.landmarks.at - truth.at) < 0.012, `AT ${r.landmarks.at} vs ${truth.at}`);
});
