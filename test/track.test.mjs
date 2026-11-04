import test from 'node:test';
import assert from 'node:assert/strict';
import { gridOf, hug, mapper, axes, OUT } from '../src/window.mjs';
import { keyed, valueAt, windowAt, bestRot, solve } from '../src/track.mjs';

const FRAME = { width: 3840, height: 2160 };
const BOUNDS = { x0: 0, y0: 0, x1: 3840, y1: 2160 };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

function pass(paint, w = 320, h = 180) {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (paint(x, y)) rgb.fill(200, (y * w + x) * 3, (y * w + x) * 3 + 3);
  return gridOf(rgb, w, h, FRAME);
}

// A 960 x 1680 block of content whose left edge is at pass x (source x * 12).
const block = (x0) => pass((x, y) => x >= x0 && x < x0 + 80 && y >= 20 && y < 160);

test('keys sort, the last given for a frame wins, and repeats collapse', () => {
  assert.deepEqual(keyed([[100, 1], [0, 2], [100, 3]]), [[0, 2], [100, 3]]);
  assert.deepEqual(keyed([[0, 5], [10, 5], [20, 5], [30, 6]]), [[0, 5], [20, 5], [30, 6]]);
  assert.deepEqual(keyed([[0, 5], [10, 5], [20, 5]]), [[0, 5]]);
});

test('a channel holds past its ends, moves straight when fitted and eases when pinned', () => {
  const keys = [[100, 0], [200, 40]];
  assert.equal(valueAt(keys, 0), 0);
  assert.equal(valueAt(keys, 900), 40);
  assert.equal(valueAt(keys, 125), 10);
  assert.ok(near(valueAt(keys, 125, true), 40 * 0.15625));
  assert.equal(valueAt([], 5), null);
});

test('follow fits each frame and moves straight between them', () => {
  const track = solve([{ frame: 100, grid: block(150) }, { frame: 0, grid: block(50) }], BOUNDS, { mode: 'follow' });
  const a = hug(block(50), 0);
  const b = hug(block(150), 0);
  assert.ok(near(windowAt(track, 0).cx, a.cx) && near(windowAt(track, 100).cx, b.cx));
  assert.ok(near(windowAt(track, 50).cx, (a.cx + b.cx) / 2));
});

test('sync fits one window to all frames, so the crop holds still', () => {
  const track = solve([{ frame: 0, grid: block(50) }, { frame: 100, grid: block(150) }], BOUNDS, { mode: 'sync' });
  assert.equal(track.keys.cx.length, 1);
  assert.deepEqual(windowAt(track, 0), windowAt(track, 100));
});

test('a pinned turn eases from one angle to the next, fitting around it, never past the frame', () => {
  const samples = [0, 50, 100].map((frame) => ({ frame, grid: block(100) }));
  const track = solve(samples, BOUNDS, { keys: [{ frame: 0, rot: 0 }, { frame: 100, rot: 90 }] });
  assert.deepEqual(track.pinned, ['rot']);
  assert.ok(near(windowAt(track, 50).rot, 45));
  assert.ok(near(track.keys.scale.find(([f]) => f === 50)[1], hug(block(100), 45).scale));
  for (let f = 0; f <= 100; f += 5) {
    const at = mapper(windowAt(track, f));
    for (const [x, y] of [[0, 0], [OUT.w, 0], [OUT.w, OUT.h], [0, OUT.h]]) {
      const [sx, sy] = at(x, y);
      assert.ok(sx > -1e-6 && sx < 3840 + 1e-6 && sy > -1e-6 && sy < 2160 + 1e-6, `frame ${f}: ${sx},${sy}`);
    }
  }
});

test('pinning the centre leaves the zoom fitted', () => {
  const track = solve([{ frame: 0, grid: block(100) }], BOUNDS, { keys: [{ frame: 0, cx: 1500, cy: 1100 }] });
  assert.deepEqual(track.pinned, ['cx', 'cy']);
  assert.deepEqual(windowAt(track, 0), { cx: 1500, cy: 1100, rot: 0, scale: hug(block(100), 0).scale });
});

test('auto turns a frame full of landscape on its side, and leaves a square upright', () => {
  assert.equal(bestRot([pass(() => true)], BOUNDS), 90);
  assert.equal(bestRot([pass((x, y) => x >= 100 && x < 190 && y >= 45 && y < 135)], BOUNDS), 0);
});

test('content shaped like a phone but lying at an angle gets its angle back', () => {
  // A 540 x 960 rectangle (45 x 80 pass pixels) whose long side runs along a
  // window turned 30 degrees.
  const { ux, uy } = axes(30);
  const tilted = pass((x, y) => {
    const dx = x + 0.5 - 160;
    const dy = y + 0.5 - 90;
    return Math.abs(dx * ux[0] + dy * ux[1]) < 22.5 && Math.abs(dx * uy[0] + dy * uy[1]) < 40;
  });
  assert.ok(Math.abs(bestRot([tilted], BOUNDS) - 30) <= 2);
});

test('a thin stroke in a field of black is not worth turning for', () => {
  const stroke = pass((x, y) => Math.abs((x - 160) + (y - 90)) < 5 && Math.abs((x - 160) - (y - 90)) < 80);
  assert.equal(bestRot([stroke], BOUNDS), 0);
});
