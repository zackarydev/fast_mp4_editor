import test from 'node:test';
import assert from 'node:assert/strict';
import { sequence, evenly, random, resolve, plan } from '../src/plan.mjs';

// A 60fps clip of `count` frames with a keyframe every `gop`.
function fakeIndex(count, gop) {
  const pts = new Float64Array(count);
  const key = new Uint8Array(count);
  const keyBefore = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    pts[i] = i / 60;
    key[i] = i % gop === 0 ? 1 : 0;
    keyBefore[i] = i - (i % gop);
  }
  return { count, pts, key, keyBefore };
}

test('sequence steps from frame 0 and stops before the end', () => {
  assert.deepEqual(sequence(10000, 4242), [0, 4242, 8484]);
});

test('evenly includes the first and last frame', () => {
  assert.deepEqual(evenly(101, 5), [0, 25, 50, 75, 100]);
});

test('random is reproducible from its seed and stays in range', () => {
  const a = random(1000, 20, 7);
  assert.deepEqual(a, random(1000, 20, 7));
  assert.equal(new Set(a).size, 20);
  assert.ok(a.every((f) => f >= 0 && f < 1000));
});

test('key mode answers each request with its keyframe and merges requests that share one', () => {
  const shown = resolve(fakeIndex(3000, 600), [10, 590, 1300], 'key');
  assert.deepEqual([...shown.entries()], [[0, [10, 590]], [1200, [1300]]]);
});

test('frames far apart each get their own run seeking to their own keyframe', () => {
  const runs = plan(fakeIndex(20000, 600), [0, 4242, 8484]);
  assert.deepEqual(runs.map((r) => [r.key, r.frames]), [[0, [0]], [4200, [4242]], [8400, [8484]]]);
  assert.equal(runs[1].decodes, 4242 - 4200 + 1);
});

test('frames closer than a keyframe gap share one forward run', () => {
  const runs = plan(fakeIndex(20000, 600), [100, 200, 300, 400]);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].frames, [100, 200, 300, 400]);
});

test('a frame just past a keyframe starts fresh rather than decoding on through a gap', () => {
  const runs = plan(fakeIndex(20000, 600), [100, 1201]);
  assert.deepEqual(runs.map((r) => r.key), [0, 1200]);
});
