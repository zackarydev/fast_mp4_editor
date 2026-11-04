import { hug, contain, meanGrid, blackspace, lost, OUT } from './window.mjs';

// The window over a whole video. Each of its channels is a list of
// [frame, value] keys: between two keys it moves from one to the other, and
// past the ends it holds. A channel is either pinned, by keys someone gave, or
// fitted, from each sampled frame's content. Pinned keys ease in and out, as
// transitions someone chose; fitted keys move straight, as samples of a motion.
//
// follow fits a window to every sampled frame; sync fits one window to all of
// them at once, so the crop holds still. Either way every frame's window is
// contained last, so none shows past the content, mid-transition included.

export const CHANNELS = ['cx', 'cy', 'scale', 'rot'];
export const MODES = ['follow', 'sync'];
// Turning the picture costs the viewer a tilted head, so an angle has to save
// at least this much of a frame's cost (see costOf) to be picked.
export const TURN_WORTH = 0.1;

const smooth = (t) => t * t * (3 - 2 * t);

// Sorted by frame, one key per frame (the last given wins), and no key that
// only repeats both its neighbours.
export function keyed(pairs) {
  const byFrame = new Map(pairs);
  const sorted = [...byFrame].sort((a, b) => a[0] - b[0]);
  const kept = sorted.filter(([, v], i) => i === 0 || i === sorted.length - 1
    || v !== sorted[i - 1][1] || v !== sorted[i + 1][1]);
  return kept.length === 2 && kept[0][1] === kept[1][1] ? [kept[0]] : kept;
}

export function valueAt(keys, frame, eased = false) {
  if (!keys || !keys.length) return null;
  if (frame <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [f1, v1] = keys[i];
    if (frame > f1) continue;
    const [f0, v0] = keys[i - 1];
    const t = (frame - f0) / (f1 - f0);
    return v0 + (v1 - v0) * (eased ? smooth(t) : t);
  }
  return keys[keys.length - 1][1];
}

const channelAt = (track, c, frame) => valueAt(track.keys[c], frame, track.pinned.includes(c));

// Any frame of the video, sampled or not: this is what an export asks for.
export function windowAt(track, frame) {
  const b = track.bounds;
  return contain({
    cx: channelAt(track, 'cx', frame) ?? (b.x0 + b.x1) / 2,
    cy: channelAt(track, 'cy', frame) ?? (b.y0 + b.y1) / 2,
    scale: channelAt(track, 'scale', frame) ?? 1,
    rot: channelAt(track, 'rot', frame) ?? 0,
  }, b, track.out);
}

// What a fitted, contained window costs a frame: the share of the picture
// that is black plus the share of the content it leaves out. A crop can
// always trade one for the other, so only the two together say which is better.
const costOf = (grid, rot, bounds, out = OUT) => {
  const h = hug(grid, rot, { out });
  if (!h) return 0;
  const win = contain(h, bounds, out);
  return blackspace(win, grid, out) + lost(win, grid, out);
};

// The angle, to the degree, that costs all the grids least. A half turn
// frames the same window, so (-90, 90] is every choice. Each step from upright
// has to earn its place: a quarter turn against upright, a tilt against the
// better of the two.
export function bestRot(grids, bounds, out = OUT) {
  const cost = (rot) => grids.reduce((sum, g) => sum + costOf(g, rot, bounds, out), 0) / grids.length;
  const worth = (c, than) => c < than - TURN_WORTH;
  let best = 0;
  let least = cost(0);
  const quarter = cost(90);
  if (worth(quarter, least)) [best, least] = [90, quarter];
  let tilt = 0;
  let tilted = Infinity;
  const look = (rot) => {
    if (rot % 90 === 0) return;
    const c = cost(rot);
    if (c < tilted) [tilt, tilted] = [rot, c];
  };
  for (let r = -85; r < 90; r += 5) look(r);
  const coarse = tilt;
  for (let r = coarse - 4; r <= coarse + 4; r++) look(((r + 269) % 180) - 89);
  return worth(tilted, least) ? tilt : best;
}

// samples: [{ frame, grid }], the frames of one pass. keys: [{ frame, cx?, cy?,
// scale?, rot? }], each pinning only the channels it names.
export function solve(samples, bounds, { mode = 'follow', autoRot = false, keys = [], out = OUT } = {}) {
  const sorted = [...samples].sort((a, b) => a.frame - b.frame);
  const track = { mode, out, bounds, pinned: [], keys: {} };
  for (const c of CHANNELS) {
    track.keys[c] = keyed(keys.filter((k) => Number.isFinite(k[c])).map((k) => [k.frame, k[c]]));
    if (track.keys[c].length) track.pinned.push(c);
  }
  if (!sorted.length) return track;

  const grids = sorted.map((s) => s.grid);
  const whole = mode === 'sync' ? meanGrid(grids) : null;
  if (!track.keys.rot.length && autoRot) {
    track.keys.rot = [[sorted[0].frame, bestRot(whole ? [whole] : grids, bounds, out)]];
  }
  const fit = CHANNELS.filter((c) => c !== 'rot' && !track.pinned.includes(c));
  if (fit.length) {
    const fitted = sorted
      .map((s) => ({ frame: s.frame, win: hug(whole || s.grid, channelAt(track, 'rot', s.frame) ?? 0, { out }) }))
      .filter((f) => f.win);
    for (const c of fit) track.keys[c] = keyed(fitted.map((f) => [f.frame, f.win[c]]));
  }
  return track;
}
