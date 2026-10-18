#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { probe, summary } from '../src/probe.mjs';
import { sequence, evenly, random, resolve, plan } from '../src/plan.mjs';
import { extractRun, outputSize } from '../src/extract.mjs';

const USAGE = `usage:
  mp4cut probe <file>
  mp4cut frames <file> [which] [options]

which frames (default --every 4242):
  --every <n>        every nth frame, from frame 0
  --count <n>        n frames spread evenly from first to last
  --random <n>       n random frames (--seed <s>, default 1)
  --at <a,b,c>       exactly these frame numbers

options:
  --passes <spec>    name:width:mode,... (default low:64:key,medium:320:exact)
                     mode key   = nearest keyframe at or before, decodes one frame
                     mode exact = the frame asked for, decodes from its keyframe
  --out <dir>        where frames and manifest.json go (default out/<file name>)
  --jobs <n>         ffmpeg processes at once (default 4)
  --sheet <mode>     contact sheet per pass: mobile (default) tiles each frame's
                     9:16 crop centred on its colour; desktop tiles whole frames
                     with the fixed crop outlined; none writes no sheet
  --no-hw            decode and scale on the CPU instead of VideoToolbox
  --plan             print the runs each pass would make, decode nothing`;

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
    'no-hw': { type: 'boolean' },
    plan: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [command, file] = positionals;
if (values.help || !command || !file) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
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

async function pool(items, jobs, fn) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(lanes);
}

const t0 = performance.now();
const index = await probe(file);
const probed = performance.now() - t0;

if (command === 'probe') {
  console.log(JSON.stringify({ ...summary(index), probeMs: Math.round(probed) }, null, 2));
  process.exit(0);
}
if (command !== 'frames') {
  console.log(USAGE);
  process.exit(1);
}

const passes = parsePasses(values.passes);
if (!['mobile', 'desktop', 'none'].includes(values.sheet)) {
  console.error(`--sheet must be mobile, desktop or none, not "${values.sheet}"`);
  process.exit(1);
}
const targets = targetsOf(index);
const jobs = Math.max(1, Number(values.jobs) || 4);
const s = summary(index);
console.log(`${path.basename(file)}: ${s.size} ${s.codec} ${s.fps}fps, ${s.frames} frames, `
  + `${s.keyframes} keyframes (gap mean ${s.meanKeyGap}, max ${s.maxKeyGap}), probed in ${ms(probed)}`);
console.log(`${targets.length} frames requested`);

if (values.plan) {
  for (const pass of passes) {
    const runs = plan(index, [...resolve(index, targets, pass.mode).keys()]);
    const decodes = runs.reduce((n, r) => n + r.decodes, 0);
    console.log(`\n${pass.name} (${pass.mode}): ${runs.length} runs, ~${decodes} frames decoded`);
    for (const r of runs) console.log(`  seek ${r.key} -> [${r.frames.join(', ')}]  decodes ~${r.decodes}`);
  }
  process.exit(0);
}

const out = path.resolve(values.out || path.join('out', path.parse(file).name));
fs.mkdirSync(out, { recursive: true });
const sink = new Worker(new URL('../src/sink-worker.mjs', import.meta.url), {
  workerData: {
    out, source: s, frameSize: { width: index.width, height: index.height }, window: { w: 1080, h: 1920 },
    sheetMode: values.sheet,
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
  const runs = plan(index, [...shown.keys()]);
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
  const { crop, sheet } = await flushed(pass.name);
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
  if (sheet) console.log(`         sheet ${path.join(out, sheet)}`);
}

await sink.terminate();
console.log(`wrote ${out}/manifest.json`);
