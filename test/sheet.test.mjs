import test from 'node:test';
import assert from 'node:assert/strict';
import {
  layout, createSheet, place, outline, origin, windowIn, cut, BACKDROP, WINDOW, MAX_PIXELS,
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

test('a window hanging off the frame is clipped to its own tile', () => {
  const sheet = createSheet([0, 1], 10, 10);
  outline(sheet, 0, { x0: 0.5, y0: 0.2, x1: 1.5, y1: 0.8 });
  const a = origin(sheet, 0);
  const b = origin(sheet, 1);
  assert.deepEqual(px(sheet, a.ox + 5, a.oy + 2), WINDOW);
  assert.deepEqual(px(sheet, b.ox, b.oy + 2), [BACKDROP, BACKDROP, BACKDROP]);
});

test('the mobile window scales into each pass', () => {
  const source = { width: 3840, height: 2160 };
  const win = { w: 1080, h: 1920 };
  assert.deepEqual(windowIn(320, 180, source, win), { w: 90, h: 160 });
  assert.deepEqual(windowIn(64, 36, source, win), { w: 18, h: 32 });
});

test('a cut takes the window around the centre, and is pulled inside at the edge', () => {
  // A 6x2 frame whose red channel is the column number.
  const rgb = new Uint8Array(6 * 2 * 3);
  for (let i = 0; i < 12; i++) rgb[i * 3] = i % 6;
  const reds = (t) => [...t].filter((_, i) => i % 3 === 0);
  assert.deepEqual(reds(cut(rgb, 6, 2, 3, 1, 2, 2)), [2, 3, 2, 3]);
  assert.deepEqual(reds(cut(rgb, 6, 2, 6, 1, 2, 2)), [4, 5, 4, 5]);
});
