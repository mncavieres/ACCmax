// Image calibration panel. An image is calibrated automatically when it is
// opened (io/autocal.js): the velocity scale, baseline, time marks and
// display region are found and drawn over the image with labels, and listed
// below it. The marks it places are the same ones a user sets by hand (the
// display region, the baseline, one labelled velocity mark and two time
// marks), so any of them can be corrected with the tools. DICOM files with
// an ultrasound region calibration use that instead.

import { extractEnvelope, regionStats, autoThreshold } from '../io/envelope.js';

// Overlay colours: drawn on the (always dark) image, so fixed rather than
// themed. The swatches in the list below the image use the same values.
export const OVERLAY = {
  region: '#43b8cc',
  scale: '#ffd166',
  time: '#ff8fb1',
  ignored: '#8aa0ab',
  forward: '#ff9f1c',
  reverse: '#43b8cc',
  manual: '#ffd166',
};

const f = (x, d) => (Number.isFinite(x) ? (Number(x.toFixed(d)) || 0).toFixed(d) : '–');
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function createCalibrator(ui, { onTrace, onStatus }) {
  const { canvas, tools, vMarkValue, tMarkValue, threshold, thresholdOut, autoBtn, invert, ignoreColor, frameField, frameInput, status, found } = ui;
  const ctx = canvas.getContext('2d');
  const base = document.createElement('canvas');
  const s = {
    img: null,
    tool: 'region',
    region: null,
    baselineY: null,
    vMarkY: null,
    tMarks: [],
    dicomCal: null,
    useDicom: false,
    auto: null,
    autoMarks: null,
    drag: null,
    envelope: null,
    autoThr: true,
    onFrame: null,
  };

  function setTool(name) {
    s.tool = name;
    for (const b of tools) b.setAttribute('aria-pressed', String(b.dataset.tool === name));
  }
  for (const b of tools) b.addEventListener('click', () => setTool(b.dataset.tool));

  // Whether the marks are still the ones the automatic calibration placed
  // (complete or not), and whether they are complete too.
  function asPlaced() {
    const a = s.autoMarks;
    if (!a) return false;
    return (
      s.region === a.region &&
      s.baselineY === a.baselineY &&
      s.vMarkY === a.vMarkY &&
      s.tMarks.length === a.tMarks.length &&
      s.tMarks.every((x, i) => x === a.tMarks[i]) &&
      (a.vMarkY === null || Number(vMarkValue.value) === a.vMarkValue) &&
      (a.tMarks.length < 2 || Number(tMarkValue.value) === a.tMarkValue)
    );
  }
  const untouched = () => asPlaced() && s.tMarks.length === 2 && s.vMarkY !== null;

  function calibration() {
    if (s.useDicom && s.dicomCal) return s.dicomCal;
    const vVal = Number(vMarkValue.value);
    const tVal = Number(tMarkValue.value);
    if (!s.region || s.baselineY === null || s.vMarkY === null || s.tMarks.length < 2) return null;
    if (s.vMarkY === s.baselineY || s.tMarks[0] === s.tMarks[1] || !vVal || !tVal) return null;
    const auto = untouched();
    return {
      region: s.region,
      baselineY: s.baselineY,
      velPerPx: vVal / 100 / (s.baselineY - s.vMarkY),
      secPerPx: tVal / Math.abs(s.tMarks[1] - s.tMarks[0]),
      tOffset: 0,
      source: auto ? 'auto' : s.autoMarks ? 'adjusted' : 'manual',
      ...(auto && s.auto?.calibration?.ignoreColumns ? { ignoreColumns: s.auto.calibration.ignoreColumns } : {}),
    };
  }

  function nextStep() {
    if (s.useDicom && s.dicomCal) return null;
    const missing = s.auto && !s.auto.ok ? ' (not found automatically)' : '';
    if (!s.region) return { tool: 'region', text: `Drag a box around the spectral Doppler display${missing}.` };
    if (s.baselineY === null) return { tool: 'baseline', text: `Click the baseline (0 cm/s)${missing}.` };
    if (s.vMarkY === null) return { tool: 'vmark', text: `Click a labelled velocity mark and enter its value${missing}.` };
    if (s.tMarks.length < 2) return { tool: 'tmark', text: `Click ${s.tMarks.length ? 'the second' : 'two'} time mark${s.tMarks.length ? '' : 's'} and enter the time between them${missing}.` };
    return null;
  }

  // ---------- drawing ----------

  function draw() {
    if (!s.img) return;
    ctx.drawImage(base, 0, 0);
    // Pixels of the image per pixel on screen: line widths and text are
    // sized for the displayed size.
    // On a small screen the image is shrunk a lot: cap the overlay's size
    // so it does not cover the image.
    const shown = canvas.getBoundingClientRect().width || canvas.width;
    const k = Math.min(canvas.width / shown, canvas.height / 260);
    const lw = Math.max(1, 1.2 * k);
    const cal = calibration();
    const region = cal?.region ?? s.region ?? s.drag?.rect;
    const auto = s.auto && (asPlaced() || !s.autoMarks) ? s.auto : null;
    const fnd = auto?.found;
    const x0 = region ? region.x0 : 0;
    const x1 = region ? region.x1 : canvas.width;

    // Overlays kept out of the display region.
    if (fnd) {
      ctx.setLineDash([4 * k, 3 * k]);
      ctx.strokeStyle = OVERLAY.ignored;
      ctx.lineWidth = lw;
      const boxes = [...(fnd.ecg ? [{ ...fnd.ecg, name: 'ECG' }] : []), ...(fnd.text ?? []).map((t) => ({ ...t, name: '' }))];
      for (const b of boxes) ctx.strokeRect(b.x0 - 2, b.y0 - 2, b.x1 - b.x0 + 4, b.y1 - b.y0 + 4);
      ctx.setLineDash([]);
      if (fnd.ecg) label('ECG, ignored', fnd.ecg.x0 + 4 * k, fnd.ecg.y1 + 2 * k, OVERLAY.ignored, k, 'top');
    }

    if (region) {
      ctx.strokeStyle = OVERLAY.region;
      ctx.lineWidth = lw * 1.5;
      ctx.setLineDash([]);
      ctx.strokeRect(region.x0 + 0.5, region.y0 + 0.5, region.x1 - region.x0, region.y1 - region.y0);
      if (fnd) label('spectral display', region.x0 + 4 * k, region.y0 + 3 * k, OVERLAY.region, k, 'top');
    }
    const baseY = cal ? cal.baselineY : s.baselineY;
    if (baseY !== null && baseY !== undefined) {
      ctx.strokeStyle = OVERLAY.region;
      ctx.lineWidth = lw;
      ctx.setLineDash([6 * k, 4 * k]);
      ctx.beginPath();
      ctx.moveTo(x0, baseY + 0.5);
      ctx.lineTo(x1, baseY + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      if (fnd) label('baseline', x0 + 4 * k, baseY - 3 * k, OVERLAY.region, k, 'bottom');
    }

    if (fnd?.scale) {
      // Every tick found; the labels as read, next to the long ticks.
      for (const t of fnd.scale.ticks) {
        ctx.strokeStyle = OVERLAY.scale;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.arc((t.x0 + t.x1) / 2, t.y, Math.max(3 * k, (t.x1 - t.x0) / 2 + 2), 0, 2 * Math.PI);
        ctx.stroke();
      }
      const used = new Set((fnd.labels?.points ?? []).map((p) => p.word));
      for (const w of fnd.labels?.words ?? []) {
        if (!w.text) continue;
        const ok = used.has(w);
        const p = (fnd.labels.points ?? []).find((q) => q.word === w);
        const text = ok ? (p.unitLabel ? `0 (${fnd.labels.unit})` : w.text) : `${w.text}?`;
        const side = fnd.scale.side === 'right';
        label(text, side ? w.tick.x0 - 6 * k : w.tick.x1 + 6 * k, w.tick.y, ok ? OVERLAY.scale : OVERLAY.ignored, k, 'middle', side ? 'right' : 'left', true);
      }
    }

    if (fnd?.time) {
      ctx.fillStyle = OVERLAY.time;
      ctx.strokeStyle = OVERLAY.time;
      ctx.lineWidth = lw;
      const sz = 4 * k;
      if (fnd.time.kind === 'timeline') {
        const y = Math.max(fnd.time.top - 2 * k, sz * 2);
        for (const m of fnd.time.marks) {
          ctx.beginPath();
          ctx.moveTo(m.x - sz, y - 2 * sz);
          ctx.lineTo(m.x + sz, y - 2 * sz);
          ctx.lineTo(m.x, y - sz * 0.6);
          ctx.closePath();
          ctx.fill();
        }
        const last = fnd.time.marks[fnd.time.marks.length - 1];
        label(`${f(fnd.time.step * 1000, 0)} ms per mark`, last.x - 6 * k, y - 2.4 * sz, OVERLAY.time, k, 'bottom', 'right');
      } else {
        ctx.setLineDash([2 * k, 3 * k]);
        for (const l of fnd.time.lines) {
          ctx.beginPath();
          ctx.moveTo(l.x, region ? region.y0 : 0);
          ctx.lineTo(l.x, region ? region.y1 : canvas.height);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        const l0 = fnd.time.lines[0];
        label('1 s between lines', l0.x + 5 * k, (region ? region.y0 : 0) + 18 * k, OVERLAY.time, k, 'top');
      }
    }

    // Hand-set marks (shown when no automatic overlay explains them).
    if (!s.useDicom && !auto) {
      ctx.strokeStyle = OVERLAY.manual;
      ctx.lineWidth = lw;
      if (s.vMarkY !== null) {
        ctx.beginPath();
        ctx.moveTo(x0, s.vMarkY + 0.5);
        ctx.lineTo(x1, s.vMarkY + 0.5);
        ctx.stroke();
      }
      for (const x of s.tMarks) {
        ctx.beginPath();
        ctx.moveTo(x + 0.5, region ? region.y0 : 0);
        ctx.lineTo(x + 0.5, region ? region.y1 : canvas.height);
        ctx.stroke();
      }
    }

    const env = s.envelope;
    if (env && cal) {
      // Reverse-flow edge thin, forward edge bold.
      for (const [edges, color, width] of [
        [env.edgeReverseY, OVERLAY.reverse, lw],
        [env.edgeY, OVERLAY.forward, lw * 1.6],
      ]) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        let pen = false;
        for (let c = 0; c < edges.length; c++) {
          const y = edges[c];
          if (!Number.isFinite(y)) {
            pen = false;
            continue;
          }
          const x = cal.region.x0 + c;
          if (pen) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
          pen = true;
        }
        ctx.stroke();
      }
    }
  }

  // Text with a dark plate behind it, readable on any part of the image.
  function label(text, x, y, color, k, baseline = 'middle', align = 'left', plate = false) {
    const size = 12 * k;
    ctx.font = `600 ${size}px "IBM Plex Sans", system-ui, sans-serif`;
    ctx.textBaseline = baseline;
    ctx.textAlign = align;
    const w = ctx.measureText(text).width;
    const pad = 3 * k;
    const bx = align === 'right' ? x - w - pad : x - pad;
    const by = baseline === 'top' ? y - pad / 2 : baseline === 'bottom' ? y - size - pad / 2 : y - size / 2 - pad / 2;
    ctx.fillStyle = plate ? 'rgba(0,0,0,0.78)' : 'rgba(0,0,0,0.6)';
    ctx.fillRect(bx, by, w + 2 * pad, size + pad);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  // ---------- what was found ----------

  function renderFound() {
    if (!found) return;
    const a = s.auto;
    const cal = calibration();
    if (!s.img || (!a && !(s.useDicom && s.dicomCal))) {
      found.innerHTML = '';
      found.hidden = true;
      return;
    }
    found.hidden = false;
    if (s.useDicom && s.dicomCal) {
      found.innerHTML = row(OVERLAY.region, 'Calibration', `From the DICOM ultrasound region (${esc(s.dicomCal.dataType ?? 'spectral')}): ${f(Math.abs(s.dicomCal.velPerPx) * 100, 3)} cm/s and ${f(s.dicomCal.secPerPx * 1000, 3)} ms per pixel.`);
      return;
    }
    const fnd = a.found;
    const rows = [];
    const edited = s.autoMarks && !asPlaced();
    if (a.match) {
      const m = a.match;
      const sub = m.subtitle.replace(' (figure panel)', '');
      rows.push(row(null, 'Recognised', `${esc(m.label)}; ${esc(sub.charAt(0).toLowerCase() + sub.slice(1))}: the published example image${m.scale !== 1 ? `, resized ${f(m.scale * 100, 0)}%` : ''}. ${esc(m.source)}${m.displayedHr ? ` The scanner shows ${m.displayedHr} bpm.` : ''}`));
    }
    if (fnd.scale) {
      const lab = fnd.labels;
      const read = (lab?.words ?? []).filter((w) => w.text).map((w) => {
        const p = (lab.points ?? []).find((q) => q.word === w);
        return p ? (p.unitLabel ? `${esc(lab.unit)} (0)` : esc(w.text)) : `<s>${esc(w.text)}</s>`;
      });
      const pxPer = lab?.ok ? Math.abs(lab.pxPerCmS) : null;
      const dir = lab?.ok ? (lab.pxPerCmS < 0 ? 'positive velocities upwards' : 'positive velocities downwards (inverted display)') : '';
      rows.push(
        row(
          OVERLAY.scale,
          'Velocity scale',
          `${fnd.scale.ticks.length} tick marks ${fnd.scale.side === 'right' ? 'right' : 'left'} of the display; labels read ${read.join(', ') || 'none'}${lab?.unitInferred ? ' (no unit printed: cm/s assumed)' : ''}.` +
            (lab?.ok ? ` <b>${f(1 / pxPer, 3)} cm/s per pixel</b> (${f(pxPer, 2)} px per cm/s, labels within ${f(lab.rms, 1)} px of a straight line); ${dir}.` : ` <b>Not usable:</b> ${esc(lab?.reason ?? 'no labels')}.`)
        )
      );
    } else rows.push(row(OVERLAY.scale, 'Velocity scale', '<b>Not found.</b> Set a velocity mark by hand.'));
    const b = fnd.baseline;
    if (b) {
      const off = Number.isFinite(b.zeroY) && b.from === 'line' ? `, ${f(Math.abs(b.y - b.zeroY), 1)} px from the scale's zero` : '';
      rows.push(row(OVERLAY.region, 'Baseline', b.from === 'line' ? `Horizontal line at row ${f(b.y, 1)}${off}.` : `No line drawn: the scale's zero, row ${f(b.y, 1)}.`));
    } else rows.push(row(OVERLAY.region, 'Baseline', '<b>Not found.</b> Click it by hand.'));
    if (fnd.time) {
      const t = fnd.time;
      const n = t.kind === 'timeline' ? t.marks.length : t.lines.length;
      const what = t.kind === 'timeline' ? `${n} timeline marks ${f(t.spacing, 2)} px apart` : `${n} dotted grid lines ${f(t.spacing, 1)} px apart`;
      rows.push(row(OVERLAY.time, 'Time scale', `${what}; assumed ${esc(t.assumption)}. <b>${f((t.step / t.spacing) * 1000, 3)} ms per pixel.</b>`));
    } else rows.push(row(OVERLAY.time, 'Time scale', a.found.match ? 'Not found on the image: taken from the reference calibration of the recognised example.' : '<b>Not found.</b> Click two time marks and enter the time between them.'));
    const r = fnd.region;
    if (r) rows.push(row(OVERLAY.region, 'Display region', `x ${r.x0}–${r.x1}, y ${r.y0}–${r.y1} px${r.why.length ? `; ${esc(r.why.join(', '))}` : ''}.`));
    if (fnd.ecg || fnd.text?.length) rows.push(row(OVERLAY.ignored, 'Ignored', [fnd.ecg ? 'ECG trace' : '', fnd.text?.length ? `${fnd.text.length} line${fnd.text.length > 1 ? 's' : ''} of on-screen text` : ''].filter(Boolean).join(' and ') + ', kept out of the display region.'));
    if (s.envelope) rows.push(row(OVERLAY.forward, 'Envelope', `Outer edge traced at grey level ${s.envelope.threshold}: forward flow (bold), reverse flow (thin).`));
    if (a.match && cal) {
      const ref = a.match.calibration;
      const dv = Math.abs(cal.velPerPx) / (Math.abs(ref.velPerPx) / a.match.scale) - 1;
      const dt = cal.secPerPx / (ref.secPerPx / a.match.scale) - 1;
      rows.push(row(null, 'Check', `Against the reference calibration of this example: velocity scale ${dv >= 0 ? '+' : ''}${f(dv * 100, 1)}%, time scale ${dt >= 0 ? '+' : ''}${f(dt * 100, 1)}%.`));
    }
    for (const c of a.checks) rows.push(row(null, c.level === 'warn' ? 'Check' : 'Note', esc(c.message), c.level));
    if (edited) rows.unshift(row(null, 'Adjusted', 'You changed the automatic marks; the calibration below uses your marks.', 'warn'));
    found.innerHTML = rows.join('');
  }

  function row(color, name, html, level = '') {
    const sw = color ? `<i class="sw" style="background:${color}"></i>` : '<i class="sw none"></i>';
    return `<li class="${level}">${sw}<span class="name">${name}</span><span class="what">${html}</span></li>`;
  }

  function updateStatus() {
    const step = nextStep();
    const cal = calibration();
    if (step) {
      setTool(step.tool);
      status.textContent = step.text;
      status.dataset.state = 'todo';
      if (ui.adjust) ui.adjust.open = true;
    } else if (cal) {
      const scale = `${(Math.abs(cal.velPerPx) * 100).toFixed(3)} cm/s and ${(cal.secPerPx * 1000).toFixed(3)} ms per pixel`;
      status.textContent =
        cal.source === 'auto'
          ? `Calibrated automatically from the image: ${scale}.`
          : cal.source === 'adjusted'
            ? `Calibrated with your adjustments: ${scale}.`
            : cal.source === 'manual'
              ? `Calibrated by hand: ${scale}.`
              : cal.sourceLabel
                ? `Calibrated from ${cal.sourceLabel}: ${scale}.`
                : `Calibrated from the DICOM ultrasound region (${cal.dataType}): ${scale}.`;
      status.dataset.state = 'done';
    }
    renderFound();
  }

  let extractTimer = null;
  function extract(delay = 0) {
    clearTimeout(extractTimer);
    extractTimer = setTimeout(() => {
      const cal = calibration();
      if (!cal || !s.img) {
        s.envelope = null;
        updateStatus();
        draw();
        return;
      }
      if (s.autoThr) {
        const st = regionStats(s.img, { region: cal.region, baselineY: cal.baselineY });
        threshold.value = String(autoThreshold(st));
      }
      thresholdOut.textContent = threshold.value;
      s.envelope = extractEnvelope(s.img, cal, {
        threshold: Number(threshold.value),
        invert: invert.checked,
        ignoreColor: ignoreColor.checked ? 'auto' : false,
      });
      updateStatus();
      draw();
      const qc = [];
      if (s.envelope.clippedFraction > 0.01) {
        qc.push({ level: 'warn', message: `The forward envelope reaches the edge of the traced region in ${(s.envelope.clippedFraction * 100).toFixed(0)}% of columns. If that edge is the end of the velocity scale, this is possible aliasing: raise the scale (PRF) or move the baseline when recording.` });
      }
      if (cal.dopplerAngle > 60) {
        qc.push({ level: 'warn', message: `Doppler angle ${cal.dopplerAngle.toFixed(0)}° is above 60°. Velocities, and therefore ACCmax, are less reliable.` });
      }
      onTrace({ t: s.envelope.t, v: s.envelope.v, qc, calibration: cal });
    }, delay);
  }

  // ---------- pointer tools ----------

  function toImage(evt) {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.round(((evt.clientX - r.left) / r.width) * canvas.width),
      y: Math.round(((evt.clientY - r.top) / r.height) * canvas.height),
    };
  }

  canvas.addEventListener('pointerdown', (evt) => {
    if (!s.img) return;
    const p = toImage(evt);
    canvas.setPointerCapture(evt.pointerId);
    if (s.tool === 'region') {
      s.drag = { start: p, rect: { x0: p.x, y0: p.y, x1: p.x, y1: p.y } };
      return;
    }
    s.useDicom = false;
    if (s.tool === 'baseline') s.baselineY = p.y;
    if (s.tool === 'vmark') s.vMarkY = p.y;
    if (s.tool === 'tmark') s.tMarks = s.tMarks.length >= 2 ? [p.x] : [...s.tMarks, p.x];
    extract();
  });
  canvas.addEventListener('pointermove', (evt) => {
    if (!s.drag) return;
    const p = toImage(evt);
    const a = s.drag.start;
    s.drag.rect = { x0: Math.min(a.x, p.x), y0: Math.min(a.y, p.y), x1: Math.max(a.x, p.x), y1: Math.max(a.y, p.y) };
    draw();
  });
  canvas.addEventListener('pointerup', () => {
    if (!s.drag) return;
    const r = s.drag.rect;
    s.drag = null;
    if (r.x1 - r.x0 > 20 && r.y1 - r.y0 > 20) {
      s.useDicom = false;
      s.region = {
        x0: Math.max(0, r.x0),
        y0: Math.max(0, r.y0),
        x1: Math.min(canvas.width - 1, r.x1),
        y1: Math.min(canvas.height - 1, r.y1),
      };
    }
    extract();
  });

  threshold.addEventListener('input', () => {
    s.autoThr = false;
    thresholdOut.textContent = threshold.value;
    extract(120);
  });
  autoBtn.addEventListener('click', () => {
    s.autoThr = true;
    extract();
  });
  for (const c of [invert, ignoreColor]) c.addEventListener('change', () => extract());
  for (const i of [vMarkValue, tMarkValue]) i.addEventListener('change', () => extract());
  frameInput.addEventListener('change', () => s.onFrame?.(Math.max(0, Number(frameInput.value) - 1)));

  /** Marks equivalent to an automatic calibration (as far as it went). */
  function marksFrom(a) {
    const p = a.partial;
    const m = { region: p.region ?? null, baselineY: p.baselineY ?? null, vMarkY: null, vMarkValue: null, tMarks: [], tMarkValue: null };
    if (p.baselineY !== null && p.velPerPx) {
      // The labelled tick farthest from the baseline, placed on the fitted line.
      const pts = (a.found.labels?.points ?? []).filter((q) => !q.unitLabel);
      const v = pts.length ? pts.reduce((x, q) => (Math.abs(q.value) > Math.abs(x.value) ? q : x)).value : 50;
      const cm = a.found.labels?.unit === 'm/s' ? v * 100 : v;
      m.vMarkValue = cm;
      m.vMarkY = p.baselineY - cm / 100 / p.velPerPx;
    }
    if (p.secPerPx) {
      const t = a.found.time;
      if (t) {
        const ks = t.kind === 'timeline' ? t.marks.map((q) => q.k) : t.lines.map((q) => q.k);
        const kA = Math.min(...ks);
        const kB = Math.max(...ks);
        m.tMarks = [t.origin + kA * t.spacing, t.origin + kB * t.spacing];
        m.tMarkValue = Number(((kB - kA) * t.step).toFixed(6));
      } else {
        // From a recognised example's reference calibration.
        const x0 = p.region?.x0 ?? 0;
        m.tMarks = [x0, x0 + 1 / p.secPerPx];
        m.tMarkValue = 1;
      }
    }
    return m;
  }

  return {
    /**
     * @param {{width:number,height:number,data:Uint8ClampedArray}} img
     * @param {object|null} dicomCal calibration from DICOM, or null
     * @param {{auto?:object, preset?:object, frames?:number, frame?:number, onFrame?:(i:number)=>void, keepMarks?:boolean}} opts
     *   auto: result of autoCalibrate() for this image.
     */
    setImage(img, dicomCal, opts = {}) {
      s.img = img;
      canvas.width = img.width;
      canvas.height = img.height;
      base.width = img.width;
      base.height = img.height;
      base.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
      if (!opts.keepMarks) {
        s.dicomCal = dicomCal;
        s.useDicom = Boolean(dicomCal);
        s.auto = dicomCal ? null : (opts.auto ?? null);
        s.autoMarks = null;
        const p = opts.preset ?? (s.auto ? marksFrom(s.auto) : {});
        s.region = p.region ?? dicomCal?.region ?? null;
        s.baselineY = p.baselineY ?? null;
        s.vMarkY = p.vMarkY ?? null;
        s.tMarks = p.tMarks ?? [];
        if (p.vMarkValue) vMarkValue.value = p.vMarkValue;
        if (p.tMarkValue) tMarkValue.value = p.tMarkValue;
        if (s.auto && !opts.preset) s.autoMarks = { ...p, tMarks: s.tMarks, vMarkValue: Number(vMarkValue.value), tMarkValue: Number(tMarkValue.value) };
        s.autoThr = true;
        invert.checked = false;
      }
      frameField.hidden = !(opts.frames > 1);
      frameInput.max = String(opts.frames ?? 1);
      frameInput.value = String((opts.frame ?? 0) + 1);
      s.onFrame = opts.onFrame ?? null;
      s.envelope = null;
      draw();
      extract();
    },
    /** Whether the current marks give a complete calibration. */
    ready: () => Boolean(calibration()),
    /** What is still missing, as a sentence, or null. */
    missing: () => nextStep()?.text ?? null,
    redraw: draw,
    clear() {
      s.img = null;
      s.envelope = null;
      s.auto = null;
      s.autoMarks = null;
      if (found) {
        found.innerHTML = '';
        found.hidden = true;
      }
    },
    status: onStatus,
  };
}
