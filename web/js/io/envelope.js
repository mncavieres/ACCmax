// Spectral Doppler image → maximum-velocity envelopes.
//
// The calibrated spectral display is scanned column by column. In each
// column the outer edge of the spectrum is the first run of `minRun`
// consecutive pixels above the intensity threshold, searched from the scale
// limit towards the baseline (separately above and below the baseline). Requiring a run, rather than a single bright pixel,
// keeps isolated speckle above the envelope from being traced. The edge is
// refined to sub-pixel precision by interpolating across the threshold.

export function grayAt(img, x, y) {
  const i = (y * img.width + x) * 4;
  return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
}

function chromaAt(img, x, y) {
  const i = (y * img.width + x) * 4;
  const r = img.data[i];
  const g = img.data[i + 1];
  const b = img.data[i + 2];
  return Math.max(r, g, b) - Math.min(r, g, b);
}

/** Otsu's threshold for a 256-bin histogram. */
export function otsu(hist) {
  let total = 0;
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    total += hist[i];
    sum += i * hist[i];
  }
  let wB = 0;
  let sumB = 0;
  let best = 0;
  let thr = 0;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      thr = i;
    }
  }
  return thr;
}

/**
 * Analyse the region's intensities: background level, Otsu split, and
 * whether coloured pixels look like overlays (calipers, text, auto-trace).
 */
export function regionStats(img, { region, baselineY, guardPx = 2 }) {
  const hist = new Float64Array(256);
  let colored = 0;
  let lit = 0;
  for (let y = region.y0; y <= region.y1; y++) {
    if (Math.abs(y - baselineY) <= guardPx) continue;
    for (let x = region.x0; x <= region.x1; x++) {
      const g = grayAt(img, x, y);
      hist[Math.min(255, Math.round(g))]++;
      if (g > 30) {
        lit++;
        if (chromaAt(img, x, y) > 40) colored++;
      }
    }
  }
  const split = otsu(hist);
  let n = 0;
  let s = 0;
  for (let i = 0; i <= split; i++) {
    n += hist[i];
    s += i * hist[i];
  }
  const background = n ? s / n : 0;
  return { split, background, coloredFraction: lit ? colored / lit : 0 };
}

/** Default threshold: part-way from the background level to the Otsu split. */
export function autoThreshold(stats) {
  return Math.round(stats.background + 0.55 * (stats.split - stats.background));
}

/**
 * Trace the maximum-velocity envelope of a spectral display.
 *
 * Both outer edges are traced in every column: the forward edge (flow
 * towards the display's positive direction) and the reverse edge. The trace
 * used for the analysis (`v`) is signed, so reverse flow enters the fit as
 * negative velocity. Where both directions are present in a column, the share
 * of bright pixels on each side of the baseline decides: stray speckle on the
 * opposite side is ignored, and where the flow genuinely reverses the trace
 * crosses zero smoothly, as the outer envelope does when traced by eye. (Switching hard from one edge to the other would
 * jump across the baseline in a single column and fake a near-vertical
 * upstroke.) Columns without signal are zero flow, not gaps: in a clean
 * display, diastole with no detectable flow is black.
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}} img RGBA
 * @param {{region:{x0:number,y0:number,x1:number,y1:number}, baselineY:number, velPerPx:number, secPerPx:number, tOffset?:number}} cal
 *   velPerPx: m/s per pixel, positive when velocity increases upwards.
 * @param {{threshold?:number|null, minRun?:number, invert?:boolean, ignoreColor?:'auto'|boolean, guardPx?:number}} opts
 *   invert: forward flow is displayed below the baseline.
 * @returns {{t:Float64Array, v:Float64Array, vForward:Float64Array, vReverse:Float64Array, edgeY:Float64Array, edgeReverseY:Float64Array}}
 *   v is the signed envelope (m/s); vForward and vReverse are the magnitudes
 *   of the two edges; edgeY/edgeReverseY are their pixel rows.
 */
export function extractEnvelope(img, cal, opts = {}) {
  const { region, baselineY, velPerPx, secPerPx, tOffset = 0 } = cal;
  const { minRun = 3, invert = false, ignoreColor = 'auto', guardPx = 2 } = opts;
  const stats = regionStats(img, { region, baselineY, guardPx });
  const threshold = opts.threshold ?? autoThreshold(stats);
  // Coloured overlays (ECG, baseline, calipers, scanner auto-trace) are not
  // spectrum. Strongly saturated pixels are always ignored; mildly coloured
  // ones too, unless the whole spectrum is colour-mapped.
  const dropColor = ignoreColor === 'auto' ? stats.coloredFraction < 0.15 : Boolean(ignoreColor);
  const I = (x, y) => {
    if (ignoreColor !== false) {
      const c = chromaAt(img, x, y);
      if (c > 110 || (dropColor && c > 15)) return 0;
    }
    return grayAt(img, x, y);
  };

  const cols = region.x1 - region.x0 + 1;
  const t = new Float64Array(cols);
  const vUp = new Float64Array(cols);
  const vDown = new Float64Array(cols);
  const massUp = new Float64Array(cols);
  const massDown = new Float64Array(cols);
  const edgeUp = new Float64Array(cols).fill(NaN);
  const edgeDown = new Float64Array(cols).fill(NaN);
  let clippedUp = 0;
  let clippedDown = 0;
  let blank = 0;

  // Outer edge (first run of minRun bright pixels from the scale limit
  // towards the baseline) and the number of bright pixels on that side.
  const scan = (x, from, to, step) => {
    let run = 0;
    let edge = null;
    let mass = 0;
    for (let y = from; step > 0 ? y <= to : y >= to; y += step) {
      if (I(x, y) >= threshold) {
        run++;
        if (edge !== null) mass++;
        if (run === minRun && edge === null) {
          const ys = y - step * (minRun - 1);
          const prev = ys - step;
          const gPrev = prev >= Math.min(from, to) && prev <= Math.max(from, to) ? I(x, prev) : 0;
          const gCur = I(x, ys);
          const f = gCur > gPrev ? Math.min(1, Math.max(0, (threshold - gPrev) / (gCur - gPrev))) : 1;
          edge = ys - step * (1 - f);
          mass = minRun;
        }
      } else run = 0;
    }
    return { edge, mass };
  };

  const top = Math.max(region.y0, 0);
  const bottom = Math.min(region.y1, img.height - 1);
  const none = { edge: null, mass: 0 };
  for (let c = 0; c < cols; c++) {
    const x = region.x0 + c;
    t[c] = tOffset + c * secPerPx;
    const up = baselineY - guardPx - 1 >= top ? scan(x, top, Math.floor(baselineY - guardPx - 1), 1) : none;
    const down = baselineY + guardPx + 1 <= bottom ? scan(x, bottom, Math.ceil(baselineY + guardPx + 1), -1) : none;
    if (up.edge === null && down.edge === null) blank++;
    if (up.edge !== null) {
      edgeUp[c] = up.edge;
      vUp[c] = (baselineY - up.edge) * Math.abs(velPerPx);
      massUp[c] = up.mass;
      if (up.edge <= top + 1) clippedUp++;
    }
    if (down.edge !== null) {
      edgeDown[c] = down.edge;
      vDown[c] = (down.edge - baselineY) * Math.abs(velPerPx);
      massDown[c] = down.mass;
      if (down.edge >= bottom - 1) clippedDown++;
    }
  }
  // Forward is above the baseline unless the display is inverted (or the
  // calibration says velocity increases downwards).
  const forwardUp = (velPerPx >= 0) !== invert;
  const vForward = forwardUp ? vUp : vDown;
  const vReverse = forwardUp ? vDown : vUp;
  const mF = forwardUp ? massUp : massDown;
  const mR = forwardUp ? massDown : massUp;
  // Reverse share of the bright pixels decides the direction: below 30% the
  // column is forward flow (minor speckle ignored), above 70% reverse flow,
  // and in between the two edges are blended smoothly.
  const v = new Float64Array(cols);
  for (let c = 0; c < cols; c++) {
    const m = mF[c] + mR[c];
    if (m === 0) continue;
    const share = Math.min(1, Math.max(0, (mR[c] / m - 0.3) / 0.4));
    const w = share * share * (3 - 2 * share);
    v[c] = (1 - w) * vForward[c] - w * vReverse[c];
  }
  return {
    t,
    v,
    vForward,
    vReverse,
    edgeY: forwardUp ? edgeUp : edgeDown,
    edgeReverseY: forwardUp ? edgeDown : edgeUp,
    threshold,
    stats,
    ignoredColor: dropColor,
    clippedFraction: (forwardUp ? clippedUp : clippedDown) / cols,
    reverseClippedFraction: (forwardUp ? clippedDown : clippedUp) / cols,
    blankFraction: blank / cols,
  };
}
