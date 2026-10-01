// Spectral Doppler image → maximum-velocity envelope.
//
// The calibrated spectral display is scanned column by column. In each
// column the outer edge of the spectrum is the first run of `minRun`
// consecutive pixels above the intensity threshold, searched from the scale
// limit towards the baseline (above the baseline for forward flow, below it
// for reverse flow). Requiring a run, rather than a single bright pixel,
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
 * @param {{width:number,height:number,data:Uint8ClampedArray}} img RGBA
 * @param {{region:{x0:number,y0:number,x1:number,y1:number}, baselineY:number, velPerPx:number, secPerPx:number, tOffset?:number}} cal
 *   velPerPx: m/s per pixel, positive when velocity increases upwards.
 * @param {{threshold?:number|null, minRun?:number, invert?:boolean, ignoreColor?:'auto'|boolean, guardPx?:number}} opts
 */
export function extractEnvelope(img, cal, opts = {}) {
  const { region, baselineY, velPerPx, secPerPx, tOffset = 0 } = cal;
  const { minRun = 3, invert = false, ignoreColor = 'auto', guardPx = 2 } = opts;
  const stats = regionStats(img, { region, baselineY, guardPx });
  const threshold = opts.threshold ?? autoThreshold(stats);
  const dropColor = ignoreColor === 'auto' ? stats.coloredFraction < 0.15 : Boolean(ignoreColor);
  const I = (x, y) => (dropColor && chromaAt(img, x, y) > 40 ? 0 : grayAt(img, x, y));

  const cols = region.x1 - region.x0 + 1;
  const t = new Float64Array(cols);
  const v = new Float64Array(cols);
  const edgeY = new Float64Array(cols);
  let clipped = 0;
  let blank = 0;

  const scan = (x, from, to, step) => {
    let run = 0;
    let count = 0;
    let edge = null;
    for (let y = from; step > 0 ? y <= to : y >= to; y += step) {
      const g = I(x, y);
      if (g >= threshold) {
        run++;
        count++;
        if (run === minRun && edge === null) {
          const ys = y - step * (minRun - 1);
          const prev = ys - step;
          const gPrev = prev >= Math.min(from, to) && prev <= Math.max(from, to) ? I(x, prev) : 0;
          const gCur = I(x, ys);
          const f = gCur > gPrev ? Math.min(1, Math.max(0, (threshold - gPrev) / (gCur - gPrev))) : 1;
          edge = ys - step * (1 - f);
        }
      } else {
        run = 0;
      }
    }
    return { edge, count };
  };

  for (let c = 0; c < cols; c++) {
    const x = region.x0 + c;
    t[c] = tOffset + c * secPerPx;
    let maxG = 0;
    for (let y = region.y0; y <= region.y1; y++) maxG = Math.max(maxG, I(x, y));
    if (maxG < 0.5 * threshold) {
      // Nothing above the noise floor anywhere: erase bar or blanked column.
      v[c] = NaN;
      edgeY[c] = NaN;
      blank++;
      continue;
    }
    const top = Math.max(region.y0, 0);
    const bottom = Math.min(region.y1, img.height - 1);
    const pos = baselineY - guardPx - 1 >= top ? scan(x, top, baselineY - guardPx - 1, 1) : { edge: null, count: 0 };
    const neg = baselineY + guardPx + 1 <= bottom ? scan(x, bottom, baselineY + guardPx + 1, -1) : { edge: null, count: 0 };
    let vel = 0;
    let ey = baselineY;
    if (pos.edge !== null && pos.count >= neg.count) {
      ey = pos.edge;
      vel = (baselineY - ey) * velPerPx;
      if (ey <= top + 1) clipped++;
    } else if (neg.edge !== null) {
      ey = neg.edge;
      vel = (baselineY - ey) * velPerPx;
      if (ey >= bottom - 1) clipped++;
    }
    v[c] = invert ? -vel : vel;
    edgeY[c] = ey;
  }
  return {
    t,
    v,
    edgeY,
    threshold,
    stats,
    ignoredColor: dropColor,
    clippedFraction: clipped / cols,
    blankFraction: blank / cols,
  };
}
