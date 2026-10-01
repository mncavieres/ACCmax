// Image calibration panel: the user marks the spectral display region, the
// zero-velocity baseline, one horizontal line of known velocity and two time
// marks; the envelope is then traced and drawn over the image. DICOM files
// with an ultrasound region calibration skip the manual steps.

import { extractEnvelope, regionStats, autoThreshold } from '../io/envelope.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function createCalibrator(ui, { onTrace, onStatus }) {
  const { canvas, tools, vMarkValue, tMarkValue, threshold, thresholdOut, autoBtn, invert, ignoreColor, frameField, frameInput, status } = ui;
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

  function calibration() {
    if (s.useDicom && s.dicomCal) return s.dicomCal;
    const vVal = Number(vMarkValue.value);
    const tVal = Number(tMarkValue.value);
    if (!s.region || s.baselineY === null || s.vMarkY === null || s.tMarks.length < 2) return null;
    if (s.vMarkY === s.baselineY || s.tMarks[0] === s.tMarks[1] || !vVal || !tVal) return null;
    return {
      region: s.region,
      baselineY: s.baselineY,
      velPerPx: vVal / 100 / (s.baselineY - s.vMarkY),
      secPerPx: tVal / Math.abs(s.tMarks[1] - s.tMarks[0]),
      tOffset: 0,
      source: 'manual',
    };
  }

  function nextStep() {
    if (s.useDicom && s.dicomCal) return null;
    if (!s.region) return { tool: 'region', text: 'Drag a box around the spectral Doppler display.' };
    if (s.baselineY === null) return { tool: 'baseline', text: 'Click the baseline (0 cm/s).' };
    if (s.vMarkY === null) return { tool: 'vmark', text: 'Click a velocity scale mark and enter its value.' };
    if (s.tMarks.length < 2) return { tool: 'tmark', text: `Click ${s.tMarks.length ? 'the second' : 'two'} time mark${s.tMarks.length ? '' : 's'} and enter the time between them.` };
    return null;
  }

  function draw() {
    if (!s.img) return;
    ctx.drawImage(base, 0, 0);
    const accent = css('--accent');
    const caliper = css('--caliper');
    const lw = Math.max(1, canvas.width / 600);
    const cal = calibration();
    const region = cal?.region ?? s.region ?? s.drag?.rect;
    if (region) {
      ctx.strokeStyle = accent;
      ctx.lineWidth = lw * 1.5;
      ctx.setLineDash([]);
      ctx.strokeRect(region.x0 + 0.5, region.y0 + 0.5, region.x1 - region.x0, region.y1 - region.y0);
    }
    const x0 = region ? region.x0 : 0;
    const x1 = region ? region.x1 : canvas.width;
    const baseY = cal ? cal.baselineY : s.baselineY;
    if (baseY !== null && baseY !== undefined) {
      ctx.strokeStyle = accent;
      ctx.lineWidth = lw;
      ctx.setLineDash([6 * lw, 4 * lw]);
      ctx.beginPath();
      ctx.moveTo(x0, baseY + 0.5);
      ctx.lineTo(x1, baseY + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (!s.useDicom) {
      ctx.strokeStyle = caliper;
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
      ctx.strokeStyle = caliper;
      ctx.lineWidth = lw * 1.5;
      ctx.beginPath();
      let pen = false;
      for (let c = 0; c < env.edgeY.length; c++) {
        const y = env.edgeY[c];
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

  function updateStatus() {
    const step = nextStep();
    const cal = calibration();
    if (step) {
      setTool(step.tool);
      status.textContent = step.text;
      status.dataset.state = 'todo';
    } else if (cal) {
      const scale = `${(Math.abs(cal.velPerPx) * 100).toFixed(2)} cm/s per pixel, ${(cal.secPerPx * 1000).toFixed(2)} ms per pixel`;
      status.textContent = cal.source === 'manual' ? `Calibrated by hand: ${scale}.` : `Calibrated from the DICOM ultrasound region (${cal.dataType}): ${scale}.`;
      status.dataset.state = 'done';
    }
  }

  let extractTimer = null;
  function extract(delay = 0) {
    clearTimeout(extractTimer);
    extractTimer = setTimeout(() => {
      const cal = calibration();
      updateStatus();
      if (!cal || !s.img) {
        s.envelope = null;
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
      draw();
      const qc = [];
      if (s.envelope.clippedFraction > 0.01) {
        qc.push({ level: 'warn', message: `The envelope reaches the edge of the velocity scale in ${(s.envelope.clippedFraction * 100).toFixed(0)}% of columns. Possible aliasing: raise the scale (PRF) or move the baseline when recording.` });
      }
      if (cal.dopplerAngle > 60) {
        qc.push({ level: 'warn', message: `Doppler angle ${cal.dopplerAngle.toFixed(0)}° is above 60°. Velocities, and therefore ACCmax, are less reliable.` });
      }
      onTrace({ t: s.envelope.t, v: s.envelope.v, qc, calibration: cal });
    }, delay);
  }

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

  return {
    /**
     * @param {{width:number,height:number,data:Uint8ClampedArray}} img
     * @param {object|null} dicomCal calibration from DICOM, or null
     * @param {{preset?:object, frames?:number, frame?:number, onFrame?:(i:number)=>void, keepMarks?:boolean}} opts
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
        const p = opts.preset ?? {};
        s.region = p.region ?? dicomCal?.region ?? null;
        s.baselineY = p.baselineY ?? null;
        s.vMarkY = p.vMarkY ?? null;
        s.tMarks = p.tMarks ?? [];
        if (p.vMarkValue) vMarkValue.value = p.vMarkValue;
        if (p.tMarkValue) tMarkValue.value = p.tMarkValue;
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
    redraw: draw,
    clear() {
      s.img = null;
      s.envelope = null;
    },
    status: onStatus,
  };
}
