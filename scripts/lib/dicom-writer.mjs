// Tiny explicit-VR-little-endian DICOM writer, used for tests and sample
// files. Writes only what a spectral Doppler capture needs: the ultrasound
// region calibration and uncompressed RGB pixel data.

const LONG = new Set(['OB', 'OW', 'SQ', 'UN', 'UT']);

export function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function element(g, e, vr, value) {
  let bytes;
  if (value instanceof Uint8Array) bytes = value;
  else if (typeof value === 'string') {
    const s = value.length % 2 ? value + (vr === 'UI' ? '\0' : ' ') : value;
    bytes = Uint8Array.from(s, (c) => c.charCodeAt(0));
  } else {
    const size = { US: 2, UL: 4, SL: 4, FD: 8 }[vr];
    const b = new DataView(new ArrayBuffer(size));
    if (vr === 'US') b.setUint16(0, value, true);
    if (vr === 'UL') b.setUint32(0, value, true);
    if (vr === 'SL') b.setInt32(0, value, true);
    if (vr === 'FD') b.setFloat64(0, value, true);
    bytes = new Uint8Array(b.buffer);
  }
  const head = new DataView(new ArrayBuffer(LONG.has(vr) ? 12 : 8));
  head.setUint16(0, g, true);
  head.setUint16(2, e, true);
  head.setUint8(4, vr.charCodeAt(0));
  head.setUint8(5, vr.charCodeAt(1));
  if (LONG.has(vr)) head.setUint32(8, bytes.length, true);
  else head.setUint16(6, bytes.length, true);
  return concat([new Uint8Array(head.buffer), bytes]);
}

function delim(g, e) {
  const d = new DataView(new ArrayBuffer(8));
  d.setUint16(0, g, true);
  d.setUint16(2, e, true);
  d.setUint32(4, e === 0xe000 ? 0xffffffff : 0, true);
  return new Uint8Array(d.buffer);
}

export function sequence(g, e, items) {
  const head = new DataView(new ArrayBuffer(12));
  head.setUint16(0, g, true);
  head.setUint16(2, e, true);
  head.setUint8(4, 83);
  head.setUint8(5, 81);
  head.setUint32(8, 0xffffffff, true);
  const parts = [new Uint8Array(head.buffer)];
  for (const it of items) parts.push(delim(0xfffe, 0xe000), it, delim(0xfffe, 0xe00d));
  parts.push(delim(0xfffe, 0xe0dd));
  return concat(parts);
}

/**
 * @param {{width:number,height:number,data:Uint8ClampedArray}} img RGBA
 * @param {{region:{x0:number,y0:number,x1:number,y1:number}, baselineY:number, velPerPx:number, secPerPx:number}} cal
 */
export function spectralDicom(img, cal, { dopplerAngle = 55, manufacturer = 'Synthetic', model = 'ACCmax Workbench sample' } = {}) {
  const rgb = new Uint8Array(img.width * img.height * 3);
  for (let i = 0; i < img.width * img.height; i++) {
    rgb[3 * i] = img.data[4 * i];
    rgb[3 * i + 1] = img.data[4 * i + 1];
    rgb[3 * i + 2] = img.data[4 * i + 2];
  }
  const region = concat([
    element(0x0018, 0x6012, 'US', 1),
    element(0x0018, 0x6014, 'US', 3),
    element(0x0018, 0x6018, 'UL', cal.region.x0),
    element(0x0018, 0x601a, 'UL', cal.region.y0),
    element(0x0018, 0x601c, 'UL', cal.region.x1),
    element(0x0018, 0x601e, 'UL', cal.region.y1),
    element(0x0018, 0x6020, 'SL', 0),
    element(0x0018, 0x6022, 'SL', cal.baselineY - cal.region.y0),
    element(0x0018, 0x6024, 'US', 4),
    element(0x0018, 0x6026, 'US', 7),
    element(0x0018, 0x6028, 'FD', 0),
    element(0x0018, 0x602a, 'FD', 0),
    element(0x0018, 0x602c, 'FD', cal.secPerPx),
    element(0x0018, 0x602e, 'FD', -cal.velPerPx * 100),
    element(0x0018, 0x6034, 'FD', dopplerAngle),
  ]);
  const ts = element(0x0002, 0x0010, 'UI', '1.2.840.10008.1.2.1');
  const meta = concat([element(0x0002, 0x0000, 'UL', ts.length), ts]);
  const body = concat([
    element(0x0008, 0x0016, 'UI', '1.2.840.10008.5.1.4.1.1.6.1'),
    element(0x0008, 0x0060, 'CS', 'US'),
    element(0x0008, 0x0070, 'LO', manufacturer),
    element(0x0008, 0x1090, 'LO', model),
    sequence(0x0018, 0x6011, [region]),
    element(0x0028, 0x0002, 'US', 3),
    element(0x0028, 0x0004, 'CS', 'RGB'),
    element(0x0028, 0x0006, 'US', 0),
    element(0x0028, 0x0010, 'US', img.height),
    element(0x0028, 0x0011, 'US', img.width),
    element(0x0028, 0x0100, 'US', 8),
    element(0x0028, 0x0101, 'US', 8),
    element(0x0028, 0x0103, 'US', 0),
    element(0x7fe0, 0x0010, 'OB', rgb),
  ]);
  return concat([new Uint8Array(128), Uint8Array.from('DICM', (ch) => ch.charCodeAt(0)), meta, body]);
}
