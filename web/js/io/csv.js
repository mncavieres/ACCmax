// Delimited text (CSV, TSV, semicolon files with decimal commas) → trace.

function splitter(delim) {
  if (delim === 'ws') return (line) => line.trim().split(/\s+/);
  return (line) => line.split(delim).map((s) => s.trim());
}

const toNumber = (s, decimalComma) => {
  if (s === undefined || s === '') return NaN;
  const c = decimalComma ? s.replace(',', '.') : s;
  return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(c) ? Number(c) : NaN;
};

/**
 * Parse delimited numeric text. Returns column names and numeric rows.
 * Lines starting with # are comments; a non-numeric first line is a header.
 */
export function parseDelimited(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (!lines.length) throw new Error('The file is empty.');
  const sample = lines.slice(0, 50);
  let best = { delim: 'ws', score: -1 };
  for (const delim of ['\t', ';', ',', 'ws']) {
    const split = splitter(delim);
    const freq = new Map();
    for (const l of sample) {
      const c = split(l).length;
      freq.set(c, (freq.get(c) ?? 0) + 1);
    }
    const [mode, hits] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
    const consistent = hits / sample.length;
    const score = mode >= 2 ? consistent * 10 + mode * 0.01 : mode === 1 ? 0 : -1;
    if (score > best.score) best = { delim, score };
  }
  const split = splitter(best.delim);
  const decimalComma = best.delim !== ',' && sample.some((l) => /\d,\d/.test(l));
  let header = null;
  const rows = [];
  for (const line of lines) {
    const fields = split(line);
    const nums = fields.map((f) => toNumber(f, decimalComma));
    if (nums.every(Number.isNaN)) {
      if (!header && rows.length === 0) header = fields;
      continue;
    }
    rows.push(nums);
  }
  if (!rows.length) throw new Error('No numeric rows found. Expected columns of time and velocity.');
  const width = Math.max(...rows.map((r) => r.length));
  const columns = Array.from({ length: width }, (_, i) => (header && header[i] ? header[i] : `Column ${i + 1}`));
  return { columns, rows, delimiter: best.delim, decimalComma };
}

/** Guess units from the data range. */
export function guessUnits(table, tCol = 0, vCol = 1) {
  const single = table.columns.length === 1;
  const v = table.rows.map((r) => r[single ? 0 : vCol]).filter(Number.isFinite);
  const vmax = Math.max(...v.map(Math.abs));
  let timeUnit = 's';
  if (!single) {
    const t = table.rows.map((r) => r[tCol]).filter(Number.isFinite);
    const diffs = [];
    for (let i = 1; i < Math.min(t.length, 200); i++) diffs.push(t[i] - t[i - 1]);
    diffs.sort((a, b) => a - b);
    const dt = diffs[diffs.length >> 1];
    timeUnit = dt > 0.1 ? 'ms' : 's';
  }
  return { timeUnit, velUnit: vmax > 5 ? 'cm/s' : 'm/s', single };
}

/**
 * Convert a parsed table into a trace in seconds and m/s.
 * For a single-column file, pass sampleRate (Hz).
 */
export function tableToTrace(table, { tCol = 0, vCol = 1, timeUnit = 's', velUnit = 'm/s', sampleRate = 100 } = {}) {
  const single = table.columns.length === 1;
  const tScale = timeUnit === 'ms' ? 0.001 : 1;
  const vScale = velUnit === 'cm/s' ? 0.01 : velUnit === 'mm/s' ? 0.001 : 1;
  const t = [];
  const v = [];
  table.rows.forEach((r, i) => {
    const tt = single ? i / sampleRate : r[tCol] * tScale;
    const vv = r[single ? 0 : vCol] * vScale;
    if (Number.isFinite(tt) && Number.isFinite(vv)) {
      t.push(tt);
      v.push(vv);
    }
  });
  return { t: Float64Array.from(t), v: Float64Array.from(v) };
}
