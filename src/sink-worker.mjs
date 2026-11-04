import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { analyseFrame, aggregate, suggestCrop } from './analyse.mjs';
import { createSheet, place, mark, windowIn, cut } from './sheet.mjs';
import { gridOf, blackspace, lost } from './window.mjs';
import { solve, windowAt } from './track.mjs';
import { png } from './png.mjs';

// Frames arrive here off the decode thread. Today they become PNGs plus a
// manifest; another sink only has to answer the same three messages. Each
// frame is also read for where its content sits, which costs microseconds at
// these sizes, so the pass doubles as a crop finder: at its end the window's
// track is solved over every frame it saw.

const { out, source, frameSize, window: win, sheetMode, track: trackOptions } = workerData;
const manifest = { source, passes: {} };
const seen = {};
const grids = {};
const sheets = {};
const tiles = {};
// Mobile tiles are cut from the window, which is only known once the pass is,
// so the pixels wait here till then.
const held = {};

function flush() {
  for (const p of Object.values(manifest.passes)) p.frames.sort((a, b) => a.frame - b.frame);
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

const round = (v, k) => Math.round(v * k) / k;
const rounded = (w) => ({ cx: round(w.cx, 10), cy: round(w.cy, 10), rot: round(w.rot, 100), scale: round(w.scale, 1e4) });
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const range = (xs) => (xs.length ? [Math.min(...xs), Math.max(...xs)] : null);

// Mobile: each tile is its frame's window as the phone shows it, so there is nothing to draw.
// Desktop: whole frames with only each frame's colour centre marked.
function writeSheet(pass) {
  const sheet = sheets[pass];
  if (!sheet) return null;
  for (const f of sheetMode === 'desktop' ? manifest.passes[pass].frames : []) {
    if (f.centre) mark(sheet, sheet.slot.get(f.frame), f.centre);
  }
  const file = `sheet-${pass}.png`;
  fs.writeFileSync(path.join(out, file), png(sheet.W, sheet.H, sheet.rgb));
  return file;
}

function handle(msg) {
  if (msg.type === 'pass') {
    fs.mkdirSync(path.join(out, msg.pass.name), { recursive: true });
    manifest.passes[msg.pass.name] = { ...msg.pass, frames: [] };
    seen[msg.pass.name] = [];
    grids[msg.pass.name] = new Map();
    held[msg.pass.name] = new Map();
    const tile = sheetMode === 'mobile' ? windowIn(msg.pass.w, msg.pass.h, frameSize, win) : msg.pass;
    tiles[msg.pass.name] = { w: tile.w, h: tile.h };
    sheets[msg.pass.name] = sheetMode === 'none' ? null : createSheet(msg.frames, tile.w, tile.h);
  } else if (msg.type === 'frame') {
    const file = path.join(msg.pass, `f${String(msg.frame).padStart(7, '0')}.png`);
    fs.writeFileSync(path.join(out, file), png(msg.w, msg.h, msg.data));
    const a = analyseFrame(msg.data, msg.w, msg.h);
    seen[msg.pass].push(a);
    grids[msg.pass].set(msg.frame, gridOf(msg.data, msg.w, msg.h, frameSize));
    if (sheetMode === 'mobile') held[msg.pass].set(msg.frame, msg);
    else if (sheets[msg.pass]) place(sheets[msg.pass], msg.frame, msg.data);
    manifest.passes[msg.pass].frames.push({
      frame: msg.frame, pts: msg.pts, requested: msg.requested, file,
      box: a.box, centre: a.centre,
    });
  } else if (msg.type === 'pass-end') {
    const pass = manifest.passes[msg.pass];
    const agg = aggregate(seen[msg.pass]);
    // The fixed upright 1080x1920 crop a pass suggested before there was a
    // track: what the window is measured against.
    const crop = suggestCrop(agg, frameSize, win);
    const bounds = agg.box
      ? { x0: agg.box.x0 * frameSize.width, y0: agg.box.y0 * frameSize.height,
        x1: agg.box.x1 * frameSize.width, y1: agg.box.y1 * frameSize.height }
      : { x0: 0, y0: 0, x1: frameSize.width, y1: frameSize.height };
    const samples = [...grids[msg.pass]].map(([frame, grid]) => ({ frame, grid }));
    const track = solve(samples, bounds, { ...trackOptions, out: win });
    const fixed = { blackspace: [], lost: [] };
    for (const f of pass.frames) {
      const grid = grids[msg.pass].get(f.frame);
      const w = windowAt(track, f.frame);
      Object.assign(f, {
        window: rounded(w), blackspace: round(blackspace(w, grid, win), 1e3), lost: round(lost(w, grid, win), 1e3),
      });
      if (crop) {
        const upright = { cx: crop.cx, cy: crop.cy, rot: 0, scale: 1 };
        fixed.blackspace.push(blackspace(upright, grid, win));
        fixed.lost.push(lost(upright, grid, win));
      }
      const px = held[msg.pass].get(f.frame);
      if (!px) continue;
      const t = tiles[msg.pass];
      const tile = cut(px.data, px.w, px.h, frameSize, w, t.w, t.h);
      if (sheets[msg.pass]) place(sheets[msg.pass], f.frame, tile);
    }
    held[msg.pass].clear();
    const windows = pass.frames.map((f) => f.window);
    const summary = {
      mode: track.mode,
      rot: range(windows.map((w) => w.rot)),
      scale: range(windows.map((w) => w.scale)),
      blackspace: round(mean(pass.frames.map((f) => f.blackspace)), 1e3),
      lost: round(mean(pass.frames.map((f) => f.lost)), 1e3),
      fixed: crop ? { blackspace: round(mean(fixed.blackspace), 1e3), lost: round(mean(fixed.lost), 1e3) } : null,
    };
    const sheet = writeSheet(msg.pass);
    Object.assign(pass, msg.stats, { crop, track, windows: summary, sheet });
    // The finest pass is the last, and its track is the one an export reads.
    manifest.track = track;
    flush();
    parentPort.postMessage({ type: 'flushed', pass: msg.pass, crop, windows: summary, sheet });
  }
}

parentPort.on('message', handle);
