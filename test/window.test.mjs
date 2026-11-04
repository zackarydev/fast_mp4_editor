import test from 'node:test';
import assert from 'node:assert/strict';
import { reach, mapper, contain, gridOf, hug, blackspace, OUT } from '../src/window.mjs';

const FRAME = { width: 3840, height: 2160 };
const BOUNDS = { x0: 0, y0: 0, x1: 3840, y1: 2160 };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// A 320x180 pass of a 4K frame, lit wherever paint says.
function pass(paint, w = 320, h = 180) {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (paint(x, y)) rgb.fill(200, (y * w + x) * 3, (y * w + x) * 3 + 3);
  return gridOf(rgb, w, h, FRAME);
}

const corners = (win) => [[0, 0], [OUT.w, 0], [OUT.w, OUT.h], [0, OUT.h]].map(([x, y]) => mapper(win)(x, y));

test('a quarter turn swaps the reach of the window across the axes', () => {
  assert.deepEqual(reach(1080, 1920, 0), { x: 540, y: 960 });
  const r = reach(1080, 1920, 90);
  assert.ok(near(r.x, 960) && near(r.y, 540));
});

test('a quarter turn clockwise shows a whole 4K frame on its side, its bottom-left at the top-left', () => {
  const win = { cx: 1920, cy: 1080, rot: 90, scale: 0.5 };
  const [topLeft, topRight, bottomRight] = corners(win);
  assert.ok(near(topLeft[0], 0) && near(topLeft[1], 2160));
  assert.ok(near(topRight[0], 0) && near(topRight[1], 0));
  assert.ok(near(bottomRight[0], 3840) && near(bottomRight[1], 0));
});

test('contain slides an upright window in from the edge without resizing it', () => {
  assert.deepEqual(contain({ cx: 100, cy: 1080, rot: 0, scale: 1 }, BOUNDS), { cx: 540, cy: 1080, rot: 0, scale: 1 });
});

test('a turned window too tall for the frame shrinks until every corner is inside', () => {
  const win = contain({ cx: 3800, cy: 100, rot: 30, scale: 1 }, BOUNDS);
  assert.ok(win.scale > 1);
  for (const [x, y] of corners(win)) assert.ok(x > -1e-6 && x < 3840 + 1e-6 && y > -1e-6 && y < 2160 + 1e-6, `${x},${y}`);
});

test('a window wider than a sideways frame grows its scale to the frame exactly', () => {
  const win = contain({ cx: 0, cy: 0, rot: 90, scale: 0.4 }, BOUNDS);
  assert.ok(near(win.scale, 0.5) && near(win.cx, 1920) && near(win.cy, 1080));
});

test('a window hugs a block of content to the phone shape, and leaves less black than the fixed crop', () => {
  // Lit over pass 80..160 x 20..160: source 960..1920 x 240..1920, 960 x 1680.
  const grid = pass((x, y) => x >= 80 && x < 160 && y >= 20 && y < 160);
  const win = hug(grid, 0, { keep: 1 });
  assert.ok(near(win.cx, 1440) && near(win.cy, 1080));
  assert.ok(near(win.scale, 1080 / 960));
  assert.ok(blackspace(win, grid) < 0.03);
  assert.ok(blackspace({ cx: 1440, cy: 1080, rot: 0, scale: 1 }, grid) > 0.1);
});

test('blackspace counts what lies past the frame as black', () => {
  const grid = pass(() => true);
  assert.equal(blackspace({ cx: 1920, cy: 1080, rot: 0, scale: 1 }, grid), 0);
  assert.ok(near(blackspace({ cx: 0, cy: 1080, rot: 0, scale: 1 }, grid), 0.5, 0.02));
});

test('a black frame has nothing to hug', () => {
  assert.equal(hug(pass(() => false), 0), null);
});
