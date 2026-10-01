// ACCmax Workbench: wires file loading, calibration, analysis, plots,
// draggable calipers and export together. All processing is local.

import { analyze, DEFAULT_PARAMS } from './core/pipeline.js';
import { measureFromPoints, ONSET_METHODS } from './core/landmarks.js';
import { synthesize, truthForBeats, renderSpectrogram, PRESETS } from './core/synthetic.js';
import { parseDelimited, guessUnits, tableToTrace } from './io/csv.js';
import { parseDicom, ultrasoundRegions, spectralCalibration, decodeFrame, imageInfo } from './io/dicom.js';
import { createCalibrator } from './ui/calibrate.js';
import { frame, el, pathD, dotsD, svgPoint, extent } from './ui/plot.js';

const VERSION = '0.1.0';
const $ = (id) => document.getElementById(id);

const SITES = [
  { id: 'pta', label: 'Posterior tibial artery, ankle', pedal: false },
  { id: 'ata', label: 'Anterior tibial artery, ankle', pedal: false },
  { id: 'dpa', label: 'Dorsalis pedis artery', pedal: true },
  { id: 'lpa', label: 'Lateral plantar artery', pedal: true },
  { id: 'mpa', label: 'Medial plantar artery', pedal: true },
  { id: 'p3', label: 'Popliteal artery, P3 segment', pedal: false },
  { id: 'dfa', label: 'Deep femoral artery, proximal', pedal: false },
  { id: 'cfa', label: 'Common femoral artery', pedal: false },
  { id: 'hallux', label: 'Hallux', pedal: false },
  { id: 'brachial', label: 'Brachial artery', pedal: false },
  { id: 'digital', label: 'Digital artery (finger)', pedal: false },
  { id: 'other', label: 'Other or not recorded', pedal: false },
];

const state = {
  trace: null,
  source: null,
  window: null,
  excludedTimes: [],
  hrOverride: null,
  qcExtra: [],
  result: null,
  manual: null,
  view: 'aligned',
  zoom: 'cycle',
  csv: null,
  truth: null,
  realCases: [],
  pendingAutoFit: false,
};

// ---------- formatting ----------
// Fixed decimals without a stray "-0".
const fix = (d) => (x) => (Number.isFinite(x) ? (Number(x.toFixed(d)) || 0).toFixed(d) : '–');
const f0 = fix(0);
const f1 = fix(1);
const f2 = fix(2);
const ms = (s) => s * 1000;
const cms = (v) => v * 100;
const site = () => SITES.find((s) => s.id === $('site').value) ?? SITES[0];
const atName = () => (site().pedal ? 'PAT' : 'AT');
const beatClass = (b, n) => (!b.included ? 'beat-out' : n > 8 ? 'beat-any' : `beat-${(b.index % 8) + 1}`);

// ---------- settings ----------
function initControls() {
  for (const s of SITES) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.label;
    $('site').appendChild(o);
  }
  for (const [k, text] of Object.entries(ONSET_METHODS)) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = text.split(':')[0];
    $('p-onset').appendChild(o);
  }
  $('p-onset').value = DEFAULT_PARAMS.onsetMethod;
  const siteHint = () => {
    $('site-hint').textContent = site().pedal
      ? 'Pedal artery: the acceleration time is reported as PAT.'
      : 'The acceleration time is reported as AT. Choose a pedal artery to report PAT.';
    $('beats-at-h').firstChild.textContent = `${atName()} `;
    renderReadout();
    if (state.result?.ok) drawCalipers();
  };
  $('site').addEventListener('change', siteHint);
  siteHint();
  const onsetHint = () => ($('onset-hint').textContent = ONSET_METHODS[$('p-onset').value]);
  $('p-onset').addEventListener('change', onsetHint);
  onsetHint();
  for (const id of ['p-onset', 'p-span', 'p-bw', 'p-bwat', 'p-hrmin', 'p-hrmax', 'p-nterms', 'p-corr', 'p-boot']) {
    $(id).addEventListener('change', () => {
      if (state.result) run();
    });
  }
  $('run-btn').addEventListener('click', () => run());
}

function readParams() {
  const num = (id, d) => {
    const v = Number($(id).value);
    return Number.isFinite(v) ? v : d;
  };
  return {
    ...DEFAULT_PARAMS,
    onsetMethod: $('p-onset').value,
    spanMs: num('p-span', 20),
    bandwidthMs: num('p-bw', 5),
    bandwidthPerAT: num('p-bwat', 0.15),
    hrMin: num('p-hrmin', 30),
    hrMax: num('p-hrmax', 200),
    nterms: Math.round(num('p-nterms', 3)),
    minCorr: num('p-corr', 0.85),
    bootstrap: Math.round(num('p-boot', 200)),
    window: state.window,
    excludedTimes: state.excludedTimes,
    hrOverride: state.hrOverride,
    qcExtra: state.qcExtra,
  };
}

// ---------- analysis ----------
let runToken = 0;
function run() {
  if (!state.trace) return;
  const token = ++runToken;
  document.querySelector('.flow').classList.add('busy');
  setTimeout(() => {
    if (token !== runToken) return;
    const params = readParams();
    let result;
    try {
      result = analyze(state.trace.t, state.trace.v, params);
    } catch (err) {
      console.error(err);
      result = { ok: false, error: `The analysis stopped with an error: ${err.message}` };
    }
    state.result = result;
    state.manual = null;
    if (state.source?.example && state.source.sim) {
      const upstrokes = result.ok ? result.beats.filter((b) => b.included).map((b) => b.fiducial) : [];
      state.truth = truthForBeats(state.source.sim, state.source.example, upstrokes, { spanMs: params.spanMs, onsetMethod: params.onsetMethod });
    }
    document.querySelector('.flow').classList.remove('busy');
    renderAll();
  }, 16);
}

// A new recording waits for "Run automatic fit"; refinements of a fitted
// recording (window, calibration, settings) fit again straight away.
function setTrace(t, v, source, { qc = [], keepWindow = false, autoFit = false } = {}) {
  state.trace = { t, v };
  state.source = source;
  state.qcExtra = qc;
  if (!keepWindow) {
    state.window = null;
    state.excludedTimes = [];
    state.hrOverride = null;
  }
  state.truth = null;
  $('source-line').textContent = source.label;
  $('full-window-btn').disabled = false;
  $('run-btn').disabled = false;
  if (autoFit || state.pendingAutoFit) {
    state.pendingAutoFit = false;
    run();
  } else {
    state.result = null;
    state.manual = null;
    renderAll();
  }
}

// ---------- loading ----------
function loadExample(kind, { autoFit = false } = {}) {
  if (kind.startsWith('real:')) {
    loadRealCase(kind.slice(5), { autoFit });
    return;
  }
  const hr = Number($('ex-hr').value) || 68;
  const duration = Number($('ex-dur').value) || 6;
  const noise = (Number($('ex-noise').value) || 0) / 100;
  const seed = Number($('ex-seed').value) || 11;
  $('csv-options').hidden = true;
  if (kind === 'screenshot') {
    state.pendingAutoFit = autoFit;
    loadExampleScreenshot({ hr, seed });
    return;
  }
  hideCalibration();
  const preset = kind === 'irregular' ? 'triphasic' : kind;
  const rrSd = kind === 'irregular' ? 0.15 : 0.03;
  const sim = synthesize({ preset, hr, duration, noise, rrSd, seed });
  const label = `Example: ${PRESETS[preset].label.toLowerCase()}${kind === 'irregular' ? ', irregular rhythm' : ''}, ${hr} bpm, ${duration} s, ${f1(noise * 100)} cm/s noise.`;
  setTrace(sim.t, sim.v, { kind: 'example', label, name: `example-${kind}`, example: { preset, hr }, sim }, { autoFit });
}

function loadExampleScreenshot({ hr, seed }) {
  const preset = 'biphasic';
  const sim = synthesize({ preset, hr, duration: 5, noise: 0, seed });
  const cal = { region: { x0: 46, y0: 24, x1: 866, y1: 318 }, baselineY: 262, velPerPx: 0.0025, secPerPx: 0.0045 };
  const img = renderSpectrogram(sim, { width: 920, height: 352, ...cal, seed: seed + 1 });
  // Add scale labels like a scanner display.
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  ctx.fillStyle = '#d8d8d8';
  ctx.font = '12px monospace';
  ctx.textBaseline = 'middle';
  for (let k = -2; k <= 4; k++) {
    const y = cal.baselineY - (k * 0.2) / cal.velPerPx;
    if (y < cal.region.y0 || y > cal.region.y1) continue;
    ctx.fillText(String(k * 20), cal.region.x1 + 14, y);
  }
  ctx.fillText('cm/s', cal.region.x1 + 10, 12);
  ctx.textBaseline = 'top';
  for (let k = 0; k <= 3; k++) ctx.fillText(`${k} s`, cal.region.x0 + k / cal.secPerPx - 6, cal.region.y1 + 14);
  ctx.fillStyle = '#e8c547';
  ctx.fillText('PW  PTA  angle 52°', 10, 6);
  const data = ctx.getImageData(0, 0, img.width, img.height);
  showCalibration();
  state.trace = null;
  state.result = null;
  state.window = null;
  state.excludedTimes = [];
  state.hrOverride = null;
  state.source = { kind: 'image', label: 'Example screenshot: a synthetic spectral display, calibrated from its scale marks.', name: 'example-screenshot', example: { preset, hr }, sim };
  $('source-line').textContent = state.source.label;
  calibrator.setImage({ width: data.width, height: data.height, data: data.data }, null, {
    preset: {
      region: cal.region,
      baselineY: cal.baselineY,
      vMarkY: Math.round(cal.baselineY - 0.6 / cal.velPerPx),
      vMarkValue: 60,
      tMarks: [cal.region.x0, Math.round(cal.region.x0 + 1 / cal.secPerPx)],
      tMarkValue: 1,
    },
  });
}

// Real published cases, served next to the page by the site build
// (scripts/build-site.mjs). Absent when the page runs on its own.
async function loadRealCaseList() {
  try {
    const res = await fetch('cases/cases.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const { cases } = await res.json();
    state.realCases = cases;
    const group = document.createElement('optgroup');
    group.label = 'Real recordings (published, CC BY)';
    for (const c of cases) group.appendChild(Object.assign(document.createElement('option'), { value: `real:${c.id}`, textContent: c.menuLabel }));
    $('example-select').prepend(group);
  } catch {
    // Opened from disk or embedded: only the simulated examples are offered.
  }
}

async function loadRealCase(id, { autoFit = false } = {}) {
  const c = state.realCases.find((q) => q.id === id);
  if (!c) return;
  if (c.site && SITES.some((q) => q.id === c.site)) {
    $('site').value = c.site;
    $('site').dispatchEvent(new Event('change'));
  }
  const qc = [{ level: 'info', message: c.calibrationNote }];
  const label = `${c.label}. ${c.source}`;
  const res = await fetch(c.file);
  if (!res.ok) throw new Error(`Could not load ${c.file}`);
  $('csv-options').hidden = true;
  if (c.kind === 'csv') {
    hideCalibration();
    const table = parseDelimited(await res.text());
    const tr = tableToTrace(table, { tCol: c.columns.t, vCol: c.columns.v, timeUnit: c.units.time, velUnit: c.units.velocity });
    setTrace(tr.t, tr.v, { kind: 'real', label, name: c.id }, { qc, autoFit });
    return;
  }
  const bmp = await createImageBitmap(await res.blob());
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const id2 = ctx.getImageData(0, 0, canvas.width, canvas.height);
  showCalibration();
  state.trace = null;
  state.result = null;
  state.window = null;
  state.excludedTimes = [];
  state.hrOverride = null;
  state.pendingAutoFit = autoFit;
  state.source = { kind: 'real', label, name: c.id, qc };
  $('source-line').textContent = label;
  renderAll();
  calibrator.setImage({ width: id2.width, height: id2.height, data: id2.data }, { ...c.calibration, sourceLabel: 'the scanner overlay in the published figure (provisional)' });
}

async function loadFile(file) {
  const name = file.name;
  const lower = name.toLowerCase();
  try {
    const head = new Uint8Array(await file.slice(0, 132).arrayBuffer());
    const isDicom = (head.length >= 132 && String.fromCharCode(...head.slice(128, 132)) === 'DICM') || /\.(dcm|dicom)$/.test(lower);
    const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|bmp|webp|gif)$/.test(lower);
    if (isDicom) await loadDicom(file);
    else if (isImage) await loadImage(file);
    else await loadCsv(file);
  } catch (err) {
    console.error(err);
    showError(`Could not read ${name}: ${err.message}`);
  }
}

async function loadCsv(file) {
  hideCalibration();
  const table = parseDelimited(await file.text());
  const u = guessUnits(table);
  state.csv = { table, name: file.name };
  const fill = (sel, idx) => {
    sel.replaceChildren(...table.columns.map((c, i) => Object.assign(document.createElement('option'), { value: i, textContent: c })));
    sel.value = String(Math.min(idx, table.columns.length - 1));
  };
  fill($('csv-tcol'), 0);
  fill($('csv-vcol'), 1);
  $('csv-tunit').value = u.timeUnit;
  $('csv-vunit').value = u.velUnit;
  for (const n of document.querySelectorAll('.rate-row')) n.hidden = !u.single;
  for (const id of ['csv-tcol', 'csv-vcol']) $(id).disabled = u.single;
  $('csv-options').hidden = false;
  applyCsv();
}

function applyCsv() {
  if (!state.csv) return;
  const { table, name } = state.csv;
  const tr = tableToTrace(table, {
    tCol: Number($('csv-tcol').value),
    vCol: Number($('csv-vcol').value),
    timeUnit: $('csv-tunit').value,
    velUnit: $('csv-vunit').value,
    sampleRate: Number($('csv-rate').value) || 200,
  });
  const label = `${name}: ${tr.t.length} samples, ${f1(tr.t[tr.t.length - 1] - tr.t[0])} s. Check the units below.`;
  setTrace(tr.t, tr.v, { kind: 'csv', label, name });
}

async function loadImage(file) {
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  $('csv-options').hidden = true;
  showCalibration();
  state.trace = null;
  state.result = null;
  state.source = { kind: 'image', label: `${file.name}: ${c.width} × ${c.height} px image. Calibrate it below.`, name: file.name };
  $('source-line').textContent = state.source.label;
  renderAll();
  calibrator.setImage({ width: id.width, height: id.height, data: id.data }, null);
}

async function loadDicom(file) {
  const dcm = parseDicom(await file.arrayBuffer());
  const info = imageInfo(dcm);
  const regions = ultrasoundRegions(dcm);
  const cal = spectralCalibration(regions);
  const frames = info.frames || 1;
  const frameIndex = frames - 1;
  const img = await decodeFrame(dcm, frameIndex);
  $('csv-options').hidden = true;
  showCalibration();
  const device = [info.manufacturer, info.model].filter(Boolean).join(' ');
  const calText = cal ? 'calibrated from its ultrasound region' : 'no spectral calibration found, calibrate by hand below';
  state.trace = null;
  state.result = null;
  state.source = {
    kind: 'dicom',
    label: `${file.name}: DICOM ${info.modality ?? ''} ${info.columns} × ${info.rows} px${frames > 1 ? `, ${frames} frames` : ''}${device ? `, ${device}` : ''}; ${calText}.`,
    name: file.name,
  };
  $('source-line').textContent = state.source.label;
  renderAll();
  const onFrame = async (i) => {
    const im = await decodeFrame(dcm, i);
    calibrator.setImage(im, cal, { frames, frame: i, onFrame, keepMarks: true });
  };
  calibrator.setImage(img, cal, { frames, frame: frameIndex, onFrame });
}

function showCalibration() {
  $('calib-panel').hidden = false;
}
function hideCalibration() {
  $('calib-panel').hidden = true;
  calibrator.clear();
}

function showError(message) {
  state.result = { ok: false, error: message };
  renderAll();
}

// ---------- calipers ----------
function autoPoints(r) {
  const lm = r.landmarks;
  return { t1: lm.acc.t1, t2: lm.acc.t2, onset: lm.onset.t, peak: lm.peak.t };
}

function currentMeasure() {
  const r = state.result;
  if (!r?.ok) return null;
  if (!state.manual) return { ...r.landmarks, edited: false };
  const m = measureFromPoints(r.template, state.manual);
  return { ...r.landmarks, ...m, valley: r.landmarks.valley, edv: r.landmarks.edv, edited: true };
}

// ---------- rendering ----------
function renderAll() {
  renderReadout();
  renderTrace();
  renderStack();
  renderPeriodogram();
  renderOC();
  renderBeats();
}

const ICONS = {
  warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path class="icon-stroke" d="M8 1.8 15 14H1z"/><path class="icon-stroke" d="M8 6v4M8 11.6v.4"/></svg>',
  info: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle class="icon-stroke" cx="8" cy="8" r="6.3"/><path class="icon-stroke" d="M8 7v4.5M8 4.6v.4"/></svg>',
};

function metric(label, valueHtml, sub = [], extra = '', hero = false) {
  const lines = (Array.isArray(sub) ? sub : [sub]).filter(Boolean);
  return `<article class="metric${hero ? ' hero' : ''}"><span class="label">${label}</span><span class="value">${valueHtml}</span>${lines.length ? `<span class="sub">${lines.map((l) => `<span>${l}</span>`).join('')}</span>` : ''}${extra}</article>`;
}

function renderReadout() {
  const r = state.result;
  $('run-btn').classList.toggle('ready', Boolean(state.trace) && !r);
  const box = $('metrics');
  const qc = $('qc');
  const buttons = ['copy-btn', 'json-btn', 'csv-btn'].map($);
  if (!r) {
    box.innerHTML = '';
    qc.innerHTML = '';
    for (const b of buttons) b.disabled = true;
    $('reset-btn').disabled = true;
    $('readout-sub').textContent = state.trace
      ? 'Recording loaded. Press Run automatic fit.'
      : state.source
        ? 'Calibrate the image in step 1 to get a velocity trace.'
        : 'Load a recording or an example in step 1.';
    return;
  }
  for (const b of buttons) b.disabled = !r.ok;
  $('reset-btn').disabled = !state.manual;
  if (!r.ok) {
    box.innerHTML = '';
    qc.innerHTML = `<li class="error">${ICONS.warn}<span>${r.error}</span></li>`;
    $('readout-sub').textContent = 'No measurement.';
    return;
  }
  const m = currentMeasure();
  const lm = r.landmarks;
  $('readout-sub').textContent = `${site().label} · ${r.nBeats} of ${r.beats.length} beats stacked · window ${f2(r.window[0])}–${f2(r.window[1])} s`;
  const edited = (auto, fmt) => (m.edited ? `<span class="chip edited">edited · fit ${fmt(auto)}</span>` : '');
  const ci = r.ci;
  const accSub = [
    ci ? `68% interval ${f2(ci.accmax.lo68)}–${f2(ci.accmax.hi68)}` : 'interval needs 3 or more beats',
    ci ? `95% interval ${f2(ci.accmax.lo95)}–${f2(ci.accmax.hi95)}` : '',
    r.perBeat.accmax ? `single beats ${f2(r.perBeat.accmax.min)}–${f2(r.perBeat.accmax.max)}` : '',
  ];
  const atSub = [
    ci ? `68% interval ${f0(ms(ci.at.lo68))}–${f0(ms(ci.at.hi68))}` : '',
    ci ? `95% interval ${f0(ms(ci.at.lo95))}–${f0(ms(ci.at.hi95))}` : '',
    r.perBeat.at ? `single beats ${f0(ms(r.perBeat.at.min))}–${f0(ms(r.perBeat.at.max))}` : '',
  ];
  const truth = state.truth;
  const truthLine = (text) => (truth ? `<span class="truth">${text}</span>` : '');
  box.innerHTML = [
    metric(`ACCmax ${edited(lm.accmax, f2)}`, `<b>${f2(m.accmax)}</b> m/s²`, accSub, truthLine(`Example truth ${f2(truth?.accmax)} m/s²`), true),
    metric(`${atName()} ${edited(lm.at, (x) => `${f0(ms(x))} ms`)}`, `<b>${f0(ms(m.at))}</b> ms`, atSub, truthLine(`Example truth ${f0(ms(truth?.at ?? NaN))} ms`)),
    metric('Heart rate', `<b>${f0(r.hr)}</b> bpm`, `RR variation ${Number.isFinite(r.rrCv) ? f0(100 * r.rrCv) + '%' : '–'}`),
    metric('Peak systolic', `<b>${f0(cms(m.psv))}</b> cm/s`, `end-diastolic ${f0(cms(lm.edv))} cm/s`),
    metric('Beats stacked', `<b>${r.nBeats}</b> / ${r.beats.length}`, [`noise ${f1(cms(r.noise))} cm/s`, `smoothing ${f1(ms(r.bandwidth))} ms`]),
  ].join('');
  qc.innerHTML = r.qc.map((q) => `<li class="${q.level}">${ICONS[q.level === 'info' ? 'info' : 'warn']}<span><span class="lvl">${q.level === 'info' ? 'Note' : 'Check'}</span>${q.message}</span></li>`).join('');
}

// Trace plot with window brush.
function renderTrace() {
  const svg = $('trace-svg');
  if (!state.trace) {
    const p = frame(svg, { x: [0, 1], y: [0, 1], height: 200, xFmt: () => '', yFmt: () => '' });
    el('text', { x: p.width / 2, y: 100, class: 'empty-note', 'text-anchor': 'middle' }, p.overlay).textContent = 'No trace yet.';
    return;
  }
  const { t, v } = state.trace;
  const xr = extent(t);
  const yr = extent(Array.from(v, cms), 0.08);
  const p = frame(svg, { x: xr, y: yr, height: 220, xFmt: (x) => `${+x.toFixed(2)}`, yFmt: (y) => f0(y), xLabel: 'time (s)', yLabel: 'cm/s' });
  const r = state.result;
  const win = state.window && r?.ok ? r.window : state.window;
  if (win) {
    el('rect', { x: p.sx(win[0]), y: p.margin.t, width: Math.max(0, p.sx(win[1]) - p.sx(win[0])), height: p.ih, class: 'win-shade' }, p.data);
    for (const w of win) el('line', { x1: p.sx(w), x2: p.sx(w), y1: p.margin.t, y2: p.margin.t + p.ih, class: 'win-edge' }, p.data);
  }
  el('path', { d: pathD(t, Array.from(v, cms), p.sx, p.sy), class: 'line-trace' }, p.data);
  if (r?.ok) {
    const n = r.beats.filter((b) => b.included).length;
    for (const b of r.beats) {
      const x = p.sx(b.fiducial);
      const y = p.margin.t + 1;
      el('path', { d: `M${x - 5} ${y} L${x + 5} ${y} L${x} ${y + 8}Z`, class: `${beatClass(b, n)} marker-ring` }, p.overlay);
    }
  }
  // Brush to choose the window.
  const hit = el('rect', { x: p.margin.l, y: p.margin.t, width: p.iw, height: p.ih, class: 'hit' }, p.overlay);
  let start = null;
  let brush = null;
  hit.addEventListener('pointerdown', (e) => {
    start = svgPoint(svg, e).x;
    hit.setPointerCapture(e.pointerId);
    brush = el('rect', { x: start, y: p.margin.t, width: 0, height: p.ih, class: 'brush' }, p.overlay);
  });
  hit.addEventListener('pointermove', (e) => {
    if (start === null) return;
    const x = Math.min(Math.max(svgPoint(svg, e).x, p.margin.l), p.margin.l + p.iw);
    brush.setAttribute('x', Math.min(start, x));
    brush.setAttribute('width', Math.abs(x - start));
  });
  hit.addEventListener('pointerup', (e) => {
    if (start === null) return;
    const x = Math.min(Math.max(svgPoint(svg, e).x, p.margin.l), p.margin.l + p.iw);
    const a = p.ix(Math.min(start, x));
    const b = p.ix(Math.max(start, x));
    start = null;
    brush?.remove();
    if (Math.abs(p.sx(b) - p.sx(a)) < 12) return;
    state.window = [a, b];
    state.excludedTimes = [];
    run();
  });
}

let stackPlot = null;
function stackRange(r) {
  const fold = state.view === 'fold';
  const tpl = fold ? r.naive.template : r.template;
  const lm = fold && r.naive.landmarks.ok ? r.naive.landmarks : r.landmarks;
  const lo = tpl.x0;
  const hi = tpl.x0 + (tpl.n - 1) * tpl.dx;
  if (state.zoom === 'cycle') return [lo, hi];
  const pts = state.manual ?? autoPoints(r);
  const a = Math.min(lm.valley.t, pts.onset) - 0.09;
  const b = Math.max(lm.peak.t, pts.peak) + 0.14;
  return [Math.max(lo, a), Math.min(hi, b)];
}

function renderStack() {
  const svg = $('stack-svg');
  const r = state.result;
  const legend = $('stack-legend');
  if (!r?.ok) {
    stackPlot = null;
    const p = frame(svg, { x: [0, 1], y: [0, 1], height: 340, xFmt: () => '', yFmt: () => '' });
    el('text', { x: p.width / 2, y: 170, class: 'empty-note', 'text-anchor': 'middle' }, p.overlay).textContent = r ? 'No stack: see the message above.' : 'The stacked beats appear here.';
    legend.innerHTML = '';
    return;
  }
  const fold = state.view === 'fold';
  const xr = stackRange(r);
  const samples = fold ? r.naive : r.stack;
  const tpl = fold ? r.naive.template : r.template;
  const inX = (x) => x >= xr[0] && x <= xr[1];
  const ys = [];
  for (let i = 0; i < samples.tau.length; i++) if (inX(samples.tau[i])) ys.push(cms(samples.v[i]));
  const yr = extent(ys, 0.06);
  const height = Math.max(300, Math.min(420, Math.round((svg.parentElement.clientWidth || 700) * 0.48)));
  const p = frame(svg, {
    x: [ms(xr[0]), ms(xr[1])],
    y: yr,
    height,
    margin: { t: 24, r: 18, b: 40, l: 52 },
    xFmt: (x) => f0(x),
    yFmt: (y) => f0(y),
    xLabel: fold ? 'time from upstroke, fixed-period fold (ms)' : 'time from steepest upstroke (ms)',
    yLabel: 'cm/s',
  });
  stackPlot = { p, r, fold, tpl };
  // Samples, grouped by beat.
  const nIn = r.beats.filter((b) => b.included).length;
  if (fold) {
    el('path', { d: dotsD(Array.from(samples.tau, ms), Array.from(samples.v, cms), p.sx, p.sy, 1.5), class: 'beat-any samples' }, p.data);
  } else {
    const groups = new Map();
    for (let i = 0; i < samples.tau.length; i++) {
      const b = r.beats[samples.beat[i]];
      const cls = beatClass(b, nIn);
      if (!groups.has(cls)) groups.set(cls, { x: [], y: [] });
      const g = groups.get(cls);
      g.x.push(ms(samples.tau[i]));
      g.y.push(cms(samples.v[i]));
    }
    const order = [...groups.keys()].sort((a, b) => (a === 'beat-out' ? -1 : b === 'beat-out' ? 1 : 0));
    for (const cls of order) {
      const g = groups.get(cls);
      el('path', { d: dotsD(g.x, g.y, p.sx, p.sy, 1.6), class: `${cls} samples` }, p.data);
    }
  }
  const tx = Array.from({ length: tpl.n }, (_, i) => ms(tpl.x0 + i * tpl.dx));
  const tv = Array.from(tpl.value, cms);
  el('path', { d: pathD(tx, tv, p.sx, p.sy), class: 'line-template-halo' }, p.data);
  el('path', { d: pathD(tx, tv, p.sx, p.sy), class: 'line-template' }, p.data);
  stackPlot.lines = el('g', {}, p.data);
  stackPlot.calipers = el('g', {}, p.overlay);
  drawCalipers();
  // Legend.
  const keys = [];
  if (!fold) {
    if (nIn <= 8) {
      for (const b of r.beats.filter((q) => q.included)) keys.push(`<span class="key"><i class="sw" style="background:var(--beat-${(b.index % 8) + 1})"></i>beat ${b.index + 1}</span>`);
    } else keys.push(`<span class="key"><i class="sw" style="background:var(--beat-any)"></i>${nIn} beats</span>`);
    if (r.beats.some((b) => !b.included && b.covered)) keys.push('<span class="key"><i class="sw out"></i>left out</span>');
  } else {
    keys.push('<span class="key"><i class="sw" style="background:var(--beat-any)"></i>all samples, folded at a fixed period</span>');
  }
  keys.push('<span class="key"><i class="sw-line"></i>smoothed template</span>');
  keys.push('<span class="key"><i class="sw-dash"></i>ACCmax tangent</span>');
  if (fold && r.naive.landmarks.ok) {
    keys.push(`<span class="key">fold gives ACCmax ${f2(r.naive.landmarks.accmax)} m/s², ${atName()} ${f0(ms(r.naive.landmarks.at))} ms, against ${f2(r.landmarks.accmax)} m/s² and ${f0(ms(r.landmarks.at))} ms beat-aligned</span>`);
  }
  legend.innerHTML = keys.join('');
  $('stack-hint').textContent = fold
    ? 'Read-only comparison: every sample folded at one fixed period, as for a strictly periodic star. Switch to Beat-aligned to edit calipers.'
    : 'Drag the amber calipers along the curve, or focus one and use the arrow keys (Shift for 5 ms steps).';
}

function drawCalipers() {
  if (!stackPlot) return;
  const { p, r, fold, tpl } = stackPlot;
  const g = stackPlot.calipers;
  const gl = stackPlot.lines;
  g.replaceChildren();
  gl.replaceChildren();
  const lm = fold ? r.naive.landmarks : null;
  const m = fold ? lm : currentMeasure();
  if (!m || (fold && !lm.ok)) return;
  const X = (t) => p.sx(ms(t));
  const Y = (v) => p.sy(cms(v));
  const valley = fold ? lm.valley : r.landmarks.valley;
  // Tangent through the two ACC points, extended from the valley level to the peak level.
  const slope = m.accmax;
  if (Number.isFinite(slope) && slope > 0) {
    const tA = m.acc.t1 + (valley.v - m.acc.v1) / slope;
    const tB = m.acc.t1 + (m.peak.v - m.acc.v1) / slope;
    el('line', { x1: X(tA - 0.01), y1: Y(valley.v - 0.01 * slope), x2: X(tB + 0.01), y2: Y(m.peak.v + 0.01 * slope), class: 'tangent' }, gl);
  }
  el('line', { x1: X(valley.t - 0.06), x2: X(m.onset.t + 0.03), y1: Y(valley.v), y2: Y(valley.v), class: 'level' }, gl);
  el('path', { d: `M${X(valley.t)} ${Y(valley.v) - 5} l5 5 l-5 5 l-5 -5z`, class: 'valley-mark' }, g);
  el('text', { x: X(valley.t), y: Y(valley.v) + 20, class: 'cal-label', 'text-anchor': 'middle' }, g).textContent = 'valley';
  // AT bracket below the curve.
  const yb = Math.min(p.margin.t + p.ih - 8, Math.max(Y(valley.v), Y(m.onset.v)) + 26);
  const xa = X(m.onset.t);
  const xb = X(m.peak.t);
  el('path', { d: `M${xa} ${yb - 5} V${yb + 5} M${xa} ${yb} H${xb} M${xb} ${yb - 5} V${yb + 5}`, class: 'bracket' }, g);
  el('text', { x: xb + 8, y: yb + 4, class: 'bracket-label' }, g).textContent = `${atName()} ${f0(ms(m.at))} ms`;
  // ACC readout near the chord.
  const mid = { x: X(0.5 * (m.acc.t1 + m.acc.t2)), y: Y(0.5 * (m.acc.v1 + m.acc.v2)) };
  el('text', { x: mid.x - 14, y: mid.y - 4, class: 'bracket-label', 'text-anchor': 'end' }, g).textContent = `${f2(m.accmax)} m/s²`;

  const pts = fold
    ? { t1: lm.acc.t1, t2: lm.acc.t2, onset: lm.onset.t, peak: lm.peak.t }
    : state.manual ?? autoPoints(r);
  const labels = { onset: 'onset', t1: '1', t2: '2', peak: 'peak' };
  for (const key of ['onset', 't1', 't2', 'peak']) {
    const t = pts[key];
    const v = fold ? (key === 'onset' ? lm.onset.v : key === 'peak' ? lm.peak.v : key === 't1' ? lm.acc.v1 : lm.acc.v2) : interp(tpl, t);
    const hx = X(t);
    const hy = Y(v);
    const h = el('g', { class: `handle${fold ? ' readonly' : ''}${state.manual && !fold ? ' edited' : ''}`, transform: `translate(${hx} ${hy})`, tabindex: fold ? null : 0, role: fold ? null : 'slider', 'aria-label': `${labels[key] === '1' || labels[key] === '2' ? `ACCmax point ${labels[key]}` : labels[key]} caliper, ${f1(ms(t))} ms` }, g);
    el('circle', { r: 13, class: 'hit-area' }, h);
    const arm = 7;
    el('path', { d: `M${-arm} 0H${arm}M0 ${-arm}V${arm}`, class: 'cross-halo' }, h);
    el('path', { d: `M${-arm} 0H${arm}M0 ${-arm}V${arm}`, class: 'cross' }, h);
    const pos = { onset: [-10, -10, 'end'], t1: [10, 14, 'start'], t2: [10, 14, 'start'], peak: [10, -12, 'start'] }[key];
    el('text', { x: pos[0], y: pos[1], class: 'cal-label', 'text-anchor': pos[2] }, h).textContent = labels[key];
    if (!fold) attachDrag(h, key);
  }
}

function interp(tpl, t) {
  const pos = (t - tpl.x0) / tpl.dx;
  const i = Math.max(0, Math.min(tpl.n - 2, Math.floor(pos)));
  const f = pos - i;
  return tpl.value[i] * (1 - f) + tpl.value[i + 1] * f;
}

function setPoint(key, t) {
  const r = state.result;
  const tpl = r.template;
  const lo = tpl.x0 + tpl.dx;
  const hi = tpl.x0 + (tpl.n - 2) * tpl.dx;
  const pts = { ...(state.manual ?? autoPoints(r)) };
  let v = Math.min(Math.max(t, lo), hi);
  if (key === 't1') v = Math.min(v, pts.t2 - 0.001);
  if (key === 't2') v = Math.max(v, pts.t1 + 0.001);
  if (key === 'onset') v = Math.min(v, pts.peak - 0.001);
  if (key === 'peak') v = Math.max(v, pts.onset + 0.001);
  if (!Number.isFinite(interp(tpl, v))) return;
  pts[key] = v;
  state.manual = pts;
  drawCalipers();
  renderReadout();
}

const HANDLE_ORDER = ['onset', 't1', 't2', 'peak'];
let drag = null;

function focusHandle(key) {
  [...(stackPlot?.calipers.querySelectorAll('.handle') ?? [])][HANDLE_ORDER.indexOf(key)]?.focus({ preventScroll: true });
}

function attachDrag(h, key) {
  h.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    // Capture on the SVG: handles are redrawn on every move.
    drag = { key, pointerId: e.pointerId };
    $('stack-svg').setPointerCapture(e.pointerId);
  });
  h.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = (e.shiftKey ? 5 : 0.5) / 1000;
    const pts = state.manual ?? autoPoints(state.result);
    setPoint(key, pts[key] + (e.key === 'ArrowRight' ? step : -step));
    focusHandle(key);
  });
}

function initDrag() {
  const svg = $('stack-svg');
  svg.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId || !stackPlot) return;
    setPoint(drag.key, stackPlot.p.ix(svgPoint(svg, e).x) / 1000);
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const key = drag.key;
    drag = null;
    if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
    focusHandle(key);
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
}

function renderPeriodogram() {
  const svg = $('ls-svg');
  const r = state.result;
  $('hr-auto-btn').hidden = state.hrOverride === null;
  const pg = r?.periodogram;
  if (!pg) {
    const p = frame(svg, { x: [0, 1], y: [0, 1], height: 200, xFmt: () => '', yFmt: () => '' });
    el('text', { x: p.width / 2, y: 100, class: 'empty-note', 'text-anchor': 'middle' }, p.overlay).textContent = 'No periodogram yet.';
    return;
  }
  const bpm = Array.from(pg.freq, (f) => f * 60);
  const pw = Array.from(pg.power);
  const p = frame(svg, { x: [bpm[0], bpm[bpm.length - 1]], y: [0, Math.max(0.2, Math.min(1, Math.max(...pw) * 1.12))], height: 210, xFmt: f0, yFmt: (y) => y.toFixed(1), xLabel: 'heart rate (bpm)', yLabel: 'power' });
  const area = `${pathD(bpm, pw, p.sx, p.sy)}L${p.sx(bpm[bpm.length - 1])} ${p.sy(0)}L${p.sx(bpm[0])} ${p.sy(0)}Z`;
  el('path', { d: area, class: 'area-ls' }, p.data);
  el('path', { d: pathD(bpm, pw, p.sx, p.sy), class: 'line-ls' }, p.data);
  if (r.ok) {
    const hr = r.hr;
    el('line', { x1: p.sx(hr), x2: p.sx(hr), y1: p.margin.t, y2: p.margin.t + p.ih, class: 'chosen-line' }, p.data);
    const right = p.sx(hr) < p.margin.l + p.iw - 90;
    el('text', { x: p.sx(hr) + (right ? 6 : -6), y: p.margin.t + 10, class: 'chosen-label', 'text-anchor': right ? 'start' : 'end' }, p.overlay).textContent = `${f0(hr)} bpm${state.hrOverride ? ' (set)' : ''}`;
  }
  const best = pg.best * 60;
  const bi = bpm.reduce((a, b, i) => (Math.abs(b - best) < Math.abs(bpm[a] - best) ? i : a), 0);
  el('circle', { cx: p.sx(best), cy: p.sy(pw[bi]), r: 4, class: 'beat-any marker-ring' }, p.overlay);
  const hit = el('rect', { x: p.margin.l, y: p.margin.t, width: p.iw, height: p.ih, class: 'hit' }, p.overlay);
  hit.addEventListener('click', (e) => {
    const x = p.ix(svgPoint(svg, e).x);
    // Snap to the local maximum within ±6 bpm.
    let bestI = -1;
    bpm.forEach((b, i) => {
      if (Math.abs(b - x) <= 6 && (bestI < 0 || pw[i] > pw[bestI])) bestI = i;
    });
    if (bestI < 0) return;
    state.hrOverride = bpm[bestI];
    state.excludedTimes = [];
    run();
  });
}

function renderOC() {
  const svg = $('oc-svg');
  const r = state.result;
  const beats = r?.ok ? r.beats.filter((b) => b.covered) : [];
  if (beats.length < 2) {
    const p = frame(svg, { x: [0, 1], y: [-1, 1], height: 210, xFmt: () => '', yFmt: () => '' });
    el('text', { x: p.width / 2, y: 105, class: 'empty-note', 'text-anchor': 'middle' }, p.overlay).textContent = 'Needs at least two beats.';
    return;
  }
  const xs = beats.map((b) => b.fiducial);
  const ys = beats.map((b) => ms(b.oc));
  const lim = Math.max(10, ...ys.map(Math.abs).filter(Number.isFinite)) * 1.25;
  const xr = extent(xs, 0.08);
  const p = frame(svg, { x: xr, y: [-lim, lim], height: 210, xFmt: (x) => `${+x.toFixed(1)}`, yFmt: f0, xLabel: 'upstroke time (s)', yLabel: 'O − C (ms)' });
  const n = r.beats.filter((b) => b.included).length;
  el('path', { d: pathD(xs, ys, p.sx, p.sy), class: 'line-trace', 'stroke-dasharray': '2 3', opacity: 0.6 }, p.data);
  for (const b of beats) {
    el('circle', { cx: p.sx(b.fiducial), cy: p.sy(ms(b.oc)), r: 5, class: `${beatClass(b, n)} marker-ring` }, p.overlay);
  }
  el('text', { x: p.margin.l + p.iw, y: p.margin.t + 10, class: 'dot-label', 'text-anchor': 'end' }, p.overlay).textContent = `RR variation ${Number.isFinite(r.rrCv) ? f0(100 * r.rrCv) : '–'}%`;
}

function renderBeats() {
  const body = $('beats-body');
  const r = state.result;
  if (!r?.ok) {
    body.innerHTML = '';
    return;
  }
  const n = r.beats.filter((b) => b.included).length;
  body.innerHTML = r.beats
    .map((b) => {
      const color = b.included ? `var(--${beatClass(b, n)})` : 'var(--beat-out)';
      const status = b.included ? 'stacked' : b.reason ?? '–';
      return `<tr class="${b.included ? '' : 'out'}">
        <td><span class="beat-id"><i style="background:${color}"></i>${b.index + 1}</span></td>
        <td>${f2(b.fiducial)}</td>
        <td>${f0(ms(b.rr))}</td>
        <td>${f1(ms(b.oc))}</td>
        <td>${Number.isFinite(b.corr) ? b.corr.toFixed(3) : '–'}</td>
        <td>${f2(b.measure?.accmax)}</td>
        <td>${f0(ms(b.measure?.at ?? NaN))}</td>
        <td>${status}</td>
        <td><input type="checkbox" data-t="${b.detected}" ${b.userExcluded ? '' : 'checked'} ${b.covered ? '' : 'disabled'} aria-label="Use beat ${b.index + 1}"></td>
      </tr>`;
    })
    .join('');
  for (const cb of body.querySelectorAll('input[type=checkbox]')) {
    cb.addEventListener('change', () => {
      // Exclusions are matched on the beat's original detection time.
      const t = Number(cb.dataset.t);
      if (cb.checked) state.excludedTimes = state.excludedTimes.filter((x) => Math.abs(x - t) > 0.05);
      else state.excludedTimes = [...state.excludedTimes, t];
      run();
    });
  }
}

// ---------- export ----------
function summaryObject() {
  const r = state.result;
  const m = currentMeasure();
  const auto = r.landmarks;
  const pts = state.manual ?? autoPoints(r);
  return {
    tool: 'ACCmax Workbench',
    version: VERSION,
    exported: new Date().toISOString(),
    source: { kind: state.source?.kind, name: state.source?.name },
    site: { id: site().id, label: site().label, pedal: site().pedal, atLabel: atName() },
    window_s: r.window,
    heartRate_bpm: r.hr,
    beats: { stacked: r.nBeats, detected: r.beats.length, rrVariation: r.rrCv },
    automatic: {
      accmax_m_s2: auto.accmax,
      at_ms: ms(auto.at),
      psv_cm_s: cms(auto.psv),
      edv_cm_s: cms(auto.edv),
      calipers_ms: { onset: ms(auto.onset.t), acc1: ms(auto.acc.t1), acc2: ms(auto.acc.t2), peak: ms(auto.peak.t) },
      interval68: r.ci ? { accmax: [r.ci.accmax.lo68, r.ci.accmax.hi68], at_ms: [ms(r.ci.at.lo68), ms(r.ci.at.hi68)] } : null,
      interval95: r.ci ? { accmax: [r.ci.accmax.lo95, r.ci.accmax.hi95], at_ms: [ms(r.ci.at.lo95), ms(r.ci.at.hi95)] } : null,
    },
    reported: {
      edited: m.edited,
      accmax_m_s2: m.accmax,
      at_ms: ms(m.at),
      calipers_ms: { onset: ms(pts.onset), acc1: ms(pts.t1), acc2: ms(pts.t2), peak: ms(pts.peak) },
    },
    perBeat: r.beats.map((b) => ({ beat: b.index + 1, upstroke_s: b.fiducial, rr_ms: ms(b.rr), oc_ms: ms(b.oc), similarity: b.corr, included: b.included, reason: b.reason, accmax_m_s2: b.measure?.accmax ?? null, at_ms: b.measure ? ms(b.measure.at) : null })),
    settings: (({ window, excludedTimes, qcExtra, ...rest }) => rest)(r.params),
    qc: r.qc.map((q) => `${q.level}: ${q.message}`),
  };
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function baseName() {
  return (state.source?.name ?? 'measurement').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_');
}

function initExport() {
  $('json-btn').addEventListener('click', () => download(`${baseName()}-accmax.json`, JSON.stringify(summaryObject(), null, 2), 'application/json'));
  $('csv-btn').addEventListener('click', () => {
    const s = summaryObject();
    const rows = [
      ['field', 'value'],
      ['site', s.site.label],
      ['reported_accmax_m_s2', s.reported.accmax_m_s2],
      [`reported_${s.site.atLabel.toLowerCase()}_ms`, s.reported.at_ms],
      ['edited', s.reported.edited],
      ['auto_accmax_m_s2', s.automatic.accmax_m_s2],
      [`auto_${s.site.atLabel.toLowerCase()}_ms`, s.automatic.at_ms],
      ['heart_rate_bpm', s.heartRate_bpm],
      ['beats_stacked', s.beats.stacked],
      [],
      ['beat', 'upstroke_s', 'rr_ms', 'oc_ms', 'similarity', 'included', 'accmax_m_s2', 'at_ms'],
      ...s.perBeat.map((b) => [b.beat, b.upstroke_s, b.rr_ms, b.oc_ms, b.similarity, b.included, b.accmax_m_s2, b.at_ms]),
    ];
    const cell = (x) => {
      if (typeof x === 'number') return Number.isFinite(x) ? String(+x.toFixed(4)) : '';
      const t = String(x ?? '');
      return /[",\n]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
    };
    download(`${baseName()}-accmax.csv`, rows.map((r) => r.map(cell).join(',')).join('\n'), 'text/csv');
  });
  $('copy-btn').addEventListener('click', async () => {
    const s = summaryObject();
    const text = `${s.site.label}: ACCmax ${f2(s.reported.accmax_m_s2)} m/s², ${s.site.atLabel} ${f0(s.reported.at_ms)} ms${s.reported.edited ? ' (calipers edited)' : ''}; HR ${f0(s.heartRate_bpm)} bpm; ${s.beats.stacked} beats stacked.`;
    const btn = $('copy-btn');
    const fallback = $('copy-fallback');
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
      fallback.hidden = true;
    } catch {
      fallback.value = text;
      fallback.hidden = false;
      fallback.focus();
      fallback.select();
      btn.textContent = 'Select and copy below';
    }
    setTimeout(() => (btn.textContent = 'Copy results'), 1600);
  });
  $('reset-btn').addEventListener('click', () => {
    state.manual = null;
    renderReadout();
    renderStack();
  });
}

// ---------- wiring ----------
const calibrator = createCalibrator(
  {
    canvas: $('calib-canvas'),
    tools: [...document.querySelectorAll('#calib-panel [data-tool]')],
    vMarkValue: $('c-vval'),
    tMarkValue: $('c-tval'),
    threshold: $('c-thr'),
    thresholdOut: $('c-thr-out'),
    autoBtn: $('c-auto'),
    invert: $('c-invert'),
    ignoreColor: $('c-color'),
    frameField: $('c-frame-field'),
    frameInput: $('c-frame'),
    status: $('calib-status'),
  },
  {
    onTrace: ({ t, v, qc }) => {
      const src = state.source ?? { kind: 'image', label: 'Image', name: 'image' };
      setTrace(t, v, src, { qc: [...qc, ...(src.qc ?? [])], keepWindow: Boolean(state.trace), autoFit: Boolean(state.result?.ok) });
    },
  }
);

function initLoading() {
  $('file-input').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) loadFile(f);
    e.target.value = '';
  });
  const drop = $('drop');
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add('over')));
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) loadFile(f);
  });
  $('example-btn').addEventListener('click', () => loadExample($('example-select').value));
  for (const id of ['csv-tcol', 'csv-vcol', 'csv-tunit', 'csv-vunit', 'csv-rate']) $(id).addEventListener('change', applyCsv);
  $('full-window-btn').addEventListener('click', () => {
    state.window = null;
    state.excludedTimes = [];
    run();
  });
  $('hr-auto-btn').addEventListener('click', () => {
    state.hrOverride = null;
    run();
  });
  for (const b of document.querySelectorAll('[data-view]')) {
    b.addEventListener('click', () => {
      state.view = b.dataset.view;
      for (const o of document.querySelectorAll('[data-view]')) o.setAttribute('aria-pressed', String(o === b));
      renderStack();
    });
  }
  for (const b of document.querySelectorAll('[data-zoom]')) {
    b.addEventListener('click', () => {
      state.zoom = b.dataset.zoom;
      for (const o of document.querySelectorAll('[data-zoom]')) o.setAttribute('aria-pressed', String(o === b));
      renderStack();
    });
  }
  let resizeTimer = null;
  let lastWidth = 0;
  new ResizeObserver((entries) => {
    const w = Math.round(entries[0].contentRect.width);
    if (w === lastWidth) return;
    lastWidth = w;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      renderTrace();
      renderStack();
      renderPeriodogram();
      renderOC();
    }, 120);
  }).observe(document.querySelector('.flow'));
  const scheme = window.matchMedia?.('(prefers-color-scheme: dark)');
  scheme?.addEventListener?.('change', () => calibrator.redraw());
}

initControls();
initLoading();
initExport();
initDrag();
renderAll();
loadRealCaseList().then(() => {
  const preferred = state.realCases.find((c) => c.id === 'anterior_tibial_baseline');
  if (preferred) {
    $('example-select').value = `real:${preferred.id}`;
    loadRealCase(preferred.id, { autoFit: true });
  } else loadExample('triphasic', { autoFit: true });
});
