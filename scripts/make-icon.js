/**
 * Draws the app icon (two rings on a dark rounded tile) and writes
 * build/icon.png and build/icon.ico. No dependencies: `node scripts/make-icon.js`.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const SS = 3; // supersampling per axis, for smooth edges

const inTile = (x, y) => {
  const r = 56, m = 8, lo = m + r, hi = SIZE - m - r;
  const cx = Math.min(Math.max(x, lo), hi), cy = Math.min(Math.max(y, lo), hi);
  return Math.hypot(x - cx, y - cy) <= r;
};
// Each ring: track all the way round, arc for part of it (starting at 12 o'clock, clockwise).
const RINGS = [
  { r: 86, w: 11, rgb: [47, 194, 107], part: 0.78 },
  { r: 56, w: 11, rgb: [250, 178, 25], part: 0.55 },
];

function sample(x, y) {
  if (!inTile(x, y)) return [0, 0, 0, 0];
  const dx = x - SIZE / 2, dy = y - SIZE / 2;
  const d = Math.hypot(dx, dy);
  for (const ring of RINGS) {
    if (Math.abs(d - ring.r) > ring.w) continue;
    let turn = Math.atan2(dx, -dy) / (2 * Math.PI);
    if (turn < 0) turn += 1;
    return turn <= ring.part ? [...ring.rgb, 255] : [58, 58, 58, 255];
  }
  return [24, 24, 24, 255];
}

const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const acc = [0, 0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const s = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
      const a = s[3] / 255;
      acc[0] += s[0] * a; acc[1] += s[1] * a; acc[2] += s[2] * a; acc[3] += a;
    }
    const i = (y * SIZE + x) * 4;
    const a = acc[3] || 1;
    rgba[i] = acc[0] / a; rgba[i + 1] = acc[1] / a; rgba[i + 2] = acc[2] / a; rgba[i + 3] = (acc[3] / (SS * SS)) * 255;
  }
}

// ---- PNG
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 6;
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);

// ---- ICO wrapping the PNG (Windows Vista+ reads PNG-compressed icons)
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);          // type: icon, one image
ico[6] = 0; ico[7] = 0;                                     // 0 = 256 px
ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);        // planes, bits per pixel
ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);

const out = path.join(__dirname, '..', 'build');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), png);
fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([ico, png]));
console.log('build/icon.png, build/icon.ico');
