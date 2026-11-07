#!/usr/bin/env node
/**
 * Draws the extension icon at 16/32/48/128 px into icons/ (no dependencies).
 *
 *   node tools/make-icons.js
 *
 * Design ("Highlighter" theme): a black tile with two white text lines and
 * one yellow highlighter stroke between them — "the part of the posting
 * that matters". Shapes are snapped to whole pixels per size so the 16px
 * toolbar icon stays crisp, and edges are anti-aliased by supersampling.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const INK = [17, 17, 17];
const WHITE = [255, 255, 255];
const YELLOW = [255, 231, 76]; // --mark-yellow in popup.css

// Shapes in fractions of the icon size: [x0, y0, x1, y1, cornerRadius, color, minThicknessPx]
const SHAPES = [
  [0, 0, 1, 1, 0.2, INK, 0],              // tile
  [0.22, 0.25, 0.70, 0.34, 0.02, WHITE, 2],  // text line
  [0.15, 0.43, 0.85, 0.59, 0.03, YELLOW, 3], // highlighter stroke
  [0.22, 0.68, 0.58, 0.77, 0.02, WHITE, 2]   // text line
];

const SS = 8; // supersamples per axis

// Snap a shape to whole pixels at this size, keeping a minimum thickness.
function snap([x0, y0, x1, y1, r, color, minT], size) {
  const px = (v) => Math.round(v * size);
  let [a, b, c, d] = [px(x0), px(y0), px(x1), px(y1)];
  if (d - b < minT) d = b + minT;
  return { x0: a, y0: b, x1: c, y1: d, r: r * size, color };
}

// Is point (x, y) inside the rounded rectangle?
function inside(s, x, y) {
  if (x < s.x0 || x > s.x1 || y < s.y0 || y > s.y1) return false;
  const r = Math.min(s.r, (s.x1 - s.x0) / 2, (s.y1 - s.y0) / 2);
  const cx = Math.min(Math.max(x, s.x0 + r), s.x1 - r);
  const cy = Math.min(Math.max(y, s.y0 + r), s.y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function render(size) {
  const shapes = SHAPES.map((sh) => snap(sh, size));
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Composite shapes in order ("over"), using per-shape coverage as alpha.
      let r = 0, g = 0, b = 0, a = 0;
      for (const s of shapes) {
        let hits = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            if (inside(s, px + (sx + 0.5) / SS, py + (sy + 0.5) / SS)) hits++;
          }
        }
        const cov = hits / (SS * SS);
        if (!cov) continue;
        r = s.color[0] * cov + r * (1 - cov);
        g = s.color[1] * cov + g * (1 - cov);
        b = s.color[2] * cov + b * (1 - cov);
        a = cov + a * (1 - cov);
      }
      const i = (py * size + px) * 4;
      // Stored colors are premultiplied above; un-premultiply for PNG.
      rgba[i] = a ? Math.round(r / a) : 0;
      rgba[i + 1] = a ? Math.round(g / a) : 0;
      rgba[i + 2] = a ? Math.round(b / a) : 0;
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return encodePNG(size, size, rgba);
}

// Minimal PNG encoder (RGBA, 8-bit, no interlace).
function encodePNG(w, h, rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, render(size));
  console.log('wrote', path.relative(process.cwd(), file));
}
