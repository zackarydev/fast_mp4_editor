import { spawn } from 'node:child_process';

export function capture(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString('utf8').trim()}`));
    });
  });
}

const ratio = (s) => {
  const [n, d] = String(s || '0/1').split('/').map(Number);
  return d ? n / d : 0;
};

// The frame table comes from packet headers only — nothing is decoded — so it
// costs one read of the file, not one decode of it.
export async function probe(file) {
  const [metaText, packetText] = await Promise.all([
    capture('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,pix_fmt,time_base,avg_frame_rate,r_frame_rate,nb_frames'
        + ':stream_side_data=rotation:format=duration,size',
      '-of', 'json', file,
    ]),
    capture('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'packet=pts,flags', '-of', 'csv=p=0', file,
    ]),
  ]);

  const meta = JSON.parse(metaText);
  const stream = meta.streams && meta.streams[0];
  if (!stream) throw new Error(`${file} has no video stream`);
  const [tbNum, tbDen] = stream.time_base.split('/').map(Number);

  const packets = [];
  for (const line of packetText.split('\n')) {
    if (!line) continue;
    const [pts, flags = ''] = line.split(',');
    if (pts === 'N/A' || flags.includes('D')) continue;
    packets.push({ pts: Number(pts), key: flags[0] === 'K' });
  }
  // Presentation order: frame n is the nth frame on screen, whatever order it was stored in.
  packets.sort((a, b) => a.pts - b.pts);

  const count = packets.length;
  const pts = new Float64Array(count);
  const key = new Uint8Array(count);
  const keyBefore = new Int32Array(count);
  let lastKey = 0;
  for (let i = 0; i < count; i++) {
    pts[i] = (packets[i].pts * tbNum) / tbDen;
    key[i] = packets[i].key ? 1 : 0;
    if (key[i]) lastKey = i;
    keyBefore[i] = lastKey;
  }

  const sideData = stream.side_data_list || [];
  const rotation = Number((sideData.find((s) => s.rotation != null) || {}).rotation || 0);
  let keys = 0;
  for (let i = 0; i < count; i++) keys += key[i];

  return {
    file,
    codec: stream.codec_name,
    width: stream.width,
    height: stream.height,
    pixFmt: stream.pix_fmt,
    rotation,
    fps: ratio(stream.avg_frame_rate) || ratio(stream.r_frame_rate),
    duration: Number(meta.format.duration),
    bytes: Number(meta.format.size),
    count,
    keys,
    pts,
    key,
    keyBefore,
  };
}

export function summary(index) {
  let maxGap = 0;
  let prev = -1;
  for (let i = 0; i < index.count; i++) {
    if (!index.key[i]) continue;
    if (prev >= 0) maxGap = Math.max(maxGap, i - prev);
    prev = i;
  }
  if (prev >= 0) maxGap = Math.max(maxGap, index.count - prev);
  return {
    file: index.file,
    codec: index.codec,
    size: `${index.width}x${index.height}`,
    pixFmt: index.pixFmt,
    rotation: index.rotation,
    fps: Number(index.fps.toFixed(3)),
    duration: index.duration,
    gigabytes: Number((index.bytes / 1e9).toFixed(3)),
    frames: index.count,
    keyframes: index.keys,
    meanKeyGap: index.keys ? Math.round(index.count / index.keys) : null,
    maxKeyGap: maxGap,
  };
}
