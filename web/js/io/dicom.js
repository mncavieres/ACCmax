// Minimal DICOM reader for ultrasound spectral Doppler captures.
//
// Reads Part 10 files in implicit or explicit VR little endian, with
// uncompressed or JPEG (baseline/extended) pixel data, and the Sequence of
// Ultrasound Regions (0018,6011). For a PW/CW spectral region that region
// gives the pixel → seconds and pixel → cm/s calibration, so no manual
// calibration clicks are needed.
//
// Patient-identifying attributes are never read or displayed.

const TS = {
  IMPLICIT_LE: '1.2.840.10008.1.2',
  EXPLICIT_LE: '1.2.840.10008.1.2.1',
  DEFLATED: '1.2.840.10008.1.2.1.99',
  EXPLICIT_BE: '1.2.840.10008.1.2.2',
  JPEG_BASELINE: '1.2.840.10008.1.2.4.50',
  JPEG_EXTENDED: '1.2.840.10008.1.2.4.51',
};

const LONG_VR = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);

const key = (g, e) => `${g.toString(16).padStart(4, '0')}${e.toString(16).padStart(4, '0')}`;

export const TAGS = {
  TransferSyntaxUID: '00020010',
  SOPClassUID: '00080016',
  Modality: '00080060',
  Manufacturer: '00080070',
  ManufacturerModelName: '00081090',
  FrameTime: '00181063',
  SequenceOfUltrasoundRegions: '00186011',
  RegionSpatialFormat: '00186012',
  RegionDataType: '00186014',
  RegionFlags: '00186016',
  RegionLocationMinX0: '00186018',
  RegionLocationMinY0: '0018601a',
  RegionLocationMaxX1: '0018601c',
  RegionLocationMaxY1: '0018601e',
  ReferencePixelX0: '00186020',
  ReferencePixelY0: '00186022',
  PhysicalUnitsXDirection: '00186024',
  PhysicalUnitsYDirection: '00186026',
  ReferencePixelPhysicalValueX: '00186028',
  ReferencePixelPhysicalValueY: '0018602a',
  PhysicalDeltaX: '0018602c',
  PhysicalDeltaY: '0018602e',
  TransducerFrequency: '00186030',
  PulseRepetitionFrequency: '00186032',
  DopplerCorrectionAngle: '00186034',
  SamplesPerPixel: '00280002',
  PhotometricInterpretation: '00280004',
  PlanarConfiguration: '00280006',
  NumberOfFrames: '00280008',
  Rows: '00280010',
  Columns: '00280011',
  BitsAllocated: '00280100',
  BitsStored: '00280101',
  PixelRepresentation: '00280103',
  PixelData: '7fe00010',
};

// VRs for implicit-VR files (only the attributes this reader uses).
const IMPLICIT_VR = {
  [TAGS.SOPClassUID]: 'UI',
  [TAGS.Modality]: 'CS',
  [TAGS.Manufacturer]: 'LO',
  [TAGS.ManufacturerModelName]: 'LO',
  [TAGS.FrameTime]: 'DS',
  [TAGS.SequenceOfUltrasoundRegions]: 'SQ',
  [TAGS.RegionSpatialFormat]: 'US',
  [TAGS.RegionDataType]: 'US',
  [TAGS.RegionFlags]: 'UL',
  [TAGS.RegionLocationMinX0]: 'UL',
  [TAGS.RegionLocationMinY0]: 'UL',
  [TAGS.RegionLocationMaxX1]: 'UL',
  [TAGS.RegionLocationMaxY1]: 'UL',
  [TAGS.ReferencePixelX0]: 'SL',
  [TAGS.ReferencePixelY0]: 'SL',
  [TAGS.PhysicalUnitsXDirection]: 'US',
  [TAGS.PhysicalUnitsYDirection]: 'US',
  [TAGS.ReferencePixelPhysicalValueX]: 'FD',
  [TAGS.ReferencePixelPhysicalValueY]: 'FD',
  [TAGS.PhysicalDeltaX]: 'FD',
  [TAGS.PhysicalDeltaY]: 'FD',
  [TAGS.TransducerFrequency]: 'UL',
  [TAGS.PulseRepetitionFrequency]: 'UL',
  [TAGS.DopplerCorrectionAngle]: 'FD',
  [TAGS.SamplesPerPixel]: 'US',
  [TAGS.PhotometricInterpretation]: 'CS',
  [TAGS.PlanarConfiguration]: 'US',
  [TAGS.NumberOfFrames]: 'IS',
  [TAGS.Rows]: 'US',
  [TAGS.Columns]: 'US',
  [TAGS.BitsAllocated]: 'US',
  [TAGS.BitsStored]: 'US',
  [TAGS.PixelRepresentation]: 'US',
  [TAGS.PixelData]: 'OW',
};

export const UNITS = { 0: 'none', 1: '%', 2: 'dB', 3: 'cm', 4: 's', 5: 'Hz', 6: 'dB/s', 7: 'cm/s', 8: 'cm²', 9: 'cm²/s', 10: 'cm³', 11: 'cm³/s', 12: '°' };
export const REGION_TYPES = { 0: 'none', 1: 'tissue', 2: 'colour flow', 3: 'PW spectral Doppler', 4: 'CW spectral Doppler', 5: 'Doppler mean trace', 6: 'Doppler mode trace', 7: 'Doppler max trace', 8: 'volume trace', 10: 'ECG trace', 11: 'pulse trace', 12: 'phonocardiogram', 13: 'grey bar', 14: 'colour bar' };

class Parser {
  constructor(buffer) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.size = buffer.byteLength;
  }

  u16(o) {
    return this.view.getUint16(o, true);
  }

  u32(o) {
    return this.view.getUint32(o, true);
  }

  // Parse data elements from `offset` until `end` or an item delimiter.
  dataset(offset, end, explicit) {
    const elements = new Map();
    while (offset + 8 <= Math.min(end, this.size)) {
      const g = this.u16(offset);
      const e = this.u16(offset + 2);
      if (g === 0xfffe) {
        if (e === 0xe00d) return { elements, offset: offset + 8 };
        break;
      }
      const k = key(g, e);
      let vr;
      let length;
      let header;
      const vrText = String.fromCharCode(this.view.getUint8(offset + 4), this.view.getUint8(offset + 5));
      if (explicit && /^[A-Z]{2}$/.test(vrText)) {
        vr = vrText;
        if (LONG_VR.has(vr)) {
          length = this.u32(offset + 8);
          header = 12;
        } else {
          length = this.u16(offset + 6);
          header = 8;
        }
      } else {
        vr = IMPLICIT_VR[k] ?? 'UN';
        length = this.u32(offset + 4);
        header = 8;
      }
      const valueOffset = offset + header;
      const el = { tag: k, vr, offset: valueOffset, length };
      if (length === 0xffffffff) {
        if (k === TAGS.PixelData) {
          const enc = this.fragments(valueOffset);
          el.fragments = enc.fragments;
          offset = enc.offset;
        } else {
          // Undefined length: a sequence. An explicit 'UN' with undefined
          // length is encoded as implicit VR (PS3.5 §6.2.2).
          const seq = this.items(valueOffset, Infinity, explicit && vr !== 'UN');
          el.items = seq.items;
          el.vr = 'SQ';
          offset = seq.offset;
        }
      } else {
        if (vr === 'SQ') el.items = this.items(valueOffset, valueOffset + length, explicit).items;
        offset = valueOffset + length;
      }
      elements.set(k, el);
    }
    return { elements, offset };
  }

  items(offset, end, explicit) {
    const items = [];
    while (offset + 8 <= Math.min(end, this.size)) {
      const g = this.u16(offset);
      const e = this.u16(offset + 2);
      const len = this.u32(offset + 4);
      if (g === 0xfffe && e === 0xe0dd) return { items, offset: offset + 8 };
      if (g !== 0xfffe || e !== 0xe000) break;
      if (len === 0xffffffff) {
        const ds = this.dataset(offset + 8, this.size, explicit);
        items.push(ds.elements);
        offset = ds.offset;
      } else {
        items.push(this.dataset(offset + 8, offset + 8 + len, explicit).elements);
        offset += 8 + len;
      }
    }
    return { items, offset };
  }

  fragments(offset) {
    const fragments = [];
    while (offset + 8 <= this.size) {
      const g = this.u16(offset);
      const e = this.u16(offset + 2);
      const len = this.u32(offset + 4);
      if (g === 0xfffe && e === 0xe0dd) return { fragments, offset: offset + 8 };
      if (g !== 0xfffe || e !== 0xe000) break;
      fragments.push({ offset: offset + 8, length: len });
      offset += 8 + len;
    }
    return { fragments, offset };
  }
}

function readValue(buffer, el) {
  if (!el) return undefined;
  const view = new DataView(buffer, el.offset, el.length);
  const n = el.length;
  switch (el.vr) {
    case 'US':
      return n >= 2 ? view.getUint16(0, true) : undefined;
    case 'SS':
      return n >= 2 ? view.getInt16(0, true) : undefined;
    case 'UL':
      return n >= 4 ? view.getUint32(0, true) : undefined;
    case 'SL':
      return n >= 4 ? view.getInt32(0, true) : undefined;
    case 'FL':
      return n >= 4 ? view.getFloat32(0, true) : undefined;
    case 'FD':
      return n >= 8 ? view.getFloat64(0, true) : undefined;
    case 'DS':
    case 'IS': {
      const s = readString(buffer, el).split('\\')[0];
      return s === '' ? undefined : Number(s);
    }
    default:
      return readString(buffer, el);
  }
}

function readString(buffer, el) {
  const bytes = new Uint8Array(buffer, el.offset, el.length);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s.replace(/[\0\s]+$/, '').trim();
}

/** Parse a DICOM file into a lightweight element tree. */
export function parseDicom(buffer) {
  const p = new Parser(buffer);
  let offset = 0;
  let meta = new Map();
  if (p.size >= 132 && String.fromCharCode(...new Uint8Array(buffer, 128, 4)) === 'DICM') {
    offset = 132;
    // File meta group: always explicit VR little endian.
    const metaEnd = (() => {
      let o = offset;
      while (o + 8 <= p.size && p.u16(o) === 0x0002) {
        const vr = String.fromCharCode(p.view.getUint8(o + 4), p.view.getUint8(o + 5));
        o += LONG_VR.has(vr) ? 12 + p.u32(o + 8) : 8 + p.u16(o + 6);
      }
      return o;
    })();
    meta = p.dataset(offset, metaEnd, true).elements;
    offset = metaEnd;
  }
  const tsEl = meta.get(TAGS.TransferSyntaxUID);
  const transferSyntax = tsEl ? readString(buffer, tsEl) : TS.IMPLICIT_LE;
  if (transferSyntax === TS.EXPLICIT_BE) throw new Error('Big-endian DICOM is not supported. Re-export the image as little endian.');
  if (transferSyntax === TS.DEFLATED) throw new Error('Deflated DICOM is not supported. Re-export the image uncompressed.');
  const explicit = transferSyntax !== TS.IMPLICIT_LE;
  const { elements } = p.dataset(offset, p.size, explicit);
  const get = (tag, items = elements) => readValue(buffer, items.get(tag));
  return { buffer, transferSyntax, elements, meta, get };
}

/** The Sequence of Ultrasound Regions as plain objects. */
export function ultrasoundRegions(dcm) {
  const seq = dcm.elements.get(TAGS.SequenceOfUltrasoundRegions);
  if (!seq || !seq.items) return [];
  return seq.items.map((item) => {
    const g = (t) => dcm.get(t, item);
    return {
      x0: g(TAGS.RegionLocationMinX0),
      y0: g(TAGS.RegionLocationMinY0),
      x1: g(TAGS.RegionLocationMaxX1),
      y1: g(TAGS.RegionLocationMaxY1),
      spatialFormat: g(TAGS.RegionSpatialFormat),
      dataType: g(TAGS.RegionDataType),
      flags: g(TAGS.RegionFlags),
      refX: g(TAGS.ReferencePixelX0) ?? 0,
      refY: g(TAGS.ReferencePixelY0) ?? 0,
      unitsX: g(TAGS.PhysicalUnitsXDirection),
      unitsY: g(TAGS.PhysicalUnitsYDirection),
      refPhysX: g(TAGS.ReferencePixelPhysicalValueX) ?? 0,
      refPhysY: g(TAGS.ReferencePixelPhysicalValueY) ?? 0,
      deltaX: g(TAGS.PhysicalDeltaX),
      deltaY: g(TAGS.PhysicalDeltaY),
      dopplerAngle: g(TAGS.DopplerCorrectionAngle),
      prf: g(TAGS.PulseRepetitionFrequency),
    };
  });
}

/**
 * Calibration for the first spectral Doppler region (time in s on x,
 * velocity in cm/s on y), in the form used by extractEnvelope().
 * Reference pixel coordinates are relative to the region's top-left corner.
 */
export function spectralCalibration(regions) {
  const r = regions.find((q) => q.unitsX === 4 && q.unitsY === 7 && q.deltaX && q.deltaY);
  if (!r) return null;
  return {
    region: { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 },
    baselineY: r.y0 + r.refY - r.refPhysY / r.deltaY,
    velPerPx: -r.deltaY / 100,
    secPerPx: r.deltaX,
    tOffset: r.refPhysX - r.refX * r.deltaX,
    dopplerAngle: r.dopplerAngle,
    dataType: REGION_TYPES[r.dataType] ?? `type ${r.dataType}`,
    source: 'DICOM ultrasound region',
  };
}

export function imageInfo(dcm) {
  const g = (t) => dcm.get(t);
  return {
    rows: g(TAGS.Rows),
    columns: g(TAGS.Columns),
    samplesPerPixel: g(TAGS.SamplesPerPixel) ?? 1,
    photometric: g(TAGS.PhotometricInterpretation) ?? 'MONOCHROME2',
    planar: g(TAGS.PlanarConfiguration) ?? 0,
    frames: g(TAGS.NumberOfFrames) ?? 1,
    bitsAllocated: g(TAGS.BitsAllocated) ?? 8,
    pixelRepresentation: g(TAGS.PixelRepresentation) ?? 0,
    modality: g(TAGS.Modality),
    manufacturer: g(TAGS.Manufacturer),
    model: g(TAGS.ManufacturerModelName),
    transferSyntax: dcm.transferSyntax,
  };
}

const clamp8 = (x) => (x < 0 ? 0 : x > 255 ? 255 : Math.round(x));

/** Decode one uncompressed frame to RGBA. */
export function decodeUncompressed(dcm, frame = 0) {
  const info = imageInfo(dcm);
  const px = dcm.elements.get(TAGS.PixelData);
  if (!px || px.fragments) throw new Error('No uncompressed pixel data.');
  const { rows, columns: cols, samplesPerPixel: spp, bitsAllocated: bits } = info;
  const bpp = bits / 8;
  const frameBytes = rows * cols * spp * bpp;
  const start = px.offset + frame * frameBytes;
  if (start + frameBytes > dcm.buffer.byteLength) throw new Error('Pixel data is shorter than expected.');
  const src = new Uint8Array(dcm.buffer, start, frameBytes);
  const out = new Uint8ClampedArray(rows * cols * 4);
  const pi = info.photometric.toUpperCase();
  if (pi === 'PALETTE COLOR') throw new Error('Palette-colour DICOM is not supported. Export as RGB or JPEG.');
  if (spp === 1) {
    let read;
    if (bits === 8) read = (i) => src[i];
    else {
      const dv = new DataView(dcm.buffer, start, frameBytes);
      const raw = (i) => (info.pixelRepresentation ? dv.getInt16(2 * i, true) : dv.getUint16(2 * i, true));
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < rows * cols; i++) {
        const v = raw(i);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const s = hi > lo ? 255 / (hi - lo) : 1;
      read = (i) => (raw(i) - lo) * s;
    }
    for (let i = 0; i < rows * cols; i++) {
      let g = read(i);
      if (pi === 'MONOCHROME1') g = 255 - g;
      out[4 * i] = out[4 * i + 1] = out[4 * i + 2] = g;
      out[4 * i + 3] = 255;
    }
  } else if (spp === 3 && bits === 8) {
    const n = rows * cols;
    for (let i = 0; i < n; i++) {
      let a;
      let b;
      let c;
      if (pi === 'YBR_FULL_422') {
        const pair = i >> 1;
        a = src[4 * pair + (i & 1)];
        b = src[4 * pair + 2];
        c = src[4 * pair + 3];
      } else if (info.planar === 1) {
        a = src[i];
        b = src[n + i];
        c = src[2 * n + i];
      } else {
        a = src[3 * i];
        b = src[3 * i + 1];
        c = src[3 * i + 2];
      }
      if (pi.startsWith('YBR')) {
        out[4 * i] = clamp8(a + 1.402 * (c - 128));
        out[4 * i + 1] = clamp8(a - 0.344136 * (b - 128) - 0.714136 * (c - 128));
        out[4 * i + 2] = clamp8(a + 1.772 * (b - 128));
      } else {
        out[4 * i] = a;
        out[4 * i + 1] = b;
        out[4 * i + 2] = c;
      }
      out[4 * i + 3] = 255;
    }
  } else {
    throw new Error(`Unsupported pixel layout (${spp} samples, ${bits} bits).`);
  }
  return { width: cols, height: rows, data: out };
}

/** Bytes of one encapsulated (JPEG) frame. */
export function encapsulatedFrame(dcm, frame = 0) {
  const px = dcm.elements.get(TAGS.PixelData);
  if (!px || !px.fragments) throw new Error('No encapsulated pixel data.');
  const frags = px.fragments.slice(1); // the first item is the Basic Offset Table
  const nFrames = imageInfo(dcm).frames;
  const bytes = (f) => new Uint8Array(dcm.buffer, f.offset, f.length);
  let groups;
  if (nFrames <= 1) groups = [frags];
  else if (frags.length === nFrames) groups = frags.map((f) => [f]);
  else {
    groups = [];
    for (const f of frags) {
      const b = bytes(f);
      if (b[0] === 0xff && b[1] === 0xd8) groups.push([f]);
      else if (groups.length) groups[groups.length - 1].push(f);
    }
  }
  const g = groups[Math.min(frame, groups.length - 1)];
  const total = g.reduce((s, f) => s + f.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const f of g) {
    out.set(bytes(f), o);
    o += f.length;
  }
  return out;
}

/** Decode a frame to RGBA in the browser (JPEG via the built-in decoder). */
export async function decodeFrame(dcm, frame = 0) {
  const ts = dcm.transferSyntax;
  if (ts === TS.IMPLICIT_LE || ts === TS.EXPLICIT_LE) return decodeUncompressed(dcm, frame);
  if (ts === TS.JPEG_BASELINE || ts === TS.JPEG_EXTENDED) {
    const blob = new Blob([encapsulatedFrame(dcm, frame)], { type: 'image/jpeg' });
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const id = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return { width: id.width, height: id.height, data: id.data };
  }
  throw new Error(`This DICOM compression (${ts}) is not supported yet. Export the capture uncompressed, as JPEG, or as PNG.`);
}
