// What one extra ffmpeg process costs, in frames of decode it could have done
// instead: process start, file open, seek, decoder warm-up.
export const SPAWN_COST = 24;

export function sequence(count, every, start = 0) {
  const out = [];
  for (let i = start; i < count; i += every) out.push(i);
  return out;
}

export function evenly(count, n) {
  if (n <= 1) return [0];
  const out = new Set();
  for (let i = 0; i < n; i++) out.add(Math.round((i * (count - 1)) / (n - 1)));
  return [...out];
}

export function random(count, n, seed = 1) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Set();
  while (out.size < Math.min(n, count)) out.add(Math.floor(next() * count));
  return [...out];
}

// The frame each request is answered with. Exact answers the frame asked for;
// key answers the keyframe at or before it, which decodes on its own.
export function resolve(index, targets, mode) {
  const shown = new Map();
  for (const t of targets) {
    if (t < 0 || t >= index.count) continue;
    const frame = mode === 'key' ? index.keyBefore[t] : t;
    if (!shown.has(frame)) shown.set(frame, []);
    shown.get(frame).push(t);
  }
  return shown;
}

// Group frames into runs. A run is one process: seek to a keyframe, then decode
// forward through every frame it owns. The next frame joins the current run when
// decoding on from there is cheaper than a new process seeking to its own keyframe.
export function plan(index, frames, spawnCost = SPAWN_COST) {
  const sorted = [...frames].sort((a, b) => a - b);
  const runs = [];
  let run = null;
  for (const f of sorted) {
    const k = index.keyBefore[f];
    if (run) {
      const onward = f - run.last;
      const fresh = spawnCost + (f - k);
      if (onward <= fresh) {
        run.frames.push(f);
        run.last = f;
        continue;
      }
    }
    run = { key: k, frames: [f], last: f };
    runs.push(run);
  }
  for (const r of runs) r.decodes = r.last - r.key + 1;
  return runs;
}
