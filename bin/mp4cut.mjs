#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { probe, summary } from '../src/probe.mjs';
import { sequence, evenly, random, resolve, plan, sweep } from '../src/plan.mjs';
import { CHANNELS, MODES } from '../src/track.mjs';
import { extractRun, outputSize } from '../src/extract.mjs';

const USAGE = `usage:
  mp4cut probe <file...>
  mp4cut frames <file> [which] [options]

which frames (default --every 4242):
  --every <n>        every nth frame, from frame 0
  --count <n>        n frames spread evenly from first to last
  --random <n>       n random frames (--seed <s>, default 1)
  --at <a,b,c>       exactly these frame numbers

options:
  --passes <spec>    name:width:mode,... (default low:64:key,medium:320:exact)
                     mode key   = nearest keyframe at or before, decoding only
                                  keyframes, in one sweep per job
                     mode exact = the frame asked for, decodes from its keyframe
  --out <dir>        where frames and manifest.json go (default out/<file name>)
  --jobs <n>         ffmpeg processes at once (default 4)
  --sheet <mode>     contact sheet per pass: mobile (default) tiles each frame's
                     9:16 crop centred on its colour; desktop tiles whole frames
                     with each colour centre marked; none writes no sheet
  --no-hw            decode and scale on the CPU instead of VideoToolbox
  --plan             print the runs each pass would make, decode nothing

the window (the 1080x1920 phone picture, solved per pass over its frames):
  --track <mode>     follow (default): fit the window to each frame's content
                     and move between them; sync: one window fits all frames
  --rot <deg|auto>   turn the picture clockwise (default 0); auto picks the
                     angle with the least black and least content left out,
                     if it saves enough to be worth turning the viewer's head
  --scale <n|auto>   output pixels per source pixel; auto (default) zooms to
                     the content, up to 2
  --key <f:k=v,...>  pin channels cx, cy, scale or rot from frame f, e.g.
                     1200:rot=90 or 0:cx=1900,cy=1000; repeatable. A pinned
                     channel eases between its keys and is no longer fitted.
                     Whatever is asked, the window stays inside the content`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    every: { type: 'string' },
    count: { type: 'string' },
    random: { type: 'string' },
    seed: { type: 'string' },
    at: { type: 'string' },
    passes: { type: 'string', default: 'low:64:key,medium:320:exact' },
    out: { type: 'string' },
    jobs: { type: 'string', default: '4' },
    sheet: { type: 'string', default: 'mobile' },
    track: { type: 'string', default: 'follow' },
    rot: { type: 'string' },
    scale: { type: 'string' },
    key: { type: 'string', multiple: true },
    'no-hw': { type: 'boolean' },
    plan: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [command, ...files] = positionals;
if (values.help || !command || !files.length) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}
const missing = files.filter((f) => !fs.existsSync(f));
if (missing.length) {
  console.error(`no such file: ${missing.join(', ')}`);
  process.exit(1);
}

const ms = (t) => `${t.toFixed(0)}ms`;

function parsePasses(spec) {
  return spec.split(',').map((s) => {
    const [name, width, mode = 'exact'] = s.split(':');
    if (!name || !(Number(width) > 0) || !['key', 'exact'].includes(mode)) {
      throw new Error(`bad pass "${s}": want name:width:key|exact`);
    }
    return { name, width: Number(width), mode };
  });
}

function targetsOf(index) {
  if (values.at) return values.at.split(',').map(Number);
  if (values.random) return random(index.count, Number(values.random), Number(values.seed || 1));
  if (values.count) return evenly(index.count, Number(values.count));
  return sequence(index.count, Number(values.every || 4242));
}

// --rot and --scale are keys at frame 0, given first so a --key there wins.
function trackOf() {
  if (!MODES.includes(values.track)) throw new Error(`--track must be ${MODES.join(' or ')}, not "${values.track}"`);
  const keys = [];
  const number = (flag, v) => {
    if (!Number.isFinite(Number(v)) || v === '') throw new Error(`${flag} wants a number, not "${v}"`);
    return Number(v);
  };
  if (values.rot !== undefined && values.rot !== 'auto') keys.push({ frame: 0, rot: number('--rot', values.rot) });
  if (values.scale !== undefined && values.scale !== 'auto') keys.push({ frame: 0, scale: number('--scale', values.scale) });
  for (const spec of values.key || []) {
    const [at, pairs = ''] = spec.split(':');
    const key = { frame: number('--key frame', at) };
    for (const pair of pairs.split(',').filter(Boolean)) {
      const [k, v] = pair.split('=');
      if (!CHANNELS.includes(k)) throw new Error(`--key ${spec}: ${k} is not one of ${CHANNELS.join(', ')}`);
      key[k] = number(`--key ${spec}`, v);
    }
    keys.push(key);
  }
  if (keys.some((k) => k.scale !== undefined && !(k.scale > 0))) throw new Error('a scale must be above 0');
  return { mode: values.track, autoRot: values.rot === 'auto', keys };
}

async function pool(items, jobs, fn) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(lanes);
}

// One at a time, so each probeMs is that file's own and not a share of a race.
if (command === 'probe') {
  for (const f of files) {
    const t = performance.now();
    const index = await probe(f);
    console.log(JSON.stringify({ ...summary(index), probeMs: Math.round(performance.now() - t) }, null, 2));
  }
  process.exit(0);
}
if (command !== 'frames' || files.length > 1) {
  console.log(USAGE);
  process.exit(1);
}

const [file] = files;
const t0 = performance.now();
const index = await probe(file);
const probed = performance.now() - t0;

const passes = parsePasses(values.passes);
if (!['mobile', 'desktop', 'none'].includes(values.sheet)) {
  console.error(`--sheet must be mobile, desktop or none, not "${values.sheet}"`);
  process.exit(1);
}
let trackOptions;
try {
  trackOptions = trackOf();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const targets = targetsOf(index);
const jobs = Math.max(1, Number(values.jobs) || 4);
const runsOf = (pass, frames) => (pass.mode === 'key' ? sweep(index, frames, jobs) : plan(index, frames));
const s = summary(index);
console.log(`${path.basename(file)}: ${s.size} ${s.codec} ${s.fps}fps, ${s.frames} frames, `
  + `${s.keyframes} keyframes (gap mean ${s.meanKeyGap}, max ${s.maxKeyGap}), probed in ${ms(probed)}`);
console.log(`${targets.length} frames requested`);

if (values.plan) {
  for (const pass of passes) {
    const runs = runsOf(pass, [...resolve(index, targets, pass.mode).keys()]);
    const decodes = runs.reduce((n, r) => n + r.decodes, 0);
    console.log(`\n${pass.name} (${pass.mode}): ${runs.length} runs, ~${decodes} frames decoded`);
    for (const r of runs) {
      console.log(`  seek ${r.key} -> [${r.frames.join(', ')}]  decodes ~${r.decodes}${r.keysOnly ? ' keyframes' : ''}`);
    }
  }
  process.exit(0);
}

const out = path.resolve(values.out || path.join('out', path.parse(file).name));
fs.mkdirSync(out, { recursive: true });
const sink = new Worker(new URL('../src/sink-worker.mjs', import.meta.url), {
  workerData: {
    out, source: s, frameSize: { width: index.width, height: index.height }, window: { w: 1080, h: 1920 },
    sheetMode: values.sheet, track: trackOptions,
  },
});
const flushed = (name) => new Promise((res) => {
  const on = (m) => {
    if (m.type === 'flushed' && m.pass === name) {
      sink.off('message', on);
      res(m);
    }
  };
  sink.on('message', on);
});

let hw = !values['no-hw'];
for (const pass of passes) {
  const shown = resolve(index, targets, pass.mode);
  const runs = runsOf(pass, [...shown.keys()]);
  const size = outputSize(index, pass.width);
  sink.postMessage({
    type: 'pass', pass: { ...pass, w: size.w, h: size.h }, frames: [...shown.keys()].sort((a, b) => a - b),
  });

  const started = performance.now();
  const done = new Set();
  let first = null;
  const onFrame = (fr) => {
    if (done.has(fr.frame)) return;
    done.add(fr.frame);
    if (first == null) first = performance.now() - started;
    sink.postMessage({
      type: 'frame', pass: pass.name, frame: fr.frame, pts: fr.pts,
      requested: shown.get(fr.frame), w: fr.w, h: fr.h, data: fr.data,
    }, [fr.data.buffer]);
  };

  await pool(runs, jobs, async (run) => {
    try {
      await extractRun(index, run, size, hw, onFrame);
    } catch (err) {
      if (!hw) throw err;
      console.warn(`hardware path failed, falling back to software: ${err.message.split('\n')[0]}`);
      hw = false;
      await extractRun(index, run, size, false, onFrame);
    }
  });

  const took = performance.now() - started;
  const decodes = runs.reduce((n, r) => n + r.decodes, 0);
  const stats = {
    runs: runs.length, decodes, wallMs: Math.round(took), firstFrameMs: Math.round(first ?? took), hw,
  };
  sink.postMessage({ type: 'pass-end', pass: pass.name, stats });
  const { crop, windows, sheet } = await flushed(pass.name);
  console.log(`${pass.name.padEnd(8)} ${size.w}x${size.h} ${pass.mode.padEnd(5)} ${done.size} frames, `
    + `${runs.length} runs, ~${decodes} decoded, first frame ${ms(stats.firstFrameMs)}, `
    + `all in ${ms(took)} (${ms(took / Math.max(1, done.size))}/frame)${hw ? '' : ' [software]'}`);
  if (crop) {
    const c = crop.content;
    console.log(`         content ${c.w}x${c.h} at ${c.x},${c.y}, colour centre ${crop.colour.x},${crop.colour.y}`
      + ` -> CX=${crop.cx} CY=${crop.cy}  (±${Math.round(index.width / size.w)}px)`);
  } else {
    console.log('         no content found: every sampled frame is black');
  }
  if (windows && windows.rot) {
    const span = ([a, b], k) => (a === b ? `${+a.toFixed(k)}` : `${+a.toFixed(k)}..${+b.toFixed(k)}`);
    const pct = (v) => `${Math.round(v * 100)}%`;
    const costs = (c) => `${pct(c.blackspace)} black, ${pct(c.lost)} of content left out`;
    console.log(`         window ${windows.mode}, rot ${span(windows.rot, 1)}, scale ${span(windows.scale, 2)}: ${costs(windows)}`
      + `${windows.fixed ? `\n         (the fixed crop above: ${costs(windows.fixed)})` : ''}`);
  }
  if (sheet) console.log(`         sheet ${path.join(out, sheet)}`);
}

await sink.terminate();
console.log(`wrote ${out}/manifest.json`);
