// Where the picture is, read off the small frames a pass already decoded.
// Coordinates come out as fractions of the frame, so a 64px pass and a 320px
// pass answer in the same units and either maps straight onto the source.

export const BLACK = 24;
export const CHROMA = 24;
export const MIN_FRAC = 0.02;

// A row or column is content when at least MIN_FRAC of it, and never fewer
// than two pixels, is brighter than BLACK, so a stray cursor or compression
// speckle in a border does not count even on a 36-pixel-tall pass.
export function analyseFrame(rgb, w, h, { black = BLACK, chroma = CHROMA, minFrac = MIN_FRAC } = {}) {
  const rows = new Uint32Array(h);
  const cols = new Uint32Array(w);
  let mass = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const r = rgb[i];
      const g = rgb[i + 1];
      const b = rgb[i + 2];
      const hi = Math.max(r, g, b);
      if (hi <= black) continue;
      rows[y]++;
      cols[x]++;
      const c = hi - Math.min(r, g, b);
      if (c > chroma) {
        mass += c;
        sx += c * (x + 0.5);
        sy += c * (y + 0.5);
      }
    }
  }

  const span = (counts, len, across) => {
    const need = Math.max(2, Math.ceil(across * minFrac));
    let lo = 0;
    while (lo < len && counts[lo] < need) lo++;
    if (lo === len) return null;
    let hi = len;
    while (counts[hi - 1] < need) hi--;
    return [lo / len, hi / len];
  };
  const xs = span(cols, w, h);
  const ys = span(rows, h, w);
  const box = xs && ys ? { x0: xs[0], y0: ys[0], x1: xs[1], y1: ys[1] } : null;

  // No colour at all (a grey UI): fall back to the middle of the content.
  const centre = mass > 0
    ? { x: sx / mass / w, y: sy / mass / h }
    : box ? { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 } : null;
  return { box, centre, mass };
}

// Across a pass: the box is the union, because a border is only dead space if
// every sampled frame left it black; the centre is weighted by each frame's colour.
export function aggregate(results) {
  let box = null;
  let mass = 0;
  let cx = 0;
  let cy = 0;
  let plain = 0;
  let px = 0;
  let py = 0;
  for (const r of results) {
    if (r.box) {
      box = box
        ? { x0: Math.min(box.x0, r.box.x0), y0: Math.min(box.y0, r.box.y0),
          x1: Math.max(box.x1, r.box.x1), y1: Math.max(box.y1, r.box.y1) }
        : { ...r.box };
    }
    if (!r.centre) continue;
    if (r.mass > 0) {
      mass += r.mass;
      cx += r.mass * r.centre.x;
      cy += r.mass * r.centre.y;
    } else {
      plain++;
      px += r.centre.x;
      py += r.centre.y;
    }
  }
  const centre = mass > 0 ? { x: cx / mass, y: cy / mass } : plain ? { x: px / plain, y: py / plain } : null;
  return { box, centre, frames: results.length };
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Centre a win.w x win.h window (source pixels) on the colour, then pull it
// back inside the content box, then inside the frame. Where the content is
// narrower than the window on an axis, it centres on the content instead.
export function suggestCrop(agg, source, win = { w: 1080, h: 1920 }) {
  if (!agg.box || !agg.centre) return null;
  const axis = (c, lo, hi, size, full) => {
    const a = lo * full;
    const b = hi * full;
    const want = c * full;
    const inBox = b - a >= size ? clamp(want, a + size / 2, b - size / 2) : (a + b) / 2;
    return Math.round(clamp(inBox, size / 2, full - size / 2));
  };
  const px = (v, full) => Math.round(v * full);
  return {
    cx: axis(agg.centre.x, agg.box.x0, agg.box.x1, win.w, source.width),
    cy: axis(agg.centre.y, agg.box.y0, agg.box.y1, win.h, source.height),
    content: {
      x: px(agg.box.x0, source.width),
      y: px(agg.box.y0, source.height),
      w: px(agg.box.x1 - agg.box.x0, source.width),
      h: px(agg.box.y1 - agg.box.y0, source.height),
    },
    colour: { x: px(agg.centre.x, source.width), y: px(agg.centre.y, source.height) },
  };
}
