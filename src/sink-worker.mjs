import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { analyseFrame, aggregate, suggestCrop } from './analyse.mjs';
import { createSheet, place, outline, mark, windowIn, cut } from './sheet.mjs';

// Frames arrive here off the decode thread. Today they become PNGs plus a
// manifest; another sink only has to answer the same three messages. Each
// frame is also read for where its content and colour sit, which costs
// microseconds at these sizes, so the pass doubles as a crop finder.

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const { out, source, frameSize, window: win, sheetMode } = workerData;
const manifest = { source, passes: {} };
const seen = {};
const sheets = {};

function flush() {
  for (const p of Object.values(manifest.passes)) p.frames.sort((a, b) => a.frame - b.frame);
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

// Mobile: each tile already is its frame's crop, so there is nothing to draw.
// Desktop: the suggested window is the same on every tile and the colour centre
// is each frame's own, so a centre outside the window is a frame the crop loses.
function writeSheet(name, crop) {
  const sheet = sheets[name];
  if (!sheet) return null;
  for (const f of sheetMode === 'desktop' ? manifest.passes[name].frames : []) {
    const i = sheet.slot.get(f.frame);
    if (crop) {
      const { w, h } = win;
      outline(sheet, i, {
        x0: (crop.cx - w / 2) / frameSize.width, x1: (crop.cx + w / 2) / frameSize.width,
        y0: (crop.cy - h / 2) / frameSize.height, y1: (crop.cy + h / 2) / frameSize.height,
      });
    }
    if (f.centre) mark(sheet, i, f.centre);
  }
  const file = `sheet-${name}.png`;
  fs.writeFileSync(path.join(out, file), png(sheet.W, sheet.H, sheet.rgb));
  return file;
}

parentPort.on('message', (msg) => {
  if (msg.type === 'pass') {
    fs.mkdirSync(path.join(out, msg.pass.name), { recursive: true });
    manifest.passes[msg.pass.name] = { ...msg.pass, frames: [] };
    seen[msg.pass.name] = [];
    const tile = sheetMode === 'mobile' ? windowIn(msg.pass.w, msg.pass.h, frameSize, win) : msg.pass;
    sheets[msg.pass.name] = sheetMode === 'none' ? null : createSheet(msg.frames, tile.w, tile.h);
  } else if (msg.type === 'frame') {
    const file = path.join(msg.pass, `f${String(msg.frame).padStart(7, '0')}.png`);
    fs.writeFileSync(path.join(out, file), png(msg.w, msg.h, msg.data));
    const a = analyseFrame(msg.data, msg.w, msg.h);
    seen[msg.pass].push(a);
    // This frame's own mobile crop: its colour centre, kept inside its content and the frame.
    const own = suggestCrop({ box: a.box, centre: a.centre }, frameSize, win)
      || { cx: frameSize.width / 2, cy: frameSize.height / 2 };
    const sheet = sheets[msg.pass];
    if (sheet && sheetMode === 'mobile') {
      const cx = (own.cx * msg.w) / frameSize.width;
      const cy = (own.cy * msg.h) / frameSize.height;
      place(sheet, msg.frame, cut(msg.data, msg.w, msg.h, cx, cy, sheet.w, sheet.h));
    } else if (sheet) {
      place(sheet, msg.frame, msg.data);
    }
    manifest.passes[msg.pass].frames.push({
      frame: msg.frame, pts: msg.pts, requested: msg.requested, file, box: a.box, centre: a.centre,
      mobile: { cx: own.cx, cy: own.cy },
    });
  } else if (msg.type === 'pass-end') {
    const crop = suggestCrop(aggregate(seen[msg.pass]), frameSize, workerData.window);
    const sheet = writeSheet(msg.pass, crop);
    Object.assign(manifest.passes[msg.pass], msg.stats, { crop, sheet });
    flush();
    parentPort.postMessage({ type: 'flushed', pass: msg.pass, crop, sheet });
  }
});
