import test from 'node:test';
import assert from 'node:assert/strict';
import { analyseFrame, aggregate, suggestCrop } from '../src/analyse.mjs';

function frame(w, h, paint) {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y) || [0, 0, 0];
      rgb.set([r, g, b], (y * w + x) * 3);
    }
  }
  return rgb;
}

test('the box is the non-black area and the centre sits on the colour', () => {
  // Grey panel over x 10..50, y 5..25, with a red patch at x 40..50, y 5..15.
  const rgb = frame(64, 36, (x, y) => {
    if (x < 10 || x >= 50 || y < 5 || y >= 25) return null;
    return x >= 40 && y < 15 ? [220, 30, 30] : [120, 120, 120];
  });
  const a = analyseFrame(rgb, 64, 36);
  assert.deepEqual(a.box, { x0: 10 / 64, y0: 5 / 36, x1: 50 / 64, y1: 25 / 36 });
  assert.equal(a.centre.x, 45 / 64);
  assert.equal(a.centre.y, 10 / 36);
});

test('a lone bright pixel in a black border is not content', () => {
  const rgb = frame(64, 36, (x, y) => (x === 2 && y === 2) || (x >= 20 && x < 40) ? [200, 200, 200] : null);
  assert.equal(analyseFrame(rgb, 64, 36).box.x0, 20 / 64);
});

test('a frame with no colour centres on its content, and an all-black frame has neither', () => {
  const grey = analyseFrame(frame(64, 36, (x) => (x < 32 ? [128, 128, 128] : null)), 64, 36);
  assert.deepEqual(grey.centre, { x: 0.25, y: 0.5 });
  const black = analyseFrame(frame(64, 36, () => null), 64, 36);
  assert.equal(black.box, null);
  assert.equal(black.centre, null);
});

test('across a pass the box is the union and the centre is weighted by colour', () => {
  const agg = aggregate([
    { box: { x0: 0.2, y0: 0.2, x1: 0.5, y1: 0.5 }, centre: { x: 0.3, y: 0.3 }, mass: 1 },
    { box: { x0: 0.4, y0: 0.1, x1: 0.8, y1: 0.6 }, centre: { x: 0.6, y: 0.5 }, mass: 3 },
    { box: null, centre: null, mass: 0 },
  ]);
  assert.deepEqual(agg.box, { x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.6 });
  assert.ok(Math.abs(agg.centre.x - 0.525) < 1e-12);
  assert.ok(Math.abs(agg.centre.y - 0.45) < 1e-12);
});

test('the suggested window follows the colour, stays inside the content, and centres where content is too small', () => {
  const source = { width: 3840, height: 2160 };
  // Content 2000..3200 wide (1200 >= 1080) and 200..2000 tall (1800 < 1920).
  const box = { x0: 2000 / 3840, y0: 200 / 2160, x1: 3200 / 3840, y1: 2000 / 2160 };
  const near = suggestCrop({ box, centre: { x: 3100 / 3840, y: 0.5 } }, source);
  assert.equal(near.cx, 3200 - 540);
  assert.equal(near.cy, 1100);
  const inside = suggestCrop({ box, centre: { x: 2600 / 3840, y: 0.5 } }, source);
  assert.equal(inside.cx, 2600);
});
