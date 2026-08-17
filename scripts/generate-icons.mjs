/**
 * Generate the app icons.
 *
 * Run with `npm run icons`. The PNGs it writes are committed, so a build never
 * depends on this, but the mark is defined here as code rather than as a binary
 * nobody can edit: changing the colour or the weight of the ring is a two line
 * change and a rerun.
 *
 * It writes the PNGs itself. Every raster library that could do this is a
 * dependency with a native build step, for a job that is a few hundred lines of
 * arithmetic and one call to zlib, which node already has.
 *
 * The mark is a ring with a dot on it: a cycle, and where in it you are. It sits
 * inside the maskable safe zone (the middle 80%, which is what a launcher is
 * allowed to crop to) so the same file works masked and unmasked.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

/** Background gradient, top to bottom, and the mark drawn over it. */
const BACKGROUND_TOP = [184, 54, 90];
const BACKGROUND_BOTTOM = [104, 28, 62];
const MARK = [255, 255, 255];

// Fractions of the icon's width, so every size is the same drawing.
const RING_RADIUS = 0.235;
const RING_THICKNESS = 0.062;
const DOT_RADIUS = 0.055;
/** Where on the ring the dot sits. -PI/2 is straight up. */
const DOT_ANGLE = -Math.PI / 2;
/**
 * Half-width of the break in the ring, in radians.
 *
 * Without it the dot reads as a lump welded onto the ring. Cutting the ring away
 * around the dot leaves a marker sitting in a gap, which is the thing the mark
 * is meant to say.
 */
const RING_GAP = 0.34;
/** Samples per axis inside each pixel. 3x3 is enough to hide the stair-stepping. */
const SUPERSAMPLE = 3;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** 8-bit RGBA, no interlacing, one filter-0 scanline per row. */
function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function mix(a, b, t) {
  return a.map((channel, index) => Math.round(channel + (b[index] - channel) * t));
}

/**
 * Coverage of the mark at one point, in [0, 1].
 *
 * The ring and the dot are unioned by taking the larger coverage rather than by
 * adding them, so where the dot overlaps the ring the result stays at 1 instead
 * of clipping to a brighter seam.
 */
function markCoverage(x, y, size) {
  const cx = size / 2;
  const cy = size / 2;
  const dx = x - cx;
  const dy = y - cy;

  const ringRadius = RING_RADIUS * size;
  const half = (RING_THICKNESS * size) / 2;
  const distance = Math.hypot(dx, dy);
  // Angular distance to the dot, wrapped into [0, PI] by going through the unit
  // circle rather than by juggling modulo signs.
  const offset = Math.atan2(dy, dx) - DOT_ANGLE;
  const angularGap = Math.abs(Math.atan2(Math.sin(offset), Math.cos(offset)));
  const onRing = Math.abs(distance - ringRadius) <= half && angularGap > RING_GAP ? 1 : 0;

  const dotX = cx + Math.cos(DOT_ANGLE) * ringRadius;
  const dotY = cy + Math.sin(DOT_ANGLE) * ringRadius;
  const inDot = Math.hypot(x - dotX, y - dotY) <= DOT_RADIUS * size ? 1 : 0;

  return Math.max(onRing, inDot);
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const step = 1 / SUPERSAMPLE;
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let y = 0; y < size; y += 1) {
    const background = mix(BACKGROUND_TOP, BACKGROUND_BOTTOM, size === 1 ? 0 : y / (size - 1));
    for (let x = 0; x < size; x += 1) {
      let covered = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          covered += markCoverage(x + (sx + 0.5) * step, y + (sy + 0.5) * step, size);
        }
      }
      const alpha = covered / samples;
      const colour = mix(background, MARK, alpha);
      const offset = (y * size + x) * 4;
      rgba[offset] = colour[0];
      rgba[offset + 1] = colour[1];
      rgba[offset + 2] = colour[2];
      rgba[offset + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

const ICONS = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  // iOS does not round the corners of an apple-touch-icon it is given, it masks
  // it, so this is the same square drawing at the size iOS asks for.
  ['apple-touch-icon.png', 180],
  ['favicon-32.png', 32],
];

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, size] of ICONS) {
  writeFileSync(join(OUT_DIR, name), render(size));
  process.stdout.write(`wrote ${name} (${size}x${size})\n`);
}
