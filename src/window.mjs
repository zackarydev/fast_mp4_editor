import { BLACK } from './analyse.mjs';

// The phone window: an out.w x out.h picture taken from the source at any
// centre, angle and size. Everything here is in source pixels, y down.
//
//   cx, cy  where the window's centre sits
//   rot     degrees the picture turns clockwise on its way out, as ffmpeg's
//           rotate counts them; the window itself lies turned the other way
//   scale   output pixels per source pixel: 1 takes 1080x1920 of the source,
//           0.5 takes 2160x3840, which is a whole 4K frame on its side
//
// Blackspace is the share of the output that shows no content: picture past
// the source's edge, or source that is itself black.

export const OUT = { w: 1080, h: 1920 };
// Past twice, a 4K source is being upscaled into mush.
export const MAX_SCALE = 2;
// The share of content a fitted window keeps along each of its axes: a stray
// label or cursor at the far edge is not worth a window twice the size.
export const KEEP = 0.96;
// Cells across a content grid: fine enough to fit to, coarse enough to scan many angles.
export const GRID = 160;
// A cell's neighbourhood, for how dense the content around it is: a fortieth
// of the frame each way, about a button on a 4K screen.
export const DENSE = 40;

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// The window's own right and down, as source directions.
export function axes(rot) {
  const c = Math.cos(rot * DEG);
  const s = Math.sin(rot * DEG);
  return { ux: [c, -s], uy: [s, c] };
}

export const sizeOf = (scale, out = OUT) => ({ w: out.w / scale, h: out.h / scale });

// Half the upright box a w x h rectangle covers when turned rot degrees.
export function reach(w, h, rot) {
  const c = Math.abs(Math.cos(rot * DEG));
  const s = Math.abs(Math.sin(rot * DEG));
  return { x: (w * c + h * s) / 2, y: (w * s + h * c) / 2 };
}

// Where output pixel (x, y) is taken from in the source.
export function mapper(win, out = OUT) {
  const { ux, uy } = axes(win.rot);
  return (x, y, at = [0, 0]) => {
    const u = (x - out.w / 2) / win.scale;
    const v = (y - out.h / 2) / win.scale;
    at[0] = win.cx + u * ux[0] + v * uy[0];
    at[1] = win.cy + u * ux[1] + v * uy[1];
    return at;
  };
}

// A turned rectangle lies inside an upright one exactly when its upright box
// does. So shrink the window until that box fits the bounds, if it must, then
// slide it in: whatever it was asked for, it never shows past the bounds.
export function contain(win, bounds, out = OUT) {
  const { w, h } = sizeOf(win.scale, out);
  const r = reach(w, h, win.rot);
  const k = Math.max(1, (2 * r.x) / (bounds.x1 - bounds.x0), (2 * r.y) / (bounds.y1 - bounds.y0));
  return {
    cx: clamp(win.cx, bounds.x0 + r.x / k, bounds.x1 - r.x / k),
    cy: clamp(win.cy, bounds.y0 + r.y / k, bounds.y1 - r.y / k),
    rot: win.rot,
    scale: win.scale * k,
  };
}

// The weight a fit gives each lit cell: its own light times the square of its
// neighbourhood's, so a solid subject outweighs the thin lines and stray
// labels scattered around it, which are lit but mostly black between.
function weights(lit, gw, gh) {
  const r = Math.max(1, Math.round(gw / DENSE));
  const sat = new Float64Array((gw + 1) * (gh + 1));
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      sat[(y + 1) * (gw + 1) + x + 1] = lit[y * gw + x] + sat[y * (gw + 1) + x + 1]
        + sat[(y + 1) * (gw + 1) + x] - sat[y * (gw + 1) + x];
    }
  }
  const out = new Float64Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(gh, y + r + 1);
    for (let x = 0; x < gw; x++) {
      if (!lit[y * gw + x]) continue;
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(gw, x + r + 1);
      const around = (sat[y1 * (gw + 1) + x1] - sat[y0 * (gw + 1) + x1] - sat[y1 * (gw + 1) + x0] + sat[y0 * (gw + 1) + x0])
        / ((x1 - x0) * (y1 - y0));
      out[y * gw + x] = lit[y * gw + x] * around * around;
    }
  }
  return out;
}

// A pass's pixels as cells, each the share of its pixels that are not black.
// The lit cells are also listed as source x, y and weight, which is all a fit reads.
export function gridOf(rgb, w, h, frame, black = BLACK) {
  const f = Math.max(1, Math.ceil(w / GRID));
  const gw = Math.ceil(w / f);
  const gh = Math.ceil(h / f);
  const lit = new Float32Array(gw * gh);
  const all = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const row = Math.floor(y / f) * gw;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const c = row + Math.floor(x / f);
      all[c]++;
      if (Math.max(rgb[i], rgb[i + 1], rgb[i + 2]) > black) lit[c]++;
    }
  }
  for (let c = 0; c < lit.length; c++) lit[c] /= all[c];
  return withPoints({ w: gw, h: gh, cw: (f * frame.width) / w, ch: (f * frame.height) / h, cells: lit });
}

function withPoints(grid) {
  const weight = weights(grid.cells, grid.w, grid.h);
  const points = [];
  for (let c = 0; c < weight.length; c++) {
    if (weight[c]) points.push(((c % grid.w) + 0.5) * grid.cw, (Math.floor(c / grid.w) + 0.5) * grid.ch, weight[c]);
  }
  return { ...grid, points: Float64Array.from(points) };
}

// Grids of one pass averaged cell by cell: how often each cell was content.
export function meanGrid(grids) {
  const [first] = grids;
  const cells = new Float32Array(first.cells.length);
  for (const g of grids) for (let c = 0; c < cells.length; c++) cells[c] += g.cells[c] / grids.length;
  return withPoints({ ...first, cells });
}

const BINS = 1024;

// The span holding keep of the weight, trimmed evenly from both ends.
function spread(vals, weights, keep) {
  let lo = Infinity;
  let hi = -Infinity;
  let total = 0;
  for (let i = 0; i < vals.length; i++) {
    lo = Math.min(lo, vals[i]);
    hi = Math.max(hi, vals[i]);
    total += weights[i];
  }
  if (hi - lo < 1e-9) return [lo, hi];
  const k = (BINS - 1) / (hi - lo);
  const bins = new Float64Array(BINS);
  for (let i = 0; i < vals.length; i++) bins[Math.round((vals[i] - lo) * k)] += weights[i];
  const cut = (total * (1 - keep)) / 2;
  let a = 0;
  for (let acc = 0; acc + bins[a] <= cut; a++) acc += bins[a];
  let b = BINS - 1;
  for (let acc = 0; acc + bins[b] <= cut; b--) acc += bins[b];
  return [lo + a / k, lo + b / k];
}

// The window that wraps a frame's content tightest at a given angle: keep of
// the content along each of the window's own axes, widened or heightened to
// the phone's shape. What black it leaves is where the content's shape is not
// the phone's, or where the content is too small to zoom to.
export function hug(grid, rot, { keep = KEEP, out = OUT, maxScale = MAX_SCALE } = {}) {
  const n = grid.points.length / 3;
  if (!n) return null;
  const { ux, uy } = axes(rot);
  const us = new Float64Array(n);
  const vs = new Float64Array(n);
  const ms = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = grid.points[i * 3];
    const y = grid.points[i * 3 + 1];
    us[i] = x * ux[0] + y * ux[1];
    vs[i] = x * uy[0] + y * uy[1];
    ms[i] = grid.points[i * 3 + 2];
  }
  // Cells are points here, so each end gains back half a cell.
  const cell = reach(grid.cw, grid.ch, rot);
  const [u0, u1] = spread(us, ms, keep);
  const [v0, v1] = spread(vs, ms, keep);
  const w = Math.max(u1 - u0 + 2 * cell.x, ((v1 - v0 + 2 * cell.y) * out.w) / out.h);
  const u = (u0 + u1) / 2;
  const v = (v0 + v1) / 2;
  return { cx: u * ux[0] + v * uy[0], cy: u * ux[1] + v * uy[1], rot, scale: Math.min(maxScale, out.w / w) };
}

// The share of a frame's content, weighted as a fit weighs it, that falls
// outside the window: the other way a crop goes wrong.
export function lost(win, grid, out = OUT) {
  const { ux, uy } = axes(win.rot);
  const hw = out.w / win.scale / 2;
  const hh = out.h / win.scale / 2;
  let total = 0;
  let outside = 0;
  for (let i = 0; i < grid.points.length; i += 3) {
    const dx = grid.points[i] - win.cx;
    const dy = grid.points[i + 1] - win.cy;
    const m = grid.points[i + 2];
    total += m;
    if (Math.abs(dx * ux[0] + dy * ux[1]) > hw || Math.abs(dx * uy[0] + dy * uy[1]) > hh) outside += m;
  }
  return total ? outside / total : 0;
}

// Read on a lattice over the output, so a window measures the same whichever
// pass's grid it is read against.
export function blackspace(win, grid, out = OUT, across = 36) {
  const at = mapper(win, out);
  const down = Math.round((across * out.h) / out.w);
  const p = [0, 0];
  let black = 0;
  for (let j = 0; j < down; j++) {
    for (let i = 0; i < across; i++) {
      at(((i + 0.5) * out.w) / across, ((j + 0.5) * out.h) / down, p);
      const gx = Math.floor(p[0] / grid.cw);
      const gy = Math.floor(p[1] / grid.ch);
      black += gx < 0 || gy < 0 || gx >= grid.w || gy >= grid.h ? 1 : 1 - grid.cells[gy * grid.w + gx];
    }
  }
  return black / (across * down);
}
