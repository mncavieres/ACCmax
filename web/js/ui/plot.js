// Minimal SVG plotting helpers: scales, nice ticks, axes, lines and dot clouds.
// Colours come from CSS classes so both themes are handled by the stylesheet.

const NS = 'http://www.w3.org/2000/svg';

export function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

export function niceTicks(lo, hi, count = 5) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return ticks;
}

export function extent(values, pad = 0) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return [0, 1];
  const span = hi - lo || Math.abs(hi) || 1;
  return [lo - pad * span, hi + pad * span];
}

/**
 * Prepare an SVG for drawing. Returns scales and layer groups.
 * @param {SVGSVGElement} svg
 */
export function frame(svg, { x, y, height = 280, margin = { t: 14, r: 16, b: 38, l: 52 }, xTicks, yTicks, xFmt = String, yFmt = String, xLabel, yLabel }) {
  const width = Math.max(240, svg.parentElement.clientWidth || 600);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.replaceChildren();
  const iw = width - margin.l - margin.r;
  const ih = height - margin.t - margin.b;
  const sx = (v) => margin.l + ((v - x[0]) / (x[1] - x[0])) * iw;
  const sy = (v) => margin.t + (1 - (v - y[0]) / (y[1] - y[0])) * ih;
  const ix = (px) => x[0] + ((px - margin.l) / iw) * (x[1] - x[0]);
  const iy = (py) => y[0] + (1 - (py - margin.t) / ih) * (y[1] - y[0]);

  const defs = el('defs', {}, svg);
  const clipId = `clip-${Math.random().toString(36).slice(2, 9)}`;
  el('rect', { x: margin.l, y: margin.t, width: iw, height: ih }, el('clipPath', { id: clipId }, defs));

  const grid = el('g', { class: 'grid' }, svg);
  for (const t of yTicks ?? niceTicks(y[0], y[1], 5)) {
    if (t < y[0] || t > y[1]) continue;
    el('line', { x1: margin.l, x2: margin.l + iw, y1: sy(t), y2: sy(t), class: t === 0 ? 'zero' : '' }, grid);
    const label = el('text', { x: margin.l - 8, y: sy(t), class: 'tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, grid);
    label.textContent = yFmt(t);
  }
  for (const t of xTicks ?? niceTicks(x[0], x[1], Math.max(3, Math.round(iw / 90)))) {
    if (t < x[0] || t > x[1]) continue;
    el('line', { x1: sx(t), x2: sx(t), y1: margin.t + ih, y2: margin.t + ih + 4, class: 'tickmark' }, grid);
    const label = el('text', { x: sx(t), y: margin.t + ih + 16, class: 'tick', 'text-anchor': 'middle' }, grid);
    label.textContent = xFmt(t);
  }
  el('line', { x1: margin.l, x2: margin.l + iw, y1: margin.t + ih, y2: margin.t + ih, class: 'axis' }, grid);
  if (xLabel) {
    const t = el('text', { x: margin.l + iw, y: height - 4, class: 'axis-label', 'text-anchor': 'end' }, grid);
    t.textContent = xLabel;
  }
  if (yLabel) {
    const t = el('text', { x: 4, y: margin.t - 2, class: 'axis-label', 'text-anchor': 'start', 'dominant-baseline': 'hanging' }, grid);
    t.textContent = yLabel;
    // keep the y label clear of the top tick
    t.setAttribute('y', 0);
  }
  const data = el('g', { 'clip-path': `url(#${clipId})` }, svg);
  const overlay = el('g', {}, svg);
  return { svg, width, height, margin, iw, ih, sx, sy, ix, iy, x, y, data, overlay };
}

/** Polyline through finite points; NaN breaks the line. */
export function pathD(xs, ys, sx, sy) {
  let d = '';
  let pen = false;
  for (let i = 0; i < xs.length; i++) {
    const X = xs[i];
    const Y = ys[i];
    if (!Number.isFinite(X) || !Number.isFinite(Y)) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${sx(X).toFixed(1)} ${sy(Y).toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** Many small circles as one path element (fast for thousands of points). */
export function dotsD(xs, ys, sx, sy, r = 1.6) {
  let d = '';
  const r2 = (2 * r).toFixed(2);
  for (let i = 0; i < xs.length; i++) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
    const X = sx(xs[i]) - r;
    const Y = sy(ys[i]);
    d += `M${X.toFixed(1)} ${Y.toFixed(1)}a${r} ${r} 0 1 0 ${r2} 0a${r} ${r} 0 1 0 -${r2} 0`;
  }
  return d;
}

/** SVG coordinates of a pointer event. */
export function svgPoint(svg, evt) {
  const r = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  return {
    x: ((evt.clientX - r.left) / r.width) * vb.width,
    y: ((evt.clientY - r.top) / r.height) * vb.height,
  };
}
