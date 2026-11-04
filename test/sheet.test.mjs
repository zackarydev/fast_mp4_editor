import test from 'node:test';
import assert from 'node:assert/strict';
import {
  layout, createSheet, place, mark, origin, windowIn, cut, BACKDROP, CENTRE, MAX_PIXELS,
} from '../src/sheet.mjs';

const px = (sheet, x, y) => [...sheet.rgb.subarray((y * sheet.W + x) * 3, (y * sheet.W + x) * 3 + 3)];

test('30 widescreen tiles lay out 6 by 5, near 16:9', () => {
  const l = layout(30, 320, 180);
  assert.equal(l.cols, 6);
  assert.equal(l.rows, 5);
  assert.equal(l.W, 6 * 320);
});

test('one frame is one tile, and a sheet too big to hold is skipped', () => {
  assert.deepEqual([layout(1, 64, 36).cols, layout(1, 64, 36).rows], [1, 1]);
  const huge = Math.ceil(MAX_PIXELS / (320 * 180)) + 100;
  assert.equal(createSheet([...Array(huge).keys()], 320, 180), null);
});

test('a frame lands in its time slot whatever order it arrives in', () => {
  const sheet = createSheet([10, 20, 30], 2, 2);
  place(sheet, 30, new Uint8Array(12).fill(200));
  const { ox, oy } = origin(sheet, 2);
  assert.deepEqual(px(sheet, ox, oy), [200, 200, 200]);
  assert.deepEqual(px(sheet, origin(sheet, 0).ox, origin(sheet, 0).oy), [BACKDROP, BACKDROP, BACKDROP]);
});

test('a mark at the frame edge is clipped to its own tile', () => {
  const sheet = createSheet([0, 1], 10, 10);
  mark(sheet, 0, { x: 1, y: 0.5 });
  const a = origin(sheet, 0);
  const b = origin(sheet, 1);
  assert.deepEqual(px(sheet, a.ox + 9, a.oy + 5), CENTRE);
  assert.deepEqual(px(sheet, b.ox, b.oy + 5), [BACKDROP, BACKDROP, BACKDROP]);
});

test('the mobile window scales into each pass', () => {
  const source = { width: 3840, height: 2160 };
  const win = { w: 1080, h: 1920 };
  assert.deepEqual(windowIn(320, 180, source, win), { w: 90, h: 160 });
  assert.deepEqual(windowIn(64, 36, source, win), { w: 18, h: 32 });
});

test('a cut takes the window as the phone shows it: turned, and black past the frame', () => {
  // A 32x18 pass of a 4K frame, so one pass pixel is 120 source pixels and a
  // scale-1 window is 9x16 of them. Red is the column, green is lit everywhere.
  const frame = { width: 3840, height: 2160 };
  const rgb = new Uint8Array(32 * 18 * 3);
  for (let i = 0; i < 32 * 18; i++) rgb.set([i % 32, 255, 0], i * 3);
  const row = (t) => [...Array(9).keys()].map((i) => t[i * 3]);
  assert.deepEqual(row(cut(rgb, 32, 18, frame, { cx: 1980, cy: 1080, rot: 0, scale: 1 }, 9, 16)), [12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.deepEqual(row(cut(rgb, 32, 18, frame, { cx: 1980, cy: 1080, rot: 180, scale: 1 }, 9, 16)), [20, 19, 18, 17, 16, 15, 14, 13, 12]);
  const edge = cut(rgb, 32, 18, frame, { cx: 0, cy: 1080, rot: 0, scale: 1 }, 9, 16);
  assert.deepEqual([...edge.subarray(0, 3)], [0, 0, 0]);
  assert.equal(edge[8 * 3 + 1], 255);
});
