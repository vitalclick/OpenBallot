#!/usr/bin/env node
// Generates the PWA icons referenced from public/manifest.json without
// pulling in sharp / canvas / imagemagick. The output is a flat
// OpenBallot-green square with a white "form" panel echoing the
// EC8A-first identity of the platform.
//
// Run once at build time (or whenever the manifest icon URLs change):
//   node web/scripts/generate-icons.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public');

// Nigerian green + clean white. Matches manifest.json theme_color.
const BG = [0x00, 0x87, 0x53];
const FG = [0xff, 0xff, 0xff];
const SIG_INK = [0x33, 0x33, 0x33];

function renderIcon(size) {
  const buf = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 3;
      // Default: green background.
      buf[o] = BG[0];
      buf[o + 1] = BG[1];
      buf[o + 2] = BG[2];

      // Centered white "form" rectangle: 50% width, 65% height.
      const formX0 = Math.round(size * 0.25);
      const formX1 = Math.round(size * 0.75);
      const formY0 = Math.round(size * 0.175);
      const formY1 = Math.round(size * 0.825);
      if (x >= formX0 && x < formX1 && y >= formY0 && y < formY1) {
        buf[o] = FG[0];
        buf[o + 1] = FG[1];
        buf[o + 2] = FG[2];

        // A single horizontal "signature line" near the bottom of the
        // form — 3% of icon height tall, 75% of form width wide.
        const sigY0 = Math.round(size * 0.72);
        const sigY1 = sigY0 + Math.max(2, Math.round(size * 0.02));
        const sigX0 = Math.round(size * 0.32);
        const sigX1 = Math.round(size * 0.68);
        if (x >= sigX0 && x < sigX1 && y >= sigY0 && y < sigY1) {
          buf[o] = SIG_INK[0];
          buf[o + 1] = SIG_INK[1];
          buf[o + 2] = SIG_INK[2];
        }
      }
    }
  }
  return encodePng(buf, size, size);
}

// Minimal PNG encoder — RGB, no alpha, no interlace.
function encodePng(rgb, width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type = RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // IDAT: per-row filter byte (0 = None) then RGB pixels.
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw);

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [192, 512]) {
  const path = resolve(OUT_DIR, `icon-${size}.png`);
  writeFileSync(path, renderIcon(size));
  console.log(`wrote ${path} (${size}x${size})`);
}
