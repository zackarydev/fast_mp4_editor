// A pass as one picture: every frame it decoded, tiled in time order. Tiles
// land as frames arrive, in any order, so the sheet is complete the moment the
// last frame is.

export const PAD = 0;
export const BACKDROP = 0;
export const CENTRE = [255, 0, 200];
// Past this the sheet stops being something to look at and starts being a memory problem.
export const MAX_PIXELS = 64 * 1024 * 1024;

// Columns chosen so the whole sheet comes out near 16:9 whatever the tile shape.
export function layout(n, w, h, pad = PAD) {
  const cols = Math.max(1, Math.min(n, Math.ceil(Math.sqrt((n * 16 * h) / (9 * w)))));
  const rows = Math.max(1, Math.ceil(n / cols));
  return { cols, rows, w, h, pad, W: cols * w + (cols + 1) * pad, H: rows * h + (rows + 1) * pad };
}

export function createSheet(frames, w, h) {
  const l = layout(frames.length, w, h);
  if (l.W * l.H > MAX_PIXELS) return null;
  const slot = new Map(frames.map((f, i) => [f, i]));
  return { ...l, slot, rgb: new Uint8Array(l.W * l.H * 3).fill(BACKDROP) };
}

export function origin(sheet, i) {
  const c = i % sheet.cols;
  const r = Math.floor(i / sheet.cols);
  return { ox: sheet.pad + c * (sheet.w + sheet.pad), oy: sheet.pad + r * (sheet.h + sheet.pad) };
}

export function place(sheet, frame, rgb) {
  const i = sheet.slot.get(frame);
  if (i == null) return;
  const { ox, oy } = origin(sheet, i);
  const row = sheet.w * 3;
  for (let y = 0; y < sheet.h; y++) {
    sheet.rgb.set(rgb.subarray(y * row, (y + 1) * row), ((oy + y) * sheet.W + ox) * 3);
  }
}

// The mobile window measured in a pass's pixels: 1080x1920 of a 3840x2160
// source is 90x160 of a 320x180 pass.
export function windowIn(passW, passH, source, win) {
  return {
    w: Math.min(passW, Math.max(1, Math.round((win.w * passW) / source.width))),
    h: Math.min(passH, Math.max(1, Math.round((win.h * passH) / source.height))),
  };
}

// Cut a cw x ch window centred at (cx, cy) out of a w x h frame, pulled back
// inside the frame so a centre near the edge never reads past it.
export function cut(rgb, w, h, cx, cy, cw, ch) {
  const x0 = Math.min(Math.max(Math.round(cx - cw / 2), 0), w - cw);
  const y0 = Math.min(Math.max(Math.round(cy - ch / 2), 0), h - ch);
  const tile = new Uint8Array(cw * ch * 3);
  for (let y = 0; y < ch; y++) {
    const from = ((y0 + y) * w + x0) * 3;
    tile.set(rgb.subarray(from, from + cw * 3), y * cw * 3);
  }
  return tile;
}

// Drawing is clipped to the tile, so a mark at the frame edge never bleeds into a neighbour.
function plot(sheet, i, x, y, colour) {
  if (x < 0 || y < 0 || x >= sheet.w || y >= sheet.h) return;
  const { ox, oy } = origin(sheet, i);
  sheet.rgb.set(colour, ((oy + y) * sheet.W + ox + x) * 3);
}

export function mark(sheet, i, point, colour = CENTRE) {
  const r = Math.max(1, Math.round(sheet.w / 80));
  const cx = Math.floor(point.x * sheet.w);
  const cy = Math.floor(point.y * sheet.h);
  for (let d = -r; d <= r; d++) {
    plot(sheet, i, cx + d, cy, colour);
    plot(sheet, i, cx, cy + d, colour);
  }
}
