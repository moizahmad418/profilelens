// Generates icons/icon-{16,32,48,128}.png from the logo artwork, with no dependencies.
//   node tools/make-icons.js [path/to/logo.png]      (default: tools/logo.png)
// The logo is found in the artwork (everything brighter than its dark backdrop), cropped to
// a square around it and drawn on a dark rounded tile, so it reads on light and dark toolbars.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 32, 48, 128];
const TILE_RADIUS = 0.22; // corner radius, as a share of the icon's width
const MARGIN = 0.04; // space kept around the logo, as a share of the crop
const BRIGHT = 96; // a pixel belongs to the logo when any channel is brighter than this

// ---------- PNG reading (8-bit RGB / RGBA, not interlaced) ----------

function readPng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG file: ' + file);
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const colorType = data[9];
      if (data[8] !== 8 || (colorType !== 2 && colorType !== 6) || data[12] !== 0) {
        throw new Error('Unsupported PNG (needs 8-bit RGB or RGBA, not interlaced)');
      }
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      const v = raw[line + x];
      const add = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
      pixels[y * stride + x] = (v + add) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

// ---------- PNG writing ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- artwork -> icon ----------

// The square around the logo: the bounding box of its bright pixels, plus a margin.
function logoSquare(img) {
  let x0 = img.width;
  let y0 = img.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * img.channels;
      if (Math.max(img.pixels[i], img.pixels[i + 1], img.pixels[i + 2]) <= BRIGHT) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error('No logo found in the artwork');
  const side = Math.max(x1 - x0, y1 - y0) * (1 + MARGIN * 2);
  return { left: (x0 + x1) / 2 - side / 2, top: (y0 + y1) / 2 - side / 2, side };
}

function inRoundedSquare(u, v, r) {
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
}

// Each icon pixel is the average of the artwork under it (the backdrop colour outside it).
function render(img, square, size) {
  const out = Buffer.alloc(size * size * 4);
  const backdrop = [img.pixels[0], img.pixels[1], img.pixels[2]];
  const step = square.side / size;
  const taps = Math.max(2, Math.min(24, Math.ceil(step)));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let inside = 0;
      for (let sy = 0; sy < taps; sy++) {
        for (let sx = 0; sx < taps; sx++) {
          const u = (x + (sx + 0.5) / taps) / size;
          const v = (y + (sy + 0.5) / taps) / size;
          if (!inRoundedSquare(u, v, TILE_RADIUS)) continue;
          inside++;
          const px = Math.floor(square.left + u * square.side);
          const py = Math.floor(square.top + v * square.side);
          if (px < 0 || py < 0 || px >= img.width || py >= img.height) {
            r += backdrop[0]; g += backdrop[1]; b += backdrop[2];
          } else {
            const i = (py * img.width + px) * img.channels;
            r += img.pixels[i]; g += img.pixels[i + 1]; b += img.pixels[i + 2];
          }
        }
      }
      if (!inside) continue;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / inside);
      out[o + 1] = Math.round(g / inside);
      out[o + 2] = Math.round(b / inside);
      out[o + 3] = Math.round((inside / (taps * taps)) * 255);
    }
  }
  return out;
}

const source = path.resolve(process.argv[2] || path.join(__dirname, 'logo.png'));
const img = readPng(source);
const square = logoSquare(img);
const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const size of SIZES) {
  const file = path.join(dir, 'icon-' + size + '.png');
  fs.writeFileSync(file, png(size, render(img, square, size)));
  console.log('wrote', path.relative(process.cwd(), file));
}
