import { spawn } from 'node:child_process';

export function outputSize(index, width) {
  const w = Math.max(2, Math.round(width / 2) * 2);
  const h = Math.max(2, Math.round((w * index.height) / index.width / 2) * 2);
  return { w, h };
}

// Half the distance to the nearest neighbour: wide enough to survive float
// rounding, narrow enough that no other frame can match. Safe under variable frame rate.
function window(index, f) {
  const prev = f > 0 ? index.pts[f] - index.pts[f - 1] : Infinity;
  const next = f + 1 < index.count ? index.pts[f + 1] - index.pts[f] : Infinity;
  const gap = Math.min(prev, next);
  return Number.isFinite(gap) ? gap / 2 : 0.5;
}

function selectExpr(index, frames) {
  return frames
    .map((f) => `lt(abs(t-${index.pts[f].toFixed(9)}),${window(index, f).toFixed(9)})`)
    .join('+');
}

function hwDownloadFormat(pixFmt) {
  return /10|12/.test(pixFmt || '') ? 'p010le' : 'nv12';
}

// Hardware: VideoToolbox decodes, select drops unwanted frames while they are
// still on the GPU, scale_vt shrinks there too, and only the small frame crosses
// to the CPU. Software: the same graph with the CPU doing every step. A
// keyframes-only run has the decoder skip the rest before they cost anything.
export function ffmpegArgs(index, run, { w, h }, hw) {
  const seekTo = index.pts[run.key] + window(index, run.key);
  const select = `select='${selectExpr(index, run.frames)}'`;
  const graph = hw
    ? `${select},scale_vt=w=${w}:h=${h},hwdownload,format=${hwDownloadFormat(index.pixFmt)},format=rgb24,showinfo`
    : `${select},scale=${w}:${h}:flags=area,format=rgb24,showinfo`;
  return [
    '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info',
    ...(hw ? ['-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld'] : []),
    '-noautorotate',
    '-noaccurate_seek', '-ss', seekTo.toFixed(9), '-copyts',
    ...(run.keysOnly ? ['-skip_frame', 'nokey'] : []),
    '-i', index.file,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', graph,
    '-fps_mode', 'passthrough',
    '-frames:v', String(run.frames.length),
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ];
}

const SHOWINFO = /\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:\s*(-?[\d.]+)/;

// One run, one process. Frames leave stdout as fixed-size raw RGB; showinfo
// on stderr says which timestamp each one is, so a frame is never mislabelled.
export function extractRun(index, run, size, hw, onFrame) {
  const frameBytes = size.w * size.h * 3;
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ffmpegArgs(index, run, size, hw), { stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = Buffer.alloc(0);
    let lineBuf = '';
    const log = [];
    const images = [];
    const times = [];
    let emitted = 0;
    let failure = null;

    const pair = () => {
      while (images.length && times.length) {
        const data = images.shift();
        const t = times.shift();
        const f = run.frames.find((x) => Math.abs(index.pts[x] - t) < window(index, x));
        if (f == null) {
          failure = new Error(`ffmpeg produced a frame at ${t}s that this run did not ask for`);
          child.kill();
          return;
        }
        emitted++;
        onFrame({ frame: f, pts: index.pts[f], w: size.w, h: size.h, data });
      }
    };

    child.stdout.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameBytes) {
        images.push(new Uint8Array(pending.subarray(0, frameBytes)));
        pending = pending.subarray(frameBytes);
      }
      pair();
    });
    child.stderr.on('data', (chunk) => {
      lineBuf += chunk.toString('utf8');
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop();
      for (const line of lines) {
        const m = SHOWINFO.exec(line);
        if (m) times.push(Number(m[1]));
        else if (log.length < 200) log.push(line);
      }
      pair();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}:\n${log.slice(-15).join('\n')}`));
      if (emitted !== run.frames.length) {
        return reject(new Error(`run from frame ${run.key} asked for ${run.frames.length} frames, got ${emitted}`));
      }
      resolve({ emitted });
    });
  });
}
